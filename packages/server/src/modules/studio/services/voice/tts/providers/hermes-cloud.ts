import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'
import type { CloudTtsProviderOptions, TtsProvider, TtsProviderId } from './types'

const DEFAULTS = {
  elevenlabs: {
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_multilingual_v2',
    voice: 'pNInz6obpgDQGcFmaJgB',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash-preview-tts',
    voice: 'Kore',
  },
  xai: {
    baseUrl: 'https://api.x.ai/v1',
    voice: 'eve',
    language: 'en',
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'voxtral-mini-tts-2603',
    voice: 'c69964a6-ab8b-4f8a-9465-ec0925096ec8',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io/v1/t2a_v2',
    model: 'speech-02-hd',
    voice: 'English_expressive_narrator',
  },
} as const

function requireText(raw: string, provider: string): string {
  const text = clampTtsText(cleanTtsText(raw))
  if (!text) throw new Error(`${provider} TTS text is empty after cleaning`)
  return text
}

function requireApiKey(options: CloudTtsProviderOptions, provider: string): string {
  const apiKey = String(options.apiKey || '').trim()
  if (!apiKey) throw new Error(`${provider} TTS API key is required`)
  return apiKey
}

function providerUrl(rawBaseUrl: unknown, defaultBaseUrl: string, provider: string): URL {
  const url = new URL(String(rawBaseUrl || defaultBaseUrl).trim())
  assertSafeTtsBaseUrl(url, provider)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url
}

function appendPath(url: URL, path: string): URL {
  const result = new URL(url)
  const suffix = path.startsWith('/') ? path : `/${path}`
  result.pathname = `${result.pathname.replace(/\/+$/, '')}${suffix}`
  return result
}

function numberOption(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function checkedResponse(response: Response, provider: string, apiKey: string): Promise<Response> {
  if (response.ok) return response
  const detail = (await response.text().catch(() => response.statusText || ''))
    .replaceAll(apiKey, '[redacted]')
    .slice(0, 500)
  throw new Error(`${provider} TTS returned ${response.status}${detail ? `: ${detail}` : ''}`)
}

function result(
  provider: TtsProviderId,
  audio: Buffer,
  contentType: string,
): { audio: Buffer; contentType: string; engine: string; provider: TtsProviderId } {
  if (!audio.length) throw new Error(`${provider} TTS returned empty audio`)
  return { audio, contentType, engine: provider, provider }
}

function wrapPcmAsWav(pcm: Buffer, sampleRate = 24_000, channels = 1, sampleWidth = 2): Buffer {
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * sampleWidth, 28)
  header.writeUInt16LE(channels * sampleWidth, 32)
  header.writeUInt16LE(sampleWidth * 8, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm])
}

export const elevenLabsTtsProvider: TtsProvider<CloudTtsProviderOptions> = {
  id: 'elevenlabs',
  async synthesize(req, options) {
    const apiKey = requireApiKey(options, 'ElevenLabs')
    const text = requireText(req.text, 'ElevenLabs')
    const voice = String(options.voice || DEFAULTS.elevenlabs.voice).trim()
    const url = appendPath(
      providerUrl(options.baseUrl, DEFAULTS.elevenlabs.baseUrl, 'ElevenLabs'),
      `/text-to-speech/${encodeURIComponent(voice)}`,
    )
    url.searchParams.set('output_format', 'mp3_44100_128')
    const response = await checkedResponse(await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: options.model || DEFAULTS.elevenlabs.model,
      }),
      signal: req.signal,
    }), 'ElevenLabs', apiKey)
    return result('elevenlabs', Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') || 'audio/mpeg')
  },
}

export const xaiTtsProvider: TtsProvider<CloudTtsProviderOptions> = {
  id: 'xai',
  async synthesize(req, options) {
    const apiKey = requireApiKey(options, 'xAI')
    const url = appendPath(providerUrl(options.baseUrl, DEFAULTS.xai.baseUrl, 'xAI'), '/tts')
    const sampleRate = numberOption(options.sampleRate, 24_000)
    const bitRate = numberOption(options.bitRate, 128_000)
    const response = await checkedResponse(await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: requireText(req.text, 'xAI'),
        voice_id: options.voice || DEFAULTS.xai.voice,
        language: options.language || DEFAULTS.xai.language,
        output_format: {
          codec: options.format === 'wav' ? 'wav' : 'mp3',
          sample_rate: sampleRate,
          ...(options.format === 'wav' ? {} : { bit_rate: bitRate }),
        },
        ...(options.speed ? { speed: Math.max(0.7, Math.min(1.5, numberOption(options.speed, 1))) } : {}),
      }),
      signal: req.signal,
    }), 'xAI', apiKey)
    return result('xai', Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') || 'audio/mpeg')
  },
}

export const mistralTtsProvider: TtsProvider<CloudTtsProviderOptions> = {
  id: 'mistral',
  async synthesize(req, options) {
    const apiKey = requireApiKey(options, 'Mistral')
    const url = appendPath(providerUrl(options.baseUrl, DEFAULTS.mistral.baseUrl, 'Mistral'), '/audio/speech')
    const response = await checkedResponse(await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: options.model || DEFAULTS.mistral.model,
        input: requireText(req.text, 'Mistral'),
        voice_id: options.voice || DEFAULTS.mistral.voice,
        response_format: options.format || 'mp3',
      }),
      signal: req.signal,
    }), 'Mistral', apiKey)
    const payload = await response.json() as { audio_data?: unknown }
    const audio = typeof payload.audio_data === 'string' ? Buffer.from(payload.audio_data, 'base64') : Buffer.alloc(0)
    return result('mistral', audio, options.format === 'wav' ? 'audio/wav' : 'audio/mpeg')
  },
}

export const geminiTtsProvider: TtsProvider<CloudTtsProviderOptions> = {
  id: 'gemini',
  async synthesize(req, options) {
    const apiKey = requireApiKey(options, 'Gemini')
    const model = String(options.model || DEFAULTS.gemini.model).trim()
    const url = appendPath(
      providerUrl(options.baseUrl, DEFAULTS.gemini.baseUrl, 'Gemini'),
      `/models/${encodeURIComponent(model)}:generateContent`,
    )
    url.searchParams.set('key', apiKey)
    const response = await checkedResponse(await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: requireText(req.text, 'Gemini') }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: options.voice || DEFAULTS.gemini.voice },
            },
          },
        },
      }),
      signal: req.signal,
    }), 'Gemini', apiKey)
    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: unknown }; inline_data?: { data?: unknown } }> } }>
    }
    const parts = payload.candidates?.[0]?.content?.parts || []
    const encoded = parts
      .map(part => part.inlineData?.data ?? part.inline_data?.data)
      .find(value => typeof value === 'string')
    const pcm = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : Buffer.alloc(0)
    if (!pcm.length) throw new Error('Gemini TTS returned empty audio')
    return result('gemini', wrapPcmAsWav(pcm), 'audio/wav')
  },
}

export const minimaxTtsProvider: TtsProvider<CloudTtsProviderOptions> = {
  id: 'minimax',
  async synthesize(req, options) {
    const apiKey = requireApiKey(options, 'MiniMax')
    const url = providerUrl(options.baseUrl, DEFAULTS.minimax.baseUrl, 'MiniMax')
    if (options.groupId && !url.searchParams.has('GroupId')) {
      url.searchParams.set('GroupId', options.groupId)
    }
    const isV2 = url.pathname.includes('t2a_v2')
    const common = {
      model: options.model || DEFAULTS.minimax.model,
      text: requireText(req.text, 'MiniMax'),
    }
    const body = isV2
      ? {
          ...common,
          voice_setting: {
            voice_id: options.voice || DEFAULTS.minimax.voice,
            speed: numberOption(options.speed, 1),
            vol: numberOption(options.volume, 1),
            pitch: numberOption(options.pitch, 0),
            emotion: options.emotion || 'neutral',
          },
          audio_setting: {
            sample_rate: numberOption(options.sampleRate, 32_000),
            bitrate: numberOption(options.bitRate, 128_000),
            format: 'mp3',
            channel: 1,
          },
        }
      : {
          ...common,
          voice_id: options.voice || DEFAULTS.minimax.voice,
        }
    const response = await checkedResponse(await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: req.signal,
    }), 'MiniMax', apiKey)

    if (!isV2 && (response.headers.get('content-type') || '').startsWith('audio/')) {
      return result('minimax', Buffer.from(await response.arrayBuffer()), response.headers.get('content-type') || 'audio/mpeg')
    }
    const payload = await response.json() as {
      data?: { audio?: unknown }
      base_resp?: { status_code?: unknown; status_msg?: unknown }
    }
    if (Number(payload.base_resp?.status_code) !== 0) {
      throw new Error(`MiniMax TTS API error: ${String(payload.base_resp?.status_msg || 'unknown error')}`)
    }
    const audio = typeof payload.data?.audio === 'string' ? Buffer.from(payload.data.audio, 'hex') : Buffer.alloc(0)
    return result('minimax', audio, 'audio/mpeg')
  },
}
