import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type AgentRunResult, type ExecutionScope, type RuntimeCreateInput } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const input = { content: [{ type: 'text' as const, text: 'hello' }] }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function setup(dispose = vi.fn(async () => {}), result?: Promise<AgentRunResult>) {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn()
  const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, ['ekko'])
  const create = vi.fn(async (_input: RuntimeCreateInput) => ({
    run: async () => ({ events: (async function* () {})(), result: result ?? Promise.resolve({ status: 'completed' as const, checkpoint: { native: 'old' } }), cancel: async () => {} }), dispose,
  }))
  registration.register({ id: 'ekko', name: 'Fixture', configSchema: { type: 'object', required: ['model'], additionalProperties: false, properties: { model: { type: 'string', minLength: 1 } } },
    capabilities: { text: true, modes: ['scoped', 'global'], persistentSession: true, resume: true }, create })
  registration.commit()
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize, context: (scope, signal) => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null },
  }) })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: { model: 'old' }, mode: 'global' })
  cleanups.push(async () => { await coordinator.close(); events.close(); db.close() })
  const run = async (key: string) => { const run = coordinator.start(scope, instance.id, input, key); await coordinator.wait(run.id); return coordinator.get(scope, run.id) }
  const configuration = { revision: 1, config: { model: 'new' }, mode: 'scoped' as const }
  return { coordinator, store, create, dispose, instance, run, configuration, authorize, registration }
}

it('updates an idle instance after native disposal and uses a fresh checkpoint namespace', async () => {
  const f = setup(), before = await f.run('before')
  const updated = await f.coordinator.updateInstance(scope, f.instance.id, f.configuration)
  expect(updated).toMatchObject({ revision: 2, mode: 'scoped', config: { model: 'new' }, profileId: 'one', ownerId: 'owner' })
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.coordinator.start(scope, f.instance.id, input, 'before').id).toBe(before.id)
  expect(await f.run('after')).toMatchObject({ status: 'completed', configRevision: 2 })
  expect(f.create.mock.calls[1][0]).toMatchObject({ configRevision: 2, config: { model: 'new' }, mode: 'scoped' })
  expect(f.create.mock.calls[1][0].resume).toBeUndefined()
  expect(f.coordinator.get(scope, before.id)).toMatchObject({ status: 'completed', configRevision: 1 })
  await expect(f.coordinator.updateInstance(scope, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
})

it('blocks new work and competing updates until old disposal finishes, and snapshots input', async () => {
  const barrier = deferred<void>(), f = setup(vi.fn(() => barrier.promise))
  const old = await f.run('old')
  const mutableScope = structuredClone(scope), configuration = structuredClone(f.configuration)
  const update = f.coordinator.updateInstance(mutableScope, f.instance.id, configuration)
  configuration.config.model = 'tampered'; mutableScope.principal.id = 'other'
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce())
  expect(f.store.instance(f.instance.id)?.revision).toBe(1)
  expect(() => f.coordinator.start(scope, f.instance.id, input, 'new')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  expect(f.coordinator.start(scope, f.instance.id, input, 'old').id).toBe(old.id)
  await expect(f.coordinator.updateInstance(scope, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  barrier.resolve()
  expect(await update).toMatchObject({ ownerId: 'owner', config: { model: 'new' }, revision: 2 })
})

it('refuses active and queued runs without implicitly cancelling them', async () => {
  const result = deferred<AgentRunResult>(), f = setup(undefined, result.promise)
  const first = f.coordinator.start(scope, f.instance.id, input, 'first')
  const queued = f.coordinator.start(scope, f.instance.id, input, 'queued')
  await expect(f.coordinator.updateInstance(scope, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.dispose).not.toHaveBeenCalled()
  result.resolve({ status: 'completed' })
  await f.coordinator.wait(first.id); await f.coordinator.wait(queued.id)
  expect(f.coordinator.get(scope, queued.id).status).toBe('completed')
})

it.each([
  { revision: 0 }, { revision: 1.5 }, { config: { model: '' } }, { config: {} }, { config: [] },
  { mode: 'other' }, { agentTypeId: 'other' }, { ownerId: 'other' }, { provider: {} },
])('rejects invalid configuration before touching an idle runtime: %j', async invalid => {
  const f = setup(); await f.run('before')
  await expect(f.coordinator.updateInstance(scope, f.instance.id, { ...f.configuration, ...invalid } as any)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.dispose).not.toHaveBeenCalled()
  expect(f.store.instance(f.instance.id)).toMatchObject({ revision: 1, config: { model: 'old' } })
})

it.each([
  { ...scope, profileId: 'other' }, { ...scope, principal: { id: 'other', kind: 'user' as const } },
])('protects instance configuration across owner and profile boundaries', async caller => {
  const f = setup()
  await expect(f.coordinator.updateInstance(caller, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(f.store.instance(f.instance.id)?.revision).toBe(1)
})

it.each(['sessionId', 'runId', 'workspaceId'])('rejects a resource-bound configuration caller: %s', async key => {
  const f = setup()
  await expect(f.coordinator.updateInstance({ ...scope, [key]: 'bound' }, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
})

it('rechecks revoked access after disposing the old runtime and preserves configuration', async () => {
  const barrier = deferred<void>(), f = setup(vi.fn(() => barrier.promise))
  await f.run('before')
  const update = f.coordinator.updateInstance(scope, f.instance.id, f.configuration)
  await vi.waitFor(() => expect(f.dispose).toHaveBeenCalledOnce())
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  barrier.resolve()
  await expect(update).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.store.instance(f.instance.id)?.revision).toBe(1)
})

it('leaves configuration intact when native cleanup cannot be confirmed', async () => {
  const f = setup(vi.fn(async () => { throw new Error('still active') }))
  await f.run('before')
  await expect(f.coordinator.updateInstance(scope, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(f.store.instance(f.instance.id)).toMatchObject({ revision: 1, config: { model: 'old' } })
  await expect(f.coordinator.updateInstance(scope, f.instance.id, f.configuration)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})
