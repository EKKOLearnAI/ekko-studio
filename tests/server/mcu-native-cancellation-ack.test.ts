import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ abort: vi.fn(), exit: vi.fn(), has: vi.fn(), session: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, appHome: '/unused-native-cancel-ack' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async original => ({ ...await original<object>(), getSession: fixture.session }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({ handleAbort: fixture.abort }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', async original => ({ ...await original<object>(), chatCodingAgentRunManager: { hasSession: fixture.has, waitForSessionExit: fixture.exit } }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/app-events', () => ({ bindAppEventSubscription: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events', () => ({ bindLegacyAppEvents: vi.fn() }))
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function setup() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const state = { messages: [], events: [], queue: [{ queue_id: 'own-queue' }, { queue_id: 'other-queue' }], isWorking: true, source: 'global_agent', runId: 'own-run', activeRunMarker: 'own-marker', profile: 'default' }
  const server = Object.assign(Object.create(ChatRunSocket.prototype), { sessionMap: new Map([['selected-chat', state]]), runAdmissions: new Map(), runHandlers: new Map(), runExecutionReceipts: new Map(), ekkoExecutions: new Map(),
    sessionStateSync: { attach: vi.fn() }, nsp: { to: () => ({ emit: vi.fn() }), adapter: { rooms: new Map() } }, canAccessProfile: () => true,
    finishTaskPlanRun: vi.fn(), emitSessionActivity: vi.fn() })
  const socket = { data: { user: { id: 1, role: 'super_admin' } }, handshake: { query: { profile: 'default' }, auth: {} }, rooms: new Set(), id: 'fixture-socket', connected: true,
    join: vi.fn(), on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), emit: vi.fn() }
  Reflect.get(server, 'onConnection').call(server, socket)
  return { server, state, socket, handlers }
}
beforeEach(() => {
  vi.resetAllMocks(); fixture.session.mockReturnValue({ id: 'selected-chat', profile: 'default', source: 'cli' })
  fixture.has.mockReturnValue(false); fixture.exit.mockResolvedValue(undefined)
  fixture.abort.mockResolvedValue({ dispatched: true, runtime: 'native', synced: true, runId: 'own-run' })
})
it('acknowledges only the requested queue item actually removed by the real socket handler', async () => {
  const f = setup(), ack = vi.fn()
  await f.handlers.get('cancel_queued_run')!({ session_id: 'selected-chat', queue_id: 'own-queue' }, ack)
  expect(f.state.queue).toEqual([{ queue_id: 'other-queue' }])
  expect(ack).toHaveBeenCalledWith({ session_id: 'selected-chat', queue_id: 'own-queue', settled: true })
  const missing = vi.fn()
  await f.handlers.get('cancel_queued_run')!({ session_id: 'selected-chat', queue_id: 'absent' }, missing)
  expect(missing).toHaveBeenCalledWith(expect.objectContaining({ settled: false, reason: 'not_found' }))
})
it('waits for in-flight native admission before deciding a queue item was absent', async () => {
  const f = setup(), admission = deferred(), ack = vi.fn()
  f.server.runAdmissions.set('selected-chat', admission.promise)
  const operation = f.handlers.get('cancel_queued_run')!({ session_id: 'selected-chat', queue_id: 'own-queue' }, ack)
  await Promise.resolve(); expect(ack).not.toHaveBeenCalled(); expect(f.state.queue).toHaveLength(2)
  admission.resolve(); await operation
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ settled: true }))
})
it('does not let a stale expected run touch task plans or abort a replacement run', async () => {
  const f = setup(), ack = vi.fn()
  await f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'previous-run' }, ack)
  expect(f.server.finishTaskPlanRun).not.toHaveBeenCalled(); expect(fixture.abort).not.toHaveBeenCalled()
  expect(ack).toHaveBeenCalledWith({ session_id: 'selected-chat', run_id: 'previous-run', settled: false, reason: 'run_mismatch' })
})
it('recognizes the Coding Agent response identity and waits for both native exit and handler cleanup', async () => {
  const f = setup(), native = deferred(), handler = deferred(), ack = vi.fn()
  Object.assign(f.state, { source: 'coding_agent', runId: 'persistent-manager', responseRun: { responseId: 'response-turn', runMarker: 'response-marker' } })
  fixture.has.mockReturnValue(true); fixture.exit.mockReturnValue(native.promise)
  f.server.runHandlers.set('selected-chat', new Set([handler.promise]))
  f.server.runExecutionReceipts.set(JSON.stringify(['selected-chat', 'response-turn']), { terminal: false, finishedAt: 0, confirmed: true, done: handler.promise })
  const operation = f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'response-turn' }, ack)
  await vi.waitFor(() => expect(fixture.abort).toHaveBeenCalled())
  expect(ack).not.toHaveBeenCalled(); native.resolve(); await Promise.resolve(); expect(ack).not.toHaveBeenCalled()
  handler.resolve(); await operation
  expect(ack).toHaveBeenCalledWith({ session_id: 'selected-chat', run_id: 'response-turn', settled: true })
})
it('does not claim a bridge timeout or a dispatch-only abort has settled', async () => {
  const f = setup(), ack = vi.fn()
  fixture.abort.mockResolvedValue({ dispatched: true, runtime: 'bridge', synced: false, runId: 'own-run' })
  await f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'own-run' }, ack)
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ settled: false, reason: 'stop_unconfirmed' }))
})
it('does not convert a native AbortController dispatch without a tracked execution into settlement', async () => {
  const f = setup(), ack = vi.fn()
  fixture.abort.mockResolvedValue({ dispatched: true, runtime: 'native', synced: true })
  await f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'own-run' }, ack)
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ settled: false, reason: 'stop_unconfirmed' }))
})
it('rejects inaccessible queue and run targets without mutating either one', async () => {
  const f = setup(), queue = vi.fn(), run = vi.fn()
  fixture.session.mockReturnValue({ id: 'selected-chat', profile: 'foreign-profile' })
  await f.handlers.get('cancel_queued_run')!({ session_id: 'selected-chat', queue_id: 'own-queue' }, queue)
  await f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'own-run' }, run)
  expect(queue).toHaveBeenCalledWith(expect.objectContaining({ settled: false, reason: 'access_denied' }))
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ settled: false, reason: 'access_denied' }))
  expect(f.state.queue).toHaveLength(2); expect(fixture.abort).not.toHaveBeenCalled()
})
it('keeps legacy unguarded desktop abort dispatch compatible', async () => {
  const f = setup()
  await f.handlers.get('abort')!({ session_id: 'selected-chat' })
  expect(fixture.abort).toHaveBeenCalledTimes(1)
})
it.each(['own-run', 'replacement-run'])('proves an already terminal own run through cleanup without aborting %s', async current => {
  const f = setup(), cleanup = deferred(), ack = vi.fn()
  f.state.runId = current
  f.server.handleRun = vi.fn(async (_socket, data) => {
    data.onEvent('run.started', { run_id: 'own-run', queue_id: 'own-queue' })
    data.onEvent('run.completed', { run_id: 'own-run', queue_id: 'own-queue' })
    await cleanup.promise
  })
  const execution = f.server.executeRun(f.socket, { session_id: 'selected-chat', queue_id: 'own-queue', input: 'fixture', source: 'global_agent' }, 'default')
  const operation = f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'own-run' }, ack)
  await Promise.resolve(); expect(ack).not.toHaveBeenCalled(); expect(fixture.abort).not.toHaveBeenCalled()
  cleanup.resolve(); await execution; await operation
  expect(ack).toHaveBeenCalledWith({ session_id: 'selected-chat', run_id: 'own-run', settled: true })
  expect(f.state.runId).toBe(current)
})
it('keeps ordinary socket execution in the termination wait until its real handler exits', async () => {
  const f = setup(), cleanup = deferred()
  f.server.handleRun = vi.fn(() => cleanup.promise)
  const execution = f.server.executeRun(f.socket, { session_id: 'selected-chat', input: 'fixture', source: 'global_agent' }, 'default')
  let ended = false
  const waiting = f.server.waitForRunTermination('selected-chat').then(() => { ended = true })
  await new Promise(resolve => setImmediate(resolve)); expect(ended).toBe(false)
  cleanup.resolve(); await execution; await waiting; expect(ended).toBe(true)
})

it('does not wait for an earlier completed Bridge turn still evaluating its goal when cancelling the current run', async t => {
  const f = setup(), goalEvaluation = deferred(), currentCleanup = deferred(), ack = vi.fn()
  let previousExited = false
  f.server.bridge = { goalEvaluate: vi.fn(() => goalEvaluation.promise) }
  f.server.handleRun = vi.fn(async (_socket, data) => {
    const previous = data.queue_id === 'previous-queue', id = previous ? 'previous-run' : 'own-run'
    f.state.runId = id; f.state.activeRunMarker = `${id}-marker`
    data.onEvent('run.started', { run_id: id, queue_id: data.queue_id })
    if (previous) {
      f.state.isWorking = false
      data.onEvent('run.completed', { run_id: id, queue_id: data.queue_id })
      await f.server.bridge.goalEvaluate('selected-chat', 'prior answer', 'default')
      previousExited = true
    } else {
      f.state.isWorking = true
      await currentCleanup.promise
    }
  })
  fixture.abort.mockResolvedValue({ dispatched: true, runtime: 'bridge', synced: true, runId: 'own-run' })
  const previous = f.server.executeRun(f.socket, { session_id: 'selected-chat', queue_id: 'previous-queue', input: 'previous', source: 'global_agent' }, 'default')
  const current = f.server.executeRun(f.socket, { session_id: 'selected-chat', queue_id: 'own-queue', input: 'current', source: 'global_agent' }, 'default')
  const cancellation = f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'own-run' }, ack)
  t.onTestFinished(async () => { goalEvaluation.resolve(); currentCleanup.resolve(); await previous; await current; await cancellation })
  await vi.waitFor(() => expect(fixture.abort).toHaveBeenCalled())
  expect(ack).not.toHaveBeenCalled()
  currentCleanup.resolve(); await current
  await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ session_id: 'selected-chat', run_id: 'own-run', settled: true }), { timeout: 100 })
  expect(previousExited).toBe(false)
  expect(f.server.bridge.goalEvaluate).toHaveBeenCalledTimes(1)
})

it('uses only the captured Coding Agent native exit when no own execution receipt exists', async t => {
  const f = setup(), priorCleanup = deferred(), native = deferred(), ack = vi.fn()
  Object.assign(f.state, { source: 'coding_agent', runId: 'manager', responseRun: { responseId: 'response-turn', runMarker: 'own-marker' } })
  f.server.runHandlers.set('selected-chat', new Set([priorCleanup.promise]))
  fixture.has.mockReturnValue(true); fixture.exit.mockReturnValue(native.promise)
  const cancellation = f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'response-turn' }, ack)
  t.onTestFinished(async () => { priorCleanup.resolve(); native.resolve(); await cancellation })
  await vi.waitFor(() => expect(fixture.abort).toHaveBeenCalled())
  expect(ack).not.toHaveBeenCalled()
  native.resolve()
  await vi.waitFor(() => expect(ack).toHaveBeenCalledWith({ session_id: 'selected-chat', run_id: 'response-turn', settled: true }), { timeout: 100 })
})

it('does not use an unrelated session handler as termination proof for an untracked native run', async t => {
  const f = setup(), unrelated = deferred(), ack = vi.fn()
  f.server.runHandlers.set('selected-chat', new Set([unrelated.promise]))
  const cancellation = f.handlers.get('abort')!({ session_id: 'selected-chat', run_id: 'own-run' }, ack)
  t.onTestFinished(async () => { unrelated.resolve(); await cancellation })
  await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ settled: false, reason: 'stop_unconfirmed' })), { timeout: 100 })
})
