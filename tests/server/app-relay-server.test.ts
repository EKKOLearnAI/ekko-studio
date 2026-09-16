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

describe('LocalAppRelayServer', () => {
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

  it('accepts the selected machine with a valid token or in login-only mode', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any)
    server.init()

    expect(io.of).toHaveBeenCalledWith('/app-relay')
    const denied = createMockAppSocket('denied', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_other_machine_1234567890',
    })
    const deniedNext = vi.fn()
    await namespace.__middleware[0](denied, deniedNext)
    expect(deniedNext.mock.calls[0][0]).toBeInstanceOf(Error)

    const allowed = createMockAppSocket('allowed', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, allowed)
    expect(allowed.emit).toHaveBeenCalledWith('relay.ready', expect.objectContaining({
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      hostConnected: true,
    }))

    const loginOnly = createMockAppSocket('login-only', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, loginOnly)
    expect(loginOnly.data.localUserToken).toBe('')
  })

  it('requires and binds cloud entitlements to the App account and device when enforcement is enabled', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const entitlement = {
      issuer: 'hermes-studio-server',
      audience: 'ekko-studio',
      userId: 7001,
      deviceCode: 'phone-001',
      features: ['lan_access'],
      plan: 'public_beta',
      issuedAt: Math.floor(Date.now() / 1000) - 60,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      tokenId: 'entitlement-001',
    }
    const verifyEntitlementToken = vi.fn((token: string) => token === 'signed-entitlement' ? entitlement : null)
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      entitlementRequired: true,
      verifyEntitlementToken,
    })
    server.init()

    const missing = createMockAppSocket('missing-entitlement', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-001',
    })
    const missingNext = vi.fn()
    await namespace.__middleware[0](missing, missingNext)
    expect(missingNext.mock.calls[0][0]).toMatchObject({ message: 'app_entitlement_required' })

    const wrongAccount = createMockAppSocket('wrong-account', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-001',
      cloudUserId: 7002,
      entitlementToken: 'signed-entitlement',
    })
    const wrongAccountNext = vi.fn()
    await namespace.__middleware[0](wrongAccount, wrongAccountNext)
    expect(wrongAccountNext.mock.calls[0][0]).toMatchObject({ message: 'app_entitlement_account_mismatch' })

    const wrongDevice = createMockAppSocket('wrong-device', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-002',
      cloudUserId: 7001,
      entitlementToken: 'signed-entitlement',
    })
    const wrongDeviceNext = vi.fn()
    await namespace.__middleware[0](wrongDevice, wrongDeviceNext)
    expect(wrongDeviceNext.mock.calls[0][0]).toMatchObject({ message: 'app_entitlement_device_mismatch' })

    const allowed = createMockAppSocket('entitled', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-001',
      cloudUserId: 7001,
      entitlementToken: 'signed-entitlement',
    })
    await connectApp(namespace, allowed)
    expect(allowed.data.appEntitlement).toEqual(entitlement)
    expect(allowed.data.appDeviceCode).toBe('phone-001')
    expect(allowed.emit).toHaveBeenCalledWith('relay.ready', expect.objectContaining({
      capabilities: expect.arrayContaining(['app.entitlement']),
    }))
  })

  it('records the signed mode and token lifetime when an entitlement has expired', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      entitlementRequired: true,
      inspectEntitlementToken: () => ({
        status: 'expired',
        claims: {
          issuer: 'hermes-studio-server',
          audience: 'ekko-studio',
          userId: 7001,
          deviceCode: 'phone-001',
          features: ['lan_access'],
          plan: 'paid',
          issuedAt: 1_787_000_000,
          expiresAt: 1_787_000_000,
          tokenId: 'entitlement-expired-001',
        },
      }),
    })
    server.init()

    const app = createMockAppSocket('expired-entitlement', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-001',
      cloudUserId: 7001,
      entitlementToken: 'signed-expired-entitlement',
    })
    const next = vi.fn()
    await namespace.__middleware[0](app, next)

    expect(next.mock.calls[0][0]).toMatchObject({ message: 'app_entitlement_expired' })
    expect(server.getLatestEntitlementFailure()).toMatchObject({
      code: 'app_entitlement_expired',
      deviceCode: 'phone-001',
      cloudUserId: 7001,
      plan: 'paid',
      tokenTtlSeconds: 0,
    })
  })

  it('rejects an App login body whose device does not match the signed entitlement', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const fetchImpl = vi.fn()
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      fetchImpl: fetchImpl as any,
      entitlementRequired: true,
      verifyEntitlementToken: () => ({
        issuer: 'hermes-studio-server',
        audience: 'ekko-studio',
        userId: 7001,
        deviceCode: 'phone-001',
        features: ['lan_access'],
        plan: 'public_beta',
        issuedAt: Math.floor(Date.now() / 1000) - 60,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        tokenId: 'entitlement-001',
      }),
    })
    server.init()
    const app = createMockAppSocket('entitled-login', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-001',
      cloudUserId: 7001,
      entitlementToken: 'signed-entitlement',
    })
    await connectApp(namespace, app)

    const ack = vi.fn()
    app.__handlers.get('http.request')({
      id: 'app-login-mismatch',
      method: 'POST',
      path: '/api/auth/app-login',
      body: {
        authorization_code: 'one-time-code',
        device_code: 'phone-002',
        cloud_user_id: 7001,
      },
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      status: 403,
      error: expect.objectContaining({ code: 'app_entitlement_device_mismatch' }),
    })))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('tracks an authenticated App as online, notifies it when deleted, and rejects its next connection', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, { machineId: 'hwui_local_machine_1234567890' })
    server.init()
    authMocks.inspectAppUserToken.mockResolvedValue({
      status: 'active',
      user: { id: 7, username: 'app-user', role: 'user' },
      deviceCode: 'phone-001',
      connectionType: 'lan',
    })

    const app = createMockAppSocket('app-online', {
      role: 'app',
      token: 'app-device-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)

    expect(server.isConnectionOnline('phone-001', 'lan')).toBe(true)
    expect(server.notifyConnectionDeleted('phone-001', 'lan')).toBe(1)
    expect(app.emit).toHaveBeenCalledWith('relay.connection.deleted', {
      machineId: 'hwui_local_machine_1234567890',
      deviceCode: 'phone-001',
      connectionType: 'lan',
    })
    await vi.waitFor(() => expect(app.disconnect).toHaveBeenCalledWith(true))

    authMocks.inspectAppUserToken.mockResolvedValue({
      status: 'revoked',
      user: { id: 7, username: 'app-user', role: 'user' },
      deviceCode: 'phone-001',
      connectionType: 'lan',
    })
    const reconnecting = createMockAppSocket('app-reconnecting', {
      role: 'app',
      token: 'app-device-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    const next = vi.fn()
    await namespace.__middleware[0](reconnecting, next)
    expect(next.mock.calls[0][0]).toMatchObject({ message: 'app_connection_deleted' })
  })

  it('forwards login over the socket, remembers its token, then unlocks protected requests', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const issuedToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
    authMocks.authenticateUserToken.mockImplementation(async (token: string) => token === issuedToken
      ? { id: 7, username: 'app-user', role: 'user' }
      : null)
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/api/auth/login')
      ? new Response(JSON.stringify({ token: issuedToken, userId: 7 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      : new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const app = createMockAppSocket('app-login', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)

    const deniedAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'protected-before-login',
      method: 'GET',
      path: '/api/studio/sessions',
    }, deniedAck)
    await vi.waitFor(() => expect(deniedAck).toHaveBeenCalledWith(expect.objectContaining({
      status: 401,
      error: expect.objectContaining({ code: 'app_relay_unauthorized' }),
    })))
    expect(fetchImpl).not.toHaveBeenCalled()

    const loginAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'login-1',
      method: 'POST',
      path: '/api/auth/login',
      headers: {
        authorization: 'Bearer untrusted-token',
        'content-type': 'application/json',
      },
      body: { username: 'studio-user', password: 'secret' },
    }, loginAck)
    await vi.waitFor(() => expect(loginAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'login-1',
      status: 200,
      body: expect.stringContaining(issuedToken),
    })))
    expect(app.data.localUserToken).toBe(issuedToken)
    const loginHeaders = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(loginHeaders.get('authorization')).toBeNull()

    const protectedAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'protected-after-login',
      method: 'GET',
      path: '/api/studio/sessions',
    }, protectedAck)
    await vi.waitFor(() => expect(protectedAck).toHaveBeenCalledWith(expect.objectContaining({ status: 200 })))
    const protectedHeaders = fetchImpl.mock.calls[1][1]?.headers as Headers
    expect(protectedHeaders.get('authorization')).toBe(`Bearer ${issuedToken}`)
  })

  it('marks authorization-code login from the local App relay as a LAN connection', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const issuedToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
    authMocks.authenticateUserToken.mockImplementation(async (token: string) => token === issuedToken
      ? { id: 7, username: 'app-user', role: 'user' }
      : null)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: issuedToken, userId: 7 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const app = createMockAppSocket('app-login', {
      role: 'app',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const ack = vi.fn()
    app.__handlers.get('http.request')({
      id: 'app-login-1',
      method: 'POST',
      path: '/api/auth/app-login',
      headers: {
        authorization: 'Bearer untrusted-token',
        'content-type': 'application/json',
      },
      body: {
        authorization_code: 'one-time-code',
        device_code: 'phone-001',
        device_name: 'Alice iPhone',
      },
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: 200 })))
    const headers = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-hermes-app-connection')).toBe('lan')
    expect(app.data.localUserToken).toBe(issuedToken)
  })

  it('handles the cloud-compatible HTTP relay request directly on loopback', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const app = createMockAppSocket('app-http', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const ack = vi.fn()
    app.__handlers.get('http.request')({
      id: 'http-1',
      method: 'GET',
      path: '/api/studio/sessions?profile=default',
      headers: { 'if-match': '"revision-1"' },
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      id: 'http-1',
      status: 200,
      body: '{"sessions":[]}',
    })))
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/api/studio/sessions?profile=default',
      expect.objectContaining({ method: 'GET' }),
    )
    const headers = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer local-user-token')
    expect(headers.get('if-match')).toBe('"revision-1"')
    expect(clientSocketMocks.io).not.toHaveBeenCalled()

    fetchImpl.mockResolvedValueOnce(new Response(Uint8Array.from([7, 8, 9]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    }))
    const binaryAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'binary-1',
      method: 'POST',
      path: '/api/studio/tts/synthesize',
      headers: { 'content-type': 'application/octet-stream' },
      bodyBytes: Uint8Array.from([1, 2, 3]),
    }, binaryAck)
    await vi.waitFor(() => expect(binaryAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'binary-1',
      status: 200,
      bodyBytes: expect.any(Uint8Array),
    })))
    const binaryRequest = fetchImpl.mock.calls[1][1]
    expect(Buffer.from(binaryRequest?.body as Uint8Array)).toEqual(Buffer.from([1, 2, 3]))
    const binaryResponse = binaryAck.mock.calls[0][0].bodyBytes as Uint8Array
    expect(Buffer.from(binaryResponse)).toEqual(Buffer.from([7, 8, 9]))
  })

  it('streams opted-in LAN downloads in bounded chunks while preserving legacy responses', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const fetchImpl = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '5',
      },
    }))
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const app = createMockAppSocket('app-download', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    expect(app.emit).toHaveBeenCalledWith('relay.ready', expect.objectContaining({
      capabilities: expect.arrayContaining(['http.download.chunked']),
    }))

    const openAck = vi.fn()
    app.__handlers.get('http.request')({
      id: 'download-open',
      method: 'GET',
      path: '/api/studio/files/download?path=test.bin',
      streamBinary: true,
    }, openAck)
    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'download-open',
      status: 200,
      download: { id: expect.any(String), totalBytes: 5 },
    })))
    const downloadId = openAck.mock.calls[0][0].download.id

    const firstAck = vi.fn()
    app.__handlers.get('http.download.chunk')({ id: downloadId, maxBytes: 3 }, firstAck)
    await vi.waitFor(() => expect(firstAck).toHaveBeenCalledWith(expect.objectContaining({
      receivedBytes: 3,
      done: false,
    })))
    expect(Array.from(firstAck.mock.calls[0][0].bodyBytes)).toEqual([1, 2, 3])

    const secondAck = vi.fn()
    app.__handlers.get('http.download.chunk')({ id: downloadId, maxBytes: 3 }, secondAck)
    await vi.waitFor(() => expect(secondAck).toHaveBeenCalledWith(expect.objectContaining({
      receivedBytes: 5,
      done: true,
    })))
    expect(Array.from(secondAck.mock.calls[0][0].bodyBytes)).toEqual([4, 5])
  })

  it('bridges /chat-run directly with the same App socket events as the cloud relay', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
    })
    server.init()

    const app = createMockAppSocket('app-chat', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const openAck = vi.fn()
    app.__handlers.get('socket.open')({
      id: 'chat-1',
      namespace: '/chat-run',
      auth: { token: 'untrusted-token' },
      query: { profile: 'default' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith({
      id: 'chat-1',
      ok: true,
      namespace: '/chat-run',
      stream: true,
    }))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/chat-run',
      expect.objectContaining({
        auth: { token: 'local-user-token' },
        query: { profile: 'default' },
      }),
    )

    const local = clientSocketMocks.sockets[0]
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'chat-1',
      event: 'run',
      payload: { session_id: 'session-1', input: 'hello' },
    }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chat-1',
      ok: true,
      event: 'run',
    })))
    expect(local.emit).toHaveBeenCalledWith('run', { session_id: 'session-1', input: 'hello' })

    const resumeAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'chat-1',
      event: 'app.resume',
      payload: { session_id: 'session-1', id: 'cache-1' },
    }, resumeAck)
    await vi.waitFor(() => expect(resumeAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chat-1',
      ok: true,
      event: 'app.resume',
    })))
    expect(local.emit).toHaveBeenCalledWith('app.resume', {
      session_id: 'session-1',
      id: 'cache-1',
    })

    const insertAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'chat-1',
      event: 'insert_queued_run',
      payload: { session_id: 'session-1', queue_id: 'queue-1' },
    }, insertAck)
    await vi.waitFor(() => expect(insertAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chat-1',
      ok: true,
      event: 'insert_queued_run',
    })))
    expect(local.emit).toHaveBeenCalledWith('insert_queued_run', {
      session_id: 'session-1',
      queue_id: 'queue-1',
    })

    const locationAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'chat-1',
      event: 'location.respond',
      payload: {
        session_id: 'session-1',
        location_request_id: 'location-1',
        status: 'denied',
      },
    }, locationAck)
    await vi.waitFor(() => expect(locationAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chat-1',
      ok: true,
      event: 'location.respond',
    })))
    expect(local.emit).toHaveBeenCalledWith('location.respond', {
      session_id: 'session-1',
      location_request_id: 'location-1',
      status: 'denied',
    })

    local.__onAny('message.delta', { session_id: 'session-1', delta: 'hi' })
    expect(app.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 'session-1', delta: 'hi' },
    })
  })

  it('bridges /group-chat with authenticated Socket.IO acknowledgements', async () => {
    const namespace = createMockNamespace()
    const io = { of: vi.fn(() => namespace) }
    const { LocalAppRelayServer } = await import('../../packages/server/src/modules/studio/services/app-relay/server')
    const server = new LocalAppRelayServer(io as any, {
      machineId: 'hwui_local_machine_1234567890',
      localBaseUrl: 'http://127.0.0.1:8748',
    })
    server.init()

    const app = createMockAppSocket('app-group', {
      role: 'app',
      token: 'local-user-token',
      machineId: 'hwui_local_machine_1234567890',
    })
    await connectApp(namespace, app)
    const openAck = vi.fn()
    app.__handlers.get('socket.open')({
      id: 'group-1',
      namespace: '/group-chat',
      auth: { token: 'untrusted-token', authUserId: 7, name: 'app-user' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'group-1',
      ok: true,
      namespace: '/group-chat',
    })))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/group-chat',
      expect.objectContaining({
        auth: { token: 'local-user-token', authUserId: 7, name: 'app-user' },
      }),
    )

    const local = clientSocketMocks.sockets[0]
    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'join') ack?.({ roomName: 'Relay room', messages: [] })
    })
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'group-1',
      event: 'join',
      payload: { roomId: 'room-1' },
      ack: true,
    }, eventAck)

    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'group-1',
      ok: true,
      namespace: '/group-chat',
      event: 'join',
      payload: { roomName: 'Relay room', messages: [] },
    })))
  })

  it('bridges workflow status subscriptions with the authenticated Studio token', async () => {
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
      namespace: '/workflow',
      auth: { token: 'untrusted-token' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-1',
      ok: true,
      namespace: '/workflow',
    })))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/workflow',
      expect.objectContaining({ auth: { token: 'local-user-token' } }),
    )

    const local = clientSocketMocks.sockets[0]
    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'workflow.status.subscribe') {
        ack?.({ ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } })
      }
    })
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'workflow-1',
      event: 'workflow.status.subscribe',
      payload: { workflowId: 'workflow-a' },
      ack: true,
    }, eventAck)

    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-1',
      ok: true,
      namespace: '/workflow',
      event: 'workflow.status.subscribe',
      payload: { ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } },
    })))
  })

  it('bridges terminal reads with the authenticated Studio token', async () => {
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
      id: 'terminal-1',
      namespace: '/terminal',
      auth: { token: 'untrusted-token' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'terminal-1',
      ok: true,
      namespace: '/terminal',
    })))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/terminal',
      expect.objectContaining({ auth: { token: 'local-user-token' } }),
    )

    const local = clientSocketMocks.sockets[0]
    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'terminal.read') {
        ack?.({ ok: true, data: { chunks: [{ seq: 1, data: 'hello\r\n' }], cursor: 1 } })
      }
    })
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'terminal-1',
      event: 'terminal.read',
      payload: { terminalId: 'terminal-a', lease: 'lease-a', cursor: 0 },
      ack: true,
    }, eventAck)

    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'terminal-1',
      ok: true,
      namespace: '/terminal',
      event: 'terminal.read',
      payload: { ok: true, data: { chunks: [{ seq: 1, data: 'hello\r\n' }], cursor: 1 } },
    })))
    const deniedAck = vi.fn()
    app.__handlers.get('socket.event')({ id: 'terminal-1', event: 'run', payload: {}, ack: true }, deniedAck)
    await vi.waitFor(() => expect(deniedAck).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'event_not_allowed' }),
    })))
  })

  it('bridges unified App subscriptions over local and manually addressed relay', async () => {
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
      namespace: '/chat-run',
      auth: { token: 'untrusted-token', appEventVersion: 1 }, query: { profile: 'default' },
    }, openAck)

    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-1',
      ok: true,
      namespace: '/chat-run',
    })))
    expect(clientSocketMocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8748/chat-run',
      expect.objectContaining({ auth: { token: 'local-user-token', appEventVersion: 1 } }),
    )

    const local = clientSocketMocks.sockets[0]
    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'app.events.subscribe') {
        ack?.({ ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } })
      }
    })
    const eventAck = vi.fn()
    app.__handlers.get('socket.event')({
      id: 'workflow-1',
      event: 'app.events.subscribe',
      payload: { schema_version: 1, profile: 'default', types: ['workflow.run.completed'] },
      ack: true,
    }, eventAck)

    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-1',
      ok: true,
      namespace: '/chat-run',
      event: 'app.events.subscribe',
      payload: { ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } },
    })))
  })
})
