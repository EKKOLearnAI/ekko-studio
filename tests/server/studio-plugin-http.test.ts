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
  commands: { list: vi.fn(() => []), start: vi.fn(), get: vi.fn(), cancel: vi.fn() },
  bundledAgents: { list: vi.fn(() => []), enable: vi.fn() }, setupInstance: vi.fn(),
  createChat: vi.fn(), createOrdinaryChat: vi.fn(),
  authorizeResourceUpload: vi.fn(), importSkill: vi.fn(),
  ownedChat: vi.fn(), readChatImage: vi.fn(),
  startLogin: vi.fn(), startInstall: vi.fn(), management: { list: vi.fn(() => []), get: vi.fn(), output: vi.fn(), input: vi.fn(), resize: vi.fn(), cancel: vi.fn() },
  uploadImage: vi.fn(), removeImage: vi.fn(), respond: vi.fn(), interactions: vi.fn(() => []), usage: vi.fn(() => []), cancel: vi.fn(), updateInstance: vi.fn(), inspectInstance: vi.fn(), resourceLocations: vi.fn(), resourceFiles: vi.fn(), role: 'super_admin', consumers: null as unknown as ReliablePluginConsumers }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/runtime', () => ({
  authorizePluginScope: vi.fn(),
  getStudioPluginRuntime: () => ({ host: { uninstall: state.remove, configure: state.configure, install: state.install, list: state.list, diagnostic: state.diagnostic },
    agentChats: { create: state.createChat, ownedBinding: state.ownedChat },
    ordinaryChats: { create: state.createOrdinaryChat },
    bundledAgents: state.bundledAgents, commands: state.commands, artifacts: { create: state.uploadImage, remove: state.removeImage, readForChat: state.readChatImage }, consumers: state.consumers, registry: { list: () => [], getRevision: () => 1 }, coordinator: { authorizeResourceUpload: state.authorizeResourceUpload, importSkill: state.importSkill, startLogin: state.startLogin, startInstall: state.startInstall, managementOperations: state.management, setupInstance: state.setupInstance, respond: state.respond, interactions: state.interactions, usage: state.usage, cancel: state.cancel, updateInstance: state.updateInstance, inspectInstance: state.inspectInstance, resourceLocations: state.resourceLocations, resourceFiles: state.resourceFiles } }),
}))
import { studioPluginRoutes } from '../../packages/server/src/modules/studio/routes/studio-plugins'
import { executionScope } from '../../packages/server/src/modules/studio/controllers/studio-plugins'
import { bindRunRequestContext } from '../../packages/server/src/modules/studio/services/auth/run-request-context'

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

it('preserves authentication-owned Run bindings instead of granting native credentials an unbound management scope', () => {
  const ctx: any = { state: { user: { id: 7 }, profile: { name: 'one' } }, get: () => 'forged', request: { body: { runId: 'forged' } } }
  expect(executionScope(ctx)).not.toHaveProperty('runId')
  const release = bindRunRequestContext(ctx, { runId: 'canonical', sessionId: 'owned-chat', profile: 'one' })
  try {
    expect(executionScope(ctx)).toMatchObject({ runId: 'canonical', sessionId: 'owned-chat', profileId: 'one', principal: { kind: 'user', id: '7' } })
    ctx.state.profile.name = 'other'
    expect(() => executionScope(ctx)).toThrow(/authenticated Run/)
  } finally { release() }
})

it('creates an owned chat using only a saved instance revision and retry key', async () => {
  const input = { revision: 3, idempotencyKey: 'chat-create' }
  const receipt = { sessionId: 'owned-chat', instanceId: 'instance', profileId: 'one', configurationRevision: 3, createdAt: 1 }
  state.createChat.mockReturnValue(receipt)
  const request = (body: unknown, profile = '?profile=one') => fetch(`${base}/api/studio/agent-instances/instance/chats${profile}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await request(input, '')).status).toBe(400)
  for (const extra of [{ ownerId: 'other' }, { sessionId: 'other' }, { config: {} }, { scope: {} }]) expect((await request({ ...input, ...extra })).status).toBe(400)
  expect(state.createChat).not.toHaveBeenCalled()
  const response = await request(input)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ ok: true, data: receipt })
  expect(state.createChat).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' }, profileId: 'one' }), 'instance', input)
  state.createChat.mockImplementationOnce(() => { throw new StudioError('REVISION_CONFLICT', 'Instance changed') })
  expect((await request(input)).status).toBe(409)
})

it('imports multipart Skill files with host identity and only explicit revision, source and snapshot fields', async () => {
  state.importSkill.mockClear(); state.authorizeResourceUpload.mockReset()
  state.importSkill.mockResolvedValue({ name: 'uploaded', locationId: 'native', path: 'uploaded' })
  const upload = (extra = false) => {
    const data = new FormData()
    data.append('revision', '3'); data.append('snapshot', 'a'.repeat(64)); data.append('locationId', 'native')
    data.append('file', new Blob([Buffer.from('# Skill')]), 'uploaded/SKILL.md')
    if (extra) data.append('ownerId', 'another-user')
    return data
  }
  const url = `${base}/api/studio/agent-instances/instance/skills/import?profile=one`
  expect((await fetch(url, { method: 'POST', body: upload(true) })).status).toBe(400)
  expect(state.importSkill).not.toHaveBeenCalled()
  state.authorizeResourceUpload.mockImplementationOnce(() => { throw new StudioError('NOT_FOUND', 'Instance unavailable') })
  expect((await fetch(url, { method: 'POST', body: upload() })).status).toBe(404)
  expect(state.importSkill).not.toHaveBeenCalled()
  const response = await fetch(url, { method: 'POST', body: upload() })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(state.importSkill).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' }, profileId: 'one' }),
    'instance', 3, 'a'.repeat(64), 'native', [{ filename: 'uploaded/SKILL.md', data: Buffer.from('# Skill') }], expect.any(AbortSignal))
})

it('authorizes the live chat before serving historical image bytes with detected media type', async () => {
  state.ownedChat.mockImplementationOnce(() => { throw new StudioError('NOT_FOUND', 'Chat unavailable') })
  const path = `${base}/api/studio/agent-chats/chat/images/image?profile=one`
  expect((await fetch(path)).status).toBe(404)
  expect(state.readChatImage).not.toHaveBeenCalled()
  state.readChatImage.mockReturnValue({ mediaType: 'image/png', bytes: Buffer.from('fixture bytes') })
  const response = await fetch(path)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-type')).toBe('image/png')
  expect(await response.text()).toBe('fixture bytes')
  expect(state.readChatImage).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' }, profileId: 'one' }), 'chat', 'image')
})

it('returns a stable protection error for system deletion', async () => {
  state.remove.mockImplementation(() => { throw new StudioError('SYSTEM_PLUGIN_PROTECTED', 'System plugins cannot be uninstalled') })
  const response = await fetch(`${base}/api/studio/plugins/studio.agent-codex`, { method: 'DELETE' })
  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'SYSTEM_PLUGIN_PROTECTED', retryable: false } })
})

it('restricts global diagnostics to an authorized administrator without requiring a profile', async () => {
  state.diagnostic.mockReturnValue({ state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' })
  state.diagnostic.mockClear()
  state.role = 'admin'
  try { expect((await fetch(`${base}/api/studio/plugins/test.provider/diagnostic?profile=one`)).status).toBe(403) }
  finally { state.role = 'super_admin' }
  expect(state.diagnostic).not.toHaveBeenCalled()
  const response = await fetch(`${base}/api/studio/plugins/test.provider/diagnostic?profile=one`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, data: { state: 'blocked', errorCode: 'PLUGIN_UNAVAILABLE' } })
  expect(state.diagnostic).toHaveBeenCalledWith('test.provider')
  expect((await fetch(`${base}/api/studio/plugins/test.provider/diagnostic`)).status).toBe(200)
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

it('configures the global plugin without profile or account ownership', async () => {
  state.configure.mockClear()
  const input = { enabled: true, config: {}, grants: ['agents.register'], revision: 0 }
  const response = await fetch(`${base}/api/studio/plugins/test.global/configuration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  })
  expect(response.status).toBe(200)
  expect(state.configure).toHaveBeenCalledWith({ pluginId: 'test.global', enabled: true, config: {}, grants: ['agents.register'] }, 0)
  state.role = 'admin'
  try { expect((await fetch(`${base}/api/studio/agent-types`)).status).toBe(200) }
  finally { state.role = 'super_admin' }
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

it('scopes global consumer management to an administrator and plugin and requires explicit revisions', async () => {
  const record = state.consumers.store.register({ pluginId: 'test.consumer', name: 'history' }, { types: ['run.completed'], start: 'now', resume: 'continue' })
  const path = `/api/studio/plugins/test.consumer/consumers/${record.id}`
  expect((await fetch(`${base}/api/studio/plugins/test.consumer/consumers`)).status).toBe(200)
  state.role = 'admin'
  try { expect((await fetch(`${base}${path}/deliveries?profile=one`)).status).toBe(403) }
  finally { state.role = 'super_admin' }
  expect((await fetch(`${base}${path}/deliveries?profile=two`)).status).toBe(200)
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
  const record = store.register({ pluginId: 'test.consumer', name: 'dead' }, { types: ['run.completed'], start: 'now', resume: 'continue' })
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


it('gets plugin location arrays using the owned instance revision, without accepting paths or actions', async () => {
  state.resourceLocations.mockResolvedValue({ skills: [], configs: [] })
  const request = (body: unknown) => fetch(`${base}/api/studio/agent-instances/instance/locations?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  for (const extra of [{ ownerId: 'other' }, { path: '/arbitrary' }, { action: 'write' }, { config: {} }]) {
    expect((await request({ revision: 1, ...extra })).status).toBe(400)
  }
  expect(state.resourceLocations).not.toHaveBeenCalled()
  const response = await request({ revision: 1 })
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ ok: true, data: { skills: [], configs: [] } })
  expect(state.resourceLocations).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), 'instance', 1, expect.any(AbortSignal))
})


it('routes command calls with caller identity, hides receipt ownership and preserves raw arguments', async () => {
  const input = { sessionId: 'owned', commandId: 'test.commands/echo', revision: 'registration', text: '/test.commands:echo  "quoted"\n tail ', idempotencyKey: 'once' }
  const record = { id: 'call', ownerId: '7', profileId: 'default', sessionId: 'owned', commandId: input.commandId, status: 'running', results: [], errorCode: null }
  state.commands.start.mockReturnValue(record); state.commands.get.mockReturnValue(record); state.commands.cancel.mockResolvedValue({ ...record, status: 'cancelled' })
  const send = (body: object, profile = '?profile=default') => fetch(`${base}/api/studio/command-calls${profile}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  expect((await send(input, '')).status).toBe(400)
  expect((await send({ ...input, ownerId: 'forged' })).status).toBe(400)
  expect(state.commands.start).not.toHaveBeenCalled()
  const response = await send(input)
  expect(response.status).toBe(200)
  const payload = await response.json()
  expect(payload.data).toMatchObject({ id: 'call', status: 'running' })
  expect(payload.data).not.toHaveProperty('ownerId'); expect(payload.data).not.toHaveProperty('profileId')
  expect(state.commands.start).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'default' }), input)
  expect((await fetch(`${base}/api/studio/commands?profile=default`)).status).toBe(400)
  expect((await fetch(`${base}/api/studio/commands?profile=default&sessionId=owned`)).status).toBe(200)
  expect(state.commands.list).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'default' }), 'owned')
  expect((await fetch(`${base}/api/studio/command-calls/call?profile=default`)).status).toBe(200)
  expect((await fetch(`${base}/api/studio/command-calls/call/cancel?profile=default`, { method: 'POST' })).status).toBe(200)
  expect(state.commands.cancel).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' } }), 'call')
})

it('routes resource IO only by instance, revision and source reference, rejecting injected paths/identity', async () => {
  state.resourceFiles.mockResolvedValue({ file: { content: 'saved' } })
  const payload = { action: 'read', revision: 1, snapshot: 'snapshot', kind: 'configs', locationId: 'native', path: '' }
  const post = (value: unknown) => fetch(`${base}/api/studio/agent-instances/instance/resources?profile=default`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  })
  const response = await post(payload)
  expect(response.status).toBe(200)
  expect(state.resourceFiles).toHaveBeenCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' }, profileId: 'default' }), 'instance', 1,
    { action: 'read', kind: 'configs', locationId: 'native', path: '' }, 'snapshot', expect.any(AbortSignal))
  state.resourceFiles.mockClear()
  for (const value of [{ ...payload, ownerId: 'other' }, { ...payload, absolutePath: '/etc/passwd' }, { ...payload, action: 'list' }, { ...payload, action: 'delete' }]) expect((await post(value)).status).toBe(400)
  expect(state.resourceFiles).not.toHaveBeenCalled()
})

it('binds manual setup checks to the authenticated owner/profile and rejects configuration overrides', async () => {
  state.setupInstance.mockResolvedValue({ cli: { state: 'unavailable' } })
  const request = (body: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  expect((await fetch(`${base}/api/studio/agent-instances/instance/setup?profile=one`, request({ revision: 2 }))).status).toBe(200)
  expect(state.setupInstance).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'one' }), 'instance', 2, expect.any(AbortSignal))
  state.setupInstance.mockClear()
  expect((await fetch(`${base}/api/studio/agent-instances/instance/setup?profile=one`, request({ revision: 2, config: { command: 'forged' } }))).status).toBe(400)
  expect(state.setupInstance).not.toHaveBeenCalled()
})

it('limits bundled plugin setup to super administrators and passes the exact current global revision', async () => {
  state.bundledAgents.enable.mockResolvedValue({ enabled: true, revision: 1 })
  const request = (body: object) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  state.role = 'admin'
  try {
    expect((await fetch(`${base}/api/studio/bundled-agent-plugins?profile=one`)).status).toBe(403)
    expect((await fetch(`${base}/api/studio/bundled-agent-plugins/qwen/enable?profile=one`, request({ revision: 0 }))).status).toBe(403)
  } finally { state.role = 'super_admin' }
  expect(state.bundledAgents.enable).not.toHaveBeenCalled()
  expect((await fetch(`${base}/api/studio/bundled-agent-plugins`)).status).toBe(200)
  expect((await fetch(`${base}/api/studio/bundled-agent-plugins/qwen/enable?profile=one`, request({ revision: 0, path: '/untrusted' }))).status).toBe(400)
  expect((await fetch(`${base}/api/studio/bundled-agent-plugins/qwen/enable?profile=one`, request({ revision: 0 }))).status).toBe(200)
  expect(state.bundledAgents.enable).toHaveBeenCalledWith('qwen', '7', 0, undefined)
  expect((await fetch(`${base}/api/studio/bundled-agent-plugins/qwen/enable?profile=one`, request({ revision: 1, grants: ['agents.register', 'commands.register'] }))).status).toBe(200)
  expect(state.bundledAgents.enable).toHaveBeenLastCalledWith('qwen', '7', 1, ['agents.register', 'commands.register'])
})

it('requires an interactive super administrator for every native login terminal endpoint', async () => {
  const endpoints = [
    ['POST', '/agent-instances/instance/install'], ['POST', '/agent-instances/instance/login'], ['GET', '/agent-instances/instance/operations'],
    ['GET', '/agent-management-operations/operation'], ['GET', '/agent-management-operations/operation/output'],
    ['POST', '/agent-management-operations/operation/input'], ['POST', '/agent-management-operations/operation/resize'],
    ['POST', '/agent-management-operations/operation/cancel'],
  ]
  for (const [method, path] of endpoints) {
    state.role = 'admin'
    try { expect((await fetch(`${base}/api/studio${path}?profile=one`, { method })).status).toBe(403) }
    finally { state.role = 'super_admin' }
    expect((await fetch(`${base}/api/studio${path}?profile=one`, { method, headers: { Authorization: 'Bearer studio_run_fixture' } })).status).toBe(403)
    expect((await fetch(`${base}/api/studio${path}?profile=one&token=studio_run_fixture`, { method })).status).toBe(403)
  }
  expect(state.startLogin).not.toHaveBeenCalled()
  for (const method of Object.values(state.management)) expect(method).not.toHaveBeenCalled()
})

it('accepts only login revision/request keys and scoped terminal controls, with no caching', async () => {
  const post = (path: string, value: unknown, profile = '?profile=one') => fetch(`${base}/api/studio${path}${profile}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const payload = { revision: 1, idempotencyKey: 'login-key' }
  state.startLogin.mockReturnValue({ id: 'operation', status: 'starting' })
  expect((await post('/agent-instances/instance/login', payload, '')).status).toBe(400)
  for (const extra of [{ command: 'injected' }, { env: {} }, { ownerId: 'foreign' }, { terminal: { cols: 80, rows: 24 } }]) {
    expect((await post('/agent-instances/instance/login', { ...payload, ...extra })).status).toBe(400)
  }
  expect(state.startLogin).not.toHaveBeenCalled()
  const response = await post('/agent-instances/instance/login', payload)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(state.startLogin).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'one' }), 'instance', 1, 'login-key')
  expect((await post('/agent-management-operations/operation/input', { sequence: 1, text: 'input', command: 'forged' })).status).toBe(400)
  expect(state.management.input).not.toHaveBeenCalled()
  expect((await post('/agent-management-operations/operation/input', { sequence: 1, text: 'input' })).status).toBe(200)
  expect(state.management.input).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'one' }), 'operation', 1, 'input')
  expect((await post('/agent-management-operations/operation/resize', { cols: 100, rows: 40 })).status).toBe(200)
  expect(state.management.resize).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'one' }), 'operation', { cols: 100, rows: 40 })
  expect((await fetch(`${base}/api/studio/agent-management-operations/operation/output?profile=one&after=-1`)).status).toBe(400)
  expect(state.management.output).not.toHaveBeenCalled()
  expect((await fetch(`${base}/api/studio/agent-management-operations/operation/output?profile=one&after=5`)).status).toBe(200)
  expect(state.management.output).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'one' }), 'operation', 5)
  expect((await post('/agent-management-operations/operation/cancel', { id: 'another' })).status).toBe(400)
  expect((await post('/agent-management-operations/operation/cancel', {})).status).toBe(200)
  expect(state.management.cancel).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'one' }), 'operation')
})

 it('accepts only the owned revision and retry key for managed CLI installation', async () => {
  const post = (path: string, value: unknown, profile = '?profile=one') => fetch(`${base}/api/studio${path}${profile}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })
  const payload = { revision: 1, idempotencyKey: 'install-key' }
  state.startInstall.mockReturnValue({ id: 'installation', action: 'install', status: 'starting' })
  expect((await post('/agent-instances/instance/install', payload, '')).status).toBe(400)
  for (const extra of [{ command: 'npm' }, { version: 'latest' }, { path: '/global' }, { env: { TOKEN: 'secret' } }]) {
    expect((await post('/agent-instances/instance/install', { ...payload, ...extra })).status).toBe(400)
  }
  expect(state.startInstall).not.toHaveBeenCalled()
  expect((await post('/agent-instances/instance/install', payload)).status).toBe(200)
  expect(state.startInstall).toHaveBeenCalledWith(expect.objectContaining({ principal: { id: '7', kind: 'user' }, profileId: 'one' }), 'instance', 1, 'install-key')
})

it('creates ordinary plugin chats with the authenticated scope and rejects private runtime overrides', async () => {
  state.createOrdinaryChat.mockResolvedValue({ sessionId: 'draft', instanceId: 'internal', configurationRevision: 1 })
  const input = { sessionId: 'draft', agentTypeId: 'codex', mode: 'global' }
  const send = (body: object) => fetch(`${base}/api/studio/agent-chats?profile=one`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const response = await send(input)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, data: { sessionId: 'draft', instanceId: 'internal' } })
  expect(state.createOrdinaryChat).toHaveBeenLastCalledWith(expect.objectContaining({ principal: { kind: 'user', id: '7' }, profileId: 'one' }), input)
  const calls = state.createOrdinaryChat.mock.calls.length
  for (const patch of [{ ownerId: '8' }, { config: { command: 'untrusted' } }, { instanceId: 'foreign' }, { scope: { profileId: 'other' } }]) expect((await send({ ...input, ...patch })).status).toBe(400)
  expect(state.createOrdinaryChat).toHaveBeenCalledTimes(calls)
})
