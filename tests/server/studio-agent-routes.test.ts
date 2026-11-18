import { afterEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { manifest } from '../../packages/server/src/modules/studio/services/plugins/schema'

const state = vi.hoisted(() => ({ user: { id: 2, role: 'super_admin' } as any, shared: false, agents: [] as any[], updates: null as any,
  reconcile: vi.fn(async () => {}),
}))
vi.mock('../../packages/server/src/modules/studio/services/agents/plugin-update-policy', async importOriginal => {
  const actual = await importOriginal<any>()
  return { ...actual, getPluginAgentUpdates: () => state.updates }
})
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({
  ensureBuiltinPlugins: state.reconcile,
  getPluginManager: () => ({ registeredAgents: () => state.agents }),
  resolvePluginIdentity: (identity: any) => identity,
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  requireSuperAdmin: async (ctx: any, next: any) => { if (ctx.state.user?.role !== 'super_admin') ctx.throw(403); await next() },
}))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: { recognizes: (token: string) => token === 'run-token' } }))
import { studioAgentRoutes } from '../../packages/server/src/modules/studio/routes/agents'
import { agentStatusRoutes } from '../../packages/server/src/modules/studio/routes/agent-status'
import { configureBuiltinAgents, configurePluginAgents } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginAgentUpdates } from '../../packages/server/src/modules/studio/services/agents/plugin-update-policy'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { state.user = { id: 2, role: 'super_admin' }; state.shared = false; state.agents = []; state.reconcile.mockClear(); vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function server(slowStatus?: (signal: AbortSignal) => Promise<never>) {
  let version = '1.0.0'
  const actors: number[] = [], upgraded = vi.fn()
  const checkUpdate = vi.fn(async (_context: unknown) => ({ currentVersion: version, latestVersion: '2.0.0', updateAvailable: version !== '2.0.0' }))
  const directory = await mkdtemp(join(tmpdir(), 'studio-agent-routes-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const runtime = new PluginRuntime({ directory, source: directory, config: {}, installedAt: 0, enabled: true,
    manifest: manifest({ id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, server: 'server.mjs', client: 'client.mjs', permissions: ['agents', 'ui'], views: [{ id: 'settings', title: 'Settings', slot: 'agent-settings', icon: 'settings' }] }) },
  { userId: 1, profile: 'installer' }, new PluginStore(directory), { authorize() {}, api: async () => null, emit() {}, log() {} })
  cleanup.push(() => runtime.close())
  await runtime.load({ apply(ctx) {
    const definition = {
      id: 'assistant', name: 'Example Agent', vendor: 'Example Team', agentApiVersion: 1,
      getStatus: async context => { actors.push(context.identity.userId); return { installed: true, version, path: '/private/executable' } },
      management: { settings: () => ({ viewId: 'settings' }), checkUpdate, supportsAutoUpdate: () => true,
        upgrade: async input => { upgraded(input); version = input.version; return { installedVersion: version } } },
      modes: { global: { listModels: async context => ({ status: 'ready', source: 'sdk', scope: 'configured', models: [{ id: `model-${context.identity.userId}`, name: 'Native' }] }) } },
      features: { surfaces: ['chat'], streaming: true, resume: false }, runtime: { createSession: () => ({ run: async () => ({ content: [], finishReason: 'stop' }), dispose() {} }) },
    } satisfies Parameters<typeof ctx.extensions.agents.register>[0]
    ctx.extensions.agents.register(definition)
    if (slowStatus) ctx.extensions.agents.register({ ...definition, id: 'slow', getStatus: context => slowStatus(context.signal) })
  } }); runtime.activate(); state.agents = [...runtime.agents.values()]
  configurePluginAgents(() => state.agents)
  state.updates = new PluginAgentUpdates(directory, () => state.agents)
  const legacyCheck = vi.fn(async () => ({ currentVersion: 'old', latestVersion: 'new', updateAvailable: true }))
  configureBuiltinAgents({ list: () => [{ id: 'codex', name: 'Codex', vendor: 'OpenAI', description: '', icon: '', origin: 'builtin', modes: ['scoped', 'global'], surfaces: ['chat'], actions: { settings: true, checkUpdate: true, upgrade: true } }],
    status: async () => ({ installed: true, version: 'old' }), settings: () => ({ name: 'codingAgent.config', params: { agentId: 'codex', section: 'settings' } }),
    models: async () => ({}), checkUpdate: legacyCheck, upgrade: async () => ({}), scopedModel: async () => { throw new Error('unused') },
  })
  const app = new Koa()
  app.use(bodyParser()); app.use(async (ctx, next) => { ctx.state.user = state.user; ctx.state.profile = { name: 'work' }; ctx.state.sessionShare = state.shared; await next() }); app.use(studioAgentRoutes.routes()); app.use(agentStatusRoutes.routes())
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening')
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
  const base = `http://127.0.0.1:${(http.address() as any).port}`
  const request = (suffix: string, body?: object, token = '') => fetch(`${base}/api/studio/agents${suffix}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { base, request, actors, upgraded, legacyCheck, checkUpdate, updates: state.updates as PluginAgentUpdates, id: '/' + encodeURIComponent('plugin:example/assistant') }
}

it('returns built-in and responsive Agents while plugin reconciliation and one probe are stalled', async () => {
  const getStatus = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}))
  const { base } = await server(getStatus)
  const initialization = Promise.withResolvers<void>()
  state.reconcile.mockReturnValue(initialization.promise)
  const deadline = new AbortController()
  const timeout = AbortSignal.timeout
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 5_000 ? deadline.signal : timeout(ms))
  try {
    const pending = ['/api/agents/status', '/api/agents/availability', '/api/studio/agents'].map(path =>
      fetch(base + path, { signal: timeout(3_000) }).then(async response => {
        expect(response.ok).toBe(true)
        return (await response.json()).agents
      }),
    )
    const all = Promise.all(pending)
    void all.catch(() => {})
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(3))
    deadline.abort(new DOMException('Agent status timed out', 'TimeoutError'))
    const [status, availability, manager] = await all
    for (const snapshot of [status, availability]) {
      expect(snapshot).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'ekko-agent', installed: true, source: 'built-in' }),
        expect.objectContaining({ id: 'plugin:example/assistant', installed: true }),
        expect.objectContaining({ id: 'plugin:example/slow', installed: false }),
      ]))
    }
    expect(availability.find(agent => agent.id === 'ekko-agent').available).toBe(true)
    expect(manager.find(agent => agent.id === 'plugin:example/slow').status).toMatchObject({ installed: false, error: 'Agent status timed out' })
    for (const [signal] of getStatus.mock.calls) expect(signal.aborted).toBe(true)
  } finally {
    initialization.resolve()
    state.reconcile.mockImplementation(async () => {})
  }
})

it('publishes plugin vendor/actions and native models under the actual caller and preserves builtin routing', async () => {
  const { request, actors, id, legacyCheck } = await server()
  const list = await (await request('')).json()
  expect(list.agents.find((agent: any) => agent.id.startsWith('plugin:'))).toMatchObject({ vendor: 'Example Team', status: { installed: true, version: '1.0.0' } })
  expect(list.agents.find((agent: any) => agent.id.startsWith('plugin:')).status).not.toHaveProperty('path')
  expect(await (await request(id + '/models')).json()).toMatchObject({ models: [{ id: 'model-2' }] })
  expect(await (await request(id + '/settings', {})).json()).toMatchObject({ name: 'studio.pluginAgentSettings', params: { pluginId: 'example', viewId: 'settings' } })
  expect(await (await request('/codex/settings', {})).json()).toMatchObject({ name: 'codingAgent.config', params: { agentId: 'codex' } })
  await request('/codex/check-update', {}); expect(legacyCheck).toHaveBeenCalledWith('codex')
  expect(actors).toEqual([2])
})

it('requires interactive administrator access for mutations, rejects stale versions, and invokes the engine upgrade', async () => {
  const { request, id, upgraded } = await server()
  state.user = { id: 3, role: 'user' }
  expect((await request(id + '/upgrade', { version: '2.0.0', expectedVersion: '1.0.0' })).status).toBe(403)
  state.user = { id: 2, role: 'super_admin' }
  expect((await request(id + '/check-update', {}, 'run-token')).status).toBe(403)
  expect((await request(id + '/upgrade', { version: '2.0.0', expectedVersion: 'old' })).status).toBe(409)
  expect(upgraded).not.toHaveBeenCalled()
  expect(await (await request(id + '/check-update', {})).json()).toMatchObject({ updateAvailable: true, latestVersion: '2.0.0' })
  expect(await (await request(id + '/upgrade', { version: '2.0.0', expectedVersion: '1.0.0' })).json()).toEqual({ installedVersion: '2.0.0' })
  state.shared = true; expect((await request('')).status).toBe(403)
})

it('clears failed automatic update status through the actual manual check endpoint', async () => {
  const f = await server()
  f.checkUpdate.mockRejectedValueOnce(new Error('OMP release lookup returned 403'))
  await f.updates.tick(true)
  expect(await (await f.request(f.id + '/update-policy')).json()).toMatchObject({ status: 'failed', error: 'OMP release lookup returned 403' })
  expect(await (await f.request(f.id + '/check-update', {})).json()).toEqual({ currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true })
  const recovered = await (await f.request(f.id + '/update-policy')).json()
  expect(recovered).toMatchObject({ status: 'available', currentVersion: '1.0.0', latestVersion: '2.0.0' })
  expect(recovered).not.toHaveProperty('error')
  expect(f.upgraded).not.toHaveBeenCalled()
})
