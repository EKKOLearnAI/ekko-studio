import { getApiKey } from '@/api/client'

/**
 * 口语对练分析报告 API。
 *
 * 1. POST /api/studio/speech-practice/report —— 报告（Markdown）落盘，
 *    下载用 api/studio/download.ts 的 getDownloadUrl(path, fileName) 拼链接。
 * 2. POST /api/studio/speech-practice/omni-analysis —— 把练习期间录制的
 *    用户语音（WAV base64）+ 摄像头帧 + 转写交给 Qwen3.5-Omni（HTTP 全模态）
 *    生成一段深度分析 Markdown（不落盘，由客户端拼进报告后再走 /report）。
 */

export interface SavePracticeReportResult {
  ok: boolean
  fileName?: string
  path?: string
  error?: string
}

export interface OmniAnalysisPayload {
  config: {
    language: string
    direction: string
    difficulty: string
    durationMinutes?: number
    /** 练习技能上下文（下载技能时），服务端注入深度分析提示词。 */
    skill?: {
      name?: string
      displayName?: string
      description?: string
      criteria?: string
      instructions?: string
      background?: string
    }
  }
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
  feedback: Array<Record<string, unknown>>
  audioSegments: Array<{ index: number; text: string; wavBase64: string }>
  frames: string[]
  model?: string
}

export interface OmniAnalysisResult {
  ok: boolean
  markdown?: string
  error?: string
}

const MAX_REPORT_CHARS = 512 * 1024

/** POST /api/studio/speech-practice/report */
export async function savePracticeReport(
  markdown: string,
  suggestedName?: string,
): Promise<SavePracticeReportResult> {
  const text = (markdown || '').trim()
  if (!text) return { ok: false, error: 'empty report' }
  if (text.length > MAX_REPORT_CHARS) return { ok: false, error: 'report too large' }

  try {
    const response = await fetch('/api/studio/speech-practice/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
      body: JSON.stringify({ markdown: text, suggestedName }),
    })
    const payload = await response.json().catch(() => ({} as Record<string, unknown>))
    if (!response.ok || payload?.ok === false) {
      return { ok: false, error: String(payload?.error || `save failed (${response.status})`) }
    }
    return {
      ok: true,
      fileName: String(payload?.fileName || 'report.md'),
      path: String(payload?.path || ''),
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, error: message }
  }
}

/**
 * POST /api/studio/speech-practice/omni-analysis
 *
 * 全模态分析需要 DashScope key：优先用客户端实时模型配置里持有的 key
 * （与启动 meeting-asr 后端同源），服务端读不到时用它兜底。
 */
export async function requestOmniPracticeAnalysis(
  payload: OmniAnalysisPayload,
  apiKey?: string,
): Promise<OmniAnalysisResult> {
  try {
    const response = await fetch('/api/studio/speech-practice/omni-analysis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
      body: JSON.stringify({ ...payload, apiKey }),
    })
    const data = await response.json().catch(() => ({} as Record<string, unknown>))
    if (!response.ok || data?.ok === false) {
      return { ok: false, error: String(data?.error || `omni analysis failed (${response.status})`) }
    }
    return { ok: true, markdown: String(data?.markdown || '') }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ok: false, error: message }
  }
}

export interface OmniAnalysisMediaMeta {
  /** 服务端校验后实际进入请求的录音段数。 */
  audioSegments: number
  /** 实际进入请求的画面帧数。 */
  frames: number
  model: string
}

export interface OmniStreamHandlers {
  /** 每个生成增量（纯文本，实时追加到 md 看板）。 */
  onDelta?: (text: string) => void
  /** SSE 首帧 meta（素材清单：实际入请求的录音段数/帧数/模型）。 */
  onMeta?: (meta: OmniAnalysisMediaMeta) => void
}

/**
 * POST /api/studio/speech-practice/omni-analysis（body.stream = true，SSE）
 *
 * 服务端把 Qwen3.5-Omni 的生成增量以
 * `data: {"type":"delta"|"error"|"done", …}` 逐段转发；本函数把增量实时
 * 交给 onDelta 并累加，结束后 resolve `{ ok, markdown }`。请求 modalities
 * 为 text-only（省 token，无音频段）。
 */
export async function streamOmniPracticeAnalysis(
  payload: OmniAnalysisPayload,
  apiKey: string | undefined,
  handlers: OmniStreamHandlers = {},
  signal?: AbortSignal,
): Promise<OmniAnalysisResult> {
  try {
    const response = await fetch('/api/studio/speech-practice/omni-analysis', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(getApiKey() ? { Authorization: `Bearer ${getApiKey()}` } : {}),
      },
      body: JSON.stringify({ ...payload, apiKey, stream: true }),
      signal,
    })
    if (!response.ok || !response.body) {
      return { ok: false, error: `omni analysis failed (HTTP ${response.status})` }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let markdown = ''
    let streamError = ''
    const handlePayload = (payloadText: string): void => {
      if (!payloadText || payloadText === '[DONE]') return
      try {
        const evt = JSON.parse(payloadText) as { type?: string; text?: string; message?: string; audioSegments?: number; frames?: number; model?: string }
        if (evt.type === 'delta' && typeof evt.text === 'string') {
          markdown += evt.text
          handlers.onDelta?.(evt.text)
        } else if (evt.type === 'meta') {
          handlers.onMeta?.({
            audioSegments: Number(evt.audioSegments) || 0,
            frames: Number(evt.frames) || 0,
            model: String(evt.model || ''),
          })
        } else if (evt.type === 'error') {
          streamError = String(evt.message || 'omni analysis failed')
        }
      } catch {
        // 忽略无法解析的帧
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) handlePayload(buffer.trim().replace(/^data:\s*/, ''))
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        handlePayload(trimmed.slice(5).trim())
        if (streamError) break
      }
      if (streamError) break
    }
    if (streamError) return { ok: false, error: streamError }
    if (!markdown) return { ok: false, error: 'omni analysis returned empty content' }
    return { ok: true, markdown }
  } catch (cause) {
    const message = cause instanceof Error && cause.name === 'AbortError'
      ? 'omni analysis aborted'
      : (cause instanceof Error ? cause.message : String(cause))
    return { ok: false, error: message }
  }
}
