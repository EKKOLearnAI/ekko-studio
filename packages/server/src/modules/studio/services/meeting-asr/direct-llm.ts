import { getWebUiHome } from '../../public/config'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../../public/logging'
import { getProfileDir } from '../../public/profile-config'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile } from '../../public/profile-config'
import { getCompatibleCustomProviders, type NormalizedCustomProvider } from '../../contracts/provider-compat'
import type { SceneTemplate } from './scene-templates'
import { REPORT_TITLE_INSTRUCTION } from './scene-templates'
import { prepareAnalysisSkillSection } from './skill-resolver'
import { parseAnalysisRound, type AnalysisRound, type SpeechContext } from './report-parser'

/**
 * 服务端累积的演讲评价摘要：跨批次保留，注入后续提示词，供 AI 判断是否出现新的评价点。
 * 由 realtime-assist 的 accumulateSpeechSummary 维护（源自 org 演讲功能增量评价模式）。
 */
export interface SpeechSummary {
  highlights: string[]
  improvements: string[]
  topics: string[]
  score?: Record<string, number>
}

/**
 * Direct LLM 路径（拆分自 realtime-assist.ts，行为保持一致）。
 *
 * 不经过 Hermes Agent、直接调用 OpenAI 兼容端点的所有请求都在这里：
 * 实时批次的快速分析（~3s 主路径）与报告生成的流式 fallback。
 * fetch 与 LLM 配置读取都可注入，便于单测。
 */

export interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface DirectLLMDeps {
  /** 注入 fetch 实现（单测用）；默认全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 注入 LLM 配置读取（单测用）；默认读 dataDir/config.json。 */
  loadConfig?: () => Promise<LLMConfig | null>
}

/** 墙钟毫秒 → HH:mm:ss（环节时间线展示用）。 */
function fmtClock(ms: number): string {
  if (!Number.isFinite(ms)) return '??:??:??'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 读取 meeting-asr 持久化目录里的 LLM 配置（config.json）。
 *
 * 路径解析与 MeetingASRService.getDataDir() 保持一致（而不是只 mirror 它的
 * cwd fallback）：设备端 deploy 会通过 MEETING_ASR_DATA_DIR 指到
 * /var/lib/hermes-web-ui/meeting-asr，若这里只读 <cwd>/data/meeting-asr，
 * 服务跑在 /opt/hermes-web-ui/src 下就会读不到 config.json（那下面只有
 * .venv），导致实时分析一直报 "LLM config not available"。
 */
export async function loadLLMConfig(dataDir?: string): Promise<LLMConfig | null> {
  const dir = dataDir
    || process.env.MEETING_ASR_DATA_DIR?.trim()
    || path.join(getWebUiHome(), 'meeting-asr')
  const configFile = path.join(dir, 'config.json')

  try {
    const content = await fs.readFile(configFile, 'utf-8')
    const stored = JSON.parse(content)

    const apiKey = stored?.llm?.api_key || stored?.asr?.dashscope_api_key
    if (!apiKey) return null

    return {
      apiKey,
      baseUrl: stored?.llm?.base_url || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: stored?.llm?.model || 'qwen-plus',
    }
  } catch {
    return null
  }
}

async function resolveConfig(deps?: DirectLLMDeps): Promise<LLMConfig | null> {
  if (deps?.loadConfig) return deps.loadConfig()
  return loadLLMConfig()
}

/**
 * Resolve a profile's default model + provider credentials (baseUrl + apiKey).
 *
 * Used as a fallback when `meeting-asr/config.json` has no `llm.api_key` but
 * the profile's `config.yaml` does have a usable provider. Returns null when
 * the profile doesn't expose a direct LLM endpoint (custom_providers entry
 * missing base_url / api_key / key_env), letting the caller decide whether
 * to fall through to the Hermes Agent bridge.
 */
export async function resolveProfileLLMConfig(profile: string, requestedModel?: string): Promise<LLMConfig | null> {
  if (!profile || !profile.trim()) return null
  let config: any = null
  try {
    config = await readConfigYamlForProfile(profile)
  } catch (err) {
    logger.warn('[direct-llm] failed to read profile config for %s: %s', profile, (err as Error)?.message || err)
    return null
  }
  if (!config || typeof config !== 'object') return null

  // 1. Resolve the model name: explicit request → profile default.
  const modelSection = config.model
  const defaultModel = typeof modelSection === 'string'
    ? modelSection.trim()
    : String(modelSection?.default || '').trim()
  const model = (requestedModel && requestedModel.trim()) || defaultModel
  if (!model) return null

  // 2. Resolve the provider name from model.provider if set.
  const modelProviderName = typeof modelSection === 'object'
    ? String(modelSection?.provider || '').trim()
    : ''

  // 3a. Custom providers in config.yaml take precedence (the user may have
  //     intentionally shadowed a built-in name like `anthropic` with their own
  //     baseUrl + apiKey).
  const providers = getCompatibleCustomProviders(config)
  const provider = pickProvider(providers, modelProviderName, model)
  if (provider) {
    let apiKey = (provider.api_key || '').trim()
    if (!apiKey && provider.key_env) {
      apiKey = await readEnvVarForProfile(profile, provider.key_env)
    }
    if (!apiKey) {
      logger.warn('[direct-llm] profile %s provider %s has no api_key / key_env', profile, provider.name)
      return null
    }
    return {
      apiKey,
      baseUrl: provider.base_url.replace(/\/+$/, ''),
      model,
    }
  }

  // 3b. Built-in provider (minimax-cn, deepseek, alibaba, …): credentials live
  //     in `~/.hermes/profiles/<name>/.env` keyed by `api_key_env` /
  //     `base_url_env` in `PROVIDER_ENV_MAP`. Use the preset base URL when env
  //     doesn't set one. Only used when the profile doesn't already override
  //     the provider with a custom_providers entry.
  if (modelProviderName) {
    const builtin = await resolveBuiltinProviderConfig(profile, modelProviderName)
    if (builtin) return { apiKey: builtin.apiKey, baseUrl: builtin.baseUrl, model }
  }

  logger.warn('[direct-llm] profile %s has no provider matching name=%s model=%s; %d custom_providers available', profile, modelProviderName || '(none)', model, providers.length)
  return null
}

/**
 * Resolve credentials for a built-in provider (e.g. minimax-cn, deepseek,
 * alibaba). Reads `api_key_env` from the profile's `.env`, falls back to
 * `process.env`. Base URL comes from `base_url_env` if set, otherwise from
 * the built-in preset catalog.
 *
 * Returns null when the provider is not a known built-in or has no usable key
 * — letting the caller fall through to bridge / custom_providers.
 */
async function resolveBuiltinProviderConfig(profile: string, providerName: string): Promise<{ apiKey: string; baseUrl: string } | null> {
  const envMap = PROVIDER_ENV_MAP[providerName]
  if (!envMap) {
    logger.warn('[direct-llm] builtin lookup for %s: PROVIDER_ENV_MAP has no entry', providerName)
    return null
  }
  const apiKeyEnv = envMap.api_key_env
  const baseUrlEnv = envMap.base_url_env
  if (!apiKeyEnv && !baseUrlEnv) return null  // OAuth-only providers (e.g. minimax-oauth) — no direct path

  // Ensure catalog is loaded once before the api_mode / baseUrl lookups.
  await loadBuiltinProviderCatalog()

  // Direct path uses /chat/completions. Built-in providers with a different
  // API mode (e.g. anthropic_messages for minimax-cn) would 404 here, so
  // let the caller fall through to the Hermes Agent bridge.
  if (!isBuiltinProviderChatCompletions(providerName)) {
    logger.warn('[direct-llm] builtin %s is not chat_completions (anthropic_messages); deferring to bridge', providerName)
    return null
  }

  let apiKey = apiKeyEnv ? await readEnvVarForProfile(profile, apiKeyEnv) : ''
  if (!apiKey && apiKeyEnv && process.env[apiKeyEnv]) apiKey = process.env[apiKeyEnv] || ''
  if (!apiKey) {
    logger.warn('[direct-llm] builtin %s: no api_key found in profile .env or process.env', providerName)
    return null
  }

  let baseUrl = baseUrlEnv ? await readEnvVarForProfile(profile, baseUrlEnv) : ''
  if (!baseUrl && baseUrlEnv && process.env[baseUrlEnv]) baseUrl = process.env[baseUrlEnv] || ''
  if (!baseUrl) baseUrl = builtinProviderBaseUrl(providerName)
  if (!baseUrl) {
    logger.warn('[direct-llm] builtin %s: no base_url (env=%s, preset=%s)', providerName, baseUrlEnv || '(none)', builtinProviderBaseUrl(providerName) || '(none)')
    return null
  }

  return { apiKey: apiKey.trim(), baseUrl: baseUrl.replace(/\/+$/, '') }
}

let builtinApiModeCache: Map<string, string> | null = null
let builtinBaseUrlCache: Map<string, string> | null = null
let builtinCatalogPromise: Promise<void> | null = null

async function loadBuiltinProviderCatalog(): Promise<void> {
  if (builtinApiModeCache && builtinBaseUrlCache) return
  try {
    const mod = await import('../../contracts/providers') as { PROVIDER_PRESETS?: Array<{ value: string; base_url?: string; builtin?: boolean; api_mode?: string }> }
    builtinApiModeCache = new Map()
    builtinBaseUrlCache = new Map()
    for (const p of mod.PROVIDER_PRESETS || []) {
      if (p.builtin && p.value) {
        builtinApiModeCache.set(p.value, p.api_mode || 'chat_completions')
        if (p.base_url) builtinBaseUrlCache.set(p.value, p.base_url)
      }
    }
  } catch (err) {
    logger.warn('[direct-llm] failed to load builtin provider presets: %s', (err as Error)?.message || err)
  }
}

/** Test-only: clear the cached builtin catalog so subsequent calls re-read PROVIDER_PRESETS. */
export function _resetBuiltinProviderCatalogForTests(): void {
  builtinApiModeCache = null
  builtinBaseUrlCache = null
  builtinCatalogPromise = null
}

function isBuiltinProviderChatCompletions(providerName: string): boolean {
  // Providers without an entry default to chat_completions (legacy behaviour).
  if (!builtinApiModeCache) return true
  return (builtinApiModeCache.get(providerName) || 'chat_completions') === 'chat_completions'
}

function builtinProviderBaseUrl(providerName: string): string {
  return builtinBaseUrlCache?.get(providerName) || ''
}

function pickProvider(
  providers: NormalizedCustomProvider[],
  preferredName: string,
  model: string,
): NormalizedCustomProvider | null {
  if (!providers.length) return null
  const want = preferredName.toLowerCase()
  // 1. Explicit match by name / provider_key.
  if (want) {
    const match = providers.find(p => (p.name || '').toLowerCase() === want || (p.provider_key || '').toLowerCase() === want)
    if (match) return match
  }
  // 2. Provider whose `model` matches the requested model id exactly.
  if (model) {
    const match = providers.find(p => (p.model || '').trim() === model)
    if (match) return match
  }
  // 3. No match — don't fall through to an unrelated provider (its baseUrl /
  //    api_key would be wrong). Caller will fall back to the bridge path.
  return null
}

/**
 * Look up an env var in the profile's `.env` file (KEY=VALUE per line). The
 * file is the same one Hermes Agent reads; values may be quoted or unquoted.
 */
async function readEnvVarForProfile(profile: string, key: string): Promise<string> {
  if (!key) return ''
  const envPath = path.join(getProfileDir(profile), '.env')
  try {
    const text = await fs.readFile(envPath, 'utf-8')
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!m || m[1] !== key) continue
        const raw = m[2]
        // Strip wrapping quotes.
        const stripped = raw.replace(/^["'](.*)["']$/, '$1').trim()
        if (stripped) return stripped
    }
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code !== 'ENOENT') {
      logger.warn('[direct-llm] failed to read %s: %s', envPath, (err as Error)?.message || err)
    }
  }
  return ''
}

/**
 * 回退路径：直接调用 LLM API 进行实时分析（不经过 Agent）。
 */
export async function analyzeViaDirectLLM(
  transcriptText: string,
  template: SceneTemplate,
  profile: string,
  speechContext?: SpeechContext | null,
  speechSummary?: SpeechSummary,
  deps?: DirectLLMDeps,
): Promise<AnalysisRound | null> {
  const config = await resolveConfig(deps)
  if (!config) {
    logger.warn('[meeting-assist] LLM config not available, skipping analysis')
    return null
  }

  // 动态加载 profile 下的会议分析技能并追加到 system prompt。
  // 演讲评分场景使用自成一体的专业提示词（3+1 反馈 / 金句定义 / 赘语阈值 / 说人话鼓励式点评等），
  // 不追加通用会议分析技能，避免其通用方法论稀释演讲点评风格。
  const skillSection = template.id === 'speech' ? '' : await prepareAnalysisSkillSection(profile, template.id)
  let systemPrompt = skillSection
    ? `${template.systemPrompt}\n\n${skillSection}`
    : template.systemPrompt

  // 演讲评分场景：把计时记录/每日一词/当前倒计时/已累积评价注入提示词。
  if (template.id === 'speech') {
    const lines: string[] = ['', '【当前演讲评估上下文（请据此点评与评分）】']
    if (speechContext) {
      const ctx = speechContext
      if (ctx.wordOfTheDay) lines.push(`- 每日一词：${ctx.wordOfTheDay}`)
      if (ctx.timerDurationSec) {
        lines.push(`- 计时设置：单环节标准时长 ${ctx.timerDurationSec} 秒；黄牌触发剩余 ${ctx.yellowAtSec ?? 30} 秒；红牌触发剩余 ${ctx.redAtSec ?? 10} 秒`)
      }
      if (ctx.currentRemainingSec != null) {
        lines.push(`- 当前倒计时：剩余 ${Math.round(ctx.currentRemainingSec)} 秒（${ctx.currentPhase || 'green'}）`)
      }
      if (ctx.timerRecords && ctx.timerRecords.length > 0) {
        lines.push('- 已记录环节用时：')
        for (const r of ctx.timerRecords) {
          const overtime = r.overtimeSec > 0 ? `（超时 ${r.overtimeSec} 秒）` : ''
          lines.push(`  - ${r.label}：${r.durationSec} 秒${overtime}`)
        }
      }
      if (ctx.speakerTimeline && ctx.speakerTimeline.length > 0) {
        lines.push('- 环节与发言人时间线（计时员人工登记，转写中的 [姓名] 已按此标注）：')
        for (const e of ctx.speakerTimeline) {
          const name = e.segment ? `${e.segment}/${e.speaker}` : e.speaker
          lines.push(`  - ${name}：${fmtClock(e.startMs)} - ${fmtClock(e.endMs)}`)
        }
        lines.push('- 赘语/金句/语法问题的 speaker 字段必须使用时间线中的演讲者姓名（禁止输出"说话人1"这类编号），分析点评也直接称呼姓名。')
      } else {
        // 无时间线且转写无 [姓名] 标注时明确禁止编造：LLM 在无归属信息的转写上
        // 会自行虚构姓名（如"张三"），误导用户以为系统真的识别到了演讲者。
        lines.push('- 本次未提供演讲者时间线，转写也没有 [姓名] 标注：speaker 字段一律留空字符串，禁止编造或猜测任何姓名（如"张三""发言人"）。')
      }
    }
    if (speechSummary) {
      if (speechSummary.highlights.length > 0) {
        lines.push(`- 已累积亮点：${speechSummary.highlights.join('；')}`)
      }
      if (speechSummary.improvements.length > 0) {
        lines.push(`- 已累积改进点：${speechSummary.improvements.join('；')}`)
      }
      if (speechSummary.topics.length > 0) {
        lines.push(`- 已出现主题：${speechSummary.topics.join('；')}`)
      }
      if (speechSummary.score && Object.keys(speechSummary.score).length > 0) {
        lines.push(`- 当前评分：${JSON.stringify(speechSummary.score)}`)
      }
    }
    // 用户手动记录（语法官/肢体语言观察）：AI 点评必须结合这些人工观察
    const mn = speechContext?.manualNotes
    if (mn?.goodPhrases?.length) {
      lines.push(`- 手动记录金句：${mn.goodPhrases.join('；')}（点评时呼应这些被标记的句子）`)
    }
    if (mn?.grammarNotes?.length) {
      lines.push(`- 手动语法/用词记录：${mn.grammarNotes.join('；')}（核实后可纳入 grammarIssues）`)
    }
    if (mn?.bodyNotes?.length) {
      lines.push(`- 肢体语言观察（人工记录，你看不到画面，务必结合）：${mn.bodyNotes.join('；')}`)
    }
    systemPrompt = `${systemPrompt}\n${lines.join('\n')}`
  }

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `以下是最近的对话内容：\n\n${transcriptText}` },
    ],
    temperature: 0.3,
    // 演讲评分场景需要输出评分表/赘语/语法等多字段 JSON，给更大输出空间。
    max_tokens: template.id === 'speech' ? 1200 : 800,
  }

  const doFetch = deps?.fetchImpl ?? fetch
  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`)
  }

  const data = await response.json() as any
  const content = data?.choices?.[0]?.message?.content || '{}'

  // H1 赘语阈值：实际发言时长 = 设置时长 - 当前倒计时（缺省不启用阈值过滤）
  let speechDurationSec: number | undefined
  if (template.id === 'speech' && speechContext) {
    const { timerDurationSec, currentRemainingSec } = speechContext
    if (typeof timerDurationSec === 'number' && typeof currentRemainingSec === 'number') {
      const elapsed = timerDurationSec - currentRemainingSec
      if (elapsed > 0) speechDurationSec = elapsed
    }
  }

  return parseAnalysisRound(content, { speechDurationSec })
}

/**
 * 回退路径：直接调用 LLM API 生成报告（不经过 Hermes Agent）。
 * 保留 profile 下会议分析技能的动态注入。
 */
export async function* streamDirectLLMReport(
  transcript: string,
  template: SceneTemplate,
  profile: string,
  deps?: DirectLLMDeps,
): AsyncGenerator<string> {
  const config = await resolveConfig(deps)
  if (!config) throw new Error('LLM config not available')

  // 动态加载 profile 下的会议分析技能并追加到报告 system prompt。
  // 演讲评分场景不追加通用会议分析技能：报告要求是公众号风格、不是正式文档，
  // 通用技能的会议纪要式结构会稀释该风格（见 analyzeViaDirectLLM 同款注释）。
  const skillSection = template.id === 'speech' ? '' : await prepareAnalysisSkillSection(profile, template.id)
  const reportPrompt = skillSection
    ? `${template.reportPrompt}\n\n${skillSection}\n\n${REPORT_TITLE_INSTRUCTION}`
    : `${template.reportPrompt}\n\n${REPORT_TITLE_INSTRUCTION}`

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: reportPrompt },
      { role: 'user', content: `以下是完整的会议转写内容：\n\n${transcript}` },
    ],
    temperature: 0.4,
    max_tokens: 4000,
    stream: true,
  }

  const doFetch = deps?.fetchImpl ?? fetch
  const response = await doFetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`LLM API error ${response.status}: ${text.slice(0, 200)}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let yieldedAny = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      // 流结束时把 buffer 里剩余的最后一行（可能是不带换行的最后一条 data:）flush 出去。
      // 否则最后一段 chunk 会留在 buffer 里永远不到前端。
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trim()
          if (payload && payload !== '[DONE]') {
            try {
              const chunk = JSON.parse(payload)
              // provider 也可能把错误放在流里（{error: {...}}），这种帧必须立即抛错
              // 让外层 fallback / 上层 catch 处理，否则会被静默忽略。
              if (chunk?.error) {
                throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error)))
              }
              const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
              if (delta) {
                yieldedAny = true
                yield delta
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                console.warn('[report-stream] 无法解析的 SSE 块:', payload.slice(0, 200))
              } else {
                throw err
              }
            }
          }
        }
      }
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      // 兼容 "data: {...}" 和 "data:{...}" 两种格式
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      try {
        const chunk = JSON.parse(payload)
        // provider 也可能把错误放在流里（{error: {...}}），这种帧必须立即抛错
        // 让外层 fallback / 上层 catch 处理，否则会被静默忽略。
        if (chunk?.error) {
          throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error)))
        }
        // 标准 OpenAI 流式：delta.content；部分端点：message.content
        const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
        if (delta) {
          yieldedAny = true
          yield delta
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          console.warn('[report-stream] 无法解析的 SSE 块:', payload.slice(0, 200))
        } else {
          throw err
        }
      }
    }
  }

  // 流式未产出任何内容时，回退到非流式调用（与分析接口相同的可靠路径）
  if (!yieldedAny) {
    console.warn('[report-stream] 流式响应为空，回退到非流式调用')
    const fallbackBody = { ...body, stream: false }
    const fallbackRes = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(fallbackBody),
    })
    if (!fallbackRes.ok) {
      const text = await fallbackRes.text().catch(() => '')
      throw new Error(`LLM API error ${fallbackRes.status}: ${text.slice(0, 200)}`)
    }
    const data = await fallbackRes.json() as any
    const content = data?.choices?.[0]?.message?.content
    if (content) yield content
  }
}

/**
 * 清洗 LLM 返回的标题候选：只取第一行，去掉误带的 markdown 标记、"标题："前缀与
 * 各类包裹/结尾标点；空或过长（>40 字）视为不可用。
 */
export function cleanMeetingTitle(raw: unknown): string | null {
  const text = String(raw ?? '').split(/\r?\n/)[0].trim()
  if (!text) return null
  const cleaned = text
    .replace(/^[#*>\s]+/, '') // 去掉可能误带的 markdown 标记
    .replace(/^标题[:：]?/, '') // 去掉"标题："
    .replace(/^[「『“‘"《〈(（]+/, '') // 去掉前导包裹符
    .replace(/[」』”’"》〉)）]+$/, '') // 去掉尾部包裹符
    .replace(/[。．.!！?？]+$/, '') // 去掉结尾标点
    .trim()
  if (!cleaned) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40) : cleaned
}

/**
 * 为一场会议生成一个简短标题（首次 AI 分析完成时，基于当前已有转写轻量取名）。
 * 直调 OpenAI 兼容端点（与分析/报告同款配置：meeting-asr 数据目录 config.json）。
 * 任一步失败都静默返回 null（不影响主流程），由后续最终报告标题兜底。
 */
export async function generateMeetingTitle(
  transcript: string,
  deps?: DirectLLMDeps,
): Promise<string | null> {
  const text = (transcript || '').trim()
  if (!text) return null
  const config = await resolveConfig(deps)
  if (!config) return null

  // 控制请求体大小：转写过长时只取开头与结尾，中间省略。
  const MAX = 6000
  const excerpt = text.length > MAX
    ? `${text.slice(0, Math.floor(MAX / 2))}\n…（中间内容省略）…\n${text.slice(-Math.floor(MAX / 2))}`
    : text

  const system = [
    '你是会议命名助手。请根据会议转写内容，为这场会议拟定一个简短、贴切、能概括主题的中文标题。',
    '要求：',
    '1. 只输出标题本身，长度 5~20 字，不要任何解释或多余文字。',
    '2. 不要输出引号、书名号、括号、冒号、“标题：”前缀、句号等标点。',
    '3. 标题应具体（如“Q3 供应商合同条款评审”），不要用“会议纪要/会议记录/会议总结/会议分析”这类泛化词。',
  ].join('\n')

  const doFetch = deps?.fetchImpl ?? fetch
  try {
    const response = await doFetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `会议转写内容：\n\n${excerpt}` },
        ],
        temperature: 0.3,
        max_tokens: 64,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      logger.warn('[meeting-assist] title LLM request failed: %s %s', response.status, body.slice(0, 200))
      return null
    }
    const data = await response.json() as any
    const content = data?.choices?.[0]?.message?.content
    return cleanMeetingTitle(content)
  } catch (err) {
    logger.warn('[meeting-assist] title generation failed: %s', err instanceof Error ? err.message : String(err))
    return null
  }
}
