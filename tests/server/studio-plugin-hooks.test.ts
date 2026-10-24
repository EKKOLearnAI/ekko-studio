import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginHookRegistry, parseHookRegistration } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope, type ExecutionContext, type AgentRunInput, type JsonValue } from '../../packages/studio-plugin-sdk/src'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const scope: ExecutionScope = { scopeId: 'scope', traceId: 'trace', profileId: 'one', principal: { kind: 'user', id: '1' }, surface: 'api' }
const request = { instanceId: 'instance', idempotencyKey: 'request', input: { content: [{ type: 'text' as const, text: 'hello' }], timeoutMs: 1000 } }
const context = (signal = new AbortController().signal) => ({ scope, signal }) as ExecutionContext
const declaration = (key: string, priority = 0) => ({ point: 'runs.start' as const, options: { key, priority } })

it('orders hooks by priority, plugin and stable key while preserving immutable input snapshots', async () => {
  const hooks = new PluginHookRegistry(), order: string[] = []
  for (const [plugin, key, priority] of [['z.plugin', 'a', 10], ['a.plugin', 'b', 0], ['a.plugin', 'a', 0]] as const) {
    hooks.register('one', plugin, 'generation', declaration(key, priority), async input => {
      order.push(`${plugin}:${key}`)
      expect(Object.isFrozen(input)).toBe(true)
      expect(Object.isFrozen((input as any).input.content[0])).toBe(true)
      return plugin === 'z.plugin' ? { action: 'patch', patch: { content: [{ type: 'text', text: 'patched' }], timeoutMs: 500 } } : { action: 'continue' }
    })
  }
  hooks.register('other', 'foreign', 'g', declaration('x', 100), async () => { throw Error('wrong profile') })
  const result = await hooks.run('runs.start', request, context())
  expect(order).toEqual(['z.plugin:a', 'a.plugin:a', 'a.plugin:b'])
  expect(result.snapshot.map(entry => `${entry.pluginId}:${entry.key}`)).toEqual(order)
  expect(result.input.input).toEqual({ content: [{ type: 'text', text: 'patched' }], timeoutMs: 500 })
  expect(request.input.content[0].text).toBe('hello')
})

it.each([
  { action: 'continue', actor: 'other' }, { action: 'patch', patch: { instanceId: 'other' } },
  { action: 'patch', patch: { model: 'unauthorized' } }, { action: 'patch', patch: { timeoutMs: 1001 } },
  { action: 'patch', patch: { content: [{ type: 'file', artifactId: 'secret' }] } },
  { action: 'patch', patch: {} }, { action: 'patch', patch: { content: [{ type: 'text', text: 'ok', actor: 'forged' }] } },
])('rejects a malformed or widening hook result: %j', async result => {
  const hooks = new PluginHookRegistry()
  hooks.register('one', 'test.plugin', 'g', declaration('policy'), async () => result as JsonValue)
  await expect(hooks.run('runs.start', request, context())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it('only permits continue or reject for deletion and closes a chain on rejection', async () => {
  const hooks = new PluginHookRegistry(), next = vi.fn(async () => ({ action: 'continue' }))
  hooks.register('one', 'a.plugin', 'g', { point: 'sessions.remove', options: { key: 'reject', priority: 0 } }, async () => ({ action: 'reject' }))
  hooks.register('one', 'b.plugin', 'g', { point: 'sessions.remove', options: { key: 'next', priority: 0 } }, next)
  await expect(hooks.run('sessions.remove', { sessionId: 'session' }, context())).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(next).not.toHaveBeenCalled()
  const patch = new PluginHookRegistry()
  patch.register('one', 'test.plugin', 'g', { point: 'sessions.remove', options: { key: 'patch', priority: 0 } }, async () => ({ action: 'patch', patch: { sessionId: 'other' } }))
  await expect(patch.run('sessions.remove', { sessionId: 'session' }, context())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it('aborts pending hooks on unload and does not include new registrations in an in-flight snapshot', async () => {
  const hooks = new PluginHookRegistry(), gate = Promise.withResolvers<JsonValue>(), later = vi.fn(async () => ({ action: 'continue' }))
  const remove = hooks.register('one', 'first', 'g', declaration('first'), async () => gate.promise)
  const running = hooks.run('runs.start', request, context())
  hooks.register('one', 'later', 'g', declaration('later'), later)
  await remove()
  await expect(running).rejects.toMatchObject({ code: 'PLUGIN_UNAVAILABLE' })
  gate.resolve({ action: 'continue' }); expect(later).not.toHaveBeenCalled()
  expect((await hooks.run('runs.start', request, context())).snapshot.map(entry => entry.pluginId)).toEqual(['later'])
})

it('enforces callback and total-chain deadlines and aborts query scopes', async () => {
  const hooks = new PluginHookRegistry({ timeoutMs: 20 }), signals: AbortSignal[] = []
  hooks.register('one', 'hung', 'g', declaration('hung'), async (_input, ctx) => { signals.push(ctx.signal); await new Promise(() => {}); return null })
  await expect(hooks.run('runs.start', request, context())).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  expect(signals[0].aborted).toBe(true)
  const chain = new PluginHookRegistry({ timeoutMs: 100, chainTimeoutMs: 20 })
  chain.register('one', 'first', 'g', declaration('first'), async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { action: 'continue' } })
  chain.register('one', 'hung', 'g', declaration('hung'), async () => { await new Promise(() => {}); return null })
  await expect(chain.run('runs.start', request, context())).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
})

it('validates stable keys, priorities, nodes and duplicate registrations', () => {
  for (const value of [{ point: 'unknown', options: { key: 'x' } }, { point: 'runs.start', options: { key: '' } }, { point: 'runs.start', options: { key: 'x', priority: 1001 } }]) {
    expect(() => parseHookRegistration(value)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  }
  const hooks = new PluginHookRegistry()
  expect(() => hooks.validate('one', 'plugin', [declaration('same'), declaration('same')])).toThrow(expect.objectContaining({ code: 'REGISTRATION_CONFLICT' }))
})

function setup() {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus(), hooks = new PluginHookRegistry()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let allowed = true
  const authorize = () => { if (!allowed) throw new StudioError('FORBIDDEN', 'Access revoked') }
  const inputs: AgentRunInput[] = [], factory = vi.fn(async () => ({ run: async (input: AgentRunInput) => {
    inputs.push(input); return { events: (async function* () {})(), result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {} }
  }, dispose: async () => {} }))
  const register = (version = 'one') => {
    const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: version }, ['ekko'])
    registration.register({ id: 'ekko', name: 'Fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'] }, create: factory }); registration.commit()
    return registration
  }
  const registration = register()
  const context = (scope: ExecutionScope, signal: AbortSignal) => createExecutionContext(scope, signal, logger, { authorize: async () => authorize(), agents: { list: async () => [] }, sessions: { get: async () => null } })
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize, context }), admission = new AgentRunAdmission(coordinator, hooks, context)
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'scoped' })
  cleanup.push(async () => { await coordinator.close(); events.close(); db.close() })
  return { db, store, hooks, coordinator, admission, factory, inputs, registration, register, context,
    request: { ...request, instanceId: instance.id }, revoke: () => { allowed = false } }
}

it('runs hooks once for concurrent idempotent starts and retains original-input identity and hook order', async () => {
  const f = setup(), gate = Promise.withResolvers<JsonValue>()
  const hook = vi.fn(async () => gate.promise), dispose = f.hooks.register('one', 'policy', 'generation', declaration('patch'), hook)
  const signal = new AbortController().signal
  const first = f.admission.start(scope, f.request, signal), second = f.admission.start(scope, f.request, signal)
  await expect(f.admission.start(scope, { ...f.request, input: { ...f.request.input, model: 'different' } }, signal)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  gate.resolve({ action: 'patch', patch: { content: [{ type: 'text', text: 'accepted' }], timeoutMs: 500 } })
  const [a, b] = await Promise.all([first, second]); expect(a.id).toBe(b.id)
  await f.coordinator.wait(a.id)
  expect(hook).toHaveBeenCalledTimes(1); expect(f.factory).toHaveBeenCalledTimes(1)
  expect(f.inputs[0]).toEqual({ content: [{ type: 'text', text: 'accepted' }], timeoutMs: 500 })
  expect(f.store.get(a.id)?.hooks).toEqual([{ point: 'runs.start', pluginId: 'policy', generation: 'generation', key: 'patch', priority: 0 }])
  const saved = f.db.prepare('SELECT * FROM studio_agent_run_admissions WHERE run_id=?').get(a.id) as any
  expect(JSON.parse(saved.original_input_json)).toEqual(f.request.input)
  expect(JSON.parse(saved.effective_input_json)).toEqual(f.inputs[0])
  await dispose(); f.registration.dispose()
  const restarted = new AgentRunAdmission(f.coordinator, f.hooks, f.context)
  expect((await restarted.start(scope, f.request, signal)).id).toBe(a.id)
  expect(hook).toHaveBeenCalledTimes(1)
})

it.each(['permission', 'configuration', 'provider', 'cancel'])('rechecks %s after hooks before any runtime or database acceptance', async change => {
  const f = setup(), controller = new AbortController()
  f.hooks.register('one', 'policy', 'g', declaration('gate'), async () => {
    if (change === 'permission') f.revoke()
    if (change === 'configuration') f.db.prepare('UPDATE studio_agent_instances SET revision=revision+1 WHERE id=?').run(f.request.instanceId)
    if (change === 'provider') { f.registration.dispose(); f.register('two') }
    if (change === 'cancel') controller.abort()
    return { action: 'continue' }
  })
  await expect(f.admission.start(scope, f.request, controller.signal)).rejects.toMatchObject({ code: change === 'permission' ? 'FORBIDDEN' : change === 'cancel' ? 'CANCELLED' : 'REVISION_CONFLICT' })
  expect(f.factory).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM studio_agent_runs').get()).toMatchObject({ n: 0 })
})

it('rejects inaccessible instances before hooks and commits acceptance together with the hook snapshot', async () => {
  const f = setup(), hook = vi.fn(async () => ({ action: 'continue' }))
  f.hooks.register('one', 'policy', 'g', declaration('gate'), hook)
  await expect(f.admission.start({ ...scope, principal: { kind: 'user', id: '2' } }, f.request, new AbortController().signal)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(hook).not.toHaveBeenCalled()
  f.db.exec("CREATE TRIGGER deny_snapshot BEFORE INSERT ON studio_agent_run_admissions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  await expect(f.admission.start(scope, f.request, new AbortController().signal)).rejects.toThrow('fixture failure')
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM studio_agent_runs').get()).toMatchObject({ n: 0 })
  expect(f.factory).not.toHaveBeenCalled()
})

it('bounds pending admissions without consuming a second slot for an idempotent waiter', async () => {
  const f = setup(), controller = new AbortController()
  f.hooks.register('one', 'policy', 'g', declaration('wait'), async () => { await new Promise(() => {}); return null })
  const pending = Array.from({ length: 128 }, (_, index) => f.admission.start(scope, { ...f.request, idempotencyKey: `request-${index}` }, controller.signal))
  pending.push(f.admission.start(scope, { ...f.request, idempotencyKey: 'request-0' }, controller.signal))
  const settled = Promise.allSettled(pending)
  await expect(f.admission.start(scope, { ...f.request, idempotencyKey: 'overflow' }, controller.signal)).rejects.toMatchObject({ code: 'RESOURCE_EXHAUSTED' })
  controller.abort()
  expect((await settled).every(result => result.status === 'rejected' && result.reason.code === 'CANCELLED')).toBe(true)
  expect(f.factory).not.toHaveBeenCalled()
})
