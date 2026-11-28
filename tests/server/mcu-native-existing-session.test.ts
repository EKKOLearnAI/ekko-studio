import { expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), state: vi.fn<(...args: unknown[]) => unknown>(() => { throw new Error('fixture runtime boundary must remain unreachable') }) }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, appHome: '/unused-existing-session' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async original => ({ ...await original<object>(), getSession: fixture.session }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', async original => ({ ...await original<object>(), findUserById: fixture.user }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async original => ({ ...await original<object>(), getOrCreateSession: fixture.state }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/app-events', () => ({ bindAppEventSubscription: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events', () => ({ bindLegacyAppEvents: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/plugins/command', () => ({ handlePluginCommand: vi.fn(async () => false) }))
vi.mock('../../packages/server/src/modules/studio/services/webhooks', async original => ({ ...await original<object>(), observeChatRunWebhookEvent: vi.fn() }))
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'
it('fails a bound turn at native admission when its previously verified target was just deleted', async () => {
  fixture.session.mockReturnValue(null)
  const handlers = new Map<string, (...args: any[]) => any>(), events: Array<{ event: string; payload: any }> = []
  const server = Object.assign(Object.create(ChatRunSocket.prototype), { sessionMap: new Map(), runAdmissions: new Map(),
    sessionStateSync: { attach: vi.fn() }, nsp: { to: () => ({ emit: vi.fn() }) }, canAccessProfile: () => true })
  const socket = { data: { user: { id: 1, role: 'super_admin' } }, handshake: { query: { profile: 'default' }, auth: {} }, rooms: new Set(),
    join: vi.fn(), on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    emit: (event: string, payload: any) => events.push({ event, payload }) }
  Reflect.get(server, 'onConnection').call(server, socket)
  await handlers.get('run')!({ session_id: 'deleted-selected-chat', queue_id: 'own-queue', profile: 'default', input: 'hello', require_existing_session: true })
  expect(events.find(item => item.event === 'run.failed')?.payload).toMatchObject({ session_id: 'deleted-selected-chat', queue_id: 'own-queue', error: 'Session not found' })
  expect(fixture.state).not.toHaveBeenCalled()
})

function queuedTurn() {
  const handlers = new Map<string, (...args: any[]) => any>(), events: Array<{ event: string; payload: any }> = []
  const state = { messages: [], events: [], queue: [], isWorking: true, profile: 'default', source: 'cli' }
  const allowed = vi.fn((user: { id: number }) => user.id === 1)
  fixture.session.mockReturnValue({ id: 'selected-chat', profile: 'default', source: 'cli' })
  fixture.user.mockReturnValue({ id: 1, role: 'user', status: 'active' })
  fixture.state.mockReturnValue(state)
  const server = Object.assign(Object.create(ChatRunSocket.prototype), { sessionMap: new Map([['selected-chat', state]]), runAdmissions: new Map(),
    sessionStateSync: { attach: vi.fn() }, nsp: { to: () => ({ emit: (event: string, payload: any) => events.push({ event, payload }) }) },
    canAccessProfile: allowed, executeRun: vi.fn(async (_socket: unknown, _data: unknown) => {}) })
  const socket = { id: 'origin-socket', data: { user: { id: 1, role: 'user' } }, handshake: { query: { profile: 'default' }, auth: {} }, rooms: new Set(),
    join: vi.fn(), on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    emit: (event: string, payload: any) => events.push({ event, payload }) }
  Reflect.get(server, 'onConnection').call(server, socket)
  const enqueue = async () => {
    await handlers.get('run')!({ session_id: 'selected-chat', queue_id: 'own-queue', profile: 'default', input: 'hello', require_existing_session: true })
    expect(state.queue).toHaveLength(1)
    expect(events.some(item => item.event === 'run.queued' && item.payload.queue_id === 'own-queue')).toBe(true)
    expect(server.executeRun).not.toHaveBeenCalled()
  }
  // The preceding run can finish on another connection. Its identity must not
  // replace the account/Profile captured when this queued turn was admitted.
  const drain = () => Reflect.get(server, 'dequeueNextQueuedRun').call(server,
    { ...socket, id: 'other-socket', data: { user: { id: 2, role: 'super_admin' } } }, 'selected-chat', 'default')
  return { server, state, events, allowed, enqueue, drain }
}

it.each(['deleted', 'moved-profile', 'access-revoked', 'owner-disabled'])('does not execute a bound queued turn after its target becomes %s', async reason => {
  const f = queuedTurn()
  await f.enqueue()
  if (reason === 'deleted') fixture.session.mockReturnValue(null)
  else if (reason === 'moved-profile') fixture.session.mockReturnValue({ id: 'selected-chat', profile: 'different-profile', source: 'cli' })
  else if (reason === 'access-revoked') f.allowed.mockReturnValue(false)
  else fixture.user.mockReturnValue({ id: 1, role: 'super_admin', status: 'disabled' })
  f.drain()
  await new Promise(resolve => setImmediate(resolve))
  expect(f.server.executeRun).not.toHaveBeenCalled()
  expect(f.events.find(item => item.event === 'run.failed')?.payload).toMatchObject({ event: 'run.failed', session_id: 'selected-chat', queue_id: 'own-queue', error: 'existing_session_unavailable' })
  expect(f.state.queue).toHaveLength(0)
  expect(f.state.isWorking).toBe(false)
})

it('rechecks a valid bound queued turn as its original account rather than the draining connection', async () => {
  const f = queuedTurn()
  await f.enqueue()
  f.allowed.mockClear()
  f.drain()
  await new Promise(resolve => setImmediate(resolve))
  expect(f.allowed).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'default')
  expect(f.allowed).not.toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), expect.anything())
  expect(f.server.executeRun).toHaveBeenCalledOnce()
  expect(f.server.executeRun.mock.calls[0]?.[1]).toMatchObject({ session_id: 'selected-chat', queue_id: 'own-queue', input: 'hello' })
})
