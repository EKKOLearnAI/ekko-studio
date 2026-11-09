import './fixtures/isolated-studio-state'
// Session-state events, including manual unread, over the app relay.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  authenticateUserToken: vi.fn(),
  inspectAppUserToken: vi.fn(),
  getDeviceId: vi.fn(),
}))

const clientSocketMocks = vi.hoisted(() => {
  const sockets: any[] = []
  const io = vi.fn((url: string, options: Record<string, unknown>) => {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id: `local-${sockets.length + 1}`,
      connected: true,
      __url: url,
      __options: options,
      __handlers: handlers,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      onAny: vi.fn((handler: (...args: any[]) => void) => {
        socket.__onAny = handler
        return socket
      }),
      emit: vi.fn(),
      disconnect: vi.fn(() => { socket.connected = false }),
    }
    sockets.push(socket)
    return socket
  })
  return { io, sockets }
})

vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({
  authenticateUserToken: authMocks.authenticateUserToken,
  inspectAppUserToken: authMocks.inspectAppUserToken,
}))

vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({
  getDeviceId: authMocks.getDeviceId,
}))

vi.mock('socket.io-client', () => ({
  io: clientSocketMocks.io,
}))

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: {
    port: 8648,
    appRelay: { entitlementRequired: false },
  },
}))

function createMockNamespace() {
  const middleware: Array<(socket: any, next: (err?: Error) => void) => void> = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const namespace: any = {
    use: vi.fn((handler: (socket: any, next: (err?: Error) => void) => void) => {
      middleware.push(handler)
      return namespace
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return namespace
    }),
    __middleware: middleware,
    __handlers: handlers,
  }
  return namespace
}

function createMockAppSocket(id: string, auth: Record<string, unknown>) {
  const handlers = new Map<string, (...args: any[]) => void>()
  const socket: any = {
    id,
    connected: true,
    data: {},
    handshake: { auth },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    once: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return socket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(() => { socket.connected = false }),
    __handlers: handlers,
  }
  return socket
}

async function connectApp(namespace: ReturnType<typeof createMockNamespace>, socket: any): Promise<void> {
  const next = vi.fn()
  await namespace.__middleware[0](socket, next)
  expect(next).toHaveBeenCalledWith()
  namespace.__handlers.get('connection')?.(socket)
}

describe('app relay session-state events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clientSocketMocks.sockets.length = 0
    authMocks.getDeviceId.mockResolvedValue('hwui_local_machine_1234567890')
    authMocks.authenticateUserToken.mockResolvedValue({
      id: 7,
      username: 'app-user',
      role: 'user',
    })
    authMocks.inspectAppUserToken.mockResolvedValue(null)
  })

  it.each([['/chat-run', 'app.events.subscribe'], ['/chat-run', 'sessions.unread'], ['/group-chat', 'load_room_agent_activities']])('bridges %s %s over local and manually addressed relay', async (ns, event) => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
    })
    server.init()

    const app = createMockAppSocket('app-workflow', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const openAck = vi.fn()
    app.__handlers.get('socket.open')({
      id: 'workflow-1',
      namespace: ns,
      auth: { token: 'untrusted-token', appEventVersion: 1 }, query: { profile: 'default' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-1',
      ok: true,
      namespace: ns,
    })))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      `http://127.0.0.1:8748${ns}`,
      expect.objectContaining({ auth: { token: 'local-user-token', appEventVersion: 1 } }),
    )

    const local = clientSocketMocks.sockets[0]
    local.emit.mockImplementation((name: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (name === event) {
        ack?.({ ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } })
      }
    })
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'workflow-1',
      event,
      payload: { schema_version: 1, profile: 'default', types: ['workflow.run.completed'] },
      ack: true,
    }, eventAck)

    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-1',
      ok: true,
      namespace: ns,
      event,
      payload: { ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } },
    })))
  })
})
