import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIo, sockets } = vi.hoisted(() => {
  const sockets: any[] = []

  function createSocket(url: string, options?: Record<string, unknown>) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id: `socket-${sockets.length + 1}`,
      __url: url,
      __options: options,
      __handlers: handlers,
      connected: false,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      onAny: vi.fn((handler: (...args: any[]) => void) => {
        socket.__onAny = handler
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      off: vi.fn(),
      emit: vi.fn(),
      timeout: vi.fn(() => socket),
      disconnect: vi.fn(() => { socket.connected = false }),
    }
    return socket
  }

  return {
    sockets,
    mockIo: vi.fn((url: string, options?: Record<string, unknown>) => {
      const socket = createSocket(url, options)
      sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('socket.io-client', () => ({ io: mockIo }))
vi.mock('../../packages/server/src/modules/studio/public/system-info', () => ({
  createDeviceSignature: vi.fn(async () => 'machine-signature'),
}))

describe('AppRelayClient', () => {
  beforeEach(async () => {
    const { stopAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    stopAppRelayClient()
    sockets.length = 0
    vi.clearAllMocks()
  })

  it('connects with a signed machine identity independent of the MCU relay', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const publicKey = '-----BEGIN PUBLIC KEY-----\nmachine-public-key\n-----END PUBLIC KEY-----\n'
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey,
      machineInfo: { computer_name: 'Studio Mac' },
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    expect(client).not.toBeNull()
    expect(mockIo).toHaveBeenCalledWith('https://relay.example.com/app-relay', expect.objectContaining({
      transports: ['websocket', 'polling'],
      reconnection: true,
    }))
    const options = mockIo.mock.calls[0][1]
    const auth = await new Promise<Record<string, unknown>>(resolve => options.auth(resolve))
    expect(auth).toMatchObject({
      role: 'host',
      machineId: 'hwui_machine_1234567890',
      publicKey,
      signature: 'machine-signature',
      replaceExistingHost: true,
      machine: { computer_name: 'Studio Mac' },
    })
    expect(auth.nonce).toEqual(expect.any(String))
    expect(auth.timestamp).toEqual(expect.any(Number))
  })

  it('bridges Agent events and preserves acknowledgements from the source Studio', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({ relayUrl: 'https://relay.example', machineId: 'hwui_machine_1234567890', publicKey: 'key', localBaseUrl: 'http://127.0.0.1:8648', fetchImpl: vi.fn() as any })
    const remote = sockets[0]
    remote.connected = true
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({ id: 'agent-bridge', namespace: '/group-chat-agent-relay', auth: { pairingTicket: 'target-ticket' } }, openAck)
    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/group-chat-agent-relay')
    expect(local.__options.auth).toEqual({ pairingTicket: 'target-ticket' })
    expect(openAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    local.emit.mockImplementation((_event: string, payload: unknown, ack?: Function) => { ack?.({ accepted: payload }); return local })
    const eventAck = vi.fn()
    remote.__handlers.get('app.socket.event')({ id: 'agent-bridge', event: 'agent.config.update', payload: { name: 'Updated' }, ack: true }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({ ok: true, payload: { accepted: { name: 'Updated' } } })))
    remote.emit.mockImplementation((_event: string, _payload: unknown, ack?: Function) => { ack?.(null, { ok: true }); return remote })
    const approvalAck = vi.fn()
    local.__onAny('approval.respond', { decision: 'allow' }, approvalAck)
    expect(remote.emit).toHaveBeenCalledWith('app.socket.event', { id: 'agent-bridge', namespace: '/group-chat-agent-relay', event: 'approval.respond', payload: { decision: 'allow' } }, expect.any(Function))
    expect(approvalAck).toHaveBeenCalledWith({ ok: true })
    const denied = vi.fn()
    remote.__handlers.get('app.socket.event')({ id: 'agent-bridge', event: 'run', payload: {} }, denied)
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith(expect.objectContaining({ ok: false })))
  })

  it('forwards single Agent payloads without Socket.IO recovery offsets', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({ relayUrl: 'https://relay.example', machineId: 'hwui_machine_1234567890', publicKey: 'key', localBaseUrl: 'http://127.0.0.1:8648', fetchImpl: vi.fn() as any })
    const remote = sockets[0]
    remote.connected = true
    remote.__handlers.get('app.socket.open')({ id: 'agent-recovery', namespace: '/group-chat-agent-relay', auth: {} }, vi.fn())
    const local = sockets[1]
    for (const event of ['relay.ready', 'run.request', 'run.interrupt', 'room.metadata', 'connector.revoked']) {
      const payload = { agent: { name: 'Remote Agent' }, runId: 'run-1' }
      local.__onAny(event, payload, 'recovery-offset')
      expect(remote.emit).toHaveBeenLastCalledWith('app.socket.event', {
        id: 'agent-recovery', namespace: '/group-chat-agent-relay', event, payload,
      })
    }
  })

  it('forwards target-issued Agent request secrets and workspace hash preconditions', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    startAppRelayClient({ relayUrl: 'https://relay.example', machineId: 'hwui_machine_1234567890', publicKey: 'key', localBaseUrl: 'http://127.0.0.1:8648', fetchImpl: fetchImpl as any })
    const ack = vi.fn()
    sockets[0].__handlers.get('app.http.request')({ id: 'agent-status', method: 'GET', path: '/api/studio/group-chat/invites/code/agent-links/request', headers: { 'x-group-agent-request-secret': 'request-secret', 'x-expected-sha256': 'hash' } }, ack)
    await vi.waitFor(() => expect(ack).toHaveBeenCalled())
    expect(Object.fromEntries((fetchImpl.mock.calls as any)[0][1].headers.entries())).toMatchObject({ 'x-group-agent-request-secret': 'request-secret', 'x-expected-sha256': 'hash' })
  })

  it('marks development Web UI relay hosts as non-preemptive', async () => {
    const { shouldReplaceExistingAppRelayHost } = await import(
      '../../packages/server/src/modules/studio/services/app-relay/connection'
    )
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')

    expect(shouldReplaceExistingAppRelayHost({ NODE_ENV: 'development' })).toBe(false)
    expect(shouldReplaceExistingAppRelayHost({ NODE_ENV: 'test' })).toBe(false)
    expect(shouldReplaceExistingAppRelayHost({ NODE_ENV: 'production' })).toBe(true)

    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      replaceExistingHost: false,
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const options = mockIo.mock.calls[0][1]
    const auth = await new Promise<Record<string, unknown>>(resolve => options.auth(resolve))

    expect(auth.replaceExistingHost).toBe(false)
  })

  it('keeps waiting across transient connect errors while Socket.IO retries', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    const connected = client.waitForConnected(1000)

    remote.__handlers.get('connect_error')?.(new Error('temporary network failure'))
    remote.connected = true
    remote.__handlers.get('connect')?.()

    await expect(connected).resolves.toBe(true)
  })

  it('remembers the latest cloud access failure reported by the relay', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    remote.__handlers.get('connection.access.failed')?.({
      machineId: 'hwui_machine_1234567890',
      deviceCode: 'app-device-1',
      deviceName: 'Phone',
      appUserId: 7,
      plan: 'paid',
      code: 'cloud_subscription_required',
      occurredAt: 123456,
    })

    expect(client.getLatestAccessFailure(123457)).toEqual({
      code: 'cloud_subscription_required',
      deviceCode: 'app-device-1',
      deviceName: 'Phone',
      cloudUserId: 7,
      connectionType: 'cloud',
      plan: 'paid',
      occurredAt: 123456,
    })
  })

  it('forwards local API requests with safe headers and binary support', async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/api/studio/tts/synthesize')
      ? new Response(Uint8Array.from([7, 8, 9]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      : new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    const remote = sockets[0]
    const ack = vi.fn()
    remote.__handlers.get('app.http.request')({
      id: 'http-1',
      method: 'POST',
      path: '/api/studio/sessions?profile=default',
      headers: {
        authorization: 'Bearer local-user-token',
        'content-type': 'application/json',
        'if-match': '"revision-1"',
        host: 'untrusted.example.com',
      },
      body: { title: 'App session' },
    }, ack)

    await vi.waitFor(() => expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      id: 'http-1',
      status: 200,
      body: '{"ok":true}',
    })))
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8648/api/studio/sessions?profile=default',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ title: 'App session' }) }),
    )
    const headers = fetchImpl.mock.calls[0][1]?.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer local-user-token')
    expect(headers.get('if-match')).toBe('"revision-1"')
    expect(headers.has('host')).toBe(false)

    const binaryAck = vi.fn()
    remote.__handlers.get('app.http.request')({
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

  it('uses the cloud media limit for downloads and applies live limit updates before reading the body', async () => {
    const apkBytes = new Uint8Array(23 * 1024 * 1024)
    const fetchImpl = vi.fn(async () => new Response(apkBytes, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.android.package-archive',
        'content-length': String(apkBytes.byteLength),
      },
    }))
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })!
    const remote = sockets[0]
    remote.__handlers.get('relay.ready')?.({
      limits: {
        mediaMaxMegabytes: 30,
        mediaTransferMegabytesPerSecond: 2,
        controlTransferMegabytesPerSecond: 2,
      },
    })

    const allowed = await client.handleHttpRequest({
      id: 'apk-allowed',
      method: 'GET',
      path: '/api/studio/files/download?path=test.apk',
    })
    expect(allowed.error).toBeUndefined()
    expect(allowed.bodyBytes?.byteLength).toBe(apkBytes.byteLength)

    remote.__handlers.get('relay.limits.updated')?.({
      limits: {
        mediaMaxMegabytes: 20,
        mediaTransferMegabytesPerSecond: 2,
        controlTransferMegabytesPerSecond: 2,
      },
    })
    const rejected = await client.handleHttpRequest({
      id: 'apk-rejected',
      method: 'GET',
      path: '/api/studio/files/download?path=test.apk',
    })
    expect(rejected).toMatchObject({
      id: 'apk-rejected',
      status: 413,
      error: {
        code: 'download_too_large',
        message: 'Cloud relay media files are limited to 20MB',
      },
    })
    expect(rejected.bodyBytes).toBeUndefined()
  })

  it('streams opted-in binary downloads in bounded chunks when the cloud advertises support', async () => {
    const fetchImpl = vi.fn(async () => new Response(Uint8Array.from([1, 2, 3, 4, 5]), {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': '5',
      },
    }))
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    const remote = sockets[0]
    remote.__handlers.get('relay.ready')?.({
      capabilities: ['http.request', 'http.download.chunked'],
      limits: {
        mediaMaxMegabytes: 30,
        mediaTransferMegabytesPerSecond: 2,
        controlTransferMegabytesPerSecond: 2,
      },
    })

    const openAck = vi.fn()
    remote.__handlers.get('app.http.request')({
      id: 'chunked-open',
      method: 'GET',
      path: '/api/studio/files/download?path=test.bin',
      streamBinary: true,
    }, openAck)
    await vi.waitFor(() => expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'chunked-open',
      status: 200,
      download: { id: expect.any(String), totalBytes: 5 },
    })))
    expect(openAck.mock.calls[0][0].bodyBytes).toBeUndefined()
    const downloadId = openAck.mock.calls[0][0].download.id

    const firstAck = vi.fn()
    remote.__handlers.get('app.http.download.chunk')({ id: downloadId, maxBytes: 3 }, firstAck)
    await vi.waitFor(() => expect(firstAck).toHaveBeenCalledWith(expect.objectContaining({
      id: downloadId,
      receivedBytes: 3,
      totalBytes: 5,
      done: false,
    })))
    expect(Array.from(firstAck.mock.calls[0][0].bodyBytes)).toEqual([1, 2, 3])

    const secondAck = vi.fn()
    remote.__handlers.get('app.http.download.chunk')({ id: downloadId, maxBytes: 3 }, secondAck)
    await vi.waitFor(() => expect(secondAck).toHaveBeenCalledWith(expect.objectContaining({
      id: downloadId,
      receivedBytes: 5,
      totalBytes: 5,
      done: true,
    })))
    expect(Array.from(secondAck.mock.calls[0][0].bodyBytes)).toEqual([4, 5])
  })

  it('marks App authorization-code login as a cloud connection', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ token: 'app-token' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    const remote = sockets[0]
    const ack = vi.fn()
    remote.__handlers.get('app.http.request')({
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
    expect(headers.get('x-hermes-app-connection')).toBe('cloud')
  })

  it('requests a bounded cloud preconnection without embedding the relay URL', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    remote.timeout.mockImplementation(() => ({
      emit: (_event: string, request: Record<string, unknown>, ack: (...args: any[]) => void) => {
        expect(request).toEqual({ refresh: false })
        ack(null, {
          ok: true,
          type: 'hermes-studio.app-connection',
          version: 1,
          connectionType: 'cloud',
          machineId: 'hwui_machine_1234567890',
          preconnectId: '70a0af7c-5977-4dd6-bca5-b8e641170658',
          matchingCode: 'matching-code-with-enough-entropy',
          expiresAt: 2000,
          hardExpiresAt: 2600,
          refreshRemaining: 3,
        })
      },
    }))

    const preconnection = await client.requestPreconnection('local-authorization-code', false, 8000, 7)

    expect(preconnection).toMatchObject({
      connectionType: 'cloud',
      machineId: 'hwui_machine_1234567890',
      refreshRemaining: 3,
    })
    expect(preconnection).not.toHaveProperty('relayUrl')
    expect(client.getCachedPreconnection(7, 1000)).toEqual(preconnection)
    expect(client.getCachedPreconnection(8, 1000)).toBeNull()
    expect(client.getCachedPreconnection(7, 2000)).toBeNull()
    expect(client.getCachedPreconnection(7, 2600)).toBeNull()
  })

  it('drops cached preconnections whenever the relay host session changes', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    remote.__handlers.get('connect')?.()
    remote.timeout.mockImplementation(() => ({
      emit: (_event: string, _request: Record<string, unknown>, ack: (...args: any[]) => void) => {
        ack(null, {
          ok: true,
          type: 'hermes-studio.app-connection',
          version: 1,
          connectionType: 'cloud',
          machineId: 'hwui_machine_1234567890',
          preconnectId: '70a0af7c-5977-4dd6-bca5-b8e641170658',
          matchingCode: 'matching-code-with-enough-entropy',
          expiresAt: 2_000,
          hardExpiresAt: 2_600,
          refreshRemaining: 3,
        })
      },
    }))

    const preconnection = await client.requestPreconnection('local-authorization-code', false, 8000, 7)
    expect(client.getCachedPreconnection(7, 1_000)).toEqual(preconnection)

    remote.connected = false
    remote.__handlers.get('disconnect')?.('transport close')
    expect(client.getCachedPreconnection(7, 1_000)).toBeNull()

    remote.connected = true
    remote.__handlers.get('connect')?.()
    expect(client.getCachedPreconnection(7, 1_000)).toBeNull()
  })

  it('forwards the authenticated cloud account into Studio authorization', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      token: 'studio-token',
      userId: 1,
      profiles: ['default'],
      appConnection: { token_expires_at: 4_000 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    remote.timeout.mockImplementation(() => ({
      emit: (_event: string, _request: Record<string, unknown>, ack: (...args: any[]) => void) => {
        ack(null, {
          ok: true,
          type: 'hermes-studio.app-connection',
          version: 1,
          connectionType: 'cloud',
          machineId: 'hwui_machine_1234567890',
          preconnectId: '70a0af7c-5977-4dd6-bca5-b8e641170658',
          matchingCode: 'matching-code-with-enough-entropy',
          expiresAt: Math.floor(Date.now() / 1000) + 300,
          hardExpiresAt: Math.floor(Date.now() / 1000) + 900,
          refreshRemaining: 3,
        })
      },
    }))
    const preconnection = await client.requestPreconnection('local-authorization-code', false, 8000, 1)
    const authorizeAck = vi.fn()

    remote.__handlers.get('connection.authorize')({
      preconnectId: preconnection.preconnectId,
      matchingCode: preconnection.matchingCode,
      appUserId: 101,
      deviceCode: 'shared-phone-code',
      deviceName: 'Alice Phone',
    }, authorizeAck)

    await vi.waitFor(() => expect(authorizeAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      studioUserId: 1,
    })))
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      device_code: 'shared-phone-code',
      cloud_user_id: 101,
    })
  })

  it('includes the cloud account when revoking a shared device code', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    const client = startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })!
    const remote = sockets[0]
    remote.connected = true
    const emit = vi.fn((_event: string, _request: Record<string, unknown>, ack: (...args: any[]) => void) => {
      ack(null, { ok: true })
    })
    remote.timeout.mockImplementation(() => ({ emit }))

    await expect(client.revokeCloudConnection('shared-phone-code', 101)).resolves.toBe(true)
    expect(emit).toHaveBeenCalledWith(
      'connection.revoke',
      { deviceCode: 'shared-phone-code', appUserId: 101 },
      expect.any(Function),
    )
  })

  it('bridges the full-duplex /chat-run socket without using MCU events', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({
      id: 'relay-chat-1',
      namespace: '/chat-run',
      auth: { token: 'local-user-token' },
      query: { profile: 'default' },
    }, openAck)

    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/chat-run')
    expect(local.__options).toMatchObject({
      auth: { token: 'local-user-token' },
      query: { profile: 'default' },
    })
    expect(openAck).toHaveBeenCalledWith({
      id: 'relay-chat-1',
      ok: true,
      namespace: '/chat-run',
      stream: true,
    })

    const runAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-chat-1',
      event: 'run',
      payload: { session_id: 'session-1', input: 'hello' },
    }, runAck)
    expect(local.emit).toHaveBeenCalledWith('run', { session_id: 'session-1', input: 'hello' })
    await vi.waitFor(() => expect(runAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'run',
    })))

    const resumeAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-chat-1',
      event: 'app.resume',
      payload: { session_id: 'session-1', id: 'cache-1' },
    }, resumeAck)
    expect(local.emit).toHaveBeenCalledWith('app.resume', {
      session_id: 'session-1',
      id: 'cache-1',
    })
    await vi.waitFor(() => expect(resumeAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'app.resume',
    })))

    const insertAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-chat-1',
      event: 'insert_queued_run',
      payload: { session_id: 'session-1', queue_id: 'queue-1' },
    }, insertAck)
    expect(local.emit).toHaveBeenCalledWith('insert_queued_run', {
      session_id: 'session-1',
      queue_id: 'queue-1',
    })
    await vi.waitFor(() => expect(insertAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'insert_queued_run',
    })))

    const locationAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-chat-1',
      event: 'location.respond',
      payload: {
        session_id: 'session-1',
        location_request_id: 'location-1',
        status: 'denied',
      },
    }, locationAck)
    expect(local.emit).toHaveBeenCalledWith('location.respond', {
      session_id: 'session-1',
      location_request_id: 'location-1',
      status: 'denied',
    })
    await vi.waitFor(() => expect(locationAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-chat-1',
      ok: true,
      event: 'location.respond',
    })))

    local.__onAny('message.delta', { session_id: 'session-1', delta: 'hi' })
    expect(remote.emit).toHaveBeenCalledWith('app.socket.event', {
      id: 'relay-chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 'session-1', delta: 'hi' },
    })

    local.__onAny('subagent.start', { session_id: 'session-1', task_id: 'task-1' })
    expect(remote.emit).toHaveBeenCalledWith('app.socket.event', {
      id: 'relay-chat-1',
      namespace: '/chat-run',
      event: 'subagent.start',
      payload: { session_id: 'session-1', task_id: 'task-1' },
    })

    remote.__handlers.get('disconnect')('transport close')
    expect(local.disconnect).toHaveBeenCalled()
  })

  it('closes a cloud bridge even when the cleanup notification has no acknowledgement', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    remote.__handlers.get('app.socket.open')({
      id: 'abandoned-bridge', namespace: '/chat-run', auth: { token: 'local-user-token' },
    }, vi.fn())
    const local = sockets[1]

    remote.__handlers.get('app.socket.close')({ id: 'abandoned-bridge' })

    expect(local.disconnect).toHaveBeenCalledTimes(1)
    const eventAck = vi.fn()
    remote.__handlers.get('app.socket.event')({ id: 'abandoned-bridge', event: 'run', payload: {} }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'socket_not_open' }),
    })))
    expect(local.emit).not.toHaveBeenCalled()
  })

  it('bridges the /workflow status namespace and whitelisted subscription events', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({
      id: 'relay-workflow-1',
      namespace: '/workflow',
      auth: { token: 'local-user-token' },
    }, openAck)

    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/workflow')
    expect(local.__options).toMatchObject({ auth: { token: 'local-user-token' } })
    expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-workflow-1',
      ok: true,
      namespace: '/workflow',
    }))

    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'workflow.status.subscribe') {
        ack?.({ ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } })
      }
    })
    const eventAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-workflow-1',
      event: 'workflow.status.subscribe',
      payload: { workflowId: 'workflow-a' },
      ack: true,
    }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      namespace: '/workflow',
      event: 'workflow.status.subscribe',
    })))
  })

  it('bridges the /terminal namespace and rejects unlisted events', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({
      id: 'relay-terminal-1',
      namespace: '/terminal',
      auth: { token: 'local-user-token' },
    }, openAck)

    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/terminal')
    expect(local.__options).toMatchObject({ auth: { token: 'local-user-token' } })
    expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-terminal-1',
      ok: true,
      namespace: '/terminal',
    }))

    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'terminal.read') {
        ack?.({ ok: true, data: { chunks: [{ seq: 1, data: 'hello\r\n' }], cursor: 1 } })
      }
    })
    const eventAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-terminal-1',
      event: 'terminal.read',
      payload: { terminalId: 'terminal-a', lease: 'lease-a', cursor: 0, stream: true },
      ack: true,
    }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      namespace: '/terminal',
      event: 'terminal.read',
    })))
    const pushed = { terminalId: 'terminal-a', lease: 'lease-a', batch: 1, chunks: [{ seq: 1, data: 'echo' }], cursor: 1 }
    local.__onAny('terminal.output', pushed)
    expect(remote.emit).toHaveBeenCalledWith('app.socket.event', expect.objectContaining({
      id: 'relay-terminal-1', namespace: '/terminal', event: 'terminal.output', payload: pushed,
    }))
    const deniedAck = vi.fn()
    remote.__handlers.get('app.socket.event')({ id: 'relay-terminal-1', event: 'run', payload: {}, ack: true }, deniedAck)
    await vi.waitFor(() => expect(deniedAck).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'event_not_allowed' }),
    })))
  })

  it('bridges unified App subscriptions through cloud relay transport', async () => {
    const { startAppRelayClient } = await import('../../packages/server/src/modules/studio/services/app-relay/client')
    startAppRelayClient({
      relayUrl: 'https://relay.example.com',
      machineId: 'hwui_machine_1234567890',
      publicKey: 'machine-public-key',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const remote = sockets[0]
    const openAck = vi.fn()
    remote.__handlers.get('app.socket.open')({
      id: 'relay-workflow-1',
      namespace: '/chat-run',
      auth: { token: 'local-user-token', appEventVersion: 1 }, query: { profile: 'default' },
    }, openAck)

    const local = sockets[1]
    expect(local.__url).toBe('http://127.0.0.1:8648/chat-run')
    expect(local.__options).toMatchObject({ auth: { token: 'local-user-token', appEventVersion: 1 } })
    expect(openAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'relay-workflow-1',
      ok: true,
      namespace: '/chat-run',
    }))

    local.emit.mockImplementation((event: string, payload: unknown, ack?: (response: unknown) => void) => {
      if (event === 'app.events.subscribe') {
        ack?.({ ok: true, data: { statuses: [{ workflowId: 'workflow-a', status: 'idle' }] } })
      }
    })
    const eventAck = vi.fn()
    remote.__handlers.get('app.socket.event')({
      id: 'relay-workflow-1',
      event: 'app.events.subscribe',
      payload: { schema_version: 1, profile: 'default', types: ['workflow.run.completed'] },
      ack: true,
    }, eventAck)
    await vi.waitFor(() => expect(eventAck).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      namespace: '/chat-run',
      event: 'app.events.subscribe',
    })))
  })
})
