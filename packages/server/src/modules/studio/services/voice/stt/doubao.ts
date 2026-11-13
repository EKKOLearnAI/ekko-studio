import { randomUUID } from 'crypto'
import { transcodeToWav } from './audio-convert'
import { SttProviderConfigError } from './openai'
import { SttNoSpeechDetectedError, type SttTranscribeInput, type SttTranscribeResult } from './types'

const DEFAULT_BASE_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel'
const DEFAULT_RESOURCE_ID = 'volc.seedasr.auc'
const DEFAULT_USER_ID = 'hermes-web-ui'
const DONE_STATUS = '20000000'
const RUNNING_STATUSES = new Set(['20000001', '20000002'])
const STATUS_MESSAGES: Record<string, string> = {
  '20000003': 'No speech detected in the audio',
  '45000001': 'Invalid Doubao STT request parameters',
  '45000002': 'Doubao STT received empty audio',
  '45000151': 'Doubao STT audio format is invalid',
  '55000031': 'Doubao STT service is busy',
}
const MAX_ERROR_DETAIL_LENGTH = 240
const MAX_PROMPT_LENGTH = 1000
const POLL_INTERVAL_MS = 500
const MAX_WAIT_MS = 30_000
const SUPPORTED_AUDIO_FORMATS = new Set(['wav', 'mp3', 'ogg', 'opus', 'mp4', 'm4a', 'aac', 'amr', 'pcm', 'raw', 'spx'])

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim()
  return trimmed || undefined
}

function requireApiKey(input: SttTranscribeInput): string {
  const apiKey = trimOptional(input.secrets.apiKey)
  if (!apiKey) {
    throw new SttProviderConfigError('Doubao STT API key is required')
  }
  return apiKey
}

function resolveResourceId(input: SttTranscribeInput): string {
  return trimOptional(input.settings.model) || DEFAULT_RESOURCE_ID
}

function resolveBaseUrl(input: SttTranscribeInput): string {
  const raw = trimOptional(input.settings.baseUrl) || DEFAULT_BASE_URL
  const url = new URL(raw)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function endpoint(baseUrl: string, action: 'submit' | 'query'): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith(`/${action}`)) return normalized
  if (normalized.endsWith('/submit') || normalized.endsWith('/query')) {
    return `${normalized.replace(/\/(?:submit|query)$/, '')}/${action}`
  }
  return `${normalized}/${action}`
}

function getHeader(headers: Headers, name: string): string {
  return headers.get(name) || headers.get(name.toLowerCase()) || ''
}

function safeDetail(text: string, apiKey: string): string {
  return text.replaceAll(apiKey, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL_LENGTH)
}

async function responseText(response: Response): Promise<string> {
  return await response.text().catch(() => response.statusText || '')
}

function detectAudioFormat(fileName: string, mimeType: string): string {
  const lowerName = fileName.toLowerCase()
  const lowerMime = mimeType.toLowerCase()
  if (lowerMime.includes('wav') || lowerName.endsWith('.wav')) return 'wav'
  if (lowerMime.includes('mpeg') || lowerMime.includes('mp3') || lowerName.endsWith('.mp3')) return 'mp3'
  if (lowerMime.includes('ogg') || lowerName.endsWith('.ogg')) return 'ogg'
  if (lowerMime.includes('opus') || lowerName.endsWith('.opus')) return 'opus'
  if (lowerMime.includes('mp4') || lowerName.endsWith('.mp4')) return 'mp4'
  if (lowerName.endsWith('.m4a')) return 'm4a'
  if (lowerName.endsWith('.aac')) return 'aac'
  if (lowerName.endsWith('.amr')) return 'amr'
  if (lowerName.endsWith('.pcm')) return 'pcm'
  if (lowerName.endsWith('.raw')) return 'raw'
  if (lowerName.endsWith('.spx')) return 'spx'
  return ''
}

function describeInputAudio(input: SttTranscribeInput): string {
  const mimeType = trimOptional(input.mimeType)
  const fileName = trimOptional(input.fileName)
  if (mimeType && fileName) return `${mimeType} (${fileName})`
  return mimeType || fileName || 'the provided audio'
}

function unsupportedAudioError(input: SttTranscribeInput): SttProviderConfigError {
  return new SttProviderConfigError(
    `Doubao STT cannot upload ${describeInputAudio(input)} directly. Use WAV/MP3/OGG/OPUS audio, or install ffmpeg on the Web UI server so browser WebM/Opus recordings can be transcoded to WAV.`,
  )
}

async function prepareAudio(input: SttTranscribeInput): Promise<{ audio: Buffer; format: string }> {
  let audio = input.audio
  let format = detectAudioFormat(input.fileName, input.mimeType)
  const lowerMime = input.mimeType.toLowerCase()
  const isBrowserWebm = lowerMime.includes('webm')
  const needsWav = input.settings.audioTranscode === 'ffmpeg' || !format || isBrowserWebm
  let convertedToWav = false

  if (needsWav) {
    try {
      const converted = await transcodeToWav(input.audio, input.mimeType, {
        normalizeWav: input.settings.audioTranscode === 'ffmpeg',
      })
      if (converted.mimeType === 'audio/wav' || converted.mimeType === 'audio/x-wav') {
        audio = converted.audio
        format = 'wav'
        convertedToWav = true
      }
    } catch {
      throw unsupportedAudioError(input)
    }
  }

  if (!format || !SUPPORTED_AUDIO_FORMATS.has(format) || (isBrowserWebm && !convertedToWav)) {
    throw unsupportedAudioError(input)
  }

  return { audio, format }
}

function buildSubmitBody(input: SttTranscribeInput, audio: Buffer, format: string): Record<string, unknown> {
  const language = trimOptional(input.settings.language)
  const prompt = trimOptional(input.settings.prompt)?.slice(0, MAX_PROMPT_LENGTH)
  const request: Record<string, unknown> = {
    model_name: 'bigmodel',
    enable_itn: true,
    enable_punc: true,
    show_utterances: true,
  }

  if (language) request.language = language
  if (prompt) request.corpus = { context: prompt }

  return {
    user: { uid: DEFAULT_USER_ID },
    audio: {
      format,
      data: audio.toString('base64'),
    },
    request,
  }
}

async function postJson(url: string, apiKey: string, resourceId: string, requestId: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    },
    body: JSON.stringify(body),
    signal,
  })
}

function extractTranscript(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const root = payload as Record<string, unknown>
  const directData = root.data
  if (directData && typeof directData === 'object') {
    const text = (directData as Record<string, unknown>).text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }

  const result = root.result
  if (result && typeof result === 'object') {
    const text = (result as Record<string, unknown>).text
    if (typeof text === 'string' && text.trim()) return text.trim()
  }

  const text = root.text
  return typeof text === 'string' ? text.trim() : ''
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    }
  })
}

export async function transcribeDoubaoFile(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const startedAt = Date.now()
  const apiKey = requireApiKey(input)
  if (!Buffer.isBuffer(input.audio) || input.audio.length === 0) {
    throw new Error('Doubao STT audio is empty')
  }

  const resourceId = resolveResourceId(input)
  const baseUrl = resolveBaseUrl(input)
  const requestId = randomUUID()
  const { audio, format } = await prepareAudio(input)
  const submitBody = buildSubmitBody(input, audio, format)
  const submit = await postJson(endpoint(baseUrl, 'submit'), apiKey, resourceId, requestId, submitBody, input.signal)
  const submitStatus = getHeader(submit.headers, 'X-Api-Status-Code')
  if (!submit.ok || (submitStatus && submitStatus !== DONE_STATUS)) {
    const detail = safeDetail(await responseText(submit), apiKey)
    throw new Error(`Doubao STT submit failed${submitStatus ? ` (${submitStatus})` : ` HTTP ${submit.status}`}${detail ? `: ${detail}` : ''}`)
  }

  while (Date.now() - startedAt < MAX_WAIT_MS) {
    const query = await postJson(endpoint(baseUrl, 'query'), apiKey, resourceId, requestId, {}, input.signal)
    const status = getHeader(query.headers, 'X-Api-Status-Code')
    const bodyText = await responseText(query)

    if (!query.ok) {
      const detail = safeDetail(bodyText, apiKey)
      throw new Error(`Doubao STT query failed HTTP ${query.status}${detail ? `: ${detail}` : ''}`)
    }

    if (status === DONE_STATUS) {
      const payload = bodyText ? JSON.parse(bodyText) : {}
      const text = extractTranscript(payload)
      if (!text) {
        throw new Error('Doubao STT response text is empty')
      }
      return {
        text,
        provider: 'doubao',
        model: resourceId,
        language: trimOptional(input.settings.language),
        durationMs: Date.now() - startedAt,
      }
    }

    if (status && !RUNNING_STATUSES.has(status)) {
      const detail = safeDetail(bodyText, apiKey)
      const message = STATUS_MESSAGES[status] || `Doubao STT query returned status ${status}`
      if (status === '20000003') {
        throw new SttNoSpeechDetectedError(message)
      }
      throw new Error(`${message}${detail ? `: ${detail}` : ''}`)
    }

    await sleep(POLL_INTERVAL_MS, input.signal)
  }

  throw new Error('Doubao STT query timed out')
}
