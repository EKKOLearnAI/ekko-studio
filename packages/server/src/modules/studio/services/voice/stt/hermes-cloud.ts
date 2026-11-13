import type { StoredSttProvider } from '../../../repositories/stt-settings-store'
import { assertSafeResolvedTtsBaseUrl } from '../tts/providers/url-safety'
import { transcodeToWav } from './audio-convert'
import type { SttTranscribeInput, SttTranscribeResult } from './types'

const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1'
const DEFAULT_ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1'
const DEFAULT_ELEVENLABS_MODEL = 'scribe_v2'

function requireApiKey(input: SttTranscribeInput, provider: string): string {
  const apiKey = String(input.secrets.apiKey || '').trim()
  if (!apiKey) throw new Error(`${provider} STT API key is required`)
  return apiKey
}

function booleanSetting(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const normalized = String(value ?? '').trim().toLowerCase()
  if (!normalized) return fallback
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
}

async function safeEndpoint(
  input: SttTranscribeInput,
  defaultBaseUrl: string,
  suffix: string,
  provider: string,
): Promise<URL> {
  const url = new URL(String(input.settings.baseUrl || defaultBaseUrl).trim())
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
  await assertSafeResolvedTtsBaseUrl(url, provider)
  return url
}

async function inputAudio(input: SttTranscribeInput): Promise<{ audio: Buffer; mimeType: string; fileName: string }> {
  if (input.settings.audioTranscode !== 'ffmpeg') {
    return { audio: input.audio, mimeType: input.mimeType, fileName: input.fileName }
  }
  const converted = await transcodeToWav(input.audio, input.mimeType)
  return converted.fileName
    ? converted
    : { audio: converted.audio, mimeType: converted.mimeType, fileName: input.fileName }
}

function appendAudio(form: FormData, audio: { audio: Buffer; mimeType: string; fileName: string }) {
  form.append(
    'file',
    new Blob([Uint8Array.from(audio.audio)], { type: audio.mimeType || 'application/octet-stream' }),
    audio.fileName || 'audio',
  )
}

async function checkedJson(
  response: Response,
  provider: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const detail = (await response.text().catch(() => response.statusText || ''))
      .replaceAll(apiKey, '[redacted]')
      .slice(0, 500)
    throw new Error(`${provider} STT returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }
  return await response.json() as Record<string, unknown>
}

function textResult(
  input: SttTranscribeInput,
  startedAt: number,
  payload: Record<string, unknown>,
  model: string,
): SttTranscribeResult {
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) throw new Error(`${input.provider} STT response text is empty`)
  return {
    text,
    provider: input.provider,
    model,
    language: typeof payload.language === 'string'
      ? payload.language
      : String(input.settings.language || '').trim() || undefined,
    durationMs: Date.now() - startedAt,
  }
}

export async function transcribeXai(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const startedAt = Date.now()
  const apiKey = requireApiKey(input, 'xAI')
  const url = await safeEndpoint(input, DEFAULT_XAI_BASE_URL, '/stt', 'xAI STT')
  const audio = await inputAudio(input)
  const form = new FormData()
  appendAudio(form, audio)
  const language = String(input.settings.language || '').trim()
  if (language) form.append('language', language)
  if (booleanSetting(input.settings.format, true)) form.append('format', 'true')
  if (booleanSetting(input.settings.diarize, false)) form.append('diarize', 'true')
  const payload = await checkedJson(await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: input.signal,
  }), 'xAI', apiKey)
  return textResult(input, startedAt, payload, String(input.settings.model || 'xai-stt'))
}

export async function transcribeElevenLabs(input: SttTranscribeInput): Promise<SttTranscribeResult> {
  const startedAt = Date.now()
  const apiKey = requireApiKey(input, 'ElevenLabs')
  const url = await safeEndpoint(input, DEFAULT_ELEVENLABS_BASE_URL, '/speech-to-text', 'ElevenLabs STT')
  const audio = await inputAudio(input)
  const form = new FormData()
  appendAudio(form, audio)
  const model = String(input.settings.model || DEFAULT_ELEVENLABS_MODEL).trim()
  form.append('model_id', model)
  form.append('tag_audio_events', booleanSetting(input.settings.tagAudioEvents, false) ? 'true' : 'false')
  form.append('diarize', booleanSetting(input.settings.diarize, false) ? 'true' : 'false')
  const language = String(input.settings.language || '').trim()
  if (language) form.append('language_code', language)
  const payload = await checkedJson(await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: input.signal,
  }), 'ElevenLabs', apiKey)
  return textResult(input, startedAt, payload, model)
}

export function isHermesCloudSttProvider(provider: StoredSttProvider): provider is Extract<StoredSttProvider, 'xai' | 'elevenlabs'> {
  return provider === 'xai' || provider === 'elevenlabs'
}
