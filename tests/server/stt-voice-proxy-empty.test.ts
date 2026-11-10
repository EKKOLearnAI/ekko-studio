import Koa from 'koa'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ baseUrl: '', configured: true }))
vi.mock('../../packages/server/src/modules/studio/public/voice-settings', () => ({
  getActiveSttProvider: () => 'custom',
  isStoredSttProvider: (value: string) => value === 'custom',
  getSttProviderSetting: () => fixture.configured ? {
    settings: { baseUrl: fixture.baseUrl, model: 'fixture-model' },
    secrets: { apiKey: 'fixture-key' },
  } : null,
  SttSettingsValidationError: class extends Error {},
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNames: () => ['fixture'] }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: {} }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/access', () => ({}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: {} }))
vi.mock('../../packages/server/src/modules/studio/public/mcu-voice', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/global-agent/mcu-agent-runtime', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/mcu/prompts', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/config-sync', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/local-model-manager', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/doubao', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/voice/stt/hermes-cloud', () => ({}))

import { sttProtectedRoutes } from '../../packages/server/src/modules/studio/routes/stt'

let upstream: Server
let proxy: Server
let proxyUrl: string
let upstreamStatus: number
let upstreamBody: string
let disconnect: boolean
let upstreamCalls: number

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

beforeAll(async () => {
  upstream = createServer(async (req, res) => {
    upstreamCalls++
    expect(req.url).toBe('/v1/audio/transcriptions')
    expect(req.headers.authorization).toBe('Bearer fixture-key')
    for await (const _ of req) { /* Drain the synthetic multipart upload. */ }
    if (disconnect) { req.socket.destroy(); return }
    res.writeHead(upstreamStatus, { 'content-type': 'application/json' })
    res.end(upstreamBody)
  })
  fixture.baseUrl = `${await listen(upstream)}/v1`
  const app = new Koa()
  app.use(sttProtectedRoutes.routes())
  proxy = createServer(app.callback())
  proxyUrl = await listen(proxy)
})

afterAll(async () => { await Promise.all([close(proxy), close(upstream)]) })
beforeEach(() => {
  upstreamStatus = 200
  upstreamBody = JSON.stringify({ text: '' })
  disconnect = false
  upstreamCalls = 0
  fixture.configured = true
})

async function transcribe(format = 'json', profile = 'fixture') {
  const form = new FormData()
  form.append('file', new Blob(['synthetic audio bytes'], { type: 'audio/wav' }), 'fixture.wav')
  form.append('response_format', format)
  return fetch(`${proxyUrl}/api/studio/voice/proxy/${profile}/v1/audio/transcriptions`, { method: 'POST', body: form })
}

it.each(['', ' \t\r\n '])('returns a successful empty transcript for upstream text %j', async text => {
  upstreamBody = JSON.stringify({ text })
  const response = await transcribe()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: '' })
  expect(upstreamCalls).toBe(1)
})

it('returns an empty plain-text body when requested', async () => {
  const response = await transcribe('text')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/plain')
  expect(await response.text()).toBe('')
})

it('keeps normal transcript trimming', async () => {
  upstreamBody = JSON.stringify({ text: '  Fixture transcript.  ' })
  const response = await transcribe()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ text: 'Fixture transcript.' })
})

it.each([401, 500])('keeps upstream HTTP %s as a proxy failure and redacts the key', async status => {
  upstreamStatus = status
  upstreamBody = 'Rejected fixture-key'
  const response = await transcribe()
  expect(response.status).toBe(502)
  const body = await response.text()
  expect(body).toContain(`HTTP ${status}`)
  expect(body).not.toContain('fixture-key')
})

it.each(['not JSON', '{}', '{"text":null}', '{"text":12}', 'null'])('rejects malformed upstream transcription %s', async body => {
  upstreamBody = body
  const response = await transcribe()
  expect(response.status).toBe(502)
  expect(await response.json()).toHaveProperty('error')
})

it('keeps network disconnects as proxy failures', async () => {
  disconnect = true
  const response = await transcribe()
  expect(response.status).toBe(502)
  expect(await response.json()).toHaveProperty('error')
})

it('does not call upstream without configured credentials', async () => {
  fixture.configured = false
  const response = await transcribe()
  expect(response.status).toBe(409)
  expect(upstreamCalls).toBe(0)
})

it('preserves unknown-profile rejection', async () => {
  const response = await transcribe('json', 'unknown')
  expect(response.status).toBe(404)
  expect(upstreamCalls).toBe(0)
})

it('rejects invalid input format before calling upstream', async () => {
  const response = await fetch(`${proxyUrl}/api/studio/voice/proxy/fixture/v1/audio/transcriptions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  expect(response.status).toBe(400)
  expect(upstreamCalls).toBe(0)
})
