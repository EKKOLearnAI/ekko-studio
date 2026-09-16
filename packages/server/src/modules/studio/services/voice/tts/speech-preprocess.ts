import { appendFile, mkdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import YAML from 'js-yaml'
import { getActiveConfigPath } from '../../../../hermes/services/profiles/profile'
import { readAppConfig } from '../../config/app-config'

/**
 * 语音预处理（Speech Preprocessing）
 *
 * 职责划分（v4，按用户拍板）：符号汉化、数字读法、语义理解、口播文案创作——
 * 全部交给模型层，规则层不碰「符号 → 中文」这类需要理解的转换，只做纯机械去噪。
 *
 * 管线：
 *   [1] 规则清洗 sanitizeForSpeech —— 必开、零延迟、零成本：去掉 Markdown / URL / 代码围栏 /
 *       表格线等「纯噪音」，保留文字与数字原貌（不做任何语义改写）
 *   [2] 智能触发 —— 含代码块 / 含表格 / 超字数才调用模型（短回复零额外延迟）
 *   [3] 模型创作 —— 唯一的「理解 + 改写」层：通读语义 → 汉化符号数字 → 产出可直接交给
 *       TTS 的完整口播文案（faithful 完整转述 / summary 压缩创作）。失败/超时静默降级规则层
 *
 * 铁律 1：本管线是增强，不是必经路径。任何环节失败都必须保证声音照常出来。
 * 铁律 2：模型输出不做代码层符号替换——「6.24% → 百分之六点二四」这类必须由模型在理解后
 *         用中文一次成型，禁止代码层产出「百分之6.24」这种机械混排文本。模型是否残留符号
 *         由日志的 residual 字段记录（只观测、不修改），供持续校准提示词。
 *
 * 日志：每次预处理落一条 NDJSON 到 ~/.hermes-web-ui/speech-preprocess-logs/YYYY-MM-DD.ndjson
 *       （原文 / 清洗 / 模型原始输出 / 最终输出 全量留痕 + 残留符号诊断），供事后针对性校准提示词。
 */

export interface SpeechPreprocessingTriggers {
  codeBlock: boolean
  table: boolean
  minChars: number
}

export interface SpeechPreprocessingConfig {
  enabled: boolean
  /** custom_providers 条目名，如 open.bigmodel.cn */
  provider: string
  model: string
  mode: 'faithful' | 'summary'
  promptFaithful: string
  promptSummary: string
  triggers: SpeechPreprocessingTriggers
  /**
   * 模型调用超时（毫秒）。实测 glm-4.5-air(thinking off) 清洗 ~300 字正文需 2.7~4.2s，
   * 3s 硬超时会令模型层几乎不可用，故默认 15s。超时后仍静默降级规则层。
   */
  timeoutMs: number
}

// 提示词演进落库：
//  v2 —— Podcastfy / Open NotebookLM / CosyVoice(wetext) / NeMo-TN / ChatTTS / MeloTTS 调研：
//        数字 semiotic class（标识逐字 vs 数值按量级）、≤25 字短句断句、摘要 engagement 抓耳。
//  v3 —— 负数铁律（-3%→负百分之三）+ 单位防串扰（12.5%≠12.5亿，实测模型会把 % 串成亿）。
//  v4 —— 用户拍板：代码层不得机械替换符号（会产出「百分之6.24」劣质混排），理解+汉化+创作
//        全部收归模型。模型须先通读语义再动笔，一次成型输出可直接朗读的完整口播文案；
//        阿拉伯数字不得与中文单位混排；口语数字尽量汉字化。规则层只保留纯机械去噪。
export const DEFAULT_PROMPT_FAITHFUL = `你是资深语音播报文案编辑。用户消息将被语音合成朗读，你的任务是把原始内容（可能含 Markdown、表格、代码、密集数字）改写成「一听就懂、声情并茂、可直接交给 TTS 朗读」的完整口播文案。

【工作方式：先理解，再动笔】
先通读原文，弄清语义与语境：这段在讲什么、数字代表什么含义（涨跌、百分比、金额、时间还是代码）、量级与单位是什么。理解之后用准确、自然的中文口播表达出来。禁止机械照抄符号，禁止不懂装懂硬念。

【输出硬性要求】
1. 只输出口播文案本身，不加解释、前后缀或任何 Markdown 符号。
2. 去 Markdown 标记、表格线、URL、代码块围栏；表格改为自然语言逐条描述且单元格数值全部保留；代码/公式不逐字念符号，用一句自然的话点明作用或用口语读法表达。
3. 文案必须是「完整成稿」：语序通顺、逻辑连贯、可直接整段朗读，不是翻译腔、不是符号替换稿。

【数字读法】（结合语境理解后表达，务必准确；禁止阿拉伯数字与中文单位混排）
- 负数与下跌语义：带负号的数字必须表达出「负」或语境对应的跌/降/流出语义，绝不允许丢成正数。样例：-3% →「负百分之三」；「跌幅 -3%」在行情语境应表达为「下跌了百分之三」（语义准确更口语）；-12.5亿 →「负十二点五亿」；净流出 -2.1亿 →「净流出二点一亿」。自查：原文带负号的数字，输出必须含「负」或明确的下跌语义。
- 百分比用中文数字写全：6.24% →「百分之六点二四」，8.3% →「百分之八点三」。禁止写「百分之6.24」这类阿拉伯与中文混排。
- 小数、金额、区间、比、日期时间全部中文口语：3.7→三点七；12.5亿→十二点五亿；8%~12%→百分之八到百分之十二；3:1→三比一；2026年9月3日；09:30→九点三十分。
- 数值型数字口语尽量汉字化并按量级口述：2130→二千一百三十；12600→一万二千六百。
- 标识型数字（股票代码、基金代码、版本号、型号、电话）逐字读：688981→六八八九八一，v2.5→v 二点五。
- 单位防串扰：每个数字必须带对原文的单位量级。12.5% 只可能读作「百分之十二点五」，绝不能变成十二点五亿；反之亦然。
- 数值表达稳定（防丢字、防变体）：区间必须成对写全——1%~2% 只能写成「百分之一到百分之二」，绝不允许漏掉任何一个「百分之」或数字（「一到百分之二」是错误）；概率一律用「百分之五十」式完整写法，禁止「五成 / 折 / 一半」这类替代；同一稿子里同一数字表述保持一致。输出前把每个数字逐字核对。
- 拿不准的英文专名/单位用中文口读：GB→吉字节；SQL 逐字母读作「S-Q-L」。

【节奏与情绪】
- 句子要短：单句尽量不超过 25 个字，句号断句、逗号给呼吸点；数字密集处主动拆短句；长定语、多重从句拆成两三句。
- 书面虚词口语化承接（「综上所述」→「总之」）；保留关键结论的语气与强调；不用 emoji、不用列表符号。
- 每句以句号收尾，让 TTS 有明确停顿。

【信息完整度】
- 忠实转述：保留全部信息、关键数据、结论与专有名词；只改表达、不改事实、不增删观点。

【输出前逐条自查】
① 全文没有由 -、%、:、/、| 等符号组成的数字写法；
② 原文每个带负号的数字在输出里都有「负」或跌/降/流出语义；
③ 每个数字的单位量级与原文一致（百分比不会变成亿）；
④ 没有阿拉伯数字与「百分之」「万/亿」等中文单位混排（如「百分之6.24」「6.24亿」的混写）；
⑤ 改写后仍是一段通顺完整、可直接朗读的口语，而不是符号替换稿。

【分段输出（重要）】
- 全文转述完成后，按「语义块」自然分段：每个语义块承载一个完整要点/事件/结论，块内 3~5 句、语义自洽、可独立朗读。
- 段与段之间用一行纯分隔符 ===SEG=== 隔开（前后各留一个空行）。
- 严禁把一句话从中间切开；严禁在数字读法、百分比、专有名词中间断开；每段都以句号收尾。
- 全文必须全部输出（忠实转述不删减），只是中间插入 ===SEG=== 分隔符。`

export const DEFAULT_PROMPT_SUMMARY = `你是资深语音播报文案编辑。把用户消息改写为「一听就懂、声情并茂、可直接交给 TTS 朗读」的口语化中文摘要，控制在 200 字以内。只输出口播文案本身，不加解释、前后缀或 Markdown 符号。

【工作方式：先理解，再创作】
先通读原文弄清语义与语境（在讲什么、数字含义、正负涨跌、量级单位、结论是什么），再动笔：只保留核心结论、关键数字、因果主链、必要背景，省略论证过程与重复表述。抓耳的结论放在开头，用「但是」「关键在于」「更值得注意的是」制造起伏，结尾可用「总的来说」点题。

【数字读法】（保留的数字必须理解后准确表达；禁止阿拉伯数字与中文单位混排）
- 负数与下跌语义：带负号的数字必须表达出「负」或语境对应的跌/降/流出语义，绝不丢成正数。-3% →「负百分之三」；行情语境下「跌幅 -3%」可表达为「下跌了百分之三」；净流出 -2.1亿 →「净流出二点一亿」。自查：原文负号数字输出必须含「负」或下跌语义。
- 百分比用中文数字写全：6.24% →「百分之六点二四」。禁止「百分之6.24」混排。
- 小数/金额/区间/比/日期时间中文口语：三点七、十二点五亿、百分之八到百分之十二、三比一、九点三十分。
- 数值型数字尽量汉字化（2130→二千一百三十）；标识型（股票代码/版本/型号）逐字（688981→六八八九八一）。
- 单位防串扰：12.5% 只能读作百分之十二点五，绝不写成十二点五亿；每个数字单位与原文一致。
- 数值表达稳定（防丢字、防变体，务必执行）：同一份稿子里同一数字表述必须一致，一律用「百分之 + 中文数字」完整写法，禁止改用「五成 / 三成 / 两成 / 折 / 一半」这类替代（**概率也一样：50% 只能写「百分之五十」，严禁「五成」**），也不要时而「百分之五十」时而「五成」；区间必须成对写全——1%~2% 只能写成「百分之一到百分之二」，绝不允许漏掉任何一个「百分之」或数字（「一到百分之二」是错误，必须完整成对）。输出前把每个数字逐字核对：有没有少「百分之」、少数字、或混入「成/折」。
- 拿不准的英文专名逐字母口读（SQL→S-Q-L）。

【节奏】
- 单句 ≤25 字，句号断句、逗号呼吸；数字密集处拆短句；不写 emoji、不用列表符号；每句句号收尾。

【短文本直通（硬规则，优先级最高）】
若原文不超过 60 字、不含代码块/表格/多行列表、本身已是自然口语（自述、盯盘记录、短指令），
你必须一字不改直接原样输出——不压缩、不扩写、不加「关键」「总的来说」等修饰，连标点都保持原样。

【输出前逐条自查】
① 无 -、%、:、/、| 符号组成的数字写法；② 原文负号数字都有「负」或跌/降语义；③ 数字单位量级不串（% 不变成亿）；④ 无阿拉伯数字与中文单位混排；⑤ 是通顺完整可直接朗读的口语成稿。`

export const DEFAULT_SPEECH_PREPROCESSING: SpeechPreprocessingConfig = {
  enabled: false,
  provider: 'open.bigmodel.cn',
  model: 'glm-4.5-air',
  mode: 'faithful',
  promptFaithful: DEFAULT_PROMPT_FAITHFUL,
  promptSummary: DEFAULT_PROMPT_SUMMARY,
  triggers: { codeBlock: true, table: true, minChars: 300 },
  timeoutMs: 60_000,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeSpeechPreprocessingConfig(value: unknown): SpeechPreprocessingConfig {
  const base = { ...DEFAULT_SPEECH_PREPROCESSING }
  if (!isRecord(value)) return base
  const raw = value as Record<string, unknown>

  const normalized: SpeechPreprocessingConfig = {
    ...base,
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.provider === 'string' && raw.provider.trim() ? { provider: raw.provider.trim() } : {}),
    ...(typeof raw.model === 'string' && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(raw.mode === 'summary' || raw.mode === 'faithful' ? { mode: raw.mode } : {}),
    ...(typeof raw.promptFaithful === 'string' && raw.promptFaithful.trim() ? { promptFaithful: raw.promptFaithful } : {}),
    ...(typeof raw.promptSummary === 'string' && raw.promptSummary.trim() ? { promptSummary: raw.promptSummary } : {}),
    ...(typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? { timeoutMs: Math.min(Math.max(Math.floor(raw.timeoutMs), 1_000), 30_000) }
      : {}),
  }

  if (isRecord(raw.triggers)) {
    const t = raw.triggers
    normalized.triggers = {
      codeBlock: typeof t.codeBlock === 'boolean' ? t.codeBlock : base.triggers.codeBlock,
      table: typeof t.table === 'boolean' ? t.table : base.triggers.table,
      minChars:
        typeof t.minChars === 'number' && Number.isFinite(t.minChars) && t.minChars > 0
          ? Math.floor(t.minChars)
          : base.triggers.minChars,
    }
  }

  return normalized
}

// ---------------------------------------------------------------------------
// [第 1 层] 规则清洗 —— 纯机械去噪，不做任何语义/数字转换
// ---------------------------------------------------------------------------

/**
 * 纯规则去噪：把 Markdown 内容变成“没有噪音符号、但还没做口播改写”的文本。
 * 100% 可靠、零延迟、零成本。代码块/表格等结构性内容降级为简短播报标记，
 * 真正的“一句话概括 / 自然语言转述”由模型层负责。
 *
 * 边界：本函数只删 Markdown/URL/表格线这类“纯噪音”，不碰负号、百分号、小数、
 * 冒号等语义符号——符号的汉化与理解是模型层的职责（用户拍板，代码不做机械替换）。
 */
export function sanitizeForSpeech(raw: string): string {
  let text = String(raw ?? '')

  // 图片 ![alt](url) → （图片）
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '（图片）')
  // Markdown 链接 [text](url) → text（去掉链接壳，保留文字）
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 裸 URL → 「链接」（避免逐字母朗读）
  text = text.replace(/(?:https?:\/\/|www\.)[^\s<>"'“”，。；：、）】」』]*/g, '链接')

  // 围栏代码块 ```lang ... ``` 或 ~~~ ... ~~~ → 播报标记（保留换行，防止粘连）
  text = text.replace(/```[\s\S]*?```/g, '\n（代码块略）\n')
  text = text.replace(/~~~[\s\S]*?~~~/g, '\n（代码块略）\n')

  // 表格分隔行 |---|---| → 删除；再逐行把 | 单元转成顿号分隔的自然语句
  text = text.replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
  const tableLines = text
    .split('\n')
    .map(line => {
      if (!line.includes('|')) return line
      const cells = line
        .split('|')
        .map(cell => cell.trim())
        .filter(Boolean)
      return cells.length ? cells.join('，') : line
    })
    .join('\n')
  text = tableLines

  // 标题符 #/## → 去掉符号保留文字
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
  // 引用块 >
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  // 分割线（--- / *** 独立成行）→ 空行
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
  // 列表符号 - * + 1. → 去掉（内容保留，行间靠句读自然停顿）
  text = text.replace(/^[ \t]*(?:[-*+]|\d{1,3}[.、)])[ \t]+/gm, '')

  // 强调 / 粗体 / 删除线：先剥包装符，保留文字
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1')
  text = text.replace(/__([^_]+)__/g, '$1')
  text = text.replace(/\*([^*]+)\*/g, '$1')
  text = text.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?=$|[^A-Za-z0-9])/g, '$1$2')
  text = text.replace(/~~([^~]+)~~/g, '$1')

  // 行内代码 `foo` → 去掉反引号，保留短标识（命令/文件名念出来更有用）
  text = text.replace(/`([^`]+)`/g, '$1')

  // 残余 HTML 标签
  text = text.replace(/<[^>]+>/g, '')

  // emoji 与特殊符号
  text = text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}]/gu,
    '',
  )

  // 残余单个 Markdown 装饰符（# ` * _ ~）与连续空白规整
  text = text.replace(/[#*`_~^]/g, '')
  text = text.replace(/[ \t]+/g, ' ')

  // 空行压缩（最多保留一个空行 = 一个停顿）
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/^\n+|\s+$/g, '')

  return text
}

// ---------------------------------------------------------------------------
// [第 2 层] 智能触发判断
// ---------------------------------------------------------------------------

function hasFencedCodeBlock(raw: string): boolean {
  return /```|~~~/.test(raw)
}

function hasMarkdownTable(raw: string): boolean {
  // 表格分隔行 |---|---| 或一行内含两个以上竖线的行
  return /^[ \t]*\|?[ \t]*:?-{2,}[ \t]*\|/.test(raw) || /^[ \t]*\|[^|\n]*\|[ \t]*$/m.test(raw)
}

export function shouldTriggerModel(raw: string, triggers: SpeechPreprocessingTriggers): boolean {
  const source = String(raw ?? '')
  if (!source) return false
  if (triggers.codeBlock && hasFencedCodeBlock(source)) return true
  if (triggers.table && hasMarkdownTable(source)) return true
  const minChars =
    triggers && typeof triggers.minChars === 'number' && Number.isFinite(triggers.minChars) && triggers.minChars > 0
      ? Math.floor(triggers.minChars)
      : 300
  const contentLength = source.replace(/\s+/g, '').length
  return contentLength > minChars
}

// ---------------------------------------------------------------------------
// [第 3 层] 模型创作（唯一的理解 + 改写层，含超时 + 降级）
// ---------------------------------------------------------------------------

const MODEL_TIMEOUT_MAX_MS = 120_000
const DEFAULT_MODEL_TIMEOUT_MS = 15_000

interface CustomProviderEntry {
  name: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

async function loadCustomProvider(providerName: string): Promise<CustomProviderEntry | null> {
  try {
    const text = await readFile(getActiveConfigPath(), 'utf-8')
    const doc = YAML.load(text) as { custom_providers?: unknown } | null
    const list = Array.isArray(doc?.custom_providers) ? doc.custom_providers : []
    for (const item of list) {
      if (isRecord(item) && item.name === providerName) {
        return {
          name: providerName,
          baseUrl: typeof item.base_url === 'string' && item.base_url.trim() ? item.base_url.trim() : undefined,
          apiKey: typeof item.api_key === 'string' && item.api_key.trim() ? item.api_key.trim() : undefined,
          model: typeof item.model === 'string' && item.model.trim() ? item.model.trim() : undefined,
        }
      }
    }
  } catch {
    // config.yaml 读取失败 → 视为未配置，跳过模型层
  }
  return null
}

async function summarizeWithModel(raw: string, cfg: SpeechPreprocessingConfig, outerSignal?: AbortSignal): Promise<string | null> {
  const entry = await loadCustomProvider(cfg.provider)
  if (!entry?.baseUrl || !entry?.apiKey) {
    console.warn(`[speech-preprocess] provider "${cfg.provider}" not found in custom_providers, rule-layer only`)
    return null
  }

  const model = cfg.model || entry.model
  if (!model) {
    console.warn('[speech-preprocess] model not configured, rule-layer only')
    return null
  }

  const systemPrompt =
    cfg.mode === 'summary'
      ? cfg.promptSummary || DEFAULT_PROMPT_SUMMARY
      : cfg.promptFaithful || DEFAULT_PROMPT_FAITHFUL

  const endpoint = `${entry.baseUrl.replace(/\/+$/, '')}/chat/completions`

  // 智谱 glm-4.5-air / glm-4.5-flash 等默认走 CoT 推理（实测单次 14~40s，远超预算）。
  // 改写任务不需要推理，显式关闭 thinking，实测可降到 <1s。仅对智谱域名生效，避免污染其他 provider。
  const isZhipu = /open\.bigmodel\.cn/i.test(entry.baseUrl)
  const extraBody: Record<string, unknown> = isZhipu ? { thinking: { type: 'disabled' } } : {}

  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (outerSignal?.aborted) controller.abort()
  else outerSignal?.addEventListener('abort', onOuterAbort)
  const timeoutMs =
    typeof cfg.timeoutMs === 'number' && Number.isFinite(cfg.timeoutMs)
      ? Math.min(Math.max(Math.floor(cfg.timeoutMs), 1_000), MODEL_TIMEOUT_MAX_MS)
      : DEFAULT_MODEL_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${entry.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: raw },
        ],
        temperature: 0.2,
        max_tokens: cfg.mode === 'summary' ? 500 : 4096,
        stream: false,
        ...extraBody,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      console.warn(`[speech-preprocess] model returned HTTP ${res.status}, rule-layer only`)
      return null
    }

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    const rawModelText = typeof content === 'string' ? content.trim() : ''
    if (!rawModelText) return null
    // 只做 Markdown 去噪（模型偶尔残留 URL/符号壳），不做任何数字/符号语义转换——
    // 那属于模型的创作职责，代码层不越界。残留与否由日志 residual 字段观测。
    const text = sanitizeForSpeech(rawModelText)
    return text.length > 0 ? text : rawModelText
  } catch (error) {
    const timedOut = controller.signal.aborted
    console.warn(
      `[speech-preprocess] model call ${timedOut ? 'timed out' : 'failed'}, rule-layer only:`,
      error instanceof Error ? error.message : error,
    )
    return null
  } finally {
    clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
  }
}

// ---------------------------------------------------------------------------
// 预处理日志（NDJSON，按天轮转；含残留符号诊断，只观测不修改）
// ---------------------------------------------------------------------------

// 目的：把每次预处理的 原文 / 清洗文本 / 模型原始输出 / 最终输出 全量留痕，供事后针对性地
// 校准提示词。residual 字段标记输出中是否残留 -、%、: 符号——只做诊断不修改文本，
// 因为「符号是否该保留/如何表达」是模型的理解职责，代码层不替模型做决定。
// 位置：~/.hermes-web-ui/speech-preprocess-logs/YYYY-MM-DD.ndjson（每行一条 JSON）
// 铁律：日志写入失败只 console.warn，绝不抛错、绝不影响朗读主链路。

const SPEECH_LOG_DIR = join(homedir(), '.hermes-web-ui', 'speech-preprocess-logs')
const SPEECH_LOG_MAX_FIELD = 6_000 // 单文本字段超长截断，防文件无限膨胀

let speechLogDirReady: Promise<boolean> | null = null
function ensureSpeechLogDir(): Promise<boolean> {
  if (!speechLogDirReady) {
    speechLogDirReady = mkdir(SPEECH_LOG_DIR, { recursive: true })
      .then(() => true)
      .catch(err => {
        console.warn('[speech-preprocess] log dir create failed:', err instanceof Error ? err.message : err)
        return false
      })
  }
  return speechLogDirReady
}

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function clipField(value: string, max = SPEECH_LOG_MAX_FIELD): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…[truncated ${value.length}]`
}

/** 只读诊断：输出文本是否残留需要 TTS 自行理解的符号（不修改文本，供校准 prompt 用） */
function detectResidualSymbols(text: string): { minus: boolean; pct: boolean; colon: boolean } {
  return {
    minus: /(?:^|[^0-9A-Za-z])-(?=[0-9])/.test(text),
    pct: text.includes('%'),
    colon: /[0-9]\s*:[0-9]/.test(text),
  }
}

interface SpeechPreprocessLogEntry {
  ts: string
  profile: string
  mode: 'faithful' | 'summary'
  path: 'rule' | 'model' | 'model-fallback'
  trigger: { codeBlock: boolean; table: boolean; minChars: number; hit: boolean }
  chars: { input: number; cleaned: number; output: number }
  durationMs: number
  model?: { ok: boolean; ms: number; model: string }
  residual?: { minus: boolean; pct: boolean; colon: boolean }
  texts: { input: string; cleaned: string; modelOutput: string | null; output: string }
}

async function appendSpeechPreprocessLog(entry: SpeechPreprocessLogEntry): Promise<void> {
  try {
    if (!(await ensureSpeechLogDir())) return
    const file = join(SPEECH_LOG_DIR, `${localDate(new Date(entry.ts))}.ndjson`)
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8')
  } catch (err) {
    console.warn('[speech-preprocess] log append failed:', err instanceof Error ? err.message : err)
  }
}

// ---------------------------------------------------------------------------
// 编排入口
// ---------------------------------------------------------------------------

/**
 * 把原始文本预处理成适合朗读的口播文本。
 *
 * - 总开关关闭 / 未配置 → 原样返回（零回归）
 * - 规则层只做机械去噪；仅当触发条件命中且模型可用时才调用模型创作
 * - 模型成功 → 用模型成稿；失败/超时 → 降级规则层（保证声音照常出来，宁可不改也不产出劣质改写）
 * - 每次处理落一条 NDJSON 日志（不阻塞、静默失败）
 * - 任何异常都绝不让播放中断
 */
export async function prepareSpeechText(raw: string, outerSignal?: AbortSignal, profile = 'default'): Promise<string> {
  const trimmed = String(raw ?? '')
  if (!trimmed) return trimmed

  const startedAt = Date.now()

  try {
    const appConfig = await readAppConfig()
    const stored = appConfig.speechPreprocessing?.[profile]
    if (!stored || stored.enabled !== true) return trimmed

    const cfg = normalizeSpeechPreprocessingConfig(stored)
    const codeBlockHit = cfg.triggers.codeBlock && hasFencedCodeBlock(trimmed)
    const tableHit = cfg.triggers.table && hasMarkdownTable(trimmed)
    const triggerHit = shouldTriggerModel(trimmed, cfg.triggers)

    const cleaned = sanitizeForSpeech(trimmed) || trimmed
    let modelOutput: string | null = null
    let modelOk = false
    let modelMs = 0
    let path: 'rule' | 'model' | 'model-fallback' = 'rule'
    let output = cleaned

    if (triggerHit) {
      const modelStart = Date.now()
      modelOutput = await summarizeWithModel(trimmed, cfg, outerSignal)
      modelMs = Date.now() - modelStart
      if (modelOutput && modelOutput.length > 0) {
        modelOk = true
        path = 'model'
        output = modelOutput
      } else {
        path = 'model-fallback'
      }
    }

    const entry: SpeechPreprocessLogEntry = {
      ts: new Date().toISOString(),
      profile,
      mode: cfg.mode,
      path,
      trigger: { codeBlock: codeBlockHit, table: tableHit, minChars: cfg.triggers.minChars, hit: triggerHit },
      chars: { input: trimmed.length, cleaned: cleaned.length, output: output.length },
      durationMs: Date.now() - startedAt,
      model: triggerHit ? { ok: modelOk, ms: modelMs, model: cfg.model || '' } : undefined,
      residual: detectResidualSymbols(output),
      texts: {
        input: clipField(trimmed),
        cleaned: clipField(cleaned),
        modelOutput: modelOutput ? clipField(modelOutput) : null,
        output: clipField(output),
      },
    }
    void appendSpeechPreprocessLog(entry)

    return output
  } catch (error) {
    console.warn('[speech-preprocess] preprocessing failed, falling back to raw:', error instanceof Error ? error.message : error)
    return trimmed
  }
}

// ---------------------------------------------------------------------------
// 分段输出（纯 X 路线）：faithful 全文转述后按语义块切段，逐段交 TTS 渐进播放
// ---------------------------------------------------------------------------
export const SPEECH_SEGMENT_MARKER = '===SEG==='
/** 兜底切分上限：模型漏打分隔符时按此字符数硬切，避免单段过长再次超时 */
export const SPEECH_SEGMENT_FALLBACK_CHARS = 500

/** 按模型输出的 ===SEG=== 标记切段；模型没标记时按句子边界/字符数兜底 */
export function splitSpeechSegments(text: string): string[] {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []

  // 1) 优先按语义分隔符切（模型 faithful 输出带 ===SEG===）
  if (trimmed.includes(SPEECH_SEGMENT_MARKER)) {
    const segments = trimmed
      .split(SPEECH_SEGMENT_MARKER)
      .map(s => s.trim())
      .filter(s => s.length > 0)
    if (segments.length > 1) return segments
  }

  // 2) 兜底 A：按句子边界（。！？）切块，尽量保持语义完整
  const sentenceParts = trimmed.split(/(?<=[。！？；])\s*/).map(s => s.trim()).filter(s => s.length > 0)
  const chunks: string[] = []
  let buf = ''
  for (const part of sentenceParts) {
    if (buf && (buf + part).length > SPEECH_SEGMENT_FALLBACK_CHARS) {
      chunks.push(buf.trim())
      buf = part
    } else {
      buf = buf ? buf + part : part
    }
  }
  if (buf.trim()) chunks.push(buf.trim())
  if (chunks.length > 1) return chunks

  // 3) 兜底 B：单段超长时硬切（保底不超上限）
  if (trimmed.length > SPEECH_SEGMENT_FALLBACK_CHARS) {
    const hard: string[] = []
    for (let i = 0; i < trimmed.length; i += SPEECH_SEGMENT_FALLBACK_CHARS) {
      hard.push(trimmed.slice(i, i + SPEECH_SEGMENT_FALLBACK_CHARS).trim())
    }
    return hard.filter(s => s.length > 0)
  }

  return [trimmed]
}
