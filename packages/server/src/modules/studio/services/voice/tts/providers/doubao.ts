import { randomUUID } from 'crypto'
import type { DoubaoTtsProvider, DoubaoTtsProviderOptions } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

const DEFAULT_BASE_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0'
const DEFAULT_SPEAKER = 'zh_female_xiaohe_uranus_bigtts'
const DEFAULT_USER_ID = 'hermes-web-ui'
const MAX_ERROR_DETAIL_LENGTH = 500
const DEFAULT_FORMAT = 'mp3'
const DEFAULT_SAMPLE_RATE = 24000
const SUPPORTED_FORMATS = new Set(['mp3', 'pcm', 'wav', 'ogg_opus'])

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim()
  return trimmed || undefined
}

function requireApiKey(opts: DoubaoTtsProviderOptions): string {
  const apiKey = trimOptional(opts.apiKey)
  if (!apiKey) {
    throw new Error('Doubao TTS API key is required')
  }
  return apiKey
}

function resolveBaseUrl(opts: DoubaoTtsProviderOptions): string {
  const url = new URL(trimOptional(opts.baseUrl) || DEFAULT_BASE_URL)
  assertSafeTtsBaseUrl(url, 'Doubao')
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function safeDetail(text: string, apiKey: string): string {
  return text.replaceAll(apiKey, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL_LENGTH)
}

function audioContentType(format: string): string {
  if (format === 'wav') return 'audio/wav'
  if (format === 'ogg' || format === 'opus' || format === 'ogg_opus') return 'audio/ogg'
  if (format === 'pcm') return 'audio/x-pcm'
  return 'audio/mpeg'
}

function resolveAudioFormat(opts: DoubaoTtsProviderOptions): string {
  const format = trimOptional(opts.format)?.toLowerCase().replace('-', '_') || (opts.mcuPlayback ? 'pcm' : DEFAULT_FORMAT)
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Doubao TTS format must be one of ${Array.from(SUPPORTED_FORMATS).join(', ')}`)
  }
  return format
}

function resolveSampleRate(opts: DoubaoTtsProviderOptions): number {
  const raw = opts.sampleRate ?? opts.sample_rate
  if ((raw === undefined || raw === null) && opts.mcuPlayback) return DEFAULT_SAMPLE_RATE
  if (raw === undefined || raw === null) return DEFAULT_SAMPLE_RATE
  const sampleRate = Number(raw)
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new Error('Doubao TTS sampleRate must be a positive integer')
  }
  return sampleRate
}

function resolveSpeechRate(speed: string | number | undefined): number | undefined {
  if (speed === undefined || speed === null || String(speed).trim() === '') return undefined
  const multiplier = Number(speed)
  if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 2) {
    throw new Error('Doubao TTS speed must be between 0.5 and 2')
  }
  return Math.round((multiplier - 1) * 100)
}

function buildRequestBody(text: string, opts: DoubaoTtsProviderOptions): Record<string, unknown> {
  const speaker = trimOptional(opts.voice) || DEFAULT_SPEAKER
  const prompt = trimOptional(opts.stylePrompt)
  const format = resolveAudioFormat(opts)
  const sampleRate = resolveSampleRate(opts)
  const speechRate = resolveSpeechRate(opts.speed)
  const reqParams: Record<string, unknown> = {
    text,
    speaker,
    audio_params: {
      format,
      sample_rate: sampleRate,
      ...(speechRate === undefined ? {} : { speech_rate: speechRate }),
    },
  }

  if (prompt) {
    reqParams.additions = {
      style_prompt: prompt,
    }
  }

  return {
    user: { uid: DEFAULT_USER_ID },
    req_params: reqParams,
  }
}

function extractString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractBase64Audio(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, unknown>
  const candidates = [
    root.data,
    root.audio,
    root.audio_data,
    root.audioData,
  ]

  const result = root.result
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    candidates.push(record.data, record.audio, record.audio_data, record.audioData)
  }

  for (const candidate of candidates) {
    const audio = extractString(candidate)
    if (audio) return audio
  }

  return ''
}

function parseJsonLine(line: string): unknown | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
  if (!jsonText || jsonText === '[DONE]') return null
  try {
    return JSON.parse(jsonText)
  } catch {
    return null
  }
}

function upstreamErrorFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, unknown>
  const code = root.code
  const header = root.header && typeof root.header === 'object' ? root.header as Record<string, unknown> : null
  const statusCode = extractString(root.status_code) || extractString(root.statusCode) || extractString(header?.code)
  const message = extractString(root.message) || extractString(root.error) || extractString(header?.message)
  const numericCode = typeof code === 'number' ? code : Number.NaN
  const isOkCode = numericCode === 0 || numericCode === 20000000
  if ((Number.isFinite(numericCode) && !isOkCode) || statusCode) {
    return [statusCode || String(code), message].filter(Boolean).join(': ')
  }
  return ''
}

function decodeChunkedAudio(text: string): Buffer {
  const chunks: Buffer[] = []
  let firstPayload: unknown | null = null
  let upstreamError = ''

  for (const line of text.split(/\r?\n/)) {
    const payload = parseJsonLine(line)
    if (!payload) continue
    if (!firstPayload) firstPayload = payload

    const error = upstreamErrorFromPayload(payload)
    if (error) {
      upstreamError = error
      continue
    }

    const audio = extractBase64Audio(payload)
    if (audio) {
      chunks.push(Buffer.from(audio, 'base64'))
    }
  }

  if (chunks.length > 0) {
    return Buffer.concat(chunks)
  }

  if (upstreamError) {
    throw new Error(`Doubao TTS returned ${upstreamError}`)
  }

  if (firstPayload) {
    throw new Error('Doubao TTS response missing audio data')
  }

  throw new Error('Doubao TTS response is empty')
}

export const doubaoTtsProvider: DoubaoTtsProvider = {
  id: 'doubao',
  async synthesize(req, opts) {
    const apiKey = requireApiKey(opts)
    const text = clampTtsText(cleanTtsText(req.text))

    if (!text) {
      throw new Error('Doubao TTS text is empty after cleaning')
    }

    const resourceId = trimOptional(opts.model) || DEFAULT_RESOURCE_ID
    const baseUrl = resolveBaseUrl(opts)
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': randomUUID(),
      },
      body: JSON.stringify(buildRequestBody(text, opts)),
      signal: req.signal,
    })

    const contentType = res.headers.get('content-type') || ''
    if (!res.ok) {
      const detail = safeDetail(await res.text().catch(() => ''), apiKey)
      throw new Error(`Doubao TTS returned ${res.status}: ${detail || res.statusText}`)
    }

    if (contentType.toLowerCase().startsWith('audio/')) {
      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType,
        engine: 'doubao',
        provider: 'doubao',
      }
    }

    return {
      audio: decodeChunkedAudio(await res.text()),
      contentType: audioContentType(resolveAudioFormat(opts)),
      engine: 'doubao',
      provider: 'doubao',
    }
  },
}
