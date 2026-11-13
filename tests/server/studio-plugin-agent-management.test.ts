import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginRuntime } from '../../packages/server/src/modules/studio/services/plugins/runtime'
import { PluginStore } from '../../packages/server/src/modules/studio/services/plugins/store'
import { PluginAgentUpdates } from '../../packages/server/src/modules/studio/services/agents/plugin-update-policy'
import { PluginAgentRuntime } from '../../packages/server/src/modules/studio/services/plugins/agent-runtime'
import type { AgentDefinition, AgentManagementContext } from '../../packages/plugin-sdk/src'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'plugin-agent-management-'))
  cleanup.push(() => rm(home, { recursive: true, force: true }))
  let version = '1.0.0', installed = true, supported = true
  const remove = vi.fn(async (_ctx: AgentManagementContext) => { installed = false; version = '' })
  const upgrade = vi.fn(async (input: { version: string }, _ctx: AgentManagementContext) => { version = input.version; installed = true; return { installedVersion: version } })
  const supportsAutoUpdate = vi.fn(async (ctx: AgentManagementContext) => supported && ctx.identity.profile !== 'external')
  const dispose = vi.fn()
  let run = async () => ({ content: [], finishReason: 'stop' as const })
  const definition: AgentDefinition = {
    id: 'worker', name: 'Worker', vendor: 'Test', agentApiVersion: 1,
    getStatus: async () => ({ installed, version }),
    management: { remove, upgrade, supportsAutoUpdate, checkUpdate: async () => ({ currentVersion: version, latestVersion: '2.0.0', updateAvailable: version !== '2.0.0' }) },
    modes: { global: { listModels: async () => ({ status: 'ready', source: 'fixture', scope: 'builtin', models: [] }) } },
    features: { surfaces: ['chat'], streaming: true, resume: false },
    runtime: { createSession: () => ({ run: () => run(), dispose }) },
  }
  const runtime = new PluginRuntime({ manifest: { id: 'managed', name: 'Managed', version: '1.0.0', apiVersion: 1, permissions: ['agents'], server: 'server.mjs' }, directory: home, source: home, enabled: true, installedAt: 0, config: {} },
    { userId: 1, profile: 'installer' }, new PluginStore(home), { authorize() {}, api: async () => null, emit() {}, log() {} })
  await runtime.load({ apply(ctx) { ctx.extensions.agents.register(definition) } }); runtime.activate()
  cleanup.push(() => runtime.close())
  const agent = runtime.agents.get('worker')!
  let active = [agent]
  const updates = new PluginAgentUpdates(home, () => active)
  const execute = () => agent.execute({ identity: { userId: 2, profile: 'work', sessionId: 'session', runId: 'run' }, mode: 'global', paths: { runtimeDir: join(home, 'runtime'), workspaceDir: home }, model: {},
    request: { input: [], history: [], instructions: [], options: {} }, signal: new AbortController().signal, deadlineAt: Date.now() + 60000,
    attachments: { read: async () => new Uint8Array(), resolve: async () => ({ assetId: '', name: '', mediaType: '', localPath: '', size: 0 }) }, emit: async () => {} })
  return { home, runtime, agent, updates, remove, upgrade, supportsAutoUpdate, dispose, execute, definition,
    version: () => version, support: (value: boolean) => { supported = value }, hide: () => { active = [] }, show: () => { active = [agent] },
    replace() { const next = new PluginAgentRuntime(runtime, definition); active = [next]; return next },
    holdRun() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); run = async () => { await promise; return { content: [], finishReason: 'stop' } }; return release },
  }
}

it('removes the engine with an exact version, disables auto-update and retains settings and registration', async () => {
  const f = await fixture(), who = { userId: 2, profile: 'work' }
  await f.runtime.context().state.plugin.set('saved', 'keep')
  await f.execute()
  await f.updates.set(f.agent.id, true)
  await expect(f.updates.remove(f.agent.id, who, { expectedVersion: 'old' })).rejects.toMatchObject({ code: 'AGENT_VERSION' })
  expect(f.remove).not.toHaveBeenCalled()
  expect(await f.updates.remove(f.agent.id, who, { expectedVersion: '1.0.0' })).toEqual({ removed: true })
  expect(f.remove.mock.calls[0][0].identity).toMatchObject(who)
  expect(f.dispose).toHaveBeenCalledTimes(1)
  expect(f.agent.descriptor().actions).toMatchObject({ remove: true, autoUpdate: true })
  expect(await f.agent.status(who)).toMatchObject({ installed: false })
  expect(await f.runtime.context().state.plugin.get('saved')).toBe('keep')
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ autoUpdate: false, autoUpdateSupported: false })
  expect(f.runtime.agents.get('worker')).toBe(f.agent)
})

it('rejects removal during runs and excludes new launches while a remove callback is pending', async () => {
  const f = await fixture(), release = f.holdRun()
  const running = f.execute()
  await vi.waitFor(() => expect(f.agent.isBusyForUpdate()).toBe(true))
  await expect(f.agent.remove({ userId: 1, profile: 'installer' }, { expectedVersion: '1.0.0' })).rejects.toMatchObject({ code: 'AGENT_BUSY' })
  release(); await running
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  f.remove.mockImplementationOnce(async () => { await pending })
  const removing = f.agent.remove({ userId: 1, profile: 'installer' }, { expectedVersion: '1.0.0' })
  const rejected = expect(removing).rejects.toThrow('still installed')
  await vi.waitFor(() => expect(f.remove).toHaveBeenCalled())
  await expect(f.execute()).rejects.toMatchObject({ code: 'AGENT_BUSY' })
  finish(); await rejected
  expect(f.agent.isBusyForUpdate()).toBe(false)
})

it('waits for a complete idle grace period after the latest run before automatic upgrade', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const f = await fixture()
  await f.updates.set(f.agent.id, true)
  await f.updates.tick(true)
  expect(f.upgrade).not.toHaveBeenCalled()
  const release = f.holdRun(), running = f.execute()
  await vi.waitFor(() => expect(f.agent.isBusyForUpdate()).toBe(true))
  vi.setSystemTime(Date.now() + 61000); await f.updates.tick()
  expect(f.upgrade).not.toHaveBeenCalled()
  release(); await running
  await f.updates.tick()
  expect(f.upgrade).not.toHaveBeenCalled()
  vi.setSystemTime(Date.now() + 61000); await f.updates.tick()
  expect(f.version()).toBe('2.0.0')
  expect(f.upgrade).toHaveBeenCalledTimes(1)
  expect(f.upgrade.mock.calls[0][1].identity).toMatchObject({ userId: 1, profile: 'installer' })
})

it('keeps preferences for temporarily disabled plugins and rejects unsupported installations', async () => {
  const f = await fixture()
  await f.updates.set(f.agent.id, true)
  f.hide()
  let hidden = true
  const restored = new PluginAgentUpdates(f.home, () => f.runtime.agents.size && !hidden ? [f.agent] : [])
  await restored.tick()
  hidden = false
  expect(await restored.snapshot(f.agent.id)).toMatchObject({ autoUpdate: true, autoUpdateSupported: true })
  expect(JSON.parse(await readFile(join(f.home, 'plugin-agent-update-policy.json'), 'utf8'))[f.agent.id]).toEqual({ autoUpdate: true })
  f.show(); f.support(false)
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ autoUpdateSupported: false, autoUpdate: false })
  await expect(f.updates.set(f.agent.id, true)).rejects.toMatchObject({ code: 'AGENT_UNSUPPORTED' })
})

it('checks automatic-update support again under the engine mutation lock and respects caller installation settings', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const f = await fixture()
  await f.updates.set(f.agent.id, true)
  expect(await f.updates.snapshot(f.agent.id, { userId: 2, profile: 'external' })).toMatchObject({ autoUpdateSupported: false })
  await expect(f.updates.set(f.agent.id, true, { userId: 2, profile: 'external' })).rejects.toMatchObject({ code: 'AGENT_UNSUPPORTED' })
  await f.updates.tick(true)
  f.supportsAutoUpdate.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  vi.setSystemTime(Date.now() + 61000)
  await f.updates.tick()
  expect(f.upgrade).not.toHaveBeenCalled()
  expect((await f.updates.snapshot(f.agent.id)).status).toBe('failed')
})

it('keeps legacy plugins manual by default and validates their capability declarations', async () => {
  const f = await fixture()
  delete f.definition.management.supportsAutoUpdate
  delete f.definition.management.remove
  expect(f.agent.descriptor().actions).toMatchObject({ remove: false, autoUpdate: false })
  expect(await f.agent.supportsAutoUpdate({ userId: 1, profile: 'installer' })).toBe(false)
  await expect(f.agent.remove({ userId: 1, profile: 'installer' }, { expectedVersion: '1.0.0' })).rejects.toMatchObject({ code: 'AGENT_UNSUPPORTED' })
  f.definition.management.supportsAutoUpdate = async () => 'invalid' as any
  await expect(f.agent.supportsAutoUpdate({ userId: 1, profile: 'installer' })).rejects.toThrow('Invalid Agent automatic')
})

it('publishes successful manual checks after scheduled failures and checks absent engines for installation', async () => {
  const f = await fixture(), who = f.runtime.identity
  const check = vi.fn(f.definition.management.checkUpdate!).mockRejectedValueOnce(new Error('OMP release lookup returned 403'))
  f.definition.management.checkUpdate = check
  await f.updates.tick(true)
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ status: 'failed', error: 'OMP release lookup returned 403' })
  expect(await f.updates.checkUpdate(f.agent.id, who)).toEqual({ currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true })
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ status: 'available', currentVersion: '1.0.0', latestVersion: '2.0.0', error: undefined })
  expect(f.upgrade).not.toHaveBeenCalled()
  await f.agent.remove(who, { expectedVersion: '1.0.0' })
  expect(await f.updates.checkUpdate(f.agent.id, who)).toMatchObject({ currentVersion: '', latestVersion: '2.0.0', updateAvailable: true })
})

it('retries failed checks after five minutes and retains the normal interval after recovery', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const f = await fixture(), check = vi.fn(f.definition.management.checkUpdate!).mockRejectedValueOnce(new Error('Temporary upstream error'))
  f.definition.management.checkUpdate = check
  await f.updates.tick()
  vi.setSystemTime(Date.now() + 299999); await f.updates.tick()
  expect(check).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 1); await f.updates.tick()
  expect(check).toHaveBeenCalledTimes(2)
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ status: 'available', error: undefined })
  vi.setSystemTime(Date.now() + 300000); await f.updates.tick()
  expect(check).toHaveBeenCalledTimes(2)
  expect(f.upgrade).not.toHaveBeenCalled()
})

it('refreshes a replaced runtime without retaining its predecessor failure or losing the saved preference', async () => {
  const f = await fixture()
  f.definition.management.checkUpdate = vi.fn(f.definition.management.checkUpdate!).mockRejectedValueOnce(new Error('Old runtime failure'))
  await f.updates.set(f.agent.id, true)
  await f.updates.tick()
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ status: 'failed' })
  f.replace(); await f.updates.tick()
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ status: 'waiting', autoUpdate: true, error: undefined, latestVersion: '2.0.0' })
  expect(f.upgrade).not.toHaveBeenCalled()
})

it('fences late results from an old runtime while sharing the replacement check', async () => {
  const f = await fixture()
  const policyCheck = vi.spyOn(f.updates.policy, 'checkNow')
  let failOld!: (error: Error) => void, finishNew!: (value: any) => void
  const check = vi.fn(f.definition.management.checkUpdate!)
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
  f.definition.management.checkUpdate = check
  const old = f.updates.checkUpdate(f.agent.id, f.runtime.identity)
  const rejected = expect(old).rejects.toThrow('Old failure')
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1))
  f.replace()
  const fresh = f.updates.checkUpdate(f.agent.id, f.runtime.identity)
  await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2))
  failOld(new Error('Old failure')); await rejected
  const shared = f.updates.checkUpdate(f.agent.id, f.runtime.identity)
  await vi.waitFor(() => expect(policyCheck).toHaveBeenCalledTimes(3))
  expect(check).toHaveBeenCalledTimes(2)
  finishNew({ currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true })
  expect(await fresh).toEqual(await shared)
  expect(check).toHaveBeenCalledTimes(2)
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ status: 'available', error: undefined })
})

it('preserves caller-specific results without using another Profile as the automatic update target', async () => {
  const f = await fixture(), who = { userId: 2, profile: 'external' }
  const check = vi.fn(async (ctx: AgentManagementContext) => ctx.identity.profile === 'external'
    ? { currentVersion: '100.0.0', latestVersion: '200.0.0', updateAvailable: true }
    : { currentVersion: '1.0.0', latestVersion: '2.0.0', updateAvailable: true })
  f.definition.management.checkUpdate = check
  expect(await f.updates.checkUpdate(f.agent.id, who)).toMatchObject({ currentVersion: '100.0.0', latestVersion: '200.0.0' })
  expect(await f.updates.snapshot(f.agent.id)).toMatchObject({ currentVersion: '1.0.0', latestVersion: '2.0.0' })
  expect(check.mock.calls.map(([ctx]) => ctx.identity.profile)).toEqual(['external', 'installer'])
})
