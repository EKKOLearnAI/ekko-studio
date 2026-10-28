import { beforeEach, expect, it, vi } from 'vitest'
import type { PersonRuntimePort } from '../../packages/server/src/modules/studio/public/person-runtime'

const native = vi.hoisted(() => ({ runAndWait: vi.fn(), abortSession: vi.fn(), available: true }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => native.available ? native : undefined }))
import { executePersonTask, stopPersonTask } from '../../packages/server/src/bootstrap/person-task-runtime'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function input(signal: AbortSignal, runtime = 'ekko'): Parameters<PersonRuntimePort['execute']>[0] {
  return { user: { id: 1, username: 'user', role: 'super_admin' } as any, selection: { runtime, mode: 'scoped', profile: 'default', provider: 'test', model: 'm' },
    sessionId: 'person-task-1', workspace: '/tmp/person-task', prompt: 'Work', signal, onEvent: vi.fn() }
}
beforeEach(() => { vi.resetAllMocks(); native.available = true; native.abortSession.mockResolvedValue(undefined) })

it.each(['ekko','hermes','codex'])('enables per-request automatic approvals on every %s task turn', async runtime => {
  native.runAndWait.mockResolvedValue({ ok: true, output: 'Done' })
  const task = input(new AbortController().signal, runtime)
  await executePersonTask(task)
  await executePersonTask({ ...task, prompt: [{ type: 'text', text: 'Continue the saved work' }] })
  for (const [request, options] of native.runAndWait.mock.calls) {
    expect(options).toMatchObject({ approvalChoice: 'once', user: task.user, profile: 'default' })
    expect(request).toMatchObject({ session_id: task.sessionId, source: runtime === 'hermes' ? 'api_server' : runtime === 'ekko' ? 'builtin_agent' : 'coding_agent' })
    expect(request.instructions).toContain('Ask clarifying questions normally')
    expect(request).not.toHaveProperty('approvalChoice')
  }
})

it.each(['ekko','hermes','codex'])('waits for %s initialization, then shares the real stop acknowledgement across requests', async runtime => {
  const worker = deferred<{ ok: boolean }>(); const ack = deferred()
  const controller = new AbortController()
  native.runAndWait.mockReturnValue(worker.promise)
  native.abortSession.mockReturnValue(ack.promise)
  const execution = executePersonTask(input(controller.signal, runtime))
  controller.abort()
  const first = stopPersonTask('person-task-1'); const duplicate = stopPersonTask('person-task-1')
  expect(first).toBe(duplicate)
  let acknowledged = false; void first.then(() => { acknowledged = true })
  await Promise.resolve(); await Promise.resolve()
  expect(native.abortSession).not.toHaveBeenCalled()
  expect(acknowledged).toBe(false)
  native.runAndWait.mock.calls[0][1].onEvent('run.started', { run_id: 'one' })
  await vi.waitFor(() => expect(native.abortSession).toHaveBeenCalledExactlyOnceWith('person-task-1', 'Person task stopped', { waitForTermination: true }))
  expect(acknowledged).toBe(false)
  ack.resolve(); await first
  worker.resolve({ ok: false }); await execution
})

it('propagates native stop failures for durable retry, including an unavailable runtime', async () => {
  native.abortSession.mockRejectedValueOnce(new Error('Connection lost'))
  await expect(stopPersonTask('person-task-failed')).rejects.toThrow('Connection lost')
  await stopPersonTask('person-task-failed')
  expect(native.abortSession).toHaveBeenCalledTimes(2)
  native.available = false
  await expect(stopPersonTask('person-task-restart')).rejects.toThrow('unavailable')
  native.available = true
  await stopPersonTask('person-task-restart')
})

it('does not start an already cancelled worker or retain an old abort listener into the next turn', async () => {
  const cancelled = new AbortController(); cancelled.abort()
  await expect(executePersonTask(input(cancelled.signal))).rejects.toThrow('Cancelled')
  expect(native.runAndWait).not.toHaveBeenCalled()
  const previous = new AbortController()
  native.runAndWait.mockResolvedValueOnce({ ok: false })
  await executePersonTask(input(previous.signal))
  previous.abort(); await Promise.resolve()
  expect(native.abortSession).not.toHaveBeenCalled()
})

it('unblocks a pending stop when initialization fails without emitting run.started', async () => {
  const worker = deferred<{ ok: boolean }>(); const controller = new AbortController()
  native.runAndWait.mockReturnValue(worker.promise)
  const execution = executePersonTask(input(controller.signal))
  controller.abort(); const stopped = stopPersonTask('person-task-1')
  worker.resolve({ ok: false }); await execution; await stopped
  expect(native.abortSession).toHaveBeenCalledTimes(1)
})
