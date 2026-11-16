import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { LocalAppRelayServer } from '../../packages/server/src/modules/studio/services/app-relay/server'
import { AppRelayClient } from '../../packages/server/src/modules/studio/services/app-relay/client'

vi.mock('../../packages/server/src/modules/studio/services/app-relay/p2p', () => ({ P2PRelaySessions: class {} }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 0 } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info() {}, warn() {}, error() {} } }))
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({ getDeviceId: async () => 'fixture', createDeviceSignature() {} }))
vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({ authenticateUserToken() {}, inspectAppUserToken() {} }))
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({}))

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it.each(['lan', 'cloud'])('%s forwards plugin subscriptions, acknowledgements and live events with a restricted event allowlist', async mode => {
  const http = createServer(), io = new Server(http)
  cleanup.push(() => new Promise<void>(resolve => io.close(() => resolve())))
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const commands: any[] = [], events: any[] = []
  let peer: Socket | undefined
  io.of('/plugins').use((socket, next) => {
    if (socket.handshake.auth.token !== 'owner-token' || socket.handshake.auth.profile !== 'work') return next(new Error('Unauthorized'))
    next()
  }).on('connection', socket => {
    peer = socket
    socket.on('session.open', (input, ack) => {
      commands.push(input)
      ack(input.pluginId === 'live' ? { ok: true } : { error: 'Plugin unavailable' })
      if (input.pluginId === 'live') socket.emit('session.event', { id: input.id, event: { event: 'resumed', session_id: input.sessionId, messages: [] } })
    })
    socket.on('session.command', (input, ack) => {
      commands.push(input); ack({ ok: true })
      socket.emit('session.event', { id: input.id, event: { event: 'message.delta', session_id: 'owned', delta: 'live' } })
    })
    socket.on('session.close', (input, ack) => { commands.push(input); ack({ ok: true }) })
  })
  const owner = { id: 'phone', data: { localUserToken: 'owner-token' }, connected: true,
    emit: (event: string, payload: unknown) => events.push({ event, payload }) }
  const local = mode === 'lan'
    ? Object.assign(Object.create(LocalAppRelayServer.prototype), { localBaseUrl: baseUrl, bridges: new Map(), authorized: async () => true })
    : Object.assign(Object.create(AppRelayClient.prototype), { localBaseUrl: baseUrl, bridges: new Map(), socket: owner })
  cleanup.push(() => { for (const entry of local.bridges.values()) entry.socket.disconnect() })
  const open = (input: any) => mode === 'lan' ? local.openSocket(owner, input) : local.openLocalSocket(input)
  const send = (input: any) => mode === 'lan' ? local.emitSocketEvent(owner, input) : local.emitLocalSocketEvent(input)
  const close = (input: any) => mode === 'lan' ? local.closeSocket(owner, input) : local.closeLocalSocket(input)
  const opened = await open({ id: 'bridge', namespace: '/plugins', auth: { token: 'owner-token', profile: 'work' } })
  expect(opened).toMatchObject({ ok: true, namespace: '/plugins' })
  await vi.waitFor(() => expect(peer).toBeDefined())
  const response = await send({ id: 'bridge', event: 'session.open', payload: { id: 's', sessionId: 'owned', pluginId: 'live', kind: 'chat' }, ack: true })
  expect(response).toMatchObject({ ok: true, payload: { ok: true } })
  await vi.waitFor(() => expect(events.some(value => value.payload.event === 'session.event' && value.payload.payload.event.event === 'resumed')).toBe(true))
  expect(await send({ id: 'bridge', event: 'session.command', payload: { id: 's', method: 'run', args: { input: 'hello' } }, ack: true })).toMatchObject({ payload: { ok: true } })
  await vi.waitFor(() => expect(events.some(value => value.payload.payload?.event?.delta === 'live')).toBe(true))
  expect(await send({ id: 'bridge', event: 'session.open', payload: { id: 'denied', pluginId: 'private' }, ack: true })).toMatchObject({ payload: { error: 'Plugin unavailable' } })
  expect(await send({ id: 'bridge', event: 'run', payload: {} })).toMatchObject({ error: { code: 'event_not_allowed' } })
  expect(await send({ id: 'other-phone', event: 'session.command', payload: {} })).toMatchObject({ error: { code: 'socket_not_open' } })
  expect(await send({ id: 'bridge', event: 'session.close', payload: { id: 's' }, ack: true })).toMatchObject({ payload: { ok: true } })
  expect(await close({ id: 'bridge' })).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(peer?.connected).toBe(false))
  expect(commands).toHaveLength(4)
  expect(await open({ id: 'forbidden', namespace: '/private', auth: {} })).toMatchObject({ error: { code: 'namespace_not_allowed' } })
})
