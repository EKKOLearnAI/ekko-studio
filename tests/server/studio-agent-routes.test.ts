import { afterEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'

const state = vi.hoisted(() => ({ user: { id: 2, role: 'super_admin' } as any, shared: false, agents: [] as any[] }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/host', () => ({
  ensureBuiltinPlugins: async () => {},
  getPluginManager: () => ({ registeredAgents: () => state.agents }),
  resolvePluginIdentity: (identity: any) => identity,
}))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  requireSuperAdmin: async (ctx: any, next: any) => { if (ctx.state.user?.role !== 'super_admin') ctx.throw(403); await next() },
}))
vi.mock('../../packages/server/src/modules/studio/services/auth/run-mcp-credentials', () => ({ runMcpCredentials: { recognizes: (token: string) => token === 'run-token' } }))
import { studioAgentRoutes } from '../../packages/server/src/modules/studio/routes/agents'
import { configureBuiltinAgents, configurePluginAgents } from '../../packages/server/src/modules/studio/services/agents/registry'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { state.user = { id: 2, role: 'super_admin' }; state.shared = false; state.agents = []; for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function server() {
  let version = '1.0.0'
  const actors: number[] = [], upgraded = vi.fn()
  const directory = await mkdtemp(join(tmpdir(), 'studio-agent-routes-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const runtime = new PluginRuntime({ directory, source: directory, config: {}, installedAt: 0, enabled: true,
    manifest: { id: 'example', name: 'Example', version: '1.0.0', apiVersion: 1, server: 'server.mjs', capabilities: ['agents'], views: [{ id: 'settings', title: 'Settings', slot: 'settings' }] } },
  { userId: 1, profile: 'installer' }, new PluginStore(directory), { authorize() {}, api: async () => null, emit() {}, log() {} })
  cleanup.push(() => runtime.close())
  await runtime.load({ apply(ctx) { ctx.agents.register({ id: 'assistant', name: 'Example Agent', vendor: 'Example Team', agentApiVersion: 1,
    getStatus: async context => { actors.push(context.identity.userId); return { installed: true, version, path: '/private/executable' } },
    management: { settings: () => ({ viewId: 'settings' }), checkUpdate: async () => ({ currentVersion: version, latestVersion: '2.0.0', updateAvailable: version !== '2.0.0' }),
      upgrade: async input => { upgraded(input); version = input.version; return { installedVersion: version } } },
    modes: { global: { listModels: async context => ({ status: 'ready', source: 'sdk', scope: 'configured', models: [{ id: `model-${context.identity.userId}`, name: 'Native' }] }) } },
    capabilities: { surfaces: ['chat'], streaming: true, resume: false }, runtime: { createSession: () => ({ run: async () => ({ content: [], finishReason: 'stop' }), dispose() {} }) },
  }) } }); runtime.activate(); state.agents = [...runtime.agents.values()]
  configurePluginAgents(() => state.agents)
  const legacyCheck = vi.fn(async () => ({ currentVersion: 'old', latestVersion: 'new', updateAvailable: true }))
  configureBuiltinAgents({ list: () => [{ id: 'codex', name: 'Codex', vendor: 'OpenAI', description: '', icon: '', origin: 'builtin', modes: ['scoped', 'global'], surfaces: ['chat'], actions: { settings: true, checkUpdate: true, upgrade: true } }],
    status: async () => ({ installed: true, version: 'old' }), settings: () => ({ name: 'codingAgent.config', params: { agentId: 'codex', section: 'settings' } }),
    models: async () => ({}), checkUpdate: legacyCheck, upgrade: async () => ({}), scopedModel: async () => { throw new Error('unused') },
  })
  const app = new Koa()
  app.use(bodyParser()); app.use(async (ctx, next) => { ctx.state.user = state.user; ctx.state.profile = { name: 'work' }; ctx.state.sessionShare = state.shared; await next() }); app.use(studioAgentRoutes.routes())
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening')
  cleanup.push(async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())) })
  const base = `http://127.0.0.1:${(http.address() as any).port}/api/studio/agents`
  const request = (suffix: string, body?: object, token = '') => fetch(base + suffix, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { request, actors, upgraded, legacyCheck, id: '/' + encodeURIComponent('plugin:example/assistant') }
}

it('publishes plugin vendor/actions and native models under the actual caller and preserves builtin routing', async () => {
  const { request, actors, id, legacyCheck } = await server()
  const list = await (await request('')).json()
  expect(list.agents.find((agent: any) => agent.id.startsWith('plugin:'))).toMatchObject({ vendor: 'Example Team', status: { installed: true, version: '1.0.0' } })
  expect(list.agents.find((agent: any) => agent.id.startsWith('plugin:')).status).not.toHaveProperty('path')
  expect(await (await request(id + '/models')).json()).toMatchObject({ models: [{ id: 'model-2' }] })
  expect(await (await request(id + '/settings', {})).json()).toMatchObject({ name: 'studio.pluginSettings', params: { pluginId: 'example', viewId: 'settings' } })
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
