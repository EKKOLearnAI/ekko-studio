// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const transport = vi.hoisted(() => ({ sockets: [] as any[], invalidate: null as null | (() => void) }))
vi.mock('@/api/studio/person-presence', () => ({ connectPersonPresence: () => {
  const handlers = new Map<string, Function>()
  const socket = { connected: true, handlers, on: vi.fn((event, handler) => handlers.set(event, handler)),
    volatile: { emit: vi.fn() }, removeAllListeners: vi.fn(), disconnect: vi.fn() }
  transport.sockets.push(socket)
  return socket
} }))
vi.mock('@/api/auth-invalidation', () => ({ onAuthInvalidated: (handler: () => void) => {
  transport.invalidate = handler
  return () => { transport.invalidate = null }
} }))
import { usePersonPresenceStore } from '@/stores/hermes/person-presence'

beforeEach(() => {
  vi.useFakeTimers(); setActivePinia(createPinia()); transport.sockets = []
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => { usePersonPresenceStore().stop(); vi.useRealTimers() })

it('uses the shared server state and never treats connection, polling or elapsed client time as user input', () => {
  const store = usePersonPresenceStore(); store.start(); store.start()
  expect(transport.sockets).toHaveLength(1)
  const socket = transport.sockets[0]
  socket.handlers.get('person.presence')({ state: 'sleeping', lastActivityAt: 1, sleepAt: 600001 })
  expect(store.avatarSrc).toBe('/person/sleeping.gif')
  vi.advanceTimersByTime(20 * 60 * 1000)
  expect(socket.volatile.emit).not.toHaveBeenCalled()
  socket.handlers.get('person.presence')({ state: 'searching', lastActivityAt: 1, sleepAt: 600001 })
  expect(store.state).toBe('searching')
})

it('throttles input with a trailing report and drops offline/background input', () => {
  const store = usePersonPresenceStore(); store.start()
  const socket = transport.sockets[0]
  window.dispatchEvent(new Event('pointerdown'))
  expect(socket.volatile.emit).toHaveBeenCalledTimes(1)
  for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('pointermove'))
  expect(socket.volatile.emit).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(1000)
  expect(socket.volatile.emit).toHaveBeenCalledTimes(2)
  socket.connected = false
  window.dispatchEvent(new Event('keydown')); vi.advanceTimersByTime(1000)
  socket.connected = true
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  window.dispatchEvent(new Event('wheel')); vi.advanceTimersByTime(1000)
  expect(socket.volatile.emit).toHaveBeenCalledTimes(2)
})

it('clears old account state and rejects retained socket callbacks after logout', () => {
  const store = usePersonPresenceStore(); store.start()
  const old = transport.sockets[0]
  old.handlers.get('person.presence')({ state: 'thinking', backgroundTaskCount: 3, lastActivityAt: 1, sleepAt: 600001 })
  expect(store.backgroundTaskCount).toBe(3)
  transport.invalidate!()
  store.start()
  old.handlers.get('person.presence')({ state: 'searching', lastActivityAt: 1, sleepAt: 600001 })
  expect(store.state).toBe('idle')
  expect(store.backgroundTaskCount).toBe(0)
  expect(old.disconnect).toHaveBeenCalledOnce()
  window.dispatchEvent(new Event('keydown'))
  expect(transport.sockets[1].volatile.emit).toHaveBeenCalledOnce()
  expect(old.volatile.emit).not.toHaveBeenCalled()
})

it('takes task counts from server snapshots independently of outcome animations', () => {
  const store = usePersonPresenceStore(); store.start()
  const socket = transport.sockets[0]
  socket.handlers.get('person.presence')({ state: 'done', backgroundTaskCount: 24, lastActivityAt: 1, sleepAt: 600001 })
  expect(store.backgroundTaskCount).toBe(24)
  socket.handlers.get('person.presence')({ state: 'searching', backgroundTaskCount: 2, lastActivityAt: 1, sleepAt: 600001 })
  expect(store.backgroundTaskCount).toBe(2)
  socket.handlers.get('person.presence')({ state: 'idle', backgroundTaskCount: 0, lastActivityAt: 1, sleepAt: 600001 })
  expect(store.backgroundTaskCount).toBe(0)
})

it('uses authoritative outcome deadlines and gives consecutive outcome animations distinct identities', () => {
  const store = usePersonPresenceStore(); store.start()
  const socket = transport.sockets[0]
  socket.handlers.get('person.presence')({ state: 'done', feedbackId: 'task:a', feedbackUntil: 3000, lastActivityAt: 1, sleepAt: 600001 })
  expect(store.avatarSrc).toBe('/person/done.gif')
  expect(store.avatarKey).toBe('task:a')
  vi.advanceTimersByTime(4000)
  expect(store.state).toBe('done') // The server, not a device timer, owns the transition.
  socket.handlers.get('person.presence')({ state: 'error', feedbackId: 'task:b', feedbackUntil: 7000, lastActivityAt: 1, sleepAt: 600001 })
  expect(store.avatarSrc).toBe('/person/error.gif')
  expect(store.avatarKey).toBe('task:b')
  socket.handlers.get('person.presence')({ state: 'sleeping', lastActivityAt: 1, sleepAt: 600001 })
  expect(store.avatarKey).toBe('sleeping')
  expect(socket.volatile.emit).not.toHaveBeenCalled()
})
