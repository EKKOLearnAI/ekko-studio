import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentExecutionStore } from '../../packages/server/src/modules/studio/repositories/agent-execution-store'
import { AgentCoordinator } from '../../packages/server/src/modules/studio/services/agents/coordinator'
import { AgentRegistry } from '../../packages/server/src/modules/studio/services/agents/registry'
import { PluginEventBus } from '../../packages/server/src/modules/studio/services/events/plugin-events'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { createExecutionContext } from '../../packages/server/src/modules/studio/services/context/execution'
import { AsyncChannel } from '../../packages/server/src/modules/studio/services/plugins/channel'
import { StudioError, type AgentCapabilities, type AgentRunResult, type AgentOutputEvent, type AgentTypeDefinition, type ExecutionScope } from '../../packages/studio-plugin-sdk/src'

const scope: ExecutionScope = { scopeId: 'scope', principal: { id: '1', kind: 'user' }, profileId: 'one', surface: 'api', traceId: 'trace' }
const input = { content: [{ type: 'text' as const, text: 'hello' }] }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0)) await close() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function turn() {
  const events = new AsyncChannel<AgentOutputEvent>(), result = deferred<AgentRunResult>()
  const cancel = vi.fn(async () => { events.finish(); result.resolve({ status: 'cancelled' }) })
  return { events, result: result.promise, cancel, complete: (checkpoint?: string) => { events.finish(); result.resolve({ status: 'completed', ...(checkpoint ? { checkpoint } : {}) }) } }
}
function setup(create: AgentTypeDefinition['create'], capabilities: Partial<AgentCapabilities> = {}, settleRun?: (id: string) => Promise<void>) {
  const db = new DatabaseSync(':memory:'), store = new AgentExecutionStore(db), registry = new AgentRegistry(), events = new PluginEventBus()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, authorize = vi.fn()
  const registration = registry.stage('*', { kind: 'builtin', module: 'ekko', implementationVersion: 'test' }, ['ekko'])
  const factory = vi.fn(create)
  registration.register({ id: 'ekko', name: 'Fixture', configSchema: {}, capabilities: { text: true, modes: ['scoped'], ...capabilities }, create: factory })
  registration.commit()
  const coordinator = new AgentCoordinator({ store, registry, events, logger, authorize, settleRun, context: (scope, signal) => createExecutionContext(scope, signal, logger, {
    authorize: async () => {}, sessions: { get: async () => null }, agents: { list: async profile => registry.list(profile) },
  }) })
  const instance = coordinator.createInstance(scope, { agentTypeId: 'ekko', config: {}, mode: 'scoped' })
  cleanups.push(async () => { await coordinator.close(); events.close(); db.close() })
  return { coordinator, instance, db, store, factory, registration, authorize, events }
}

it('keeps a built-in Run finalizing until its host model accounting settles', async () => {
  const accounting = deferred<void>(), settle = vi.fn(() => accounting.promise)
  const f = setup(async () => ({ run: async () => { const value = turn(); value.complete(); return value }, dispose: async () => {} }), {}, settle)
  const run = f.coordinator.start(scope, f.instance.id, input, 'metered')
  await vi.waitFor(() => expect(settle).toHaveBeenCalledExactlyOnceWith(run.id))
  expect(f.coordinator.get(scope, run.id).status).toBe('finalizing')
  accounting.resolve(); await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('completed')
  expect(settle).toHaveBeenCalledOnce()
})

it('keeps the runtime lease quarantined when model cancellation cannot be confirmed', async () => {
  const settle = vi.fn(async () => { throw new StudioError('DEADLINE_EXCEEDED', 'model still active') }), dispose = vi.fn(async () => {})
  const f = setup(async () => ({ run: async () => { const value = turn(); value.complete(); return value }, dispose }), {}, settle)
  const run = f.coordinator.start(scope, f.instance.id, input, 'first')
  await f.coordinator.wait(run.id)
  expect(f.coordinator.get(scope, run.id).status).toBe('interrupted')
  expect(dispose).toHaveBeenCalledOnce()
  const retry = f.coordinator.start(scope, f.instance.id, input, 'retry')
  await f.coordinator.wait(retry.id)
  expect(f.coordinator.get(scope, retry.id)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  expect(f.factory).toHaveBeenCalledOnce()
})

it('serializes concurrent turns and keeps the runtime signal alive between successful turns', async () => {
  const first = turn(), second = turn(), dispose = vi.fn(async () => {}), contexts: any[] = []
  const execute = vi.fn(async (_input, ctx) => { contexts.push(ctx); return execute.mock.calls.length === 1 ? first : second })
  const { coordinator, instance, factory } = setup(async () => ({ run: execute, dispose }), { persistentSession: true })
  const one = coordinator.start(scope, instance.id, input, 'one'), two = coordinator.start(scope, instance.id, input, 'two')
  expect(two.status).toBe('queued')
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
  const runtimeSignal = factory.mock.calls[0][1].signal
  first.complete()
  await coordinator.wait(one.id)
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
  expect(contexts[0].signal.aborted).toBe(true)
  expect(runtimeSignal.aborted).toBe(false)
  expect(contexts[0].scope.runtimeSessionId).toBe(contexts[1].scope.runtimeSessionId)
  expect(contexts[0].scope.runId).not.toBe(contexts[1].scope.runId)
  expect(dispose).not.toHaveBeenCalled()
  second.complete()
  await coordinator.wait(two.id)
  expect(factory).toHaveBeenCalledOnce()
  await coordinator.close()
  expect(runtimeSignal.aborted).toBe(true)
  expect(dispose).toHaveBeenCalledOnce()
})

it('waits for an idle runtime to finish disposal before creating another for the same instance', async () => {
  vi.useFakeTimers()
  const disposal = deferred<void>(), dispose = vi.fn(() => disposal.promise)
  const { coordinator, instance, factory } = setup(async () => ({
    run: async () => { const current = turn(); current.complete(); return current }, dispose,
  }), { persistentSession: true })
  const one = coordinator.start(scope, instance.id, input, 'one')
  await coordinator.wait(one.id)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(dispose).toHaveBeenCalledOnce()
  const two = coordinator.start(scope, instance.id, input, 'two')
  await vi.advanceTimersByTimeAsync(0)
  expect(factory).toHaveBeenCalledOnce()
  expect(coordinator.get(scope, two.id).status).toBe('starting')
  disposal.resolve()
  await coordinator.wait(two.id)
  expect(factory).toHaveBeenCalledTimes(2)
  expect(coordinator.get(scope, two.id).status).toBe('completed')
})

it('quarantines an instance after unconfirmed disposal instead of overlapping native runtimes', async () => {
  const { coordinator, instance, factory, db } = setup(async () => ({
    run: async () => { const current = turn(); current.complete(); return current }, dispose: async () => { throw new Error('still running') },
  }))
  const one = coordinator.start(scope, instance.id, input, 'one')
  await coordinator.wait(one.id)
  const two = coordinator.start(scope, instance.id, input, 'two')
  await coordinator.wait(two.id)
  expect(factory).toHaveBeenCalledOnce()
  expect(coordinator.get(scope, one.id).status).toBe('completed')
  expect(coordinator.get(scope, two.id)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  expect(db.prepare("SELECT count(*) AS n FROM studio_agent_runtime_leases WHERE status='active'").get()).toMatchObject({ n: 1 })
})

it('retains a timed-out factory lease until its late runtime has actually stopped', async () => {
  vi.useFakeTimers()
  const creation = deferred<any>(), disposal = deferred<void>(), dispose = vi.fn(() => disposal.promise), execute = vi.fn()
  const { coordinator, instance, factory } = setup(() => creation.promise)
  const one = coordinator.start(scope, instance.id, { ...input, timeoutMs: 100 }, 'one')
  const two = coordinator.start(scope, instance.id, input, 'two')
  await vi.advanceTimersByTimeAsync(10_101)
  await coordinator.wait(one.id); await coordinator.wait(two.id)
  expect(coordinator.get(scope, one.id)).toMatchObject({ status: 'interrupted', errorCode: 'DEADLINE_EXCEEDED' })
  expect(coordinator.get(scope, two.id)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
  expect(factory).toHaveBeenCalledOnce()
  creation.resolve({ run: execute, dispose })
  await vi.advanceTimersByTimeAsync(0)
  expect(dispose).toHaveBeenCalledOnce()
  expect(execute).not.toHaveBeenCalled()
  const three = coordinator.start(scope, instance.id, input, 'three')
  await coordinator.wait(three.id)
  expect(factory).toHaveBeenCalledOnce()
  disposal.resolve()
  await vi.advanceTimersByTimeAsync(0)
  factory.mockResolvedValue({ run: async () => { const current = turn(); current.complete(); return current }, dispose: async () => {} })
  const four = coordinator.start(scope, instance.id, input, 'four')
  await coordinator.wait(four.id)
  expect(coordinator.get(scope, four.id).status).toBe('completed')
  expect(factory).toHaveBeenCalledTimes(2)
})

it('checks permission again after runtime creation before sending user input', async () => {
  const execute = vi.fn(), dispose = vi.fn(async () => {}), creation = deferred<any>()
  const { coordinator, instance, authorize, factory } = setup(() => creation.promise)
  const run = coordinator.start(scope, instance.id, input, 'one')
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce())
  authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'revoked') })
  creation.resolve({ run: execute, dispose })
  await coordinator.wait(run.id)
  authorize.mockReset()
  expect(coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect(execute).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
})

it('cleans factory-owned processes before releasing the lease and dispatching a queued retry', async () => {
  let pid = 0, calls = 0
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  const { coordinator, instance, db } = setup(async (_input, ctx) => {
    if (++calls > 1) {
      expect(alive()).toBe(false)
      return { run: async () => { const current = turn(); current.complete(); return current }, dispose: async () => {} }
    }
    const child = await ctx.processes.spawn({ command: process.execPath, args: ['-e', `process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)`], cwd: process.cwd() })
    let batch = await child.read()
    while (!batch.chunks.length && !batch.exit) batch = await child.read()
    pid = Number(Buffer.concat(batch.chunks.map(chunk => Buffer.from(chunk.data))).toString())
    expect(alive()).toBe(true)
    throw new Error('Factory failed after launching its child')
  })
  const first = coordinator.start(scope, instance.id, input, 'failed-factory')
  const second = coordinator.start(scope, instance.id, input, 'retry-factory')
  await coordinator.wait(first.id); await coordinator.wait(second.id)
  expect(coordinator.get(scope, first.id).status).toBe('failed')
  expect(coordinator.get(scope, second.id).status).toBe('completed')
  expect(alive()).toBe(false)
  expect(db.prepare("SELECT count(*) AS total FROM studio_agent_runtime_leases WHERE status='active'").get()).toMatchObject({ total: 0 })
})

it('cancels just the queued input and cannot stop the preceding or following turn', async () => {
  const first = turn(), third = turn()
  const execute = vi.fn(async () => execute.mock.calls.length === 1 ? first : third)
  const { coordinator, instance } = setup(async () => ({ run: execute, dispose: async () => {} }), { persistentSession: true })
  const one = coordinator.start(scope, instance.id, input, 'one')
  const two = coordinator.start(scope, instance.id, input, 'two')
  const three = coordinator.start(scope, instance.id, input, 'three')
  expect((await coordinator.cancel(scope, two.id)).status).toBe('cancelled')
  await coordinator.wait(two.id)
  expect(first.cancel).not.toHaveBeenCalled()
  first.complete()
  await coordinator.wait(one.id)
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
  await coordinator.cancel(scope, two.id)
  expect(third.cancel).not.toHaveBeenCalled()
  third.complete()
  await coordinator.wait(three.id)
})

it('rechecks permission at queued dispatch', async () => {
  const first = turn(), execute = vi.fn(async () => first)
  const { coordinator, instance, authorize } = setup(async () => ({ run: execute, dispose: async () => {} }))
  const one = coordinator.start(scope, instance.id, input, 'one'), two = coordinator.start(scope, instance.id, input, 'two')
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
  authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'revoked') })
  first.complete()
  await coordinator.wait(one.id); await coordinator.wait(two.id)
  authorize.mockReset()
  expect(coordinator.get(scope, two.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  expect(execute).toHaveBeenCalledOnce()
})

it('restores only a successfully committed checkpoint without replaying an input', async () => {
  const { coordinator, instance, factory, store } = setup(async () => ({
    run: async () => { const current = turn(); current.complete('native-reference'); return current }, dispose: async () => {},
  }), { resume: true })
  const one = coordinator.start(scope, instance.id, input, 'one')
  await coordinator.wait(one.id)
  store.recover()
  expect(factory).toHaveBeenCalledOnce()
  const two = coordinator.start(scope, instance.id, input, 'two')
  await coordinator.wait(two.id)
  expect(factory.mock.calls[1][0].resume).toBe('native-reference')
  expect(factory.mock.calls[0][1].runtimeSessionId).not.toBe(factory.mock.calls[1][1].runtimeSessionId)
})

it('does not retain checkpoints from a failed stream', async () => {
  const { coordinator, instance, store } = setup(async () => ({
    run: async () => ({ events: (async function* () { yield { type: 'checkpoint.updated' as const, producerSequence: 1, value: 'unsafe' }; throw new Error('broken') })(), result: Promise.resolve({ status: 'completed' as const, checkpoint: 'also-unsafe' }), cancel: async () => {} }), dispose: async () => {},
  }), { resume: true })
  const run = coordinator.start(scope, instance.id, input, 'one')
  await coordinator.wait(run.id)
  expect(store.state.checkpoint(instance.id, run.provider, 1)).toBeUndefined()
})

it('claims completion before checkpoint capture and rejects cancellation during finalizing', async () => {
  const checkpoint = deferred<string>()
  const { coordinator, instance } = setup(async () => ({
    run: async () => { const current = turn(); current.complete(); return current }, checkpoint: () => checkpoint.promise, dispose: async () => {},
  }), { resume: true })
  const run = coordinator.start(scope, instance.id, input, 'one')
  await vi.waitFor(() => expect(coordinator.get(scope, run.id).status).toBe('finalizing'))
  await expect(coordinator.cancel(scope, run.id)).rejects.toMatchObject({ code: 'RUN_FINALIZING' })
  checkpoint.resolve('snapshot')
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('completed')
})

it('bounds the completion barrier when result succeeds but output never ends', async () => {
  vi.useFakeTimers()
  const channel = new AsyncChannel<AgentOutputEvent>()
  const { coordinator, instance } = setup(async () => ({
    run: async () => ({ events: channel, result: Promise.resolve({ status: 'completed' as const }), cancel: async () => {} }), dispose: async () => { channel.finish() },
  }))
  const run = coordinator.start(scope, instance.id, input, 'one')
  await vi.advanceTimersByTimeAsync(5_001)
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id)).toMatchObject({ status: 'interrupted', errorCode: 'DEADLINE_EXCEEDED' })
})

it('deduplicates revisions and replaces cumulative/final usage instead of summing snapshots', async () => {
  const current = turn()
  const { coordinator, instance } = setup(async () => ({ run: async () => current, dispose: async () => {} }))
  const run = coordinator.start(scope, instance.id, input, 'one')
  const report = (producerSequence: number, revision: number, mode: 'delta' | 'cumulative' | 'final', inputTokens: number) => current.events.push({ type: 'usage.reported', producerSequence, revision, mode, inputTokens, outputTokens: inputTokens, modelCallId: 'call', model: 'model' })
  await report(1, 1, 'delta', 3); await report(2, 1, 'delta', 3); await report(3, 2, 'cumulative', 7)
  await report(4, 3, 'final', 8); await report(5, 4, 'final', 6); await report(6, 2, 'cumulative', 7)
  current.complete()
  await coordinator.wait(run.id)
  expect(coordinator.usage(scope, run.id)).toEqual([{ modelCallId: 'call', model: 'model', revision: 4, inputTokens: 6, outputTokens: 6, final: true }])
  expect(coordinator.output(scope, run.id, -1)).toHaveLength(6)
})

it('rolls back invalid usage together with its output event', async () => {
  const current = turn()
  const { coordinator, instance } = setup(async () => ({ run: async () => current, dispose: async () => {} }))
  const run = coordinator.start(scope, instance.id, input, 'one')
  const event = { type: 'usage.reported' as const, producerSequence: 1, revision: 1, mode: 'final' as const, inputTokens: 3, outputTokens: 1, modelCallId: 'call', model: 'model' }
  await current.events.push(event); await current.events.push({ ...event, producerSequence: 2, inputTokens: 99 })
  current.complete(); await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('failed')
  expect(coordinator.usage(scope, run.id)[0].inputTokens).toBe(3)
  expect(coordinator.output(scope, run.id, -1)).toHaveLength(1)
})

it('persists interactions and sends a concurrent duplicate response to the runtime only once', async () => {
  const current = turn(), response = deferred<void>()
  const respond = vi.fn(async () => { current.complete(); await response.promise })
  const { coordinator, instance, db } = setup(async () => ({ run: async () => ({ ...current, respond }), dispose: async () => {} }), { approvals: true })
  const run = coordinator.start(scope, instance.id, input, 'one')
  await current.events.push({ type: 'interaction.requested', producerSequence: 1, requestId: 'approve', kind: 'approval', prompt: 'Continue?', choices: [{ id: 'yes', label: 'Yes' }] })
  await vi.waitFor(() => expect(coordinator.get(scope, run.id).status).toBe('waiting_input'))
  const interaction = coordinator.interactions(scope, run.id)[0]
  const value = { interactionId: interaction.id, idempotencyKey: 'answer', choiceId: 'yes' }
  await expect(coordinator.respond({ ...scope, principal: { id: '2', kind: 'user' } }, run.id, value)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await expect(coordinator.respond(scope, run.id, { ...value, choiceId: 'unknown' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  const first = coordinator.respond(scope, run.id, value), duplicate = coordinator.respond(scope, run.id, value)
  await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
  expect(new PluginEventStore(db).read('one')).toHaveLength(0)
  response.resolve()
  expect(await first).toMatchObject({ status: 'resolved' }); expect(await duplicate).toMatchObject({ status: 'resolved' })
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('completed')
  expect(await coordinator.respond(scope, run.id, value)).toMatchObject({ status: 'resolved' })
  await expect(coordinator.respond(scope, run.id, { ...value, idempotencyKey: 'different' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(respond).toHaveBeenCalledWith({ requestId: 'approve', choiceId: 'yes' })
})

it('expires an interaction without dispatching and marks unfinished requests interrupted at shutdown', async () => {
  const current = turn(), respond = vi.fn(async () => {})
  const { coordinator, instance } = setup(async () => ({ run: async () => ({ ...current, respond }), dispose: async () => {} }), { clarifications: true })
  const run = coordinator.start(scope, instance.id, input, 'one')
  await current.events.push({ type: 'interaction.requested', producerSequence: 1, requestId: 'question', kind: 'clarification', prompt: 'Name?', choices: [], expiresAt: Date.now() - 1 })
  await current.events.push({ type: 'interaction.requested', producerSequence: 2, requestId: 'question2', kind: 'clarification', prompt: 'Name?', choices: [] })
  await vi.waitFor(() => expect(coordinator.interactions(scope, run.id)).toHaveLength(2))
  await expect(coordinator.respond(scope, run.id, { interactionId: coordinator.interactions(scope, run.id)[0].id, idempotencyKey: 'answer', text: 'Ada' })).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  expect(respond).not.toHaveBeenCalled()
  await coordinator.close()
  expect(coordinator.interactions(scope, run.id).map(value => value.status)).toEqual(['expired', 'interrupted'])
})

it('validates clarification response modes before claiming or dispatching an answer', async () => {
  const current = turn(), respond = vi.fn(async () => {})
  const { coordinator, instance } = setup(async () => ({ run: async () => ({ ...current, respond }), dispose: async () => {} }), { clarifications: true })
  const run = coordinator.start(scope, instance.id, input, 'choices')
  await current.events.push({ type: 'interaction.requested', producerSequence: 1, requestId: 'question', kind: 'clarification', prompt: 'Pick one',
    allowText: false, choices: [{ id: 'one', label: 'One', description: 'Only this choice' }] })
  await vi.waitFor(() => expect(coordinator.interactions(scope, run.id)).toHaveLength(1))
  const interaction = coordinator.interactions(scope, run.id)[0]
  for (const response of [{ text: 'other' }, { choiceId: 'one', text: 'other' }]) {
    await expect(coordinator.respond(scope, run.id, { interactionId: interaction.id, idempotencyKey: 'answer', ...response })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }
  expect(respond).not.toHaveBeenCalled()
  expect(coordinator.interactions(scope, run.id)[0]).toMatchObject({ status: 'pending', allowText: false })
  await coordinator.respond(scope, run.id, { interactionId: interaction.id, idempotencyKey: 'answer', choiceId: 'one' })
  current.complete(); await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('completed')
})

it.each(['receipt', 'event'] as const)('preserves withdrawal when it races an in-flight response: %s', async kind => {
  const current = turn(), response = deferred<void | { status: 'withdrawn' }>()
  const respond = vi.fn(() => response.promise)
  const { coordinator, instance } = setup(async () => ({ run: async () => ({ ...current, respond }), dispose: async () => {} }), { clarifications: true })
  const run = coordinator.start(scope, instance.id, input, kind)
  await current.events.push({ type: 'interaction.requested', producerSequence: 1, requestId: 'question', kind: 'clarification', prompt: 'Name?', choices: [] })
  await vi.waitFor(() => expect(coordinator.interactions(scope, run.id)).toHaveLength(1))
  const answer = { interactionId: coordinator.interactions(scope, run.id)[0].id, idempotencyKey: 'answer', text: 'Ada' }
  const dispatch = coordinator.respond(scope, run.id, answer)
  await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce())
  if (kind === 'event') {
    await current.events.push({ type: 'interaction.withdrawn', producerSequence: 2, requestId: 'question' })
    await vi.waitFor(() => expect(coordinator.get(scope, run.id).status).toBe('running'))
    response.resolve()
  } else response.resolve({ status: 'withdrawn' })
  expect(await dispatch).toMatchObject({ status: 'withdrawn' })
  expect(await coordinator.respond(scope, run.id, answer)).toMatchObject({ status: 'withdrawn' })
  current.complete(); await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('completed')
  expect(current.cancel).not.toHaveBeenCalled()
})

it('rejects withdrawing a request that belongs to no interaction in this run', async () => {
  const current = turn()
  const { coordinator, instance } = setup(async () => ({ run: async () => current, dispose: async () => {} }))
  const run = coordinator.start(scope, instance.id, input, 'foreign-request')
  await current.events.push({ type: 'interaction.withdrawn', producerSequence: 1, requestId: 'foreign' })
  await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'INVALID_ARGUMENT' })
  expect(coordinator.output(scope, run.id, -1)).toEqual([])
})

it('rejects completion with unresolved tools or interactions', async () => {
  const current = turn()
  const { coordinator, instance } = setup(async () => ({ run: async () => current, dispose: async () => {} }))
  const run = coordinator.start(scope, instance.id, input, 'one')
  await current.events.push({ type: 'tool.started', producerSequence: 1, callId: 'call', name: 'write', data: {} })
  current.complete(); await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id)).toMatchObject({ status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' })
})

it('expires a queued run without calling the runtime or cancelling the preceding turn', async () => {
  vi.useFakeTimers()
  const current = turn(), execute = vi.fn(async () => current)
  const { coordinator, instance } = setup(async () => ({ run: execute, dispose: async () => {} }))
  const one = coordinator.start(scope, instance.id, input, 'one')
  const two = coordinator.start(scope, instance.id, { ...input, timeoutMs: 100 }, 'two')
  await vi.advanceTimersByTimeAsync(101)
  expect(coordinator.get(scope, two.id)).toMatchObject({ status: 'interrupted', errorCode: 'DEADLINE_EXCEEDED' })
  expect(current.cancel).not.toHaveBeenCalled()
  current.complete(); await coordinator.wait(one.id)
  expect(execute).toHaveBeenCalledOnce()
})

it('releases an idle persistent runtime and creates a new lease on the next explicit turn', async () => {
  vi.useFakeTimers()
  const dispose = vi.fn(async () => {})
  const { coordinator, instance, factory, db } = setup(async () => ({
    run: async () => { const current = turn(); current.complete(); return current }, dispose,
  }), { persistentSession: true })
  const first = coordinator.start(scope, instance.id, input, 'one')
  await coordinator.wait(first.id)
  await vi.advanceTimersByTimeAsync(60_001)
  expect(dispose).toHaveBeenCalledOnce()
  expect(db.prepare("SELECT count(*) AS total FROM studio_agent_runtime_leases WHERE status='active'").get()).toMatchObject({ total: 0 })
  const second = coordinator.start(scope, instance.id, input, 'two')
  await coordinator.wait(second.id)
  expect(factory).toHaveBeenCalledTimes(2)
})

it('closes persisted leases and interactions after a restart without replay', async () => {
  const current = turn(), respond = vi.fn(async () => {})
  const { coordinator, instance, store, db, factory } = setup(async () => ({ run: async () => ({ ...current, respond }), dispose: async () => {} }), { clarifications: true })
  const run = coordinator.start(scope, instance.id, input, 'one')
  await current.events.push({ type: 'interaction.requested', producerSequence: 1, requestId: 'question', kind: 'clarification', prompt: 'Name?', choices: [] })
  await vi.waitFor(() => expect(coordinator.interactions(scope, run.id)).toHaveLength(1))
  expect(store.recover()).toBe(1)
  expect(store.recover()).toBe(0)
  expect(store.state.interactions(run.id)[0].status).toBe('interrupted')
  expect(db.prepare("SELECT count(*) AS total FROM studio_agent_runtime_leases WHERE status='active'").get()).toMatchObject({ total: 0 })
  current.complete(); await coordinator.wait(run.id)
  expect(coordinator.get(scope, run.id).status).toBe('interrupted')
  expect(factory).toHaveBeenCalledOnce()
})

it('does not replay an interaction whose runtime response failed', async () => {
  const current = turn(), respond = vi.fn(async () => { throw new Error('private runtime detail') })
  const { coordinator, instance } = setup(async () => ({ run: async () => ({ ...current, respond }), dispose: async () => {} }), { clarifications: true })
  const run = coordinator.start(scope, instance.id, input, 'one')
  await current.events.push({ type: 'interaction.requested', producerSequence: 1, requestId: 'question', kind: 'clarification', prompt: 'Name?', choices: [] })
  await vi.waitFor(() => expect(coordinator.interactions(scope, run.id)).toHaveLength(1))
  const response = { interactionId: coordinator.interactions(scope, run.id)[0].id, idempotencyKey: 'answer', text: 'Ada' }
  await expect(coordinator.respond(scope, run.id, response)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', message: 'Interaction response failed' })
  await coordinator.wait(run.id)
  expect(await coordinator.respond(scope, run.id, response)).toMatchObject({ status: 'interrupted' })
  expect(respond).toHaveBeenCalledOnce()
})

it('rejects scoped reads and mutations outside the bound run', async () => {
  const { coordinator, instance } = setup(async () => ({ run: async () => { const current = turn(); current.complete(); return current }, dispose: async () => {} }))
  const run = coordinator.start(scope, instance.id, input, 'one')
  await coordinator.wait(run.id)
  const bound = { ...scope, runId: 'another-run' }
  expect(() => coordinator.usage(bound, run.id)).toThrow('outside the execution scope')
  expect(() => coordinator.interactions(bound, run.id)).toThrow('outside the execution scope')
  await expect(coordinator.cancel(bound, run.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  expect(() => coordinator.start(bound, instance.id, input, 'two')).toThrow('unbound scope')
})

it('cleans MCP connections from a failed factory before dispatching the queued replacement', async () => {
  let pid = 0, factories = 0
  const f = setup(async (_input, ctx) => {
    if (++factories === 1) {
      const connection = await ctx.mcp.connect({ type: 'stdio', command: process.execPath,
        args: [`${process.cwd()}/tests/fixtures/fake-mcp-server.cjs`], cwd: process.cwd() })
      pid = Number((await connection.callTool('fake_pid', {})).content)
      throw new Error('factory failed after acquiring MCP')
    }
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrow()
    return { run: async () => { const current = turn(); current.complete(); return current }, dispose: async () => {} }
  })
  const first = f.coordinator.start(scope, f.instance.id, input, 'mcp-factory-failed')
  const second = f.coordinator.start(scope, f.instance.id, input, 'mcp-factory-retry')
  await Promise.all([f.coordinator.wait(first.id), f.coordinator.wait(second.id)])
  expect(f.coordinator.get(scope, first.id).status).toBe('failed')
  expect(f.coordinator.get(scope, second.id).status).toBe('completed')
})
