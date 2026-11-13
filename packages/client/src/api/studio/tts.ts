import { ensureDesktopAuthReady, getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'

export interface TtsOptions {
  text: string
  lang?: string
  rate?: string   // Edge TTS rate format: "+NN%" or "-NN%"
  pitch?: string  // Edge TTS pitch format: "+NNHz" or "-NNHz"
}

export type TtsProviderId =
  | 'edge'
  | 'openai'
  | 'custom'
  | 'mimo'
  | 'doubao'
  | 'elevenlabs'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'deepinfra'

const TTS_PROVIDER_IDS = new Set<TtsProviderId>([
  'edge',
  'openai',
  'custom',
  'mimo',
  'doubao',
  'elevenlabs',
  'gemini',
  'xai',
  'mistral',
  'minimax',
  'deepinfra',
])

export function isServerTtsProvider(value: unknown): value is TtsProviderId {
  return typeof value === 'string' && TTS_PROVIDER_IDS.has(value as TtsProviderId)
}

export interface SynthesizeSpeechRequest {
  provider?: TtsProviderId
  profile?: string
  text: string
  options?: Record<string, unknown>
  signal?: AbortSignal
}

async function readTtsError(res: Response): Promise<string> {
  try {
    const data = await res.clone().json() as { error?: unknown; detail?: unknown }
    const error = typeof data.error === 'string' ? data.error : 'TTS request failed'
    const detail = typeof data.detail === 'string' && data.detail.trim() ? data.detail.trim() : ''
    return detail ? `${error}: ${detail}` : `${error}: ${res.status}`
  } catch {
    const text = await res.text().catch(() => '')
    return text ? `TTS request failed: ${res.status} ${text.slice(0, 300)}` : `TTS request failed: ${res.status}`
  }
}

function ttsHeaders(explicitProfile?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = getApiKey()
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
  }
  const profile = explicitProfile?.trim() || getActiveProfileName()
  if (profile) {
    headers['X-Hermes-Profile'] = profile
  }
  return headers
}

export async function generateSpeech(opts: TtsOptions): Promise<{ audio: Blob; engine: string }> {
  await ensureDesktopAuthReady()
  const res = await fetch(
    `${getBaseUrlValue()}/api/studio/tts`,
    {
      method: 'POST',
      headers: ttsHeaders(),
      body: JSON.stringify(opts),
    },
  )

  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  return { audio, engine }
}

export async function synthesizeSpeech(
  req: SynthesizeSpeechRequest,
): Promise<{ audio: Blob; engine: string; provider: string }> {
  req.signal?.throwIfAborted()
  await ensureDesktopAuthReady()
  req.signal?.throwIfAborted()
  const res = await fetch(
    `${getBaseUrlValue()}/api/studio/tts/synthesize`,
    {
      method: 'POST',
      headers: ttsHeaders(req.profile),
      body: JSON.stringify({
        provider: req.provider,
        text: req.text,
        options: req.options || {},
      }),
      signal: req.signal,
    },
  )

  if (!res.ok) {
    throw new Error(await readTtsError(res))
  }

  const audio = await res.blob()
  const engine = res.headers.get('X-TTS-Engine') || 'unknown'
  const provider = res.headers.get('X-TTS-Provider') || req.provider || 'unknown'
  return { audio, engine, provider }
}

export function playAudioBlob(blob: Blob): HTMLAudioElement {
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.play()
  audio.onended = () => URL.revokeObjectURL(url)
  return audio
}
