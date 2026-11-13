import type { MimoTtsProviderOptions, MimoTtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

const MAX_VOICE_CLONE_AUDIO_BYTES = 10 * 1024 * 1024

function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  assertSafeTtsBaseUrl(url, 'MiMo')

  return url.toString().replace(/\/+$/, '')
}

function buildHeaders(opts: MimoTtsProviderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const authMode = opts.authMode ?? 'bearer'

  if (authMode === 'bearer' || authMode === 'both') {
    headers.Authorization = `Bearer ${opts.apiKey}`
  }

  if (authMode === 'api-key' || authMode === 'both') {
    headers['api-key'] = opts.apiKey
  }

  return headers
}

function inferVoiceMode(opts: MimoTtsProviderOptions) {
  if (opts.voiceMode) {
    return opts.voiceMode
  }

  if (opts.model === 'mimo-v2.5-tts-voicedesign') {
    return 'voiceDesign'
  }

  if (opts.model === 'mimo-v2.5-tts-voiceclone') {
    return 'voiceClone'
  }

  return 'preset'
}

function estimateBase64DecodedBytes(base64: string): number {
  const trimmed = base64.trim()
  if (!trimmed) return 0
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.floor((trimmed.length * 3) / 4) - padding
}

function validateVoiceCloneDataUri(dataUri: string) {
  const match = /^data:audio\/(?:mpeg|mp3|wav);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri)
  if (!match) {
    throw new Error('MiMo TTS voiceCloneDataUri must be an mp3 or wav data URI')
  }

  if (estimateBase64DecodedBytes(match[1]) > MAX_VOICE_CLONE_AUDIO_BYTES) {
    throw new Error('MiMo TTS voiceCloneDataUri must be 10 MiB or smaller')
  }
}

function buildMessages(text: string, opts: MimoTtsProviderOptions) {
  const mode = inferVoiceMode(opts)

  if (mode === 'voiceClone') {
    if (!opts.voiceCloneDataUri) {
      throw new Error('MiMo TTS voiceCloneDataUri is required for voiceClone mode')
    }
    validateVoiceCloneDataUri(opts.voiceCloneDataUri)

    return [
      {
        role: 'user',
        content: opts.stylePrompt || '',
      },
      {
        role: 'assistant',
        content: text,
      },
    ]
  }

  const userContent = mode === 'voiceDesign'
    ? [opts.voiceDesignDesc || '', opts.stylePrompt || ''].filter(Boolean).join('\n\n')
    : opts.stylePrompt || ''

  return [
    {
      role: 'user',
      content: userContent,
    },
    {
      role: 'assistant',
      content: text,
    },
  ]
}

function buildAudio(opts: MimoTtsProviderOptions): Record<string, string> {
  const mode = inferVoiceMode(opts)
  const audio: Record<string, string> = {
    format: opts.format || 'wav',
  }

  if (mode === 'preset' && opts.voice) {
    audio.voice = opts.voice
  } else if (mode === 'voiceClone' && opts.voiceCloneDataUri) {
    audio.voice = opts.voiceCloneDataUri
  }

  return audio
}

function audioContentType(format: string | undefined): string {
  const normalized = String(format || 'wav').trim().toLowerCase().replace('-', '_')
  if (normalized === 'pcm' || normalized === 'raw' || normalized === 's16le') return 'audio/x-pcm'
  if (normalized === 'mp3' || normalized === 'mpeg') return 'audio/mpeg'
  if (normalized === 'opus' || normalized === 'ogg' || normalized === 'ogg_opus') return 'audio/ogg'
  if (normalized === 'flac') return 'audio/flac'
  return 'audio/wav'
}

export const mimoTtsProvider: MimoTtsProvider = {
  id: 'mimo',
  async synthesize(req, opts) {
    const baseUrl = normalizeBaseUrl(opts.baseUrl)
    const text = clampTtsText(cleanTtsText(req.text))

    if (!text) {
      throw new Error('MiMo TTS text is empty after cleaning')
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(opts),
      body: JSON.stringify({
        model: opts.model,
        messages: buildMessages(text, opts),
        audio: buildAudio(opts),
      }),
      signal: req.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`MiMo TTS returned ${res.status}: ${body || res.statusText}`)
    }

    const json = await res.json()
    const audioBase64 = json?.choices?.[0]?.message?.audio?.data
    if (!audioBase64) {
      throw new Error('MiMo TTS response missing audio data')
    }

    return {
      audio: Buffer.from(audioBase64, 'base64'),
      contentType: audioContentType(opts.format),
      engine: 'mimo',
      provider: 'mimo',
    }
  },
}
