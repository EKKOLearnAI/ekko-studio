import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../packages/server/src/modules/studio/services/voice/tts/providers/url-safety', () => ({
  assertSafeResolvedTtsBaseUrl: async () => {},
}))

import {
  transcribeElevenLabs,
  transcribeXai,
} from '../../packages/server/src/modules/studio/services/voice/stt/hermes-cloud'
import type { SttTranscribeInput } from '../../packages/server/src/modules/studio/services/voice/stt/types'

const providers = [
  ['xai', transcribeXai],
  ['elevenlabs', transcribeElevenLabs],
] as const

function input(provider: SttTranscribeInput['provider']): SttTranscribeInput {
  return {
    provider,
    audio: Buffer.from('synthetic audio bytes'),
    fileName: 'fixture.wav',
    mimeType: 'audio/wav',
    settings: {},
    secrets: { apiKey: 'fixture-key' },
  }
}

function upstream(body: string) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })))
}

afterEach(() => { vi.unstubAllGlobals() })

const cases = (values: string[]) => providers.flatMap(([provider, transcribe]) =>
  values.map(value => ({ provider, transcribe, value })))

it.each(cases(['', ' \n ']))('$provider returns an empty transcript for upstream text $value', async ({ provider, transcribe, value }) => {
  upstream(JSON.stringify({ text: value, language: 'en' }))
  await expect(transcribe(input(provider))).resolves.toMatchObject({ text: '', provider })
})

it.each(cases(['  Fixture transcript.  ']))('$provider keeps normal transcript trimming', async ({ provider, transcribe, value }) => {
  upstream(JSON.stringify({ text: value }))
  await expect(transcribe(input(provider))).resolves.toMatchObject({ text: 'Fixture transcript.' })
})

it.each(cases(['{}', '{"text":null}', '{"text":12}', 'null', '[]']))('$provider rejects a missing or invalid transcript $value', async ({ provider, transcribe, value }) => {
  upstream(value)
  await expect(transcribe(input(provider))).rejects.toThrow(`${provider} STT response text is missing or invalid`)
})
