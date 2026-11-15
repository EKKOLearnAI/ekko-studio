// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectChatRun, disconnectChatRun, respondClarify } from '@/api/studio/chat'

const mocks = vi.hoisted(() => ({ io: vi.fn() }))
vi.mock('socket.io-client', () => ({ io: mocks.io }))
vi.mock('@/api/client', () => ({ getBaseUrlValue: () => '', getApiKey: () => 'fixture' }))
vi.mock('@/api/studio/background-status', () => ({ disconnectBackgroundStatusObservers: vi.fn() }))

class TestSocket {
  listeners = new Map<string, Set<(...args: any[]) => void>>()
  on(event: string, handler: (...args: any[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(handler)
    return this
  }
  off(event: string, handler: (...args: any[]) => void) { this.listeners.get(event)?.delete(handler); return this }
  removeAllListeners() { this.listeners.clear(); return this }
  connected = false
  active = true
  sent: unknown[][] = []
  emit(event: string, ...args: any[]) { this.sent.push([event, ...args]); return true }
  receive(event: string, payload?: unknown) { for (const handler of [...this.listeners.get(event) || []]) handler(payload) }
  disconnect() { this.connected = false; this.active = false; this.receive('disconnect', 'io client disconnect'); return this }
}
let socket: TestSocket
beforeEach(() => {
  vi.useFakeTimers()
  mocks.io.mockReset().mockImplementation(() => { socket = new TestSocket(); return socket })
})
afterEach(() => { disconnectChatRun(); vi.useRealTimers() })

it('reuses a connecting socket so a second observer cannot discard an answer', () => {
  const first = connectChatRun('default')
  expect(connectChatRun('default')).toBe(first)
  expect(mocks.io).toHaveBeenCalledOnce()
})

it('waits for connection and the matching server resolution before confirming delivery', async () => {
  const result = respondClarify('session', 'question', 'B')
  expect(result).toBeInstanceOf(Promise)
  expect(socket.sent).toEqual([])
  socket.connected = true
  socket.receive('connect')
  expect(socket.sent).toEqual([['clarify.respond', { session_id: 'session', clarify_id: 'question', response: 'B' }]])
  const settled = vi.fn()
  result.then(settled)
  socket.receive('clarify.resolved', { session_id: 'other', clarify_id: 'question', resolved: true })
  socket.receive('clarify.resolved', { session_id: 'session', clarify_id: 'older', resolved: true })
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  socket.receive('clarify.resolved', { session_id: 'session', clarify_id: 'question', resolved: true })
  await result
  expect(settled).toHaveBeenCalledOnce()
})

it('reports rejection and allows the same question to be retried', async () => {
  connectChatRun('default')
  socket.connected = true
  const result = respondClarify('session', 'question', 'B')
  const rejected = expect(result).rejects.toThrow('unavailable')
  socket.receive('clarify.resolved', { session_id: 'session', clarify_id: 'question', resolved: false, error: 'temporarily unavailable' })
  await rejected
  const retry = respondClarify('session', 'question', 'B')
  socket.receive('clarify.resolved', { session_id: 'session', clarify_id: 'question', resolved: true })
  await retry
  expect(socket.sent).toHaveLength(2)
})

it('does not leave an answer buffered for late delivery after a connection timeout', async () => {
  const result = respondClarify('session', 'question', 'B')
  const rejected = expect(result).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(15_000)
  await rejected
  socket.connected = true
  socket.receive('connect')
  expect(socket.sent).toEqual([])
})

it('rejects an interrupted submission instead of silently waiting five minutes', async () => {
  connectChatRun('default')
  socket.connected = true
  const result = respondClarify('session', 'question', 'B')
  const rejected = expect(result).rejects.toThrow()
  socket.receive('disconnect', 'transport close')
  await rejected
})

it.each([{ reason: 'timeout' }, { outcome: 'timeout' }])('does not mistake a question timeout for an accepted answer (%j)', async timeout => {
  connectChatRun('default')
  socket.connected = true
  const result = respondClarify('session', 'question', 'B')
  const rejected = expect(result).rejects.toThrow(/expired/i)
  socket.receive('clarify.resolved', { session_id: 'session', clarify_id: 'question', resolved: true, ...timeout })
  await rejected
})

it('accepts the private BOT notification when the user has left its session room', async () => {
  connectChatRun('default')
  socket.connected = true
  const result = respondClarify('person-main-bot', 'question', 'B')
  socket.receive('person.clarification.resolved', { session_id: 'person-main-bot', clarify_id: 'question', resolved: true, reason: 'response' })
  await result
})
