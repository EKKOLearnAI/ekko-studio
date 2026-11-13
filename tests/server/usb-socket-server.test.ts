import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({
  authenticateUserToken: authMocks.authenticateUserToken,
  isAuthEnabled: authMocks.isAuthEnabled,
}))

function createMockNamespace() {
  const middleware: Array<(socket: any, next: (err?: Error) => void) => void> = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const toRoom = { emit: vi.fn() }
  const nsp: any = {
    use: vi.fn((fn: (socket: any, next: (err?: Error) => void) => void) => {
      middleware.push(fn)
      return nsp
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return nsp
    }),
    to: vi.fn(() => toRoom),
    __middleware: middleware,
    __handlers: handlers,
    __toRoom: toRoom,
  }
  return nsp
}

function createMockSocket(id: string, auth: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...args: any[]) => void>()
  const socket: any = {
    id,
    data: {},
    handshake: { auth },
    join: vi.fn(() => Promise.resolve()),
    leave: vi.fn(() => Promise.resolve()),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    __handlers: handlers,
  }
  return socket
}

describe('USBSocketServer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    authMocks.isAuthEnabled.mockResolvedValue(true)
    authMocks.authenticateUserToken.mockResolvedValue(null)
  })

  it('requires valid auth when auth is enabled', async () => {
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const service = new EventEmitter() as any
    service.status = vi.fn(() => ({ state: 'running' }))
    service.listDevices = vi.fn(() => [])
    service.listHistory = vi.fn(() => [])

    const { USBSocketServer } = await import('../../packages/server/src/modules/studio/services/usb/USBSocketServer')
    const server = new USBSocketServer(io as any, service)
    server.init()

    const denied = createMockSocket('socket-denied', { token: 'bad-token' })
    const deniedNext = vi.fn()
    await nsp.__middleware[0](denied, deniedNext)
    expect(deniedNext.mock.calls[0][0]).toBeInstanceOf(Error)

    authMocks.authenticateUserToken.mockResolvedValue({ id: 1, username: 'ada', role: 'super_admin' })
    const allowed = createMockSocket('socket-allowed', { token: 'good-token' })
    const allowedNext = vi.fn()
    await nsp.__middleware[0](allowed, allowedNext)
    expect(allowedNext).toHaveBeenCalledWith()
  })

  it('returns a snapshot on subscribe and forwards live events to the usb room', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 1, username: 'ada', role: 'super_admin' })

    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const service = new EventEmitter() as any
    service.status = vi.fn(() => ({ state: 'running', monitorScriptPath: '/tmp/usb_monitor.py', lastReadyAt: null, lastHeartbeatAt: null, lastError: null }))
    service.listDevices = vi.fn(() => [{
      uuid: 'uuid-1',
      deviceNode: '/dev/sdb1',
      mountPoint: '/tmp/usb/uuid-1',
      fsType: 'vfat',
      label: 'KINGSTON',
      vendor: 'Kingston',
      model: 'Traveler',
      serial: 'abc',
      sizeBytes: 1024,
      status: 'mounted',
      error: null,
      ts: new Date('2026-07-01T11:00:00.000Z').toISOString(),
    }])
    service.listHistory = vi.fn(() => [{
      id: 'evt-1',
      uuid: 'uuid-1',
      deviceNode: '/dev/sdb1',
      action: 'add',
      mountPoint: '/tmp/usb/uuid-1',
      fsType: 'vfat',
      label: 'KINGSTON',
      status: 'mounted',
      error: null,
      ts: Date.parse('2026-07-01T11:00:00.000Z'),
    }])

    const { USBSocketServer } = await import('../../packages/server/src/modules/studio/services/usb/USBSocketServer')
    const server = new USBSocketServer(io as any, service)
    server.init()

    const socket = createMockSocket('socket-1', { token: 'good-token' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](socket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(socket)

    const subscribeAck = vi.fn()
    socket.__handlers.get('usb.subscribe')?.({ since: '24h' }, subscribeAck)
    expect(socket.join).toHaveBeenCalledWith('usb:stream')
    expect(subscribeAck).toHaveBeenCalledWith({
      ok: true,
      data: {
        runtime: service.status(),
        devices: service.listDevices(),
        events: service.listHistory(),
      },
    })

    const deviceEvent = {
      id: 'evt-2',
      uuid: 'uuid-1',
      deviceNode: '/dev/sdb1',
      action: 'remove',
      mountPoint: '/tmp/usb/uuid-1',
      fsType: 'vfat',
      label: 'KINGSTON',
      status: 'removed',
      error: null,
      ts: Date.parse('2026-07-01T11:05:00.000Z'),
    }
    service.emit('device_event', deviceEvent)
    expect(nsp.to).toHaveBeenCalledWith('usb:stream')
    expect(nsp.__toRoom.emit).toHaveBeenCalledWith('usb.device_event', deviceEvent)

    const heartbeatPayload = {
      ts: new Date('2026-07-01T11:06:00.000Z').toISOString(),
      deviceCount: 1,
      runtime: service.status(),
    }
    service.emit('heartbeat', heartbeatPayload)
    expect(nsp.__toRoom.emit).toHaveBeenCalledWith('usb.heartbeat', heartbeatPayload)

    server.close()
  })
})
