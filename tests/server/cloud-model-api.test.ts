import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
const mocks = vi.hoisted(() => ({ grants: [] as any[], key: null as any, user: { status: 'active' } as any }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ findUserById: () => mocks.user }))
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({ listAppConnections: () => mocks.grants }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/keys', () => ({ findModelApiKey: () => mocks.key }))
import { CloudModelApiSessions } from '../../packages/server/src/modules/studio/services/app-relay/model-api'
import { claimCloudUsageReceipt } from '../../packages/server/src/modules/studio/services/model-api/cloud-usage'

let bridge: CloudModelApiSessions
const key = `sk-ekko-${'a'.repeat(43)}`
const input = () => ({ id: randomUUID(), endpoint: 'responses', apiKey: key, studioUserId: 7, cloudUserId: 9, body: Buffer.from('{"input":"hi"}'), maxDownloadBytes: 100000 })
beforeEach(() => {
  mocks.key = { id: 'key-1', userId: 7 }
  mocks.user = { status: 'active' }
  mocks.grants = [{ connection_type: 'cloud', user_id: 7, cloud_user_id: 9, token_expires_at: Date.now() / 1000 + 600, revoked_at: null }]
})
afterEach(() => bridge?.cancelAll())

it('requires both the key owner and a valid formal cloud grant before fetching', async () => {
  const fetcher = vi.fn()
  bridge = new CloudModelApiSessions('http://127.0.0.1:8648', fetcher)
  mocks.key = { id: 'key-1', userId: 8 }
  expect(await bridge.open(input())).toMatchObject({ status: 403 })
  mocks.key = { id: 'key-1', userId: 7 }
  const base = mocks.grants[0]
  for (const grant of [[], [{ ...base, connection_type: 'lan' }], [{ ...base, cloud_user_id: 10 }], [{ ...base, token_expires_at: 1 }]]) {
    mocks.grants = grant
    expect(await bridge.open(input())).toMatchObject({ status: 403 })
  }
  expect(fetcher).not.toHaveBeenCalled()
})

it('returns the first SSE event before completion, preserves UTF-8 bytes and bounds every chunk', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(c) { controller = c } }), { headers: { 'content-type': 'text/event-stream' } }))
  bridge = new CloudModelApiSessions('http://localhost:8648', fetcher)
  const request = input()
  expect(await bridge.open(request)).toMatchObject({ ok: true, contentType: 'text/event-stream' })
  expect(fetcher).toHaveBeenCalledWith('http://localhost:8648/api/ekko-studio/models/v1/responses', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-studio-cloud-usage': expect.any(String) }) }))
  const event = Buffer.from('event: response.output_text.delta\ndata: {"delta":"你好"}\n\n')
  controller.enqueue(event)
  const first = await bridge.read(request.id)
  expect(Buffer.from(first.data as Buffer)).toEqual(event)
  controller.enqueue(Buffer.alloc(40000, 65))
  expect((await bridge.read(request.id)).data).toHaveLength(32768)
  expect((await bridge.read(request.id)).data).toHaveLength(7232)
  controller.close()
  expect(await bridge.read(request.id)).toMatchObject({ done: true })
})

it('checks grants and key revocation after a pending read and aborts the upstream on cancellation', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let signal!: AbortSignal
  bridge = new CloudModelApiSessions('http://localhost', (async (_url, init) => {
    signal = init!.signal as AbortSignal
    return new Response(new ReadableStream({ start(c) { controller = c } }))
  }) as typeof fetch)
  const request = input()
  await bridge.open(request)
  const pending = bridge.read(request.id)
  mocks.key = null
  controller.enqueue(Buffer.from('secret'))
  expect(await pending).toMatchObject({ ok: false, error: 'cloud_model_access_denied' })
  expect(signal.aborted).toBe(true)
  mocks.key = { id: 'key-1', userId: 7 }
  const next = input()
  await bridge.open(next)
  bridge.cancelAll()
  expect(signal.aborted).toBe(true)
  expect(await bridge.read(next.id)).toMatchObject({ ok: false })
})

it('caps cumulative downloads and rejects arbitrary endpoints and redirects', async () => {
  const fetcher = vi.fn(async () => new Response('123456789'))
  bridge = new CloudModelApiSessions('http://localhost', fetcher)
  expect(await bridge.open({ ...input(), endpoint: '../settings' })).toMatchObject({ status: 400 })
  const request = { ...input(), maxDownloadBytes: 5 }
  await bridge.open(request)
  expect(await bridge.read(request.id)).toMatchObject({ error: 'download_too_large' })
})

it('authorizes without fetching or allocating streams, and rechecks revocation when opening', async () => {
  const fetcher = vi.fn()
  bridge = new CloudModelApiSessions('http://localhost', fetcher)
  const request = input()
  for (let i = 0; i < 40; i++) expect(bridge.authorize(request)).toEqual({ ok: true, version: 3 })
  expect(fetcher).not.toHaveBeenCalled()
  mocks.key = null
  expect(await bridge.open(request)).toMatchObject({ ok: false, status: 403 })
  expect(fetcher).not.toHaveBeenCalled()
  mocks.key = { id: 'key-1', userId: 7 }
  mocks.user = { status: 'disabled' }
  expect(bridge.authorize(request)).toMatchObject({ ok: false, status: 403 })
  mocks.user = { status: 'active' }
  mocks.grants[0].cloud_revocation_pending = true
  expect(bridge.authorize(request)).toMatchObject({ ok: false, status: 403 })
})

it.each([false, true])('reports only settlement metadata for JSON/SSE, even after cancellation (stream=%s)', async stream => {
  const report = vi.fn()
  let settle!: ReturnType<typeof claimCloudUsageReceipt>
  const fetcher = vi.fn(async (_url: any, init: any) => {
    const token = init.headers['x-studio-cloud-usage']
    expect(claimCloudUsageReceipt(token, 8, 'key-1')).toBeUndefined()
    expect(claimCloudUsageReceipt(token, 7, 'another-key')).toBeUndefined()
    settle = claimCloudUsageReceipt(token, 7, 'key-1')
    expect(claimCloudUsageReceipt(token, 7, 'key-1')).toBeUndefined()
    return new Response('private answer', { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } })
  })
  bridge = new CloudModelApiSessions('http://localhost', fetcher as any, report)
  const request = input()
  await bridge.open(request)
  bridge.cancel(request.id)
  settle!({ inputTokens: 80, outputTokens: 12, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 2, isEstimated: false, costUsd: 0.012, costSource: 'estimated' })
  expect(report).toHaveBeenCalledExactlyOnceWith({ id: request.id, inputTokens: 80, outputTokens: 12, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 2, costUsd: 0.012, costSource: 'estimated' })
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/private|apiKey|"body"|"input"/)
})

it('keeps unavailable provider usage unknown and allows a late catalog price fill on the same call', async () => {
  const report = vi.fn()
  let settle!: ReturnType<typeof claimCloudUsageReceipt>
  bridge = new CloudModelApiSessions('http://localhost', (async (_url: any, init: any) => {
    settle = claimCloudUsageReceipt(init.headers['x-studio-cloud-usage'], 7, 'key-1')
    return Response.json({})
  }) as any, report)
  const request = input()
  await bridge.open(request)
  const tokens = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  settle!({ ...tokens, isEstimated: true })
  expect(report.mock.calls[0][0]).toMatchObject({ id: request.id, inputTokens: null, outputTokens: null, costUsd: null, costSource: 'unknown' })
  settle!({ ...tokens, isEstimated: false })
  settle!({ ...tokens, isEstimated: false, costUsd: 0, costSource: 'reported' })
  expect(report.mock.calls.at(-1)![0]).toMatchObject({ id: request.id, inputTokens: 3, costUsd: 0, costSource: 'reported' })
})
