// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectChatRun, disconnectChatRun, respondClarify, respondToolApproval } from '@/api/studio/chat'

const mocks = vi.hoisted(() => ({ io: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: mocks.io }))
vi.mock('@/api/client', () => ({ getBaseUrlValue: () => '', getApiKey: () => 'fixture' }))
vi.mock('@/api/studio/background-status', () => ({ disconnectBackgroundStatusObservers: vi.fn() }))

class TestSocket {
  listeners = new Map<string, Set<(...args: any[]) => void>>()
  connected = false
  active = true
  sent: unknown[][] = []
  on(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }
  off(event: string, handler: (...args: any[]) => void) { this.listeners.get(event)?.delete(handler); return this }
  removeAllListeners() { this.listeners.clear(); return this }
  emit(event: string, ...args: any[]) { this.sent.push([event, ...args]); return true }
  receive(event: string, payload?: unknown) { for (const handler of [...this.listeners.get(event) || []]) handler(payload) }
  disconnect() { this.connected = false; this.active = false; this.receive('disconnect'); return this }
}
let socket: TestSocket
beforeEach(() => {
  vi.useFakeTimers()
  mocks.io.mockReset().mockImplementation(() => { socket = new TestSocket(); return socket })
})
afterEach(() => { disconnectChatRun(); vi.useRealTimers() })

it.each(['clarify', 'approval'])('answers %s on the request profile after the UI switched profiles', async kind => {
  connectChatRun('other')
  socket.connected = true
  const oldSocket = socket
  const result = kind === 'approval'
    ? respondToolApproval('session', 'request', 'once', 'chat-run', 'work')
    : respondClarify('session', 'request', 'B', 'chat-run', 'work')
  expect(mocks.io.mock.calls.at(-1)![1].query.profile).toBe('work')
  expect(oldSocket.sent).toEqual([])
  socket.connected = true
  socket.receive('connect')
  expect(socket.sent[0][0]).toBe(`${kind}.respond`)
  socket.receive(`${kind}.resolved`, { session_id: 'session', [`${kind}_id`]: 'request', resolved: true, choice: 'once' })
  await result
})

it('keeps approval pending until its own server confirmation and rejects a failed submission', async () => {
  const result = respondToolApproval('session', 'request', 'once')
  expect(result).toBeInstanceOf(Promise)
  expect(socket.sent).toEqual([])
  socket.connected = true
  socket.receive('connect')
  const settled = vi.fn()
  const failure = expect(result).rejects.toThrow('unavailable')
  result.then(settled, settled)
  socket.receive('approval.resolved', { session_id: 'other', approval_id: 'request', resolved: true })
  socket.receive('approval.resolved', { session_id: 'session', approval_id: 'older', resolved: true })
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  socket.receive('approval.resolved', { session_id: 'session', approval_id: 'request', resolved: false, error: 'temporarily unavailable' })
  await failure
  const retry = respondToolApproval('session', 'request', 'deny')
  socket.receive('approval.resolved', { session_id: 'session', approval_id: 'request', resolved: true, choice: 'deny' })
  await retry
})

it('does not send a buffered approval after connection timeout', async () => {
  const result = respondToolApproval('session', 'request', 'once')
  const failure = expect(result).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(15_000)
  await failure
  socket.connected = true
  socket.receive('connect')
  expect(socket.sent).toEqual([])
})

it('does not mistake automatic denial for an accepted approval', async () => {
  connectChatRun('default')
  socket.connected = true
  const result = respondToolApproval('session', 'request', 'once')
  const failure = expect(result).rejects.toThrow()
  socket.receive('approval.resolved', { session_id: 'session', approval_id: 'request', choice: 'deny' })
  await failure
})

it('accepts the private BOT confirmation outside its session room', async () => {
  const result = respondToolApproval('person-main-bot', 'request', 'once')
  expect(result).toBeInstanceOf(Promise)
  socket.connected = true
  socket.receive('connect')
  socket.receive('person.approval.resolved', { session_id: 'person-main-bot', approval_id: 'request', resolved: true, choice: 'once' })
  await result
})
