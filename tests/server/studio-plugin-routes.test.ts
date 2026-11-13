import { beforeEach, it, expect, vi } from 'vitest'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
const mocks = vi.hoisted(() => ({ developmentList: vi.fn(async () => ({ projects: [] })), developmentStart: vi.fn(), developmentUnlink: vi.fn(), agentRemove: vi.fn(async () => ({ removed: true })), policyGet: vi.fn(async () => ({ autoUpdate: false, autoUpdateSupported: true })), policySet: vi.fn(async () => ({ autoUpdate: true, autoUpdateSupported: true })), install: vi.fn(), update: vi.fn(), request: vi.fn(), runtime: vi.fn(), user: { id: 1, role: 'super_admin' }, profile: 'work' as string | undefined, bound: false, shared: false }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: {
  authenticate: () => mocks.bound ? { profile: 'work', sessionId: 'bound-session', contextId: 'run', agentId: 'codex' } : undefined,
  recognizes: () => mocks.bound,
} }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({ getPluginDevelopment: () => ({ list: mocks.developmentList, start: mocks.developmentStart, unlink: mocks.developmentUnlink }), ensureBuiltinPlugins: async () => {}, resolvePluginIdentity: (identity: any) => identity, pluginAdministrationIdentity: (userId: number) => ({ userId, profile: 'default' }), getPluginManager: () => ({
  snapshot: () => ({ revision: 2, plugins: [{ manifest: { id: 'notes', configSchema: { type: 'object', properties: { secret: { type: 'string', secret: true } } } }, config: { public: 'visible', secret: 'hidden' } }] }),
  install: mocks.install, update: mocks.update, request: mocks.request, runtime: mocks.runtime,
}) }))
vi.mock('../../packages/server/src/modules/studio/services/agents/plugin-update-policy', () => ({ getPluginAgentUpdates: () => ({ remove: mocks.agentRemove, snapshot: mocks.policyGet, set: mocks.policySet }) }))
import { studioAgentRoutes } from '../../packages/server/src/modules/studio/routes/agents'
import { studioPluginRoutes } from '../../packages/server/src/modules/studio/routes/plugins'
import { configurePluginMcpSync } from '../../packages/server/src/modules/studio/public/plugin-mcp'
beforeEach(() => { vi.clearAllMocks(); mocks.user = { id: 1, role: 'super_admin' }; mocks.profile = 'work'; mocks.bound = false; mocks.shared = false })
async function server(test: (base: string) => Promise<void>) {
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => { ctx.state.user = mocks.user as any; ctx.state.profile = mocks.profile ? { name: mocks.profile } : undefined; ctx.state.sessionShare = mocks.shared; await next() })
  app.use(studioPluginRoutes.routes())
  app.use(studioAgentRoutes.routes())
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening')
  try { await test(`http://127.0.0.1:${(http.address() as any).port}`) }
  finally { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())) }
}
it('synchronizes MCP configuration after successful package changes and keeps a committed install on sync failure', async () => {
  const sync = vi.fn(async () => {}), release = configurePluginMcpSync(sync)
  try {
    await server(async base => {
      const install = () => fetch(`${base}/api/studio/plugins/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: '/tmp/plugin', revision: 0, trusted: true }) })
      expect((await install()).status).toBe(200)
      expect(sync).toHaveBeenCalledTimes(1)
      const updated = await fetch(`${base}/api/studio/plugins/notes`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, revision: 1 }) })
      expect(updated.status).toBe(200)
      expect(sync).toHaveBeenCalledTimes(2)
      mocks.install.mockRejectedValueOnce(new Error('Package rejected'))
      expect((await install()).status).toBe(500)
      expect(sync).toHaveBeenCalledTimes(2)
      sync.mockRejectedValueOnce(new Error('Config sync failed'))
      expect((await install()).status).toBe(200)
      expect(sync).toHaveBeenCalledTimes(3)
    })
  } finally { release() }
})
it('requires trusted administrator installation and rejects run credentials and shared access', async () => {
  await server(async base => {
    const install = (body: object) => fetch(`${base}/api/studio/plugins/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await install({ source: '/tmp/plugin', revision: 0 })).status).toBe(400)
    expect((await install({ source: '/tmp/plugin', revision: 0, trusted: true })).status).toBe(200)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    mocks.bound = true; expect((await install({ source: '/tmp/plugin', revision: 0, trusted: true })).status).toBe(403)
    mocks.bound = false; mocks.user.role = 'admin'; expect((await install({ source: '/tmp/plugin', revision: 0, trusted: true })).status).toBe(403)
    mocks.shared = true; expect((await fetch(`${base}/api/studio/plugins`)).status).toBe(403)
  })
})
it('requires developer opt-in for browser storage and shares explicit namespaces with the backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-storage-route-'))
  const runtime = new PluginRuntime({ manifest: { id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 1, permissions: [] }, directory: dir, source: dir, installedAt: 0, enabled: true, config: {} }, { userId: 1, profile: 'work' }, new PluginStore(dir), { authorize() {}, emit() {}, log() {}, api: async () => null })
  mocks.runtime.mockReturnValue(runtime)
  try {
    await server(async base => {
      const storage = (body: object) => fetch(`${base}/api/studio/plugins/notes/storage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      expect((await storage({ action: 'get', key: 'private' })).status).toBe(403)
      runtime.record.manifest.permissions.push('storage.client')
      expect((await storage({ action: 'set', key: 'value', value: 'shared' })).status).toBe(200)
      expect(await runtime.context().state.plugin.get('value')).toBe('shared')
      mocks.user.id = 2; mocks.profile = 'other'
      expect(await storage({ action: 'get', key: 'value' }).then(response => response.json())).toEqual({ present: true, value: 'shared' })
      await runtime.context().state.plugin.namespace('project', 'alpha').set('value', 'partitioned')
      expect(await storage({ action: 'get', key: 'value', namespace: ['project', 'alpha'] }).then(response => response.json())).toEqual({ present: true, value: 'partitioned' })
      expect(await storage({ action: 'keys', namespace: ['project', 'alpha'] }).then(response => response.json())).toEqual({ keys: ['value'] })
      expect((await storage({ action: 'delete', key: 'value', namespace: ['project', 'alpha'] })).status).toBe(200)
      expect(await runtime.context().state.plugin.namespace('project', 'alpha').get('value')).toBeUndefined()
      for (const namespace of ['invalid', [null], Array(17).fill('x')]) expect((await storage({ action: 'get', key: 'value', namespace })).status).toBe(400)
    })
  } finally { await runtime.close(); await rm(dir, { recursive: true, force: true }) }
})
it('redacts configuration secrets and binds API proxy calls to the authenticated run session', async () => {
  mocks.request.mockResolvedValue({ sessions: [] })
  await server(async base => {
    const response = await fetch(`${base}/api/studio/plugins`)
    expect(response.status).toBe(200)
    expect((await response.json() as any).plugins[0].config).toEqual({ public: 'visible' })
    mocks.bound = true
    const proxy = await fetch(`${base}/api/studio/plugins/notes/api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/api/studio/sessions', sessionId: 'forged-session', options: { method: 'GET' } }) })
    expect(proxy.status).toBe(200)
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'bound-session', userId: 1, profile: 'work' }), 'notes', '/api/studio/sessions', { method: 'GET' }, expect.any(AbortSignal))
  })
})
it('exposes the same catalog without selecting a Profile and keeps ordinary accounts from changing global installations', async () => {
  await server(async base => {
    mocks.profile = undefined
    const first = await fetch(`${base}/api/studio/plugins`).then(response => response.json())
    const install = () => fetch(`${base}/api/studio/plugins/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: '/tmp/plugin', revision: 0, trusted: true }) })
    expect((await install()).status).toBe(200)
    expect(mocks.install).toHaveBeenCalledWith({ userId: 1, profile: 'default' }, '/tmp/plugin', 0, undefined, { expectedVersion: undefined })
    mocks.user = { id: 2, role: 'admin' }
    expect(await fetch(`${base}/api/studio/plugins`).then(response => response.json())).toEqual(first)
    expect((await install()).status).toBe(403)
    mocks.bound = true
    expect(await fetch(`${base}/api/studio/plugins`).then(response => response.json())).toEqual(first)
  })
})

it('restricts development discovery and execution to interactive administrators with explicit trust', async () => {
  await server(async base => {
    const start = (trusted: boolean) => fetch(`${base}/api/studio/plugins/notes/development`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trusted, revision: 2 }) })
    expect((await fetch(`${base}/api/studio/plugins/development`)).status).toBe(200)
    expect((await start(false)).status).toBe(400)
    expect((await start(true)).status).toBe(200)
    expect(mocks.developmentStart).toHaveBeenCalledWith({ userId: 1, profile: 'default' }, 'notes', 2)
    mocks.bound = true
    expect((await start(true)).status).toBe(403)
    expect((await fetch(`${base}/api/studio/plugins/development`)).status).toBe(403)
    mocks.bound = false; mocks.user.role = 'admin'
    expect((await start(true)).status).toBe(403)
    expect((await fetch(`${base}/api/studio/plugins/development`)).status).toBe(403)
    expect(mocks.developmentStart).toHaveBeenCalledTimes(1)
  })
})

it('unlinks development projects only for administrator logins', async () => {
  await server(async base => {
    const unlink = () => fetch(`${base}/api/studio/plugins/notes/development?revision=7`, { method: 'DELETE' })
    expect((await unlink()).status).toBe(200)
    expect(mocks.developmentUnlink).toHaveBeenCalledWith({ userId: 1, profile: 'default' }, 'notes', 7)
    mocks.bound = true; expect((await unlink()).status).toBe(403)
    mocks.bound = false; mocks.user.role = 'admin'; expect((await unlink()).status).toBe(403)
    mocks.user.role = 'super_admin'; mocks.shared = true; expect((await unlink()).status).toBe(403)
    expect(mocks.developmentUnlink).toHaveBeenCalledTimes(1)
  })
})

it('exposes Agent engine removal and policy APIs only to interactive super administrators', async () => {
  await server(async base => {
    const path = `${base}/api/studio/agents/${encodeURIComponent('plugin:demo/worker')}`
    const remove = () => fetch(path + '/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: '1.0.0' }) })
    const set = (autoUpdate: unknown) => fetch(path + '/update-policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoUpdate }) })
    expect(await remove().then(response => response.json())).toEqual({ removed: true })
    expect(mocks.agentRemove).toHaveBeenCalledWith('plugin:demo/worker', expect.objectContaining({ userId: 1, profile: 'work' }), { expectedVersion: '1.0.0' })
    expect(await fetch(path + '/update-policy').then(response => response.json())).toMatchObject({ autoUpdateSupported: true })
    expect(await set(true).then(response => response.json())).toMatchObject({ autoUpdate: true })
    expect((await set('yes')).status).toBe(400)
    mocks.agentRemove.mockRejectedValueOnce(Object.assign(new Error('Agent is busy'), { status: 409, code: 'AGENT_BUSY' }))
    expect((await remove()).status).toBe(409)
    for (const state of ['run', 'admin', 'shared']) {
      mocks.bound = state === 'run'; mocks.user.role = state === 'admin' ? 'admin' : 'super_admin'; mocks.shared = state === 'shared'
      expect((await remove()).status).toBe(403)
      expect((await fetch(path + '/update-policy')).status).toBe(403)
      expect((await set(true)).status).toBe(403)
    }
    expect(mocks.policySet).toHaveBeenCalledTimes(1)
  })
})
