import type { StoredSttProvider } from '../../../repositories/stt-settings-store'
import { assertSafeResolvedTtsBaseUrl, normalizeSafeTtsBaseUrl } from '../tts/providers/url-safety'
import { transcodeToWav } from './audio-convert'
import type { SttTranscribeInput, SttTranscribeResult } from './types'

export class SttProviderConfigError extends Error {}

export const DEFAULT_OPENAI_STT_URL = 'https://api.openai.com/v1/audio/transcriptions'
export const DEFAULT_MODEL = 'gpt-4o-transcribe'
const DEFAULT_PROVIDER_CONFIG: Partial<Record<StoredSttProvider, { baseUrl: string; model: string }>> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'voxtral-mini-latest',
  },
  deepinfra: {
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    model: 'openai/whisper-large-v3',
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-asr-2512',
  },
}

const MAX_ERROR_DETAIL_LENGTH = 200
const MAX_PROMPT_LENGTH = 1000

function getProviderLabel(provider: StoredSttProvider): string {
  if (provider === 'custom') return 'Custom STT'
  if (provider === 'deepinfra') return 'DeepInfra STT'
  if (provider === 'groq') return 'Groq STT'
  if (provider === 'mistral') return 'Mistral STT'
  if (provider === 'zhipu') return 'Zhipu GLM-ASR'
  return 'OpenAI STT'
}

function buildTranscriptionsUrl(baseUrl: string, providerLabel: string): string {
  const normalizedBaseUrl = normalizeSafeTtsBaseUrl(baseUrl, providerLabel)
  const url = new URL(normalizedBaseUrl)
  const search = url.search
  url.hash = ''

  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    return `${url.origin}/audio/transcriptions${search}`
  }

  if (pathname.endsWith('/audio/transcriptions')) {
    return `${url.origin}${pathname}${search}`
  }

  return `${url.origin}${pathname}/audio/transcriptions${search}`
}

function resolveBaseUrl(input: SttTranscribeInput): string {
  const configuredBaseUrl = String(input.settings.baseUrl || '').trim()
  if (input.provider === 'custom') {
    const baseUrl = configuredBaseUrl
    if (!baseUrl) {
      throw new SttProviderConfigError('Custom STT baseUrl is required')
    }
    return buildTranscriptionsUrl(baseUrl, getProviderLabel(input.provider))
  }

  if (configuredBaseUrl) {
    return buildTranscriptionsUrl(configuredBaseUrl, getProviderLabel(input.provider))
  }
  const providerDefault = DEFAULT_PROVIDER_CONFIG[input.provider]
  return providerDefault
    ? buildTranscriptionsUrl(providerDefault.baseUrl, getProviderLabel(input.provider))
    : DEFAULT_OPENAI_STT_URL
}

function requireApiKey(input: SttTranscribeInput): string {
  const apiKey = String(input.secrets.apiKey || '').trim()
  if (!apiKey) {
    throw new SttProviderConfigError('OpenAI-compatible STT API key is required')
  }
  return apiKey
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim()
  return trimmed || undefined
}

function sanitizeDetail(detail: string, apiKey: string): string {
  const normalized = String(detail || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return ''
  }

  return normalized.replaceAll(apiKey, '[redacted]').slice(0, MAX_ERROR_DETAIL_LENGTH)
}

export async function transcribeOpenAiCompatible(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const startedAt = Date.now()
  const apiKey = requireApiKey(input)

  if (!Buffer.isBuffer(input.audio) || input.audio.length === 0) {
    throw new Error('OpenAI-compatible STT audio is empty')
  }

  const baseUrl = resolveBaseUrl(input)
  const model = trimOptional(input.settings.model) || DEFAULT_PROVIDER_CONFIG[input.provider]?.model || DEFAULT_MODEL
  const language = trimOptional(input.settings.language)
  const prompt = trimOptional(input.settings.prompt)?.slice(0, MAX_PROMPT_LENGTH)

  await assertSafeResolvedTtsBaseUrl(new URL(baseUrl), getProviderLabel(input.provider))

  // Transcode browser-recorded audio (typically webm/opus) to WAV so that
  // upstream ASR services that only support mp3/wav can process it.
  let audioBuffer = input.audio
  let audioMimeType = input.mimeType
  let audioFileName = input.fileName
  if (input.settings.audioTranscode === 'ffmpeg' && audioMimeType !== 'audio/wav' && audioMimeType !== 'audio/x-wav') {
    try {
      const converted = await transcodeToWav(audioBuffer, audioMimeType)
      if (converted.mimeType === 'audio/wav') {
        audioBuffer = converted.audio
        audioMimeType = converted.mimeType
        audioFileName = converted.fileName || audioFileName
      }
    } catch {
      // Transcoding is best-effort; fall through with the original audio.
    }
  }

  const form = new FormData()
  const audioBytes = Uint8Array.from(audioBuffer)
  form.append('file', new Blob([audioBytes], { type: trimOptional(audioMimeType) || 'application/octet-stream' }), trimOptional(audioFileName) || 'audio')
  form.append('model', model)
  if (language) {
    form.append('language', language)
  }
  if (prompt && input.provider !== 'mistral') {
    form.append('prompt', prompt)
  }

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
    redirect: 'manual',
    signal: input.signal,
  })

  if (!response.ok) {
    const detail = sanitizeDetail(await response.text().catch(() => response.statusText || ''), apiKey)
    throw new Error(`OpenAI-compatible STT returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  const payload = await response.json() as { text?: unknown }
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) {
    throw new Error('OpenAI-compatible STT response text is empty')
  }

  return {
    text,
    provider: input.provider,
    model,
    language,
    durationMs: Date.now() - startedAt,
  }
}
