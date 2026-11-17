import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { expect, it, vi } from 'vitest'
import { LocalAppRelayServer } from '../../packages/server/src/modules/studio/services/app-relay/server'

vi.mock('../../packages/server/src/modules/studio/services/app-relay/p2p', () => ({ P2PRelaySessions: class {} }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 0 } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info() {}, warn() {}, error() {} } }))
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({ getDeviceId: async () => 'fixture', createDeviceSignature() {} }))
vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({ authenticateUserToken() {}, inspectAppUserToken() {} }))
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store', () => ({}))

it('starts one authorized chat resume on a combined open and keeps legacy opens usable', async () => {
  const http = createServer()
  const io = new Server(http)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`
  const received = vi.fn()
  const emit = vi.fn()
  const owner = { id: 'phone', data: { localUserToken: 'owner' }, connected: true, emit }
  const relay = Object.assign(Object.create(LocalAppRelayServer.prototype), {
    localBaseUrl: baseUrl, bridges: new Map(), authorized: async () => true,
  })
  try {
    io.of('/chat-run').use((socket, next) => {
      next(socket.handshake.auth.token === 'owner' ? undefined : new Error('Unauthorized'))
    }).on('connection', (socket: Socket) => {
      socket.on('app.resume', payload => {
        received(payload)
        socket.emit('app.resumed', { session_id: payload.session_id, id: payload.id, messages: [] })
      })
    })
    const payload = { session_id: 'session', id: 'cached', timeline: true }
    expect(await relay.openSocket(owner, {
      id: 'combined', namespace: '/chat-run', chatResume: payload,
    })).toMatchObject({ ok: true, chatResumeAccepted: true })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('socket.event', {
      id: 'combined', namespace: '/chat-run', event: 'app.resumed',
      payload: { session_id: 'session', id: 'cached', messages: [] },
    }))
    expect(received).toHaveBeenCalledExactlyOnceWith(payload)

    expect(await relay.openSocket(owner, { id: 'legacy', namespace: '/chat-run' }))
      .not.toHaveProperty('chatResumeAccepted')
    await relay.emitSocketEvent(owner, { id: 'legacy', event: 'app.resume', payload })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('socket.event', expect.objectContaining({
      id: 'legacy', event: 'app.resumed',
    })))
    expect(received).toHaveBeenCalledTimes(2)
  } finally {
    for (const bridge of relay.bridges.values()) bridge.socket.disconnect()
    await new Promise<void>(resolve => io.close(() => resolve()))
  }
})
