import type { TtsProvider, TtsProviderId } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

/**
 * 阿里云百炼 Qwen-TTS-VC（声音复刻音色，DashScope multimodal-generation 非实时接口）
 *
 * 接口要点（非 OpenAI 兼容）：
 *   POST {baseUrl}（完整 endpoint：/api/v1/services/aigc/multimodal-generation/generation）
 *   Header: Authorization: Bearer <key>
 *   Body:   { model: 'qwen3-tts-vc-2026-01-22', input: { text, voice } }
 *   响应可能为：
 *     a) 直接音频流（content-type: audio/*）
 *     b) JSON：output.audio.url / output.choices[0].message.content[0].audio.url
 *        （含 url 则再下载一次拿音频字节）
 *   容错实现：先看 content-type，若是 JSON 递归找第一个 url 字段再 GET。
 */
export interface AliyunTtsProviderOptions {
  baseUrl?: string
  apiKey?: string
  model?: string
  voice?: string
  format?: string
}

function findAudioUrl(node: unknown): string | null {
  if (typeof node === 'string') return /^https?:\/\//.test(node) ? node : null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAudioUrl(item)
      if (hit) return hit
    }
    return null
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>
    if (typeof obj.url === 'string' && /^https?:\/\//.test(obj.url)) return obj.url
    for (const key of ['output', 'audio', 'choices', 'message', 'content']) {
      const hit = findAudioUrl(obj[key])
      if (hit) return hit
    }
    for (const value of Object.values(obj)) {
      const hit = findAudioUrl(value)
      if (hit) return hit
    }
  }
  return null
}

export function createAliyunTtsProvider(id: Extract<TtsProviderId, 'aliyun'>): TtsProvider<AliyunTtsProviderOptions> {
  return {
    id,
    async synthesize(req, opts) {
      const baseUrl = String(opts.baseUrl || '').trim()
      if (!baseUrl) throw new Error('aliyun TTS baseUrl is required')
      const url = new URL(baseUrl)
      assertSafeTtsBaseUrl(url, 'aliyun')
      const text = clampTtsText(cleanTtsText(req.text))
      if (!text) throw new Error('aliyun TTS text is empty after cleaning')
      if (!opts.apiKey) throw new Error('aliyun TTS apiKey is required')
      const model = opts.model || 'qwen3-tts-vc-2026-01-22'
      if (!opts.voice) throw new Error('aliyun TTS voice is required (声音复刻音色 id，需与 model 匹配)')

      const payload = JSON.stringify({
        model,
        input: { text, voice: opts.voice },
      })
      const headers = {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      }

      const res = await fetch(baseUrl, {
        method: 'POST',
        headers,
        body: payload,
        signal: req.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`aliyun TTS returned ${res.status}: ${body.slice(0, 300)}`)
      }
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('audio/') || contentType.includes('application/octet-stream')) {
        return {
          audio: Buffer.from(await res.arrayBuffer()),
          contentType,
          engine: 'aliyun',
          provider: id,
        }
      }

      // JSON：找 output.audio.url 再下载
      const data = (await res.json().catch(() => null)) as unknown
      const audioUrl = findAudioUrl(data)
      if (!audioUrl) {
        throw new Error(`aliyun TTS: no audio url in response: ${JSON.stringify(data).slice(0, 300)}`)
      }
      const audioRes = await fetch(audioUrl, { signal: req.signal })
      if (!audioRes.ok) {
        throw new Error(`aliyun TTS audio download returned ${audioRes.status}`)
      }
      return {
        audio: Buffer.from(await audioRes.arrayBuffer()),
        contentType: audioRes.headers.get('content-type') || 'audio/mpeg',
        engine: 'aliyun',
        provider: id,
      }
    },
  }
}

export const aliyunTtsProvider: TtsProvider<AliyunTtsProviderOptions> = createAliyunTtsProvider('aliyun')
