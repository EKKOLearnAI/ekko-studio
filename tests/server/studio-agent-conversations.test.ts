import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRunAdmission } from '../../packages/server/src/modules/studio/services/agents/admission'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { PluginHookRegistry } from '../../packages/server/src/modules/studio/services/events/plugin-hooks'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { StudioError, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 'request', principal: { kind: 'user', id: '7' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const input = { content: [{ type: 'text' as const, text: 'continue' }] }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close() })

function setup() {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const hooks = new PluginHookRegistry(), logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  let created = 0, authorized = true
  const seen: Array<{ native: string; turn: number; sessionId?: string; lease: string; surface: ExecutionScope['surface'] }> = [], disposed: string[] = []
  const dispose = vi.fn(async (native: string) => { disposed.push(native) })
  const registration = registry.stage('one', { kind: 'plugin', pluginId: 'test.conversations', version: '1.0.0', generation: 'first' }, ['test.conversations/agent'])
  registration.register({ id: 'test.conversations/agent', name: 'Conversation fixture', configSchema: { type: 'object', additionalProperties: false,
    properties: { model: { type: 'string' }, cwd: { type: 'string' } } },
    capabilities: { text: true, resume: true, persistentSession: true, resumeConfigKeys: ['model'], modes: ['global'] },
    create: async (config, runtime) => {
      created++
      const saved = config.resume as { native: string; turn: number } | undefined
      const native = saved?.native ?? `native-${created}`
      let turn = saved?.turn ?? 0
      return {
        run: async (_, context) => {
          seen.push({ native, turn: ++turn, sessionId: context.scope.sessionId, lease: runtime.runtimeSessionId, surface: context.scope.surface })
          return { events: (async function* () {})(), result: Promise.resolve({ status: 'completed' as const, checkpoint: { native, turn } }), cancel: async () => {} }
        }, dispose: () => dispose(native),
      }
    },
  })
  registration.commit()
  const context = (current: ExecutionScope, signal: AbortSignal) => createExecutionContext(current, signal, logger, {
    authorize: async () => {}, sessions: { get: async () => null }, agents: { list: async profile => registry.list(profile) },
  })
  const coordinators: AgentCoordinator[] = []
  const createCoordinator = () => {
    const coordinator = new AgentCoordinator({ store, registry, events, logger, context, authorize() {}, authorizeChat: (_scope, _instance, sessionId) => {
      if (!authorized || !['a', 'b'].includes(sessionId)) throw new StudioError('FORBIDDEN', 'Fixture chat is unavailable')
    } })
    coordinators.push(coordinator)
    return { coordinator, admission: new AgentRunAdmission(coordinator, hooks, context) }
  }
  let current = createCoordinator()
  let instance = current.coordinator.createInstance(scope, { agentTypeId: 'test.conversations/agent', mode: 'global', config: { model: 'first', cwd: '/workspace' } })
  cleanup.push(async () => { for (const coordinator of coordinators) await coordinator.close(); events.close(); db.close() })
  const run = async (sessionId: string | undefined, key: string) => {
    const result = sessionId ? await current.admission.startInChat(scope, sessionId, { instanceId: instance.id, input, idempotencyKey: key }, new AbortController().signal)
      : current.coordinator.start(scope, instance.id, input, key)
    await current.coordinator.wait(result.id)
    return current.coordinator.get(scope, result.id)
  }
  return { db, store, registry, events, hooks, seen, disposed, dispose, run, scope,
    get coordinator() { return current.coordinator }, get admission() { return current.admission }, get instance() { return instance },
    revoke() { authorized = false },
    async restart() { await current.coordinator.close(); current = createCoordinator() },
    async configure(config: typeof instance.config) { instance = await current.coordinator.updateInstance(scope, instance.id, { revision: instance.revision, mode: instance.mode, config }) },
  }
}

it('isolates native history between two chats and independent Runs across cached leases and host restart', async () => {
  const f = setup()
  const a = await f.run('a', 'a1'), b = await f.run('b', 'b1'), independent = await f.run(undefined, 'i1')
  expect(a).toMatchObject({ status: 'completed', sessionId: 'a', conversationId: expect.any(String) })
  expect(b.conversationId).not.toBe(a.conversationId)
  expect(independent).not.toHaveProperty('conversationId')
  const again = await f.run('a', 'a2')
  expect(again.conversationId).toBe(a.conversationId)
  expect(f.seen.map(row => [row.native, row.turn, row.sessionId])).toEqual([
    ['native-1', 1, 'a'], ['native-2', 1, 'b'], ['native-3', 1, undefined], ['native-1', 2, 'a'],
  ])
  expect(f.seen[0].lease).toBe(f.seen[3].lease)
  expect(new Set(f.seen.map(row => row.lease)).size).toBe(3)
  await f.restart()
  await f.run('b', 'b2'); await f.run('a', 'a3'); await f.run(undefined, 'i2')
  expect(f.seen.slice(-3).map(row => [row.native, row.turn, row.sessionId])).toEqual([
    ['native-2', 2, 'b'], ['native-1', 3, 'a'], ['native-3', 2, undefined],
  ])
  const completed = new PluginEventStore(f.db).read('one').filter(row => row.event.type === 'run.completed')
  expect(completed).toHaveLength(7)
  expect(completed[0].event.subject.sessionId).toBe('a')
  expect(completed[1].event.subject.sessionId).toBe('b')
  expect(completed[2].event.subject.sessionId).toBeUndefined()
})

it('binds idempotency, reads, caller scope and fresh authorization to the exact chat', async () => {
  const f = setup(), run = await f.run('a', 'same-key')
  expect((await f.run('a', 'same-key')).id).toBe(run.id)
  expect(f.seen).toHaveLength(1)
  await expect(f.run('b', 'same-key')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.run(undefined, 'same-key')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(() => f.coordinator.get({ ...scope, sessionId: 'b' }, run.id)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => f.coordinator.get({ ...scope, sessionId: 'a' }, run.id)).not.toThrow()
  const request = { instanceId: f.instance.id, input, idempotencyKey: 'new-key' }
  for (const binding of [{ sessionId: 'b' }, { runId: run.id }, { workspaceId: 'workspace' }]) {
    await expect(f.admission.startInChat({ ...scope, ...binding }, 'a', request, new AbortController().signal)).rejects.toBeInstanceOf(StudioError)
  }
  expect(() => f.coordinator.start({ ...scope, sessionId: 'a' }, f.instance.id, input, 'independent')).toThrow(expect.objectContaining({ code: 'CAPABILITY_UNSUPPORTED' }))
  f.revoke()
  expect(() => f.coordinator.get(scope, run.id)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  await expect(f.run('a', 'same-key')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(f.seen).toHaveLength(1)
})

it('preserves background origin and native history while replacing cached runtimes across execution surfaces', async () => {
  const f = setup()
  const first = await f.run('a', 'chat')
  const background = await f.admission.startInChat({ ...scope, surface: 'event' }, 'a', { instanceId: f.instance.id, input, idempotencyKey: 'background' }, new AbortController().signal)
  await f.coordinator.wait(background.id)
  const last = await f.run('a', 'chat-again')
  expect([first.surface, background.surface, last.surface]).toEqual(['chat', 'event', 'chat'])
  expect(f.seen.map(row => row.native)).toEqual(['native-1', 'native-1', 'native-1'])
  expect(f.seen.map(row => row.surface)).toEqual(['chat', 'event', 'chat'])
  expect(new Set(f.seen.map(row => row.lease)).size).toBe(3)
})

it('drains every chat lease and carries each checkpoint only for compatible configuration changes', async () => {
  const f = setup()
  await f.run('a', 'a1'); await f.run('b', 'b1'); await f.run(undefined, 'i1')
  await f.configure({ model: 'second', cwd: '/workspace' })
  expect(f.disposed.sort()).toEqual(['native-1', 'native-2', 'native-3'])
  await f.run('a', 'a2'); await f.run('b', 'b2'); await f.run(undefined, 'i2')
  expect(f.seen.slice(-3).map(row => [row.native, row.turn])).toEqual([['native-1', 2], ['native-2', 2], ['native-3', 2]])
  await f.configure({ model: 'second', cwd: '/other-workspace' })
  await f.run('a', 'a3'); await f.run('b', 'b3'); await f.run(undefined, 'i3')
  expect(f.seen.slice(-3).map(row => [row.native, row.turn])).toEqual([['native-7', 1], ['native-8', 1], ['native-9', 1]])
})

it('rolls back the logical conversation, Run, binding and admission together on persistence failure', async () => {
  const f = setup()
  f.db.exec("CREATE TRIGGER fail_chat_target BEFORE INSERT ON studio_agent_run_targets BEGIN SELECT RAISE(ABORT, 'fixture binding failure'); END")
  await expect(f.run('a', 'request')).rejects.toThrow('fixture binding failure')
  for (const table of ['studio_agent_conversations', 'studio_agent_runs', 'studio_agent_run_targets', 'studio_agent_run_admissions']) {
    expect(f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0)
  }
  expect(f.seen).toEqual([])
  f.db.exec('DROP TRIGGER fail_chat_target')
  expect((await f.run('a', 'request')).status).toBe('completed')
})

it('runs the existing admission hooks with the bound chat and preserves the original idempotency input', async () => {
  const f = setup(), calls: string[] = []
  f.hooks.register('one', 'test.policy', 'first', { point: 'runs.start', options: { key: 'chat-policy', priority: 0 } }, async (_request, context) => {
    calls.push(context.scope.sessionId!)
    expect(context.scope.surface).toBe('chat')
    return { action: 'patch', patch: { content: [{ type: 'text', text: 'policy text' }] } }
  })
  const run = await f.run('a', 'hooked')
  expect(f.store.input(run.id)?.content).toEqual([{ type: 'text', text: 'policy text' }])
  expect(run.hooks).toMatchObject([{ pluginId: 'test.policy', key: 'chat-policy' }])
  expect((await f.run('a', 'hooked')).id).toBe(run.id)
  expect(calls).toEqual(['a'])
})

it('rejects a pending key for another chat and reauthorizes the target after a suspended hook', async () => {
  const f = setup(), gate = Promise.withResolvers<{ action: 'continue' }>()
  f.hooks.register('one', 'test.policy', 'first', { point: 'runs.start', options: { key: 'hold', priority: 0 } }, async () => gate.promise)
  const request = { instanceId: f.instance.id, input, idempotencyKey: 'pending' }, signal = new AbortController().signal
  const first = f.admission.startInChat(scope, 'a', request, signal)
  const rejected = expect(first).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(f.admission.startInChat(scope, 'b', request, signal)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  f.revoke()
  gate.resolve({ action: 'continue' })
  await rejected
  expect(f.db.prepare('SELECT count(*) AS count FROM studio_agent_runs').get()?.count).toBe(0)
  expect(f.seen).toEqual([])
})

it('keeps the instance unavailable until all physical conversation leases confirm cleanup', async () => {
  const f = setup()
  await f.run('a', 'a1'); await f.run('b', 'b1')
  vi.useFakeTimers()
  let release!: () => void
  f.dispose.mockImplementation(async native => { if (native === 'native-2') await new Promise<void>(resolve => { release = resolve }) })
  const updating = f.configure({ model: 'second', cwd: '/workspace' })
  const failed = expect(updating).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  await vi.advanceTimersByTimeAsync(5000)
  await failed
  expect(f.instance.revision).toBe(1)
  expect(await f.run('a', 'too-early')).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  expect(f.seen).toHaveLength(2)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect((await f.run('a', 'after-cleanup')).status).toBe('completed')
})
