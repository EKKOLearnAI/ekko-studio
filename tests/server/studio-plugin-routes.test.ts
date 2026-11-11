import { beforeEach, it, expect, vi } from 'vitest'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
const mocks = vi.hoisted(() => ({ install: vi.fn(), request: vi.fn(), runtime: vi.fn(), user: { id: 1, role: 'super_admin' }, profile: 'work' as string | undefined, bound: false, shared: false }))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: {
  authenticate: () => mocks.bound ? { profile: 'work', sessionId: 'bound-session', contextId: 'run', agentId: 'codex' } : undefined,
  recognizes: () => mocks.bound,
} }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({ resolvePluginIdentity: (identity: any) => identity, pluginAdministrationIdentity: (userId: number) => ({ userId, profile: 'default' }), getPluginManager: () => ({
  snapshot: () => ({ revision: 2, plugins: [{ manifest: { id: 'notes', configSchema: { type: 'object', properties: { secret: { type: 'string', secret: true } } } }, config: { public: 'visible', secret: 'hidden' } }] }),
  install: mocks.install, request: mocks.request, runtime: mocks.runtime,
}) }))
import { studioPluginRoutes } from '../../packages/server/src/modules/studio/routes/plugins'
beforeEach(() => { vi.clearAllMocks(); mocks.user = { id: 1, role: 'super_admin' }; mocks.profile = 'work'; mocks.bound = false; mocks.shared = false })
async function server(test: (base: string) => Promise<void>) {
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => { ctx.state.user = mocks.user as any; ctx.state.profile = mocks.profile ? { name: mocks.profile } : undefined; ctx.state.sessionShare = mocks.shared; await next() })
  app.use(studioPluginRoutes.routes())
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening')
  try { await test(`http://127.0.0.1:${(http.address() as any).port}`) }
  finally { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())) }
}
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
  const runtime = new PluginRuntime({ manifest: { id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 1, capabilities: [] }, directory: dir, source: dir, installedAt: 0, enabled: true, config: {} }, { userId: 1, profile: 'work' }, new PluginStore(dir), { authorize() {}, emit() {}, log() {}, api: async () => null })
  mocks.runtime.mockReturnValue(runtime)
  try {
    await server(async base => {
      const storage = (body: object) => fetch(`${base}/api/studio/plugins/notes/storage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      expect((await storage({ action: 'get', key: 'private' })).status).toBe(403)
      runtime.record.manifest.capabilities.push('storage.client')
      expect((await storage({ action: 'set', key: 'value', value: 'shared' })).status).toBe(200)
      expect(await runtime.context().storage.get('value')).toBe('shared')
      mocks.user.id = 2; mocks.profile = 'other'
      expect(await storage({ action: 'get', key: 'value' }).then(response => response.json())).toEqual({ present: true, value: 'shared' })
      await runtime.context().storage.namespace('project', 'alpha').set('value', 'partitioned')
      expect(await storage({ action: 'get', key: 'value', namespace: ['project', 'alpha'] }).then(response => response.json())).toEqual({ present: true, value: 'partitioned' })
      expect(await storage({ action: 'keys', namespace: ['project', 'alpha'] }).then(response => response.json())).toEqual({ keys: ['value'] })
      expect((await storage({ action: 'delete', key: 'value', namespace: ['project', 'alpha'] })).status).toBe(200)
      expect(await runtime.context().storage.namespace('project', 'alpha').get('value')).toBeUndefined()
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
    expect(mocks.install).toHaveBeenCalledWith({ userId: 1, profile: 'default' }, '/tmp/plugin', 0, undefined)
    mocks.user = { id: 2, role: 'admin' }
    expect(await fetch(`${base}/api/studio/plugins`).then(response => response.json())).toEqual(first)
    expect((await install()).status).toBe(403)
    mocks.bound = true
    expect(await fetch(`${base}/api/studio/plugins`).then(response => response.json())).toEqual(first)
  })
})
