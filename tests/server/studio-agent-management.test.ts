import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { ManagedProcessScope } from '../../packages/server/src/modules/studio/services/processes/managed'
import { StudioError, type AgentInspection, type AgentManagementAdapter, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const metadata: AgentInspection = { native: { name: 'Fixture', version: '1' }, authentication: { state: 'unknown', methods: [] }, models: { status: 'available', items: [{ id: 'model', name: 'Model' }] } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
function setup(inspect: AgentManagementAdapter['inspect'] = async () => metadata, supported = true) {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info() {}, warn() {}, error() {} }, authorize = vi.fn(), inspector = vi.fn(inspect), create = vi.fn()
  const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, ['ekko'])
  registration.register({ id: 'ekko', name: 'Fixture', configSchema: { type: 'object' }, capabilities: { text: true, modes: ['global'] },
    ...(supported ? { management: { inspect: inspector } } : {}), create })
  registration.commit()
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize, context: (scope, signal) => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, agents: { list: async () => [] }, sessions: { get: async () => null },
  }) })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: { key: 'instance-config' }, mode: 'global' })
  cleanups.push(async () => { await coordinator.close(); events.close(); db.close() })
  return { db, coordinator, store, registry, create, inspector, instance, authorize, registration,
    inspect: (signal?: AbortSignal) => coordinator.inspectInstance(scope, instance.id, signal) }
}

it('discovers management and inspects without creating a runtime, Run or revision', async () => {
  const f = setup()
  expect(f.registry.list('one')[0].management).toEqual({ inspect: true })
  expect(await f.inspect()).toEqual({ ...metadata, instanceId: f.instance.id, configRevision: 1, provider: { kind: 'builtin', module: 'ekko', implementationVersion: 'test' } })
  expect(f.inspector).toHaveBeenCalledWith({ instanceId: f.instance.id, config: f.instance.config, configRevision: 1, mode: 'global' },
    expect.objectContaining({ ownerId: 'owner', profileId: 'one', signal: expect.any(AbortSignal) }))
  expect(f.create).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect(f.store.instance(f.instance.id)).toEqual(f.instance)
  expect(f.inspector.mock.calls[0][1].signal.aborted).toBe(true)
})

it('serializes inspection with configuration and execution, and snapshots caller identity', async () => {
  const barrier = deferred<AgentInspection>(), f = setup(() => barrier.promise), mutableScope = structuredClone(scope)
  const pending = f.coordinator.inspectInstance(mutableScope, f.instance.id)
  mutableScope.principal.id = 'forged'
  await vi.waitFor(() => expect(f.inspector).toHaveBeenCalledOnce())
  await expect(f.inspect()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(() => f.coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'start' }] }, 'start')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  barrier.resolve(metadata); await pending
  expect(await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).toMatchObject({ revision: 2 })
})

it.each([
  { ...scope, principal: { kind: 'user' as const, id: 'other' } }, { ...scope, profileId: 'other' },
])('rejects a foreign owner/profile before native code is called', async caller => {
  const f = setup()
  await expect(f.coordinator.inspectInstance(caller, f.instance.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(f.inspector).not.toHaveBeenCalled()
})
it.each(['sessionId', 'runId', 'workspaceId'])('rejects bound management scope %s', async key => {
  const f = setup()
  await expect(f.coordinator.inspectInstance({ ...scope, [key]: 'bound' }, f.instance.id)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.inspector).not.toHaveBeenCalled()
})

it('reports unsupported inspection without starting the Agent', async () => {
  const f = setup(undefined, false)
  expect(f.registry.list('one')[0].management).toBeUndefined()
  await expect(f.inspect()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.create).not.toHaveBeenCalled()
})

it('rejects active runs without cancelling them', async () => {
  const f = setup(), result = deferred<{ status: 'completed' }>()
  f.create.mockResolvedValue({ run: async () => ({ events: (async function* () {})(), result: result.promise, cancel: async () => {} }), dispose: async () => {} })
  const run = f.coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'start' }] }, 'start')
  await expect(f.inspect()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.inspector).not.toHaveBeenCalled()
  result.resolve({ status: 'completed' }); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
})

it.each([
  { ...metadata, secret: 'credential' }, { ...metadata, native: { name: 'Fixture', home: '/private' } },
  { ...metadata, authentication: { state: 'authenticated', methods: [], email: 'private@example.test' } },
  { ...metadata, models: { status: 'available', items: [{ id: 'x', name: 'X', token: 'secret' }] } },
  { ...metadata, models: { status: 'available', items: [{ id: 'x', name: 'X' }, { id: 'x', name: 'Y' }] } },
  { ...metadata, models: { status: 'unsupported', items: [{ id: 'x', name: 'X' }] } },
])('rejects private/invalid metadata at the host boundary: %j', async value => {
  const f = setup(async () => value as AgentInspection)
  await expect(f.inspect()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it.each(['owner', 'provider', 'revision'])('rechecks %s before returning metadata', async change => {
  const barrier = deferred<AgentInspection>(), f = setup(() => barrier.promise), pending = f.inspect()
  await vi.waitFor(() => expect(f.inspector).toHaveBeenCalledOnce())
  if (change === 'owner') f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  if (change === 'provider') f.registration.dispose()
  if (change === 'revision') f.store.configureInstance(f.instance, { revision: 1, mode: 'global', config: {} })
  barrier.resolve(metadata)
  await expect(pending).rejects.toMatchObject({ code: change === 'owner' ? 'FORBIDDEN' : change === 'provider' ? 'RUNTIME_UNAVAILABLE' : 'REVISION_CONFLICT' })
})

it('cancels in-flight native work and rejects late resource acquisition', async () => {
  const f = setup(async (_input, context) => new Promise((_resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }) })), controller = new AbortController(), pending = f.inspect(controller.signal)
  await vi.waitFor(() => expect(f.inspector).toHaveBeenCalledOnce())
  controller.abort()
  await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  const context = f.inspector.mock.calls[0][1]
  expect(context.signal.aborted).toBe(true)
  await expect(context.processes.spawn({ command: process.execPath, args: ['-e', ''], cwd: process.cwd() })).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).toMatchObject({ revision: 2 })
})

it('never dispatches an already cancelled inspection and sanitizes native failures', async () => {
  const f = setup(async () => { throw new Error('private token in native error') }), controller = new AbortController()
  controller.abort()
  await expect(f.inspect(controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(f.inspector).not.toHaveBeenCalled()
  await expect(f.inspect()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', message: 'Agent inspection failed' })
})

it('bounds a hung inspector and keeps the instance occupied when its callback does not stop', async () => {
  vi.useFakeTimers()
  const f = setup(async () => new Promise(() => {}))
  const pending = f.inspect().catch(error => error)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await pending).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await expect(f.inspect()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
})

it('shuts down an outstanding cooperative inspection', async () => {
  const f = setup(async (_input, context) => new Promise((_resolve, reject) => { context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }) }))
  const shutdown = f.inspect().catch(error => error)
  await vi.waitFor(() => expect(f.inspector).toHaveBeenCalledOnce())
  await f.coordinator.close()
  expect(await shutdown).toMatchObject({ code: 'CANCELLED' })
})

it('retains the instance lock when native cleanup cannot be confirmed', async () => {
  const f = setup(), close = vi.spyOn(ManagedProcessScope.prototype, 'close').mockRejectedValue(new Error('not stopped'))
  try {
    await expect(f.inspect()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await expect(f.inspect()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, config: {}, mode: 'global' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(() => f.coordinator.start(scope, f.instance.id, { content: [{ type: 'text', text: 'start' }] }, 'start')).toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
  } finally { close.mockRestore() }
})
