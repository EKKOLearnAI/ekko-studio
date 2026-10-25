import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import type { AgentTypeDefinition, ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0)) await close() })
const scope: ExecutionScope = { scopeId: 'scope', principal: { id: '1', kind: 'user' }, profileId: 'one', surface: 'api', traceId: 'trace' }

function setup(create?: AgentTypeDefinition['create'], nativeMcp = false) {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const factory = vi.fn(create || (async () => ({
    run: async () => ({ events: (async function* () { yield { type: 'message.delta' as const, producerSequence: 1, messageId: 'message', text: 'hello' } })(), result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {} }),
    dispose: async () => {},
  })))
  const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, ['ekko'])
  registration.register({ id: 'ekko', name: 'Ekko fixture', configSchema: { type: 'object', additionalProperties: false, properties: { studioMcp: { type: 'object' } } }, capabilities: { text: true, nativeMcp, modes: ['scoped'] }, create: factory })
  registration.commit()
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize: () => {}, context: (scope, signal) => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, sessions: { get: async () => null }, agents: { list: async profile => registry.list(profile) },
  }) })
  cleanup.push(async () => { await coordinator.close(); events.close(); db.close() })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'scoped' })
  return { db, store, coordinator, instance, factory, registration }
}

it('uses one execution for duplicate requests and commits output before one completion event', async () => {
  const { db, coordinator, instance, factory } = setup()
  const input = { content: [{ type: 'text' as const, text: 'hello' }] }
  const run = coordinator.start(scope, instance.id, input, 'request')
  const retry = coordinator.start(scope, instance.id, input, 'request')
  expect(retry.id).toBe(run.id)
  await coordinator.wait(run.id)
  expect(factory).toHaveBeenCalledOnce()
  expect(coordinator.get(scope, run.id).status).toBe('completed')
  expect(coordinator.output(scope, run.id, -1)).toMatchObject([{ type: 'message.delta', text: 'hello' }])
  expect(new PluginEventStore(db).read('one').map(row => row.event.type)).toEqual(['run.completed'])
  const eventStore = new PluginEventStore(db)
  expect(eventStore.owner(eventStore.read('one')[0].event.id)).toBe(scope.principal.id)
  expect(() => coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'changed' }] }, 'request')).toThrow('different input')
})

it('keeps instance and run data bound to their owner and profile', async () => {
  const { coordinator, instance } = setup()
  const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'request')
  await coordinator.wait(run.id)
  expect(() => coordinator.get({ ...scope, profileId: 'two' }, run.id)).toThrow('unavailable')
  expect(() => coordinator.get({ ...scope, principal: { kind: 'user', id: '2' } }, run.id)).toThrow('unavailable')
  expect(coordinator.listInstances({ ...scope, profileId: 'two' })).toEqual([])
})

it('does not report completion when a plugin result succeeds but its stream fails', async () => {
  const { coordinator, instance, db } = setup(async () => ({
    run: async () => ({ events: (async function* () { yield { type: 'message.delta' as const, producerSequence: 1, messageId: 'message', text: 'partial' }; throw new Error('broken stream') })(), result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {} }),
    dispose: async () => {},
  }))
  const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'request')
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('failed')
  expect(new PluginEventStore(db).read('one').map(row => row.event.type)).toEqual(['run.failed'])
})

it('recovers persisted active runs as interrupted without replaying input', () => {
  const { store, instance, factory } = setup()
  const run = store.accept(instance, { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, { content: [{ type: 'text', text: 'hello' }] }, 'request').run
  expect(store.recover()).toBe(1)
  expect(store.get(run.id)?.status).toBe('interrupted')
  expect(store.recover()).toBe(0)
  expect(factory).not.toHaveBeenCalled()
})

it('returns an existing request after its provider is removed and ignores JSON property order', async () => {
  const { coordinator, instance, registration, factory } = setup()
  const first = coordinator.start(scope, instance.id, { model: 'test', content: [{ type: 'text', text: 'hello' }] }, 'same')
  await coordinator.wait(first.id)
  await registration.dispose()
  const retry = coordinator.start(scope, instance.id, { content: [{ text: 'hello', type: 'text' }], model: 'test' }, 'same')
  expect(retry.id).toBe(first.id)
  expect(factory).toHaveBeenCalledOnce()
})

it('bounds cancellation during runtime creation and disposes a late factory result', async () => {
  vi.useFakeTimers()
  let created!: (value: Awaited<ReturnType<AgentTypeDefinition['create']>>) => void
  const { coordinator, instance, db } = setup(() => new Promise(resolve => { created = resolve }))
  const run = coordinator.start(scope, instance.id, { content: [{ type: 'text', text: 'hello' }] }, 'request')
  await coordinator.cancel(scope, run.id)
  await vi.advanceTimersByTimeAsync(5_000)
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('interrupted')
  const dispose = vi.fn(async () => {}), execute = vi.fn()
  created({ run: execute, dispose })
  await vi.advanceTimersByTimeAsync(0)
  expect(dispose).toHaveBeenCalledOnce()
  expect(execute).not.toHaveBeenCalled()
  expect(new PluginEventStore(db).read('one').map(row => row.event.type)).toEqual(['run.failed'])
})

it('rejects malformed input before accepting a run', () => {
  const { coordinator, instance, factory } = setup()
  for (const input of [null, { content: [null] }, { content: [{ type: 'text', text: 'hello' }], model: 3 }]) {
    expect(() => coordinator.start(scope, instance.id, input as never, 'request')).toThrow()
  }
  expect(factory).not.toHaveBeenCalled()
})

it.each([false, true])('rejects unavailable native MCP before admitting a Run (adapter support: %s)', async supported => {
  const f = setup(undefined, supported)
  const configured = await f.coordinator.updateInstance(scope, f.instance.id, { revision: 1, mode: 'scoped', config: { studioMcp: { enabled: true } } })
  expect(() => f.coordinator.start(scope, configured.id, { content: [{ type: 'text', text: 'must not infer' }] }, 'unsupported-mcp'))
    .toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect(f.factory).not.toHaveBeenCalled()
})
