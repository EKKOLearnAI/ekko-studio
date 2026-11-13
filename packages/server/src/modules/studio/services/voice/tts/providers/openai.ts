import type { OpenaiTtsProvider, TtsProviderId } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { assertSafeTtsBaseUrl } from './url-safety'

function buildSpeechUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  assertSafeTtsBaseUrl(url, 'OpenAI')

  const search = url.search
  url.hash = ''

  const pathname = url.pathname.replace(/\/+$/, '')

  if (!pathname || pathname === '/') {
    return `${url.origin}/audio/speech${search}`
  }

  if (pathname.endsWith('/audio/speech')) {
    return `${url.origin}${pathname}${search}`
  }

  return `${url.origin}${pathname}/audio/speech${search}`
}

/**
 * Read the formats an endpoint says it accepts out of its own rejection.
 *
 * OpenAI-compatible speech endpoints do not all support mp3: Groq's Orpheus
 * models answer `response_format must be one of [wav]`. The list is right there
 * in the error, so honour it instead of making the user guess the format.
 */
function supportedFormatsFromError(body: string): string[] {
  const match = body.match(/response_format must be one of \[([^\]]+)\]/i)
  if (!match) return []
  return match[1]
    .split(',')
    .map(value => value.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

export function createOpenaiCompatibleTtsProvider(
  id: Extract<TtsProviderId, 'openai' | 'custom' | 'deepinfra'>,
  options: { engine?: string; defaultBaseUrl?: string; defaultModel?: string; defaultVoice?: string } = {},
): OpenaiTtsProvider {
  return {
    id,
    async synthesize(req, opts) {
      const baseUrl = String(opts.baseUrl || options.defaultBaseUrl || '').trim()
      if (!baseUrl) {
        throw new Error(`${id} TTS baseUrl is required`)
      }
      const speechUrl = buildSpeechUrl(baseUrl)
      const text = clampTtsText(cleanTtsText(req.text))

      if (!text) {
        throw new Error('OpenAI TTS text is empty after cleaning')
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      if (opts.apiKey) {
        headers.Authorization = `Bearer ${opts.apiKey}`
      }

      const speak = (format?: string) => fetch(speechUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: opts.model || options.defaultModel || 'tts-1',
          voice: opts.voice || options.defaultVoice || 'alloy',
          input: text,
          ...(opts.rate ? { rate: opts.rate } : {}),
          ...(opts.pitch ? { pitch: opts.pitch } : {}),
          ...(format ? { response_format: format } : {}),
        }),
        signal: req.signal,
      })

      let res = await speak(opts.format)

      if (!res.ok) {
        let body = await res.text().catch(() => '')
        // The endpoint just told us which formats it takes — take it at its word,
        // once, rather than failing with a message only the server understands.
        const [fallbackFormat] = supportedFormatsFromError(body)
        if (fallbackFormat && fallbackFormat !== opts.format) {
          res = await speak(fallbackFormat)
          if (!res.ok) body = await res.text().catch(() => '')
        }
        if (!res.ok) {
          throw new Error(`OpenAI TTS returned ${res.status}: ${body || res.statusText}`)
        }
      }

      return {
        audio: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'audio/mpeg',
        engine: options.engine || id,
        provider: id,
      }
    },
  }
}

export const openaiTtsProvider: OpenaiTtsProvider = createOpenaiCompatibleTtsProvider('openai')
export const customTtsProvider: OpenaiTtsProvider = createOpenaiCompatibleTtsProvider('custom')
export const deepinfraTtsProvider: OpenaiTtsProvider = createOpenaiCompatibleTtsProvider('deepinfra', {
  defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
  defaultVoice: 'default',
})
