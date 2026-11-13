import type { OpenaiTtsProviderOptions, TtsProvider } from './types'
import { cleanTtsText, clampTtsText } from './text'
import { textToSpeech } from '../core'
import { logger } from '../../../../public/logging'

function edgeOutputFormat(opts: OpenaiTtsProviderOptions): { outputFormat?: string; contentType: string } {
  const format = String(opts.format || '').trim().toLowerCase()
  if (format === 'pcm' || format === 'raw' || format === 's16le') {
    // Edge raw PCM synthesis can hang with node-edge-tts. Return MP3 and let
    // MCU callers transcode it to PCM with ffmpeg.
    return {
      outputFormat: undefined,
      contentType: 'audio/mpeg',
    }
  }
  return { contentType: 'audio/mpeg' }
}

function normalizeEdgeRate(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  if (!raw) return undefined
  if (/^[+-]?\d+%$/.test(raw)) return raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`

  const multiplier = Number(raw)
  if (!Number.isFinite(multiplier)) return raw
  const percent = Math.round((multiplier - 1) * 100)
  return percent >= 0 ? `+${percent}%` : `${percent}%`
}

function normalizeEdgePitch(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  if (!raw) return undefined
  if (/^[+-]?\d+Hz$/i.test(raw)) return raw.startsWith('+') || raw.startsWith('-') ? raw : `+${raw}`

  const hz = Number(raw)
  if (!Number.isFinite(hz)) return raw
  return hz >= 0 ? `+${Math.round(hz)}Hz` : `${Math.round(hz)}Hz`
}

export const edgeTtsProvider: TtsProvider<OpenaiTtsProviderOptions> = {
  id: 'edge',
  async synthesize(req, opts) {
    const text = clampTtsText(cleanTtsText(req.text))

    if (!text) {
      throw new Error('Edge TTS text is empty after cleaning')
    }

    const output = edgeOutputFormat(opts)
    const rate = normalizeEdgeRate(opts.rate)
    const pitch = normalizeEdgePitch(opts.pitch)
    logger.info({
      provider: 'edge',
      voice: opts.voice,
      rate,
      pitch,
      outputFormat: output.outputFormat || 'audio-24khz-48kbitrate-mono-mp3',
      textChars: text.length,
    }, '[tts:edge] synthesizing speech')

    let audio: Buffer
    let engine: string
    try {
      const result = await withAbortSignal(
        () => textToSpeech({
          text,
          voice: opts.voice,
          rate,
          pitch,
          outputFormat: output.outputFormat,
        }),
        req.signal,
      )
      audio = result.audio
      engine = result.engine
    } catch (err) {
      logger.warn({
        err,
        provider: 'edge',
        voice: opts.voice,
        rate,
        pitch,
        textChars: text.length,
      }, '[tts:edge] speech synthesis failed')
      throw err
    }

    return {
      audio,
      contentType: output.contentType,
      engine,
      provider: 'edge',
    }
  },
}

async function withAbortSignal<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return run()
  }

  if (signal.aborted) {
    throw createAbortError()
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError())
    }

    signal.addEventListener('abort', onAbort, { once: true })

    run().then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation was aborted.', 'AbortError')
  }

  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}
