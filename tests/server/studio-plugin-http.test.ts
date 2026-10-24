import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { StudioError } from '../../packages/studio-plugin-sdk/src'
import { DatabaseSync } from 'node:sqlite'
import { PluginConsumerStore } from '../../packages/server/src/modules/studio/repositories/plugin-consumer-store'
import { ReliablePluginConsumers } from '../../packages/server/src/modules/studio/services/events/reliable-consumers'

const state = vi.hoisted(() => ({ remove: vi.fn(), configure: vi.fn(), install: vi.fn(), diagnostic: vi.fn(), list: vi.fn(() => []),
  uploadImage: vi.fn(), removeImage: vi.fn(), respond: vi.fn(), interactions: vi.fn(() => []), usage: vi.fn(() => []), cancel: vi.fn(), updateInstance: vi.fn(), inspectInstance: vi.fn(), role: 'super_admin', consumers: null as unknown as ReliablePluginConsumers }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/runtime', () => ({
  authorizePluginScope: vi.fn(),
  getStudioPluginRuntime: () => ({ host: { uninstall: state.remove, configure: state.configure, install: state.install, list: state.list, diagnostic: state.diagnostic },
    artifacts: { create: state.uploadImage, remove: state.removeImage }, consumers: state.consumers, registry: { list: () => [], getRevision: () => 1 }, coordinator: { respond: state.respond, interactions: state.interactions, usage: state.usage, cancel: state.cancel, updateInstance: state.updateInstance, inspectInstance: state.inspectInstance } }),
}))
import { studioPluginRoutes } from '../../packages/server/src/modules/studio/routes/studio-plugins'

let server: Server, base: string, db: DatabaseSync
beforeAll(async () => {
  db = new DatabaseSync(':memory:'); state.consumers = new ReliablePluginConsumers(new PluginConsumerStore(db))
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    ctx.state.user = { id: 7, username: 'fixture', role: state.role as 'super_admin' | 'admin' }
    if (ctx.query.profile) ctx.state.profile = { name: String(ctx.query.profile) }
    await next()
  })
  app.use(studioPluginRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server.close(); await once(server, 'close'); await state.consumers.close(); db.close() })

it('returns a stable protection error for system deletion', async () => {
  state.remove.mockImplementation(() => { throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'System plugins cannot be uninstalled') })
  const response = await fetch(`${base}/api/studio/plugins/studio.agent-codex`, { method: 'DELETE' })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SYSTEM_PLUGIN_PROTECTED', retryable: false } })
})

it('restricts diagnostics to an authorized administrator and profile', async () => {
  state.diagnostic.mockReturnValue({ state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' })
  expect((await fetch(`${base}/api/studio/plugins/test.provider/diagnostic`)).status).toBe(400)
  state.role = 'admin'
  try { expect((await fetch(`${base}/api/studio/plugins/test.provider/diagnostic?profile=one`)).status).toBe(403) }
  finally { state.role = 'super_admin' }
  expect(state.diagnostic).not.toHaveBeenCalled()
  const response = await fetch(`${base}/api/studio/plugins/test.provider/diagnostic?profile=one`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, data: { state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' } })
  expect(state.diagnostic).toHaveBeenCalledWith('test.provider', 'one')
})

it('rejects non-super-admin plugin management before invoking services', async () => {
  state.role = 'admin'
  state.install.mockClear()
  try {
    const response = await fetch(`${base}/api/studio/plugins`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/plugin' }) })
    expect(response.status).toBe(403)
    expect(state.install).not.toHaveBeenCalled()
  } finally { state.role = 'super_admin' }
})

it('rejects caller-selected identity and requires an authorized profile', async () => {
  state.configure.mockClear()
  const request = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, config: {}, grants: [], revision: 0, ownerId: 'another-user' }) }
  expect((await fetch(`${base}/api/studio/plugins/example.echo/profile`, request)).status).toBe(400)
  expect((await fetch(`${base}/api/studio/plugins/example.echo/profile?profile=default`, request)).status).toBe(400)
  expect(state.configure).not.toHaveBeenCalled()
})


it('routes lifecycle calls with host identity and rejects forged response fields', async () => {
  state.respond.mockResolvedValue({ id: 'interaction', runId: 'run', status: 'resolved' })
  const request = { interactionId: 'interaction', idempotencyKey: 'answer', choiceId: 'yes' }
  const response = await fetch(`${base}/api/studio/agent-runs/run/respond?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  })
  expect(response.status).toBe(200)
  expect(state.respond).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), 'run', request)
  expect(await response.json()).toEqual({ ok: true, data: { id: 'interaction', runId: 'run', status: 'resolved' } })
  state.respond.mockClear()
  const forged = await fetch(`${base}/api/studio/agent-runs/run/respond?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, ownerId: 'other' }),
  })
  expect(forged.status).toBe(400)
  expect(state.respond).not.toHaveBeenCalled()
  for (const method of ['interactions', 'usage'] as const) {
    expect((await fetch(`${base}/api/studio/agent-runs/run/${method}?profile=default`)).status).toBe(200)
    expect(state[method]).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), 'run')
  }
})

it('returns a finalization conflict without reporting cancellation', async () => {
  state.cancel.mockRejectedValue(new StudioError('RUN_FINALIZING', 'Run is committing its final result'))
  const response = await fetch(`${base}/api/studio/agent-runs/run/cancel?profile=default`, { method: 'POST' })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'RUN_FINALIZING' } })
})

it('configures only the authenticated owner instance and surfaces active-run conflicts', async () => {
  state.updateInstance.mockReset().mockResolvedValue({ id: 'instance', revision: 2 })
  const configuration = { revision: 1, config: { cwd: '/fixture' }, mode: 'global' }
  const request = (body: unknown, profile = '?profile=default') => fetch(`${base}/api/studio/agent-instances/instance${profile}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await request(configuration, '')).status).toBe(400)
  expect((await request({ ...configuration, ownerId: 'forged' })).status).toBe(400)
  expect((await request({ ...configuration, agentTypeId: 'other' })).status).toBe(400)
  expect(state.updateInstance).not.toHaveBeenCalled()
  const response = await request(configuration)
  expect(await response.json()).toEqual({ ok: true, data: { id: 'instance', revision: 2 } })
  expect(state.updateInstance).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' }, profileId: 'default' }), 'instance', configuration)
  state.updateInstance.mockRejectedValue(new StudioError('REVISION_CONFLICT', 'Active run'))
  expect((await request(configuration)).status).toBe(409)
})

it('inspects using the authenticated owner, rejects configuration overrides, and prevents caching', async () => {
  state.inspectInstance.mockResolvedValue({ native: { name: 'Fixture' } })
  const request = (body: unknown, profile = '?profile=default') => fetch(`${base}/api/studio/agent-instances/instance/inspect${profile}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await request({}, '')).status).toBe(400)
  expect((await request({ config: {} })).status).toBe(400)
  expect((await request({ ownerId: 'forged' })).status).toBe(400)
  expect(state.inspectInstance).not.toHaveBeenCalled()
  const response = await request({})
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(state.inspectInstance).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), 'instance', expect.any(AbortSignal))
  state.inspectInstance.mockRejectedValue(new StudioError('CAPABILITY_UNSUPPORTED', 'No inspection'))
  expect((await request({})).status).toBe(422)
})

it('cancels a native inspection when the HTTP client disconnects', async () => {
  let signal: AbortSignal | undefined
  state.inspectInstance.mockImplementation((_scope, _id, current: AbortSignal) => {
    signal = current
    return new Promise((_resolve, reject) => current.addEventListener('abort', () => reject(new StudioError('CANCELLED', 'Disconnected')), { once: true }))
  })
  const controller = new AbortController()
  const pending = fetch(`${base}/api/studio/agent-instances/instance/inspect?profile=default`, { method: 'POST', signal: controller.signal }).catch(error => error)
  await vi.waitFor(() => expect(signal).toBeDefined())
  controller.abort()
  expect(await pending).toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(signal!.aborted).toBe(true))
})

it('scopes consumer management to an administrator, plugin and profile and requires explicit revisions', async () => {
  const record = state.consumers.store.register({ pluginId: 'test.consumer', profileId: 'one', ownerId: '7', name: 'history' }, { types: ['run.completed'], start: 'now', resume: 'continue' })
  const path = `/api/studio/plugins/test.consumer/consumers/${record.id}`
  expect((await fetch(`${base}/api/studio/plugins/test.consumer/consumers`)).status).toBe(400)
  state.role = 'admin'
  try { expect((await fetch(`${base}${path}/deliveries?profile=one`)).status).toBe(403) }
  finally { state.role = 'super_admin' }
  expect((await fetch(`${base}${path}/deliveries?profile=two`)).status).toBe(404)
  expect((await fetch(`${base}${path.replace('test.consumer', 'other.plugin')}/deliveries?profile=one`)).status).toBe(404)
  const request = (input: unknown) => fetch(`${base}${path}/control?profile=one`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  expect((await request({ action: 'pause', revision: 1, ownerId: 'forged' })).status).toBe(400)
  expect((await request({ action: 'reset', revision: 1 })).status).toBe(400)
  expect((await request({ action: 'pause', revision: 2 })).status).toBe(409)
  expect((await request({ action: 'pause', revision: 1 })).status).toBe(200)
  expect(state.consumers.store.get(record.id)).toMatchObject({ state: 'paused', revision: 2 })
  expect((await request({ action: 'resume', revision: 2 })).status).toBe(200)
  expect(await (await fetch(`${base}${path}/deliveries?profile=one`)).json()).toEqual({ ok: true, data: [] })
  expect(await (await fetch(`${base}/api/studio/plugins/test.consumer/consumers?profile=one`)).json()).toMatchObject({ ok: true, data: [{ id: record.id, name: 'history' }] })
})

it('retries only the selected dead letter revision and reports expired cursors without silently resetting', async () => {
  const store = state.consumers.store
  const record = store.register({ pluginId: 'test.consumer', profileId: 'one', ownerId: '7', name: 'dead' }, { types: ['run.completed'], start: 'now', resume: 'continue' })
  store.events.append([{ schemaVersion: 1, id: 'dead-event', type: 'run.completed', occurredAt: 1, partitionKey: 'one:run', sequence: 0, subject: { profileId: 'one' }, data: { hidden: 'payload' }, correlationId: 'trace' }])
  store.fill(record.id)
  const delivery = store.claim(record.id, 0)!
  store.fail(delivery, 'INTERNAL', 0, 1)
  const metadata = store.deliveries(record.id)[0], path = `${base}/api/studio/plugins/test.consumer/consumers/${record.id}`
  const retry = (revision: number) => fetch(`${path}/retry?profile=one`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: metadata.position, revision }) })
  const diagnostics = JSON.stringify(await (await fetch(`${path}/deliveries?profile=one`)).json())
  expect(diagnostics).not.toContain('payload'); expect(diagnostics).not.toContain(delivery.lease)
  expect((await retry(metadata.revision - 1)).status).toBe(409)
  expect((await retry(metadata.revision)).status).toBe(200)
  store.events.prune(2)
  const expired = await fetch(`${path}/control?profile=one`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume', revision: record.revision }) })
  expect(expired.status).toBe(409)
  expect(await expired.json()).toMatchObject({ ok: false, error: { code: 'EVENT_CURSOR_EXPIRED' } })
  expect(store.get(record.id)?.state).toBe('expired')
})

it('uploads raw image bytes with host identity and rejects JSON paths and oversized bodies', async () => {
  state.uploadImage.mockResolvedValue({ id: 'image', mediaType: 'image/png', byteLength: 3 })
  state.uploadImage.mockClear()
  const response = await fetch(`${base}/api/studio/agent-images?profile=one`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3]),
  })
  expect(response.status).toBe(200)
  expect(state.uploadImage).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'one' }), Buffer.from([1, 2, 3]), expect.any(AbortSignal))
  state.uploadImage.mockClear()
  expect((await fetch(`${base}/api/studio/agent-images?profile=one`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/private.png', ownerId: 'other' }),
  })).status).toBe(400)
  expect((await fetch(`${base}/api/studio/agent-images?profile=one`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(4 * 1024 * 1024 + 1),
  })).status).toBe(429)
  expect(state.uploadImage).not.toHaveBeenCalled()
  expect((await fetch(`${base}/api/studio/agent-images/image?profile=one`, { method: 'DELETE' })).status).toBe(200)
  expect(state.removeImage).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'one' }), 'image')
})
