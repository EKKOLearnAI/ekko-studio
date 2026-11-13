import { getWebUiHome } from '../public/config'
import path from 'path'
import { logger } from '../public/logging'
import { readStoredDashScopeKey } from './meeting-asr/dashscope-key-store'

/**
 * 口语对练「AI 全模态深度分析」服务。
 *
 * 会话结束后客户端把练习期间录制的用户发言音频（16 kHz mono WAV base64）、
 * 摄像头画面帧（JPEG data URL）与完整转写 / 逐轮评分一起 POST 上来，本服务
 * 把它们组合成一次 DashScope Qwen3.5-Omni（HTTP 全模态）请求，让模型真正
 * 「听录音、看画面」后生成一段 Markdown 深度分析，追加到确定性报告末尾。
 *
 * 调用形态（依据百炼官方文档 help.aliyun.com/zh/model-studio/qwen-omni）：
 *   - 仅支持 OpenAI 兼容端点
 *     `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`
 *     （中国大陆账号；国际区 dashscope-intl 的 key 与大陆不互通）；
 *   - Qwen-Omni 请求必须 `stream: true`（SSE），文本输出用
 *     `modalities: ["text"]`；
 *   - 音频 content part：`{type:"input_audio", input_audio:{data:"data:;base64,<b64>", format:"wav"}}`；
 *   - 图片 content part：`{type:"image_url", image_url:{url:"data:image/jpeg;base64,…"}}`；
 *   - 文本 + 多段音频 + 多张图片可以在同一条 user 消息里任意组合
 *     （Qwen3.5-Omni 系列；单次 base64 音频 < 10 MB、总时长 ≤ 3h）。
 *
 * Key 解析与 meeting-asr 保持一致：优先用请求方提供的 apiKey（对练舞台持有
 * DashScope key），否则读 meeting-asr 持久化目录（config.json / config.env）。
 * 目录解析镜像 MeetingASRService.getDataDir() 的 env → cwd/data/meeting-asr
 * 顺序（该目录由部署脚本显式设置 MEETING_ASR_DATA_DIR）。
 */

export const OMNI_ANALYSIS_DEFAULT_MODEL = 'qwen3.5-omni-flash'
export const OMNI_ANALYSIS_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
/** 服务端防御性上限（客户端已先行裁剪；这里做最终防线）。 */
export const OMNI_AUDIO_SEGMENT_MAX = 12
export const OMNI_AUDIO_SEGMENT_MAX_CHARS = 1_000_000
export const OMNI_AUDIO_TOTAL_MAX_CHARS = 11_000_000
export const OMNI_FRAMES_MAX = 6
export const OMNI_TURNS_MAX = 100
const OMNI_ANALYSIS_TIMEOUT_MS = 120_000

export interface OmniPracticeTurnInput {
  role: 'user' | 'assistant'
  text: string
}

export interface OmniPracticeFeedbackInput {
  round: number
  overall: number
  fluency?: number | null
  pronunciation?: number | null
  grammar?: number | null
  vocabulary?: number | null
  content?: number | null
  bodyLanguage?: number | null
  comment?: string
  strengths?: string
  improvements?: string
  example?: string
}

export interface OmniPracticeAudioInput {
  /** 用户轮次序号（1 起），用于在提示词里标注录音归属。 */
  index: number
  text: string
  /** WAV base64（不含 data: 前缀）。 */
  wavBase64: string
}

export interface OmniPracticeAnalysisInput {
  config: {
    language?: string
    direction?: string
    difficulty?: string
    durationMinutes?: number
    /** 练习技能上下文（下载技能时携带），供模型按技能标准评审。 */
    skill?: {
      name?: string
      displayName?: string
      description?: string
      criteria?: string
      instructions?: string
      background?: string
    }
  }
  turns: OmniPracticeTurnInput[]
  feedback: OmniPracticeFeedbackInput[]
  audioSegments: OmniPracticeAudioInput[]
  /** data:image/jpeg;base64,…（保持练习中发送给实时模型的同款镜像画面）。 */
  frames: string[]
  /** 请求方提供的 DashScope key（优先）；缺省时读 meeting-asr 存储。 */
  apiKey?: string
  model?: string
  baseUrl?: string
}

function languageLabel(value: string | undefined): string {
  const map: Record<string, string> = { zh: '中文', en: '英语', ja: '日语', ko: '韩语' }
  return (value && map[value]) || value || '未指定'
}

function difficultyLabel(value: string | undefined): string {
  const map: Record<string, string> = { beginner: '入门', intermediate: '进阶', advanced: '高级' }
  return (value && map[value]) || value || '未指定'
}

function cleanText(value: string | undefined | null, max: number): string {
  return (value || '').trim().slice(0, max)
}

/**
 * 组装发给 Omni 模型的提示词正文（中文；出口文件标题按 speech-export 先例
 * 硬编码中文）。转写与逐轮评分来自确定性报告同源数据。
 */
export function buildOmniAnalysisPrompt(input: OmniPracticeAnalysisInput): string {
  const cfg = input.config || {}
  const languageName = languageLabel(cfg.language)
  const direction = cleanText(cfg.direction, 200)
  const durationMinutes = Number(cfg.durationMinutes) || 0

  const lines: string[] = []
  lines.push(`## 练习信息`)
  lines.push(`- 语言：${languageName}｜难度：${difficultyLabel(cfg.difficulty)}${durationMinutes > 0 ? `｜定时 ${durationMinutes} 分钟` : ''}`)
  lines.push(`- 方向：${direction || '自由对话'}`)

  // 技能上下文（下载技能时）：显示名/简介 + 评分标准（criteria）+ 技能背景
  const skillInfo = cfg.skill
  if (skillInfo?.displayName || skillInfo?.name) {
    lines.push(`- 练习技能：${skillInfo.displayName || skillInfo.name}${skillInfo.description ? `｜${cleanText(skillInfo.description, 200)}` : ''}`)
  }
  if (skillInfo?.criteria) {
    lines.push('', '## 练习技能（评分标准）', '', cleanText(skillInfo.criteria, 4000))
  }
  if (skillInfo?.background) {
    lines.push('', '## 技能背景', '', cleanText(skillInfo.background, 1500))
  }

  const turns = (input.turns || []).slice(0, OMNI_TURNS_MAX)
  if (turns.length > 0) {
    lines.push('', '## 对话转写')
    let userIdx = 0
    for (const turn of turns) {
      const text = cleanText(turn.text, 2000)
      if (!text) continue
      if (turn.role === 'user') {
        userIdx += 1
        lines.push(`[${userIdx}] 用户：${text}`)
      } else {
        lines.push(`教练：${text}`)
      }
    }
  }

  const feedback = (input.feedback || []).slice(0, 60)
  if (feedback.length > 0) {
    lines.push('', '## 会话中的逐轮评分（模型实时给出，供参考）')
    for (const f of feedback) {
      // 技能可自定义维度：数值字段按「维度 id 数值」通用打印（评分标准段里有
      // id↔显示名对照），不绑定语言学习的固定五维。
      const dims: string[] = []
      for (const [key, value] of Object.entries(f)) {
        if (key === 'round' || key === 'overall' || key === 'comment'
          || key === 'strengths' || key === 'improvements' || key === 'example') continue
        if (typeof value === 'number' && Number.isFinite(value)) dims.push(`${key} ${value}`)
      }
      const comment = cleanText(f.comment, 300)
      const strengths = cleanText(f.strengths, 200)
      const improvements = cleanText(f.improvements, 200)
      lines.push(
        `- 第 ${f.round > 0 ? f.round : '—'} 轮：总分 ${typeof f.overall === 'number' ? f.overall : '—'}`
        + (dims.length > 0 ? `（${dims.join('｜')}）` : '')
        + (comment ? `｜点评：${comment}` : '')
        + (strengths ? `｜亮点：${strengths}` : '')
        + (improvements ? `｜可提升：${improvements}` : ''),
      )
    }
  }

  const audioCount = (input.audioSegments || []).length
  const frameCount = (input.frames || []).filter(Boolean).length

  return [
    '你是一名资深的多语言口语教练与发音评审专家。下面是一次完整的「口语对练」材料，请据此产出一段「AI 全模态深度分析」。',
    '',
    '## 你将收到的素材',
    `- 转写文本与逐轮评分（见下方）；`,
    `- ${audioCount > 0 ? `${audioCount} 段用户发言录音（WAV，按轮次顺序排列，可能夹带少量环境声 / 扬声器回声，请聚焦人声本身）` : '没有提供用户录音'}`,
    `- ${frameCount > 0 ? `${frameCount} 张练习过程画面（摄像头 1fps 抽样，用于观察仪态与镜头感）` : '没有提供画面（摄像头未开启）'}`,
    '',
    '## 输出要求',
    '输出一段 Markdown，作为分析报告新增章节，**必须以这一行开头**（不要代码块包裹、不要输出其它解释）：',
    '',
    '## 四、AI 全模态深度分析（基于录音与画面的评审）',
    '',
    '正文结构（都用中文撰写；引用目标语言的词句除外）：',
    '1. **语音表现**：逐段点评你从录音里听到的发音清晰度、语调自然度、流利度、语速与停顿。给出发音 / 语调层面的具体问题与示范（例如某个音、某个词怎么发更好）；没有录音时跳过并说明。',
    '2. **表达与内容**：结合转写点评词汇、语法、内容逻辑与对练习方向的完成度，并对照会话中的逐轮评分指出一致或不一致之处。',
    '3. **肢体语言与镜头感**：仅在提供了画面时写；观察仪态、眼神、手势、动作稳定性，给出具体建议；没有画面时整节省略。',
    '4. **整场总结与下阶段建议**：2-3 条可执行建议，附一个推荐的下一次练习任务。',
    '',
    '硬性要求：不逐字复述转写；不编造录音或画面里不存在的信息；若某段录音过短 / 无法听清，如实说明并基于文本分析。',
    ...(skillInfo?.instructions
      ? [`- 技能专属评审要求：${cleanText(skillInfo.instructions, 1000)}`, '']
      : []),
    '',
    ...lines,
  ].join('\n')
}

/**
 * 组装 DashScope 兼容端点请求。导出便于单测（注入 fetch）。
 * @param text 提示词正文（buildOmniAnalysisPrompt 的产物）
 * @param parts content 数组里文本之外的媒体 parts
 */
export function buildOmniAnalysisRequestBody(input: OmniPracticeAnalysisInput, text: string) {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
  for (const seg of (input.audioSegments || [])) {
    const data = String(seg.wavBase64 || '')
    if (!data) continue
    content.push({
      type: 'input_audio',
      input_audio: { data: `data:;base64,${data}`, format: 'wav' },
    })
  }
  for (const frame of (input.frames || [])) {
    const url = String(frame || '').trim()
    if (!url || !/^data:image\/(?:jpeg|png|webp);base64,/i.test(url)) continue
    content.push({ type: 'image_url', image_url: { url } })
  }
  return {
    model: input.model || OMNI_ANALYSIS_DEFAULT_MODEL,
    messages: [{ role: 'user', content }],
    stream: true,
    stream_options: { include_usage: true },
    modalities: ['text'],
    max_tokens: 2048,
  }
}

/** 解析 meeting-asr 持久化目录（镜像 MeetingASRService.getDataDir() 的 env → cwd 顺序）。 */
function meetingAsrDataDir(): string {
  return process.env.MEETING_ASR_DATA_DIR || path.join(getWebUiHome(), 'meeting-asr')
}

export async function resolveDashScopeKey(provided?: string): Promise<string | null> {
  if (provided && provided.trim()) return provided.trim()
  const stored = await readStoredDashScopeKey(meetingAsrDataDir()).catch(() => null)
  if (stored) return stored
  const env = process.env.DASHSCOPE_API_KEY
  return env && env.trim() ? env.trim() : null
}

/** 校验并裁剪输入；返回裁剪后的副本。单段超限抛错（由 controller 转 413），
 *  总时长超预算时丢弃最旧的段（评分看重整体观感，丢开头不丢结尾）。 */
export function validateOmniAnalysisInput(input: OmniPracticeAnalysisInput): OmniPracticeAnalysisInput {
  const audioSegments = (input.audioSegments || [])
    .filter(seg => seg && typeof seg.wavBase64 === 'string' && seg.wavBase64.length > 0)
    .slice(-OMNI_AUDIO_SEGMENT_MAX)
  let totalAudioChars = 0
  const budgeted: typeof audioSegments = []
  // 从最新往旧累计，超出总预算就停（保留最近的 N 段）
  for (let i = audioSegments.length - 1; i >= 0; i -= 1) {
    const seg = audioSegments[i]!
    if (seg.wavBase64.length > OMNI_AUDIO_SEGMENT_MAX_CHARS) {
      throw new Error(`audio segment too large (max ${OMNI_AUDIO_SEGMENT_MAX_CHARS} base64 chars)`)
    }
    if (totalAudioChars + seg.wavBase64.length > OMNI_AUDIO_TOTAL_MAX_CHARS) break
    totalAudioChars += seg.wavBase64.length
    budgeted.unshift(seg)
  }
  const frames = (input.frames || []).filter(Boolean).slice(-OMNI_FRAMES_MAX)
  const turns = (input.turns || []).slice(-OMNI_TURNS_MAX)
  const feedback = (input.feedback || []).slice(-60)
  return { ...input, audioSegments: budgeted, frames, turns, feedback }
}

function stripCodeFence(markdown: string): string {
  let text = markdown.trim()
  if (text.startsWith('```')) {
    const firstLineEnd = text.indexOf('\n')
    if (firstLineEnd !== -1) text = text.slice(firstLineEnd + 1)
    else text = text.slice(3)
    if (text.endsWith('```')) text = text.slice(0, -3).trimEnd()
  }
  return text.trim()
}

export interface OmniAnalysisDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 外部中止（客户端断开时省 token）。 */
  signal?: AbortSignal
}

/**
 * 流式分析事件：AI 生成过程中把 DashScope 的文本增量逐段吐给调用方，
 * 前端可以实时渲染成“md 看板”。请求 modalities 为 ['text']（不申请音频，
 * 最省 token）；若未来某天请求了音频输出，可扩展事件携带 audio 段。
 */
export type OmniAnalysisStreamEvent =
  | { type: 'meta'; audioSegments: number; frames: number; model: string }
  | { type: 'delta'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

/**
 * 流式调用 Qwen3.5-Omni（HTTP 全模态）：解析 DashScope 兼容端点的 SSE，
 * 把每个文本增量 yield 出来；结束 yield {type:'done'}；出错 yield
 * {type:'error', message}（不抛异常，便于已开头的响应体里写错误帧）。
 */
export async function* streamOmniPracticeAnalysis(
  rawInput: OmniPracticeAnalysisInput,
  deps: OmniAnalysisDeps = {},
): AsyncGenerator<OmniAnalysisStreamEvent> {
  const input = validateOmniAnalysisInput(rawInput)
  if (input.audioSegments.length === 0 && input.frames.length === 0) {
    yield { type: 'error', message: 'no audio or frames to analyze' }
    return
  }
  const apiKey = await resolveDashScopeKey(input.apiKey)
  if (!apiKey) {
    yield { type: 'error', message: 'DASHSCOPE_API_KEY is not configured' }
    return
  }

  // 素材清单证据（meta 首帧）：以服务端校验后的实际入请求数为准，前端可实时展示
  yield {
    type: 'meta',
    audioSegments: input.audioSegments.length,
    frames: input.frames.length,
    model: input.model || OMNI_ANALYSIS_DEFAULT_MODEL,
  }

  const baseUrl = (input.baseUrl || OMNI_ANALYSIS_BASE_URL).replace(/\/+$/, '')
  const text = buildOmniAnalysisPrompt(input)
  const body = buildOmniAnalysisRequestBody(input, text)

  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs || OMNI_ANALYSIS_TIMEOUT_MS
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = (): void => controller.abort()
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true })

  const doFetch = deps.fetchImpl || fetch
  try {
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      const snippet = detail.slice(0, 300)
      yield { type: 'error', message: `DashScope omni analysis failed (HTTP ${response.status}): ${snippet || 'no body'}` }
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let sawError: Error | null = null
    let yieldedAny = false

    const handleLine = (payload: string): void => {
      if (!payload || payload === '[DONE]') return
      try {
        const chunk = JSON.parse(payload)
        if (chunk?.error) {
          sawError = new Error(
            typeof chunk.error === 'string' ? chunk.error : (chunk.error?.message || JSON.stringify(chunk.error)),
          )
          return
        }
        const delta = chunk?.choices?.[0]?.delta?.content ?? chunk?.choices?.[0]?.message?.content
        if (typeof delta === 'string' && delta) {
          yieldedAny = true
          carry += delta
        } else if (Array.isArray(delta)) {
          for (const part of delta) {
            if (part && typeof part.text === 'string' && part.text) {
              yieldedAny = true
              carry += part.text
            }
          }
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          logger.warn('[speech-practice-omni] unparseable SSE chunk: %s', payload.slice(0, 200))
        } else {
          throw err
        }
      }
    }

    // carry 攒一小段再 yield，避免每个 token 都穿透一层 async generator
    let carry = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) handleLine(buffer.trim().replace(/^data:\s*/, ''))
        buffer = ''
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        handleLine(trimmed.slice(5).trim())
        if (carry) {
          yield { type: 'delta', text: carry }
          carry = ''
        }
        if (sawError) break
      }
      if (sawError) break
    }

    // TS 控制流把 sawError 在循环后窄化为 null（truthy 时已 break），
    // 但闭包内赋值对它不可见——用显式断言取出真正的运行时错误。
    const pendingError = sawError as Error | null
    if (pendingError) {
      yield { type: 'error', message: pendingError.message }
      return
    }
    if (!yieldedAny) {
      yield { type: 'error', message: 'DashScope omni analysis returned empty content' }
      return
    }
    logger.info('[speech-practice-omni] stream finished (%d audio segs, %d frames)',
      input.audioSegments.length, input.frames.length)
    yield { type: 'done' }
  } catch (err) {
    if (controller.signal.aborted) {
      yield { type: 'error', message: `DashScope omni analysis timed out after ${timeoutMs / 1000}s` }
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    yield { type: 'error', message: message.slice(0, 500) }
  } finally {
    clearTimeout(timeoutHandle)
    deps.signal?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * 非流式便捷入口：把 streamOmniPracticeAnalysis 的全部 delta 攒成最终
 * Markdown 返回（兼容 JSON 响应路径 / 旧调用方），出错抛 Error。
 */
export async function generateOmniPracticeAnalysis(
  rawInput: OmniPracticeAnalysisInput,
  deps: OmniAnalysisDeps = {},
): Promise<string> {
  let markdown = ''
  for await (const event of streamOmniPracticeAnalysis(rawInput, deps)) {
    if (event.type === 'delta') markdown += event.text
    else if (event.type === 'error') throw new Error(event.message)
  }
  const cleaned = stripCodeFence(markdown)
  if (!cleaned) throw new Error('DashScope omni analysis returned empty content')
  return cleaned
}
