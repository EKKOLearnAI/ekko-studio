import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeMcuImaAdpcm,
  encodeMcuImaAdpcm,
} from '../../packages/server/src/modules/studio/services/voice/mcu/adpcm'
import { MCU_VOICE_SYSTEM_INSTRUCTIONS } from '../../packages/server/src/modules/studio/services/global-agent/mcu-voice-instructions'

const authMocks = vi.hoisted(() => ({
  authenticateUserToken: vi.fn(),
  userCanAccessProfile: vi.fn(),
}))

const clientSocketMocks = vi.hoisted(() => {
  function createLocalSocket(id: string) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const socket: any = {
      id,
      __handlers: handlers,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler)
        return socket
      }),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
    }
    return socket
  }

  const localSockets: any[] = []
  const clientIo = vi.fn(() => {
    const socket = createLocalSocket(`local-socket-${localSockets.length + 1}`)
    localSockets.push(socket)
    return socket
  })
  const reset = () => {
    localSockets.length = 0
    clientIo.mockClear()
  }

  return {
    clientIo,
    localSockets,
    reset,
  }
})

const chatRunMocks = vi.hoisted(() => ({
  getChatRunServer: vi.fn(),
  clearSessionHistory: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/middleware/auth', () => ({
  authenticateUserToken: authMocks.authenticateUserToken,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: authMocks.userCanAccessProfile,
}))

vi.mock('socket.io-client', () => ({
  io: clientSocketMocks.clientIo,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({
  getChatRunServer: chatRunMocks.getChatRunServer,
}))

function createMockNamespace() {
  const middleware: Array<(socket: any, next: (err?: Error) => void) => void> = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const nsp: any = {
    use: vi.fn((fn: (socket: any, next: (err?: Error) => void) => void) => {
      middleware.push(fn)
      return nsp
    }),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, handler)
      return nsp
    }),
    emit: vi.fn(),
    __middleware: middleware,
    __handlers: handlers,
  }
  return nsp
}

function createMockSocket(id: string, auth: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const handlers = new Map<string, (...args: any[]) => void>()
  const mcuEventsRequiringApiToken = new Set([
    'mcu.ready',
    'mcu.status',
    'mcu.interrupt',
    'mcu.session.clear',
    'mcu.session.cleared',
    'voice.stream.start',
    'voice.stream.chunk',
    'voice.stream.end',
    'voice.stream.abort',
    'voice.recorded',
    'interaction.status',
    'tool.started',
    'tool.completed',
    'tool.failed',
    'audio.started',
    'audio.done',
    'audio.interrupted',
    'audio.queued',
    'audio.dropped',
    'audio.cleared',
  ])
  const socket: any = {
    id,
    data: {},
    handshake: { auth, headers },
    broadcast: { emit: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, (...args: any[]) => {
        if (mcuEventsRequiringApiToken.has(event) && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
          args[0] = {
            apiToken: socket.data.userToken || socket.handshake.auth?.token,
            ...args[0],
          }
        }
        return handler(...args)
      })
      return socket
    }),
    emit: vi.fn((_event: string, payload: unknown, ack?: (response: unknown) => void) => {
      ack?.({ id: (payload as any)?.id, status: 200, body: '{"ok":true}' })
      return socket
    }),
    disconnect: vi.fn(),
    __handlers: handlers,
  }
  return socket
}

async function waitForMockCalls(mock: { mock: { calls: unknown[] } }, count: number): Promise<void> {
  const startedAt = Date.now()
  while (mock.mock.calls.length < count && Date.now() - startedAt < 1000) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function crc32ForTest(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

async function waitForMockCallWith(
  mock: { mock: { calls: unknown[][] } },
  predicate: (call: unknown[]) => boolean,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 1000) {
    if (mock.mock.calls.some(call => predicate(call))) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for matching mock call')
}

function startPrimaryMockRun(socket: any, runId = 'run-primary'): string {
  const runCall = socket.emit.mock.calls
    .filter(([event]: [string]) => event === 'run')
    .at(-1)
  expect(runCall?.[1]).toMatchObject({
    source: 'coding_agent',
    session_source: 'global_agent',
    coding_agent_id: 'ekko-agent',
    instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
  })
  const queueId = runCall?.[1]?.queue_id
  expect(queueId).toMatch(/^mcu_/)
  socket.__handlers.get('run.started')?.({ run_id: runId, queue_id: queueId })
  return queueId
}

describe('GlobalAgentServer', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    clientSocketMocks.reset()
    chatRunMocks.getChatRunServer.mockReturnValue({
      clearSessionHistory: chatRunMocks.clearSessionHistory,
    })
    chatRunMocks.clearSessionHistory.mockReturnValue({ deleted: 2, hadMemoryState: true })
    authMocks.authenticateUserToken.mockResolvedValue(null)
    authMocks.userCanAccessProfile.mockReturnValue(false)
  })

  it('registers a local control namespace with token auth', async () => {
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    expect(io.of).toHaveBeenCalledWith('/global-agent')
    expect(nsp.use).toHaveBeenCalledTimes(1)
    expect(nsp.on).toHaveBeenCalledWith('connection', expect.any(Function))

    const denied = createMockSocket('socket-denied', { token: 'wrong' })
    const deniedNext = vi.fn()
    await nsp.__middleware[0](denied, deniedNext)
    expect(deniedNext.mock.calls[0][0]).toBeInstanceOf(Error)

    const deniedAgent = createMockSocket('socket-denied-agent', { token: 'wrong', role: 'hermes-studio' })
    const deniedAgentNext = vi.fn()
    await nsp.__middleware[0](deniedAgent, deniedAgentNext)
    expect(deniedAgentNext.mock.calls[0][0]).toBeInstanceOf(Error)

    const allowed = createMockSocket('socket-allowed', { token: server.getAuthToken() })
    const allowedNext = vi.fn()
    await nsp.__middleware[0](allowed, allowedNext)
    expect(allowedNext).toHaveBeenCalledWith()
  })

  it('tracks connected clients and forwards requests with ack', async () => {
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()
    const socket = createMockSocket('socket-1', { token: server.getAuthToken(), instanceId: 'local-global-agent' })
    nsp.__handlers.get('connection')?.(socket)

    expect(server.getClientIds()).toEqual(['local-global-agent'])
    expect(socket.__handlers.has('mcu.events.subscribe')).toBe(true)
    expect(socket.__handlers.has('mcu.events.unsubscribe')).toBe(true)

    const response = await server.httpRequest({
      id: 'req-1',
      method: 'GET',
      path: '/api/auth/users',
    }, { clientId: 'local-global-agent' })

    expect(socket.emit).toHaveBeenCalledWith(
      'http.request',
      { id: 'req-1', method: 'GET', path: '/api/auth/users' },
      expect.any(Function),
    )
    expect(response).toEqual({ id: 'req-1', status: 200, body: '{"ok":true}' })
  })

  it('accepts frontend JWT clients and injects their token and profile into forwarded requests', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', { token: server.getAuthToken(), instanceId: 'local-global-agent' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const frontendSocket = createMockSocket('frontend-socket', { token: 'frontend-jwt', profile: 'research' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](frontendSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(frontendSocket)

    expect(frontendSocket.__handlers.has('mcu.events.subscribe')).toBe(false)

    const httpAck = vi.fn()
    frontendSocket.__handlers.get('http.request')?.({
      id: 'req-frontend',
      method: 'GET',
      path: '/api/auth/users',
      clientId: 'local-global-agent',
    }, httpAck)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agentSocket.emit).toHaveBeenCalledWith(
      'http.request',
      {
        id: 'req-frontend',
        method: 'GET',
        path: '/api/auth/users',
        clientId: 'local-global-agent',
        headers: {
          authorization: 'Bearer frontend-jwt',
          'x-hermes-profile': 'research',
        },
      },
      expect.any(Function),
    )
    expect(httpAck).toHaveBeenCalledWith({ id: 'req-frontend', status: 200, body: '{"ok":true}' })

    const openAck = vi.fn()
    frontendSocket.__handlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
      clientId: 'local-global-agent',
    }, openAck)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(agentSocket.emit).toHaveBeenCalledWith(
      'socket.open',
      {
        id: 'chat-1',
        namespace: '/chat-run',
        clientId: 'local-global-agent',
        auth: { token: 'frontend-jwt' },
        query: { profile: 'research' },
      },
      expect.any(Function),
    )
  })

  it('accepts JWT agent clients and handles inbound HTTP and chat-run socket relay requests locally', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { 'content-type': 'application/json', 'x-result': 'accepted' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    expect(server.getClientIds()).toEqual(['device-1'])

    const httpAck = vi.fn()
    agentSocket.__handlers.get('http.request')?.({
      id: 'req-1',
      method: 'POST',
      path: '/api/studio/sessions',
      headers: {
        authorization: 'Bearer attacker',
        'content-type': 'application/json',
      },
      body: { title: 'hello' },
    }, httpAck)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8648/api/studio/sessions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ title: 'hello' }),
    }))
    expect(Array.from((fetchImpl.mock.calls[0][1].headers as Headers).entries())).toEqual([
      ['authorization', 'Bearer user-jwt'],
      ['content-type', 'application/json'],
      ['x-hermes-profile', 'research'],
    ])
    expect(httpAck).toHaveBeenCalledWith(expect.objectContaining({
      id: 'req-1',
      status: 202,
      body: '{"ok":true}',
    }))

    const openAck = vi.fn()
    agentSocket.__handlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
    }, openAck)

    expect(clientSocketMocks.clientIo).toHaveBeenCalledWith('http://127.0.0.1:8648/chat-run', expect.objectContaining({
      auth: { token: 'user-jwt' },
      query: { profile: 'research' },
      transports: ['websocket', 'polling'],
    }))
    expect(openAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', stream: true })

    const localSocket = clientSocketMocks.localSockets[0]
    const eventAck = vi.fn()
    agentSocket.__handlers.get('socket.event')?.({
      id: 'chat-1',
      event: 'run',
      payload: { session_id: 's1', input: 'hi' },
    }, eventAck)

    expect(localSocket.emit).toHaveBeenCalledWith('run', {
      session_id: 's1',
      input: 'hi',
      profile: 'research',
    })
    expect(eventAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', event: 'run', stream: true })

    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'hello' })
    expect(agentSocket.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 's1', delta: 'hello' },
    })
  })

  it('replaces the previous agent socket for the same instance id', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, { localBaseUrl: 'http://127.0.0.1:8648' })
    server.init()

    const first = createMockSocket('agent-old', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](first, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(first)

    first.__handlers.get('socket.open')?.({ id: 'chat-1', namespace: '/chat-run' }, vi.fn())
    expect(clientSocketMocks.localSockets).toHaveLength(1)

    const second = createMockSocket('agent-new', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](second, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(second)

    expect(first.disconnect).toHaveBeenCalledWith(true)
    expect(clientSocketMocks.localSockets[0].disconnect).toHaveBeenCalled()
    expect(server.getClientIds()).toEqual(['device-1'])
  })

  it('pushes MCU events only to the selected agent socket and forwards MCU status events to frontends', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const otherAgentSocket = createMockSocket('jwt-agent-socket-2', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-2',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](otherAgentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(otherAgentSocket)

    expect(server.emitMcuEvent({
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
      url: 'http://127.0.0.1/audio.pcm',
    }, { clientId: 'device-1' })).toBe(true)
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', {
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
      url: 'http://127.0.0.1/audio.pcm',
    })
    expect(otherAgentSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.anything())
    expect(agentSocket.broadcast.emit).not.toHaveBeenCalled()

    agentSocket.__handlers.get('audio.queued')?.({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
    })
    expect(agentSocket.broadcast.emit).not.toHaveBeenCalled()
    expect(otherAgentSocket.emit).not.toHaveBeenCalledWith('relay.socket.event', expect.anything())
  })

  it('keeps MCU voice stream in listening state until the upload is ended', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    agentSocket.__handlers.get('voice.stream.start')?.({
      interactionId: 'voice-1',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    })

    expect(agentSocket.emit).toHaveBeenCalledWith('interaction.status', {
      type: 'interaction.status',
      interactionId: 'voice-1',
      status: 'listening',
    })
    expect(agentSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({
      interactionId: 'voice-1',
      status: 'transcribing',
    }))
  })

  it('accepts MCU voice stream chunks as Socket.IO binary payloads', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const pcm = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0])
    agentSocket.__handlers.get('voice.stream.start')?.({
      interactionId: 'voice-binary',
      agentRuntime: 'hermes',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    })
    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-binary',
      offset: 0,
      bytes: pcm.byteLength,
      data: pcm,
    })
    agentSocket.__handlers.get('voice.stream.end')?.({
      interactionId: 'voice-binary',
      bytes: pcm.byteLength,
    })

    await waitForMockCalls(fetchImpl, 1)
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    expect(request.headers).toMatchObject({
      'X-Hermes-Mcu-Agent-Runtime': 'hermes',
    })
    const wav = Buffer.from(request.body as Uint8Array)
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength)
    expect(wav.subarray(44)).toEqual(Buffer.from(pcm))
  })

  it('decodes chunk-framed MCU IMA-ADPCM streams before STT', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const firstPcm = Buffer.from([0, 0, 232, 3, 208, 7, 232, 3])
    const secondPcm = Buffer.from([0, 0, 24, 252, 48, 248, 24, 252])
    const first = encodeMcuImaAdpcm(firstPcm, 16000)
    const second = encodeMcuImaAdpcm(secondPcm, 16000)
    agentSocket.__handlers.get('voice.stream.start')?.({
      interactionId: 'voice-adpcm',
      mimeType: 'audio/x-ima-adpcm',
      frameFormat: 'hadp-chunk-v1',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    })
    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-adpcm',
      offset: 0,
      bytes: first.length,
      data: first,
    })
    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-adpcm',
      offset: first.length,
      bytes: second.length,
      data: second,
    })
    agentSocket.__handlers.get('voice.stream.end')?.({
      interactionId: 'voice-adpcm',
      bytes: first.length + second.length,
    })

    await waitForMockCalls(fetchImpl, 1)
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    const wav = Buffer.from(request.body as Uint8Array)
    const expectedPcm = Buffer.concat([
      decodeMcuImaAdpcm(first).pcm,
      decodeMcuImaAdpcm(second).pcm,
    ])
    expect(request.headers).toEqual(expect.objectContaining({ 'Content-Type': 'audio/wav' }))
    expect(wav.readUInt32LE(40)).toBe(expectedPcm.length)
    expect(wav.subarray(44)).toEqual(expectedPcm)
  })

  it('ignores stale MCU voice stream chunks and ends from previous interactions', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const stalePcm = Buffer.from([1, 0, 1, 0])
    const currentPcm = Buffer.from([2, 0, 2, 0])
    agentSocket.__handlers.get('voice.stream.start')?.({
      interactionId: 'voice-2',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    })
    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-1',
      offset: 0,
      bytes: stalePcm.length,
      data: stalePcm.toString('base64'),
    })
    agentSocket.__handlers.get('voice.stream.end')?.({
      interactionId: 'voice-1',
      bytes: stalePcm.length,
    })
    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-2',
      offset: 0,
      bytes: currentPcm.length,
      data: currentPcm.toString('base64'),
    })
    agentSocket.__handlers.get('voice.stream.end')?.({
      interactionId: 'voice-2',
      bytes: currentPcm.length,
    })

    await waitForMockCalls(fetchImpl, 1)
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    const wav = Buffer.from(request.body as Uint8Array)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(wav.readUInt32LE(40)).toBe(currentPcm.length)
    expect(wav.subarray(44)).toEqual(currentPcm)
  })

  it('rejects MCU voice stream chunks that arrive out of offset order', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const firstPcm = Buffer.from([1, 0, 1, 0])
    const secondPcm = Buffer.from([2, 0, 2, 0])
    agentSocket.__handlers.get('voice.stream.start')?.({
      interactionId: 'voice-1',
      sampleRate: 16000,
      channels: 1,
      bitsPerSample: 16,
    })
    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-1',
      seq: 1,
      offset: firstPcm.length,
      bytes: secondPcm.length,
      crc32: crc32ForTest(secondPcm),
      data: secondPcm.toString('base64'),
    })
    expect(agentSocket.emit).toHaveBeenCalledWith('voice.stream.chunk.ack', expect.objectContaining({
      interactionId: 'voice-1',
      offset: firstPcm.length,
      ok: false,
      reason: 'out_of_order',
    }))

    agentSocket.__handlers.get('voice.stream.chunk')?.({
      interactionId: 'voice-1',
      seq: 0,
      offset: 0,
      bytes: firstPcm.length,
      crc32: crc32ForTest(firstPcm),
      data: firstPcm.toString('base64'),
    })
    agentSocket.__handlers.get('voice.stream.end')?.({
      interactionId: 'voice-1',
      bytes: firstPcm.length,
    })

    await waitForMockCalls(fetchImpl, 1)
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    const wav = Buffer.from(request.body as Uint8Array)
    expect(wav.readUInt32LE(40)).toBe(firstPcm.length)
    expect(wav.subarray(44)).toEqual(firstPcm)
  })

  it('returns relative MCU audio URLs for device-side playback', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const audio = await (server as any).synthesizeMcuSpeech('hello', 'user-jwt', 'research')
    expect(audio.url).toMatch(/^\/api\/studio\/mcu\/audio\/[a-f0-9-]+\.adpcm$/)
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
  })

  it('marks TTS requests as MCU playback without forcing every provider to PCM', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    await (server as any).synthesizeMcuSpeech('hello', 'user-jwt', 'research')

    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      text: 'hello',
      options: {
        mcuPlayback: true,
        sampleRate: 24000,
      },
    })
  })

  it('falls back to Edge TTS when active MCU TTS output cannot be converted to PCM', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      if (body.provider === 'edge') {
        return new Response(Buffer.from('edge-pcm'), {
          status: 200,
          headers: { 'Content-Type': 'audio/x-pcm' },
        })
      }
      return new Response(Buffer.from('not-real-mp3'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      })
    })
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const audio = await (server as any).synthesizeMcuSpeech('hello', 'user-jwt', 'research')

    expect(audio.url).toMatch(/^\/api\/studio\/mcu\/audio\/[a-f0-9-]+\.adpcm$/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      provider: 'edge',
      text: 'hello',
      options: {
        mcuPlayback: true,
        sampleRate: 24000,
      },
    })
  })

  it('falls back to Edge TTS when the active MCU TTS provider fails', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      if (body.provider === 'edge') {
        return new Response(Buffer.from('edge-pcm'), {
          status: 200,
          headers: { 'Content-Type': 'audio/x-pcm' },
        })
      }
      return new Response(JSON.stringify({ error: 'provider down' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const audio = await (server as any).synthesizeMcuSpeech('hello', 'user-jwt', 'research')

    expect(audio.url).toMatch(/^\/api\/studio\/mcu\/audio\/[a-f0-9-]+\.adpcm$/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      provider: 'edge',
      text: 'hello',
      options: {
        mcuPlayback: true,
        sampleRate: 24000,
      },
    })
  })

  it('routes Hermes and Ekko MCU turns to isolated agent sessions', async () => {
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')
    const server = new GlobalAgentServer(io as any)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-hermes',
      transcript: 'use Hermes',
      clientId: 'device-1',
      agentRuntime: 'hermes',
    })
    const hermesSocket = clientSocketMocks.localSockets.at(-1)
    hermesSocket.__handlers.get('connect')?.()
    const hermesRun = hermesSocket.emit.mock.calls.find(([event]: [string]) => event === 'run')?.[1]
    expect(hermesRun).toMatchObject({
      session_id: 'mcu-device-1-research-hermes',
      source: 'global_agent',
      session_source: 'global_agent',
      instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
    })
    expect(hermesRun).not.toHaveProperty('coding_agent_id')

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-ekko',
      transcript: 'use Ekko',
      clientId: 'device-1',
      agentRuntime: 'ekko',
    })
    const ekkoSocket = clientSocketMocks.localSockets.at(-1)
    ekkoSocket.__handlers.get('connect')?.()
    expect(ekkoSocket.emit).toHaveBeenCalledWith('run', expect.objectContaining({
      session_id: 'mcu-device-1-research-ekko',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'ekko-agent',
    }))
  })

  it('synthesizes MCU speech at completed assistant-message boundaries', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-1',
      transcript: 'hi',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket)
    localSocket.__handlers.get('message.delta')?.({ delta: '好嘞，这就去查。\n' })
    await waitForMockCalls(fetchImpl, 1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      text: '好嘞，这就去查。',
    })
    localSocket.__handlers.get('tool.started')?.({
      tool: 'weather',
      preview: '不应转发给 MCU 的工具参数'.repeat(1_000),
    })
    expect(agentSocket.emit).toHaveBeenCalledWith('tool.started', {
      type: 'tool.started',
      interactionId: 'voice-1',
      tool: 'weather',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'audio.enqueue' && (payload as { segmentId?: string })?.segmentId === 'voice-1-tts-1',
    )
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
      text: '好嘞，这就去查。',
      url: expect.stringMatching(/^\/api\/studio\/mcu\/audio\/[a-f0-9-]+\.adpcm$/),
      completionManagedByServer: true,
    }))
    expect(agentSocket.emit).toHaveBeenCalledWith('interaction.status', expect.objectContaining({
      interactionId: 'voice-1',
      status: 'speaking',
      text: '好嘞，这就去查。',
    }))
    localSocket.__handlers.get('tool.completed')?.({
      tool: 'weather',
      preview: '不应转发给 MCU 的工具结果'.repeat(1_000),
    })
    expect(agentSocket.emit).toHaveBeenCalledWith('tool.completed', {
      type: 'tool.completed',
      interactionId: 'voice-1',
      tool: 'weather',
      error: undefined,
    })
    localSocket.__handlers.get('run.completed')?.({
      output: '结果如下：\n| 名称 | 值 |\n| --- | --- |\n| foo | 1 |\n请确认。\n',
    })

    await waitForMockCalls(fetchImpl, 2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      text: '结果如下： 请确认。',
    })
    expect(agentSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
      segmentId: 'voice-1-tts-2',
    }))
    expect(agentSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({
      interactionId: 'voice-1',
      status: 'completed',
    }))
    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-1',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'audio.enqueue' && (payload as { segmentId?: string })?.segmentId === 'voice-1-tts-2',
    )
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-2',
      text: '结果如下： 请确认。',
      url: expect.stringMatching(/^\/api\/studio\/mcu\/audio\/[a-f0-9-]+\.adpcm$/),
      completionManagedByServer: true,
    }))
    expect(agentSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({
      interactionId: 'voice-1',
      status: 'completed',
    }))
    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'voice-1',
      segmentId: 'voice-1-tts-2',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'interaction.status' && (payload as { status?: string })?.status === 'completed',
    )
  })

  it('keeps MCU background work non-blocking and speaks only the final autonomous agent response', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-background',
      transcript: '后台查询天气',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket, 'run-parent')
    localSocket.__handlers.get('delegation.updated')?.({
      delegation_id: 'delegation-1',
      status: 'running',
      background_pending: 1,
    })
    localSocket.__handlers.get('run.completed')?.({
      run_id: 'run-parent',
      output: '',
      background_pending: 1,
    })

    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'interaction.status'
      && (payload as { interactionId?: string; status?: string })?.interactionId === 'voice-background'
      && (payload as { status?: string })?.status === 'completed',
    )
    expect(localSocket.disconnect).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()

    agentSocket.emit.mockClear()
    localSocket.__handlers.get('run.started')?.({
      run_id: 'run-background-delivery',
      autonomous: true,
      delegation_id: 'delegation-1',
    })
    localSocket.__handlers.get('message.delta')?.({
      run_id: 'run-background-delivery',
      delta: '厦门明天晴，最高温度 30 度。',
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(agentSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({ status: 'thinking' }))
    expect(agentSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.anything())

    localSocket.__handlers.get('run.completed')?.({
      run_id: 'run-background-delivery',
      autonomous: true,
      delegation_id: 'delegation-1',
      output: '厦门明天晴，最高温度 30 度。',
      background_pending: 0,
    })

    await waitForMockCalls(fetchImpl, 1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({
      text: '厦门明天晴，最高温度 30 度。',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'audio.enqueue'
      && (payload as { interactionId?: string })?.interactionId === 'mcu-background-delegation-1',
    )
    expect(agentSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
      interactionId: 'mcu-background-delegation-1',
      segmentId: 'mcu-background-delegation-1-tts-1',
      text: '厦门明天晴，最高温度 30 度。',
      completionManagedByServer: true,
    }))
    expect(localSocket.disconnect).toHaveBeenCalled()

    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'mcu-background-delegation-1',
      segmentId: 'mcu-background-delegation-1-tts-1',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'interaction.status'
      && (payload as { interactionId?: string; status?: string })?.interactionId === 'mcu-background-delegation-1'
      && (payload as { status?: string })?.status === 'completed',
    )
  })

  it('does not abort idle background work when a new MCU recording starts', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, { localBaseUrl: 'http://127.0.0.1:8647' })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-parent',
      transcript: '启动后台任务',
      clientId: 'device-1',
    })
    const parentSocket = clientSocketMocks.localSockets.at(-1)
    parentSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(parentSocket, 'run-parent')
    parentSocket.__handlers.get('run.completed')?.({
      run_id: 'run-parent',
      output: '',
      background_pending: 1,
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'interaction.status'
      && (payload as { interactionId?: string; status?: string })?.interactionId === 'voice-parent'
      && (payload as { status?: string })?.status === 'completed',
    )

    agentSocket.__handlers.get('mcu.interrupt')?.({
      interactionId: 'voice-parent',
      profile: 'research',
    })
    await new Promise(resolve => setTimeout(resolve, 320))
    expect(parentSocket.emit).not.toHaveBeenCalledWith('abort', { session_id: 'mcu-device-1-research-ekko' })

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-follow-up',
      transcript: '继续聊另一个问题',
      clientId: 'device-1',
    })
    const followUpSocket = clientSocketMocks.localSockets.at(-1)
    followUpSocket.__handlers.get('connect')?.()

    expect(parentSocket.disconnect).not.toHaveBeenCalled()
    expect(followUpSocket.emit).not.toHaveBeenCalledWith('abort', { session_id: 'mcu-device-1-research-ekko' })
    expect(followUpSocket.emit).toHaveBeenCalledWith('run', expect.objectContaining({
      input: '继续聊另一个问题',
      session_id: 'mcu-device-1-research-ekko',
    }))
  })

  it('isolates a queued MCU voice turn from a background result returning on the same session', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('pcm-audio'), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-parent',
      transcript: '启动后台任务',
      clientId: 'device-1',
    })
    const parentSocket = clientSocketMocks.localSockets.at(-1)
    parentSocket.__handlers.get('connect')?.()
    const parentQueueId = startPrimaryMockRun(parentSocket, 'run-parent')
    parentSocket.__handlers.get('run.completed')?.({
      run_id: 'run-parent',
      queue_id: parentQueueId,
      output: '',
      background_pending: 1,
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) => (
      event === 'interaction.status'
      && (payload as { interactionId?: string; status?: string })?.interactionId === 'voice-parent'
      && (payload as { status?: string })?.status === 'completed'
    ))

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-follow-up',
      transcript: '继续问一个问题',
      clientId: 'device-1',
    })
    const followUpSocket = clientSocketMocks.localSockets.at(-1)
    followUpSocket.__handlers.get('connect')?.()
    const followUpRun = followUpSocket.emit.mock.calls
      .filter(([event]: [string]) => event === 'run')
      .at(-1)?.[1]
    const followUpQueueId = followUpRun?.queue_id
    expect(followUpQueueId).toMatch(/^mcu_/)
    followUpSocket.__handlers.get('run.queued')?.({
      queued_messages: [{ id: followUpQueueId }],
    })
    expect(parentSocket.disconnect).not.toHaveBeenCalled()

    const autonomousStarted = {
      run_id: 'run-background-delivery',
      queue_id: 'delegation_delegation-1',
      autonomous: true,
      delegation_id: 'delegation-1',
    }
    parentSocket.__handlers.get('run.started')?.(autonomousStarted)
    followUpSocket.__handlers.get('run.started')?.(autonomousStarted)
    parentSocket.__handlers.get('message.delta')?.({ delta: '后台结果。' })
    followUpSocket.__handlers.get('message.delta')?.({ delta: '后台结果。' })
    const autonomousCompleted = {
      ...autonomousStarted,
      output: '后台结果。',
      background_pending: 0,
    }
    parentSocket.__handlers.get('run.completed')?.(autonomousCompleted)
    followUpSocket.__handlers.get('run.completed')?.(autonomousCompleted)

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(parentSocket.disconnect).toHaveBeenCalled()
    expect(followUpSocket.disconnect).not.toHaveBeenCalled()

    followUpSocket.__handlers.get('run.started')?.({
      run_id: 'run-follow-up',
      queue_id: followUpQueueId,
    })
    followUpSocket.__handlers.get('run.completed')?.({
      run_id: 'run-follow-up',
      queue_id: followUpQueueId,
      output: '',
      background_pending: 0,
    })

    await waitForMockCalls(fetchImpl, 1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toMatchObject({ text: '后台结果。' })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) => (
      event === 'interaction.status'
      && (payload as { interactionId?: string; status?: string })?.interactionId === 'voice-follow-up'
      && (payload as { status?: string })?.status === 'completed'
    ))
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) => (
      event === 'audio.enqueue'
      && (payload as { interactionId?: string })?.interactionId === 'mcu-background-delegation-1'
    ))
    expect(agentSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({
      interactionId: 'voice-follow-up',
      status: 'failed',
    }))

    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'mcu-background-delegation-1',
      segmentId: 'mcu-background-delegation-1-tts-1',
    })
  })

  it('starts later MCU TTS synthesis early but triggers MCU playback one segment at a time', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    let resolveFirstTts: ((response: Response) => void) | undefined
    const firstTts = new Promise<Response>((resolve) => {
      resolveFirstTts = resolve
    })
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'))
      if (body.text === '第一句。') return firstTts
      return new Response(Buffer.from([2, 0, 2, 0]), {
        status: 200,
        headers: { 'Content-Type': 'audio/x-pcm' },
      })
    })
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-pipeline',
      transcript: 'hi',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket)
    localSocket.__handlers.get('message.delta')?.({ delta: '第一句。\n' })
    await waitForMockCalls(fetchImpl, 1)
    localSocket.__handlers.get('message.delta')?.({ delta: '第二句。\n' })
    localSocket.__handlers.get('run.completed')?.({})
    await waitForMockCalls(fetchImpl, 2)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toMatchObject({
      text: '第二句。',
    })
    expect(agentSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.any(Object))

    resolveFirstTts?.(new Response(Buffer.from([1, 0, 1, 0]), {
      status: 200,
      headers: { 'Content-Type': 'audio/x-pcm' },
    }))

    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'audio.enqueue' && (payload as { segmentId?: string })?.segmentId === 'voice-pipeline-tts-1',
    )
    const segmentIds = agentSocket.emit.mock.calls
      .filter(([event]: [string]) => event === 'audio.enqueue')
      .map(([, payload]: [string, { segmentId: string }]) => payload.segmentId)
    expect(segmentIds).toEqual(['voice-pipeline-tts-1'])

    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'voice-pipeline',
      segmentId: 'voice-pipeline-tts-1',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'audio.enqueue' && (payload as { segmentId?: string })?.segmentId === 'voice-pipeline-tts-2',
    )
    const segmentIdsAfterFirstDone = agentSocket.emit.mock.calls
      .filter(([event]: [string]) => event === 'audio.enqueue')
      .map(([, payload]: [string, { segmentId: string }]) => payload.segmentId)
    expect(segmentIdsAfterFirstDone).toEqual(['voice-pipeline-tts-1', 'voice-pipeline-tts-2'])

    agentSocket.__handlers.get('audio.done')?.({
      interactionId: 'voice-pipeline',
      segmentId: 'voice-pipeline-tts-2',
    })
    await waitForMockCallWith(agentSocket.emit, ([event, payload]) =>
      event === 'interaction.status' && (payload as { status?: string })?.status === 'completed',
    )
  })

  it('aborts in-flight MCU TTS synthesis when the device interrupts playback', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    let ttsSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      ttsSignal = init?.signal || undefined
      return await new Promise<Response>((_resolve, reject) => {
        ttsSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, {
      fetchImpl: fetchImpl as any,
      localBaseUrl: 'http://127.0.0.1:8647',
    })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-abort',
      transcript: 'hi',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket)
    localSocket.__handlers.get('message.delta')?.({ delta: '这段正在合成。\n' })

    await waitForMockCalls(fetchImpl, 1)
    expect(ttsSignal?.aborted).toBe(false)

    agentSocket.__handlers.get('audio.interrupted')?.({
      interactionId: 'voice-abort',
      segmentId: 'voice-abort-tts-1',
    })

    await vi.waitFor(() => {
      expect(ttsSignal?.aborted).toBe(true)
    })
    expect(localSocket.emit).toHaveBeenCalledWith('abort', { session_id: 'mcu-device-1-research-ekko' })
    expect(agentSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.anything())
  })

  it('auto-approves MCU chat-run approval requests using the same choice order as the client relay', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any, { localBaseUrl: 'http://127.0.0.1:8647' })
    server.init()

    const agentSocket = createMockSocket('jwt-agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    server.startMcuVoiceChatTurn({
      userToken: 'user-jwt',
      profile: 'research',
      interactionId: 'voice-1',
      transcript: '查天气',
      clientId: 'device-1',
    })
    const localSocket = clientSocketMocks.localSockets.at(-1)
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket)
    localSocket.__handlers.get('approval.requested')?.({
      approval_id: 'approval-1',
      choices: ['once', 'session', 'deny'],
    })

    expect(agentSocket.emit).toHaveBeenCalledWith('tool.started', {
      type: 'tool.started',
      interactionId: 'voice-1',
      tool: 'approval',
    })
    expect(localSocket.emit).toHaveBeenCalledWith('approval.respond', {
      session_id: 'mcu-device-1-research-ekko',
      approval_id: 'approval-1',
      choice: 'session',
    })

    localSocket.__handlers.get('approval.resolved')?.({ resolved: true })
    expect(agentSocket.emit).toHaveBeenCalledWith('tool.completed', {
      type: 'tool.completed',
      interactionId: 'voice-1',
      tool: 'approval',
      error: undefined,
    })
    localSocket.__handlers.get('tool.failed')?.({
      tool: 'weather',
      preview: '不应转发给 MCU 的失败结果'.repeat(1_000),
      error: '不应转发给 MCU 的错误详情'.repeat(1_000),
    })
    expect(agentSocket.emit).toHaveBeenCalledWith('tool.completed', {
      type: 'tool.completed',
      interactionId: 'voice-1',
      tool: 'weather',
      error: 'tool.failed',
    })
    localSocket.__handlers.get('run.failed')?.({ error: 'done' })
  })

  it('does not forward reserved Socket.IO lifecycle events to frontend clients', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', { token: server.getAuthToken(), instanceId: 'local-global-agent' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const frontendSocket = createMockSocket('frontend-socket', { token: 'frontend-jwt', profile: 'research' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](frontendSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(frontendSocket)

    const bridgeId = 'frontend:frontend-socket:chat-run'
    const openAck = vi.fn()
    frontendSocket.__handlers.get('socket.open')?.({
      id: bridgeId,
      namespace: '/chat-run',
      clientId: 'local-global-agent',
    }, openAck)
    await new Promise(resolve => setTimeout(resolve, 0))
    frontendSocket.emit.mockClear()

    agentSocket.__handlers.get('socket.event')?.({
      id: bridgeId,
      namespace: '/chat-run',
      event: 'connect',
      payload: { socketId: 'local-chat-run' },
    })
    expect(frontendSocket.emit).not.toHaveBeenCalledWith('connect', expect.anything())

    agentSocket.__handlers.get('socket.event')?.({
      id: bridgeId,
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 's1', delta: 'hi' },
    })
    expect(frontendSocket.emit).toHaveBeenCalledWith('message.delta', { session_id: 's1', delta: 'hi' })

    agentSocket.__handlers.get('socket.event')?.({
      id: bridgeId,
      namespace: '/chat-run',
      event: 'run.queue_insertion.updated',
      payload: {
        session_id: 's1', queue_id: 'q1', phase: 'waiting_for_tool_batch', guarantee: 'strict',
      },
    })
    expect(frontendSocket.emit).toHaveBeenCalledWith('run.queue_insertion.updated', {
      session_id: 's1', queue_id: 'q1', phase: 'waiting_for_tool_batch', guarantee: 'strict',
    })
  })

  it('broadcasts MCU session clears as chat session commands for frontend clients', async () => {
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    const frontendSocket = createMockSocket('frontend-socket', { token: 'frontend-jwt', profile: 'research' })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](frontendSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(frontendSocket)

    agentSocket.__handlers.get('mcu.session.clear')?.({
      interactionId: 'clear-1',
      profile: 'research',
    })

    expect(chatRunMocks.clearSessionHistory).toHaveBeenCalledWith('mcu-device-1-research-ekko')
    expect(agentSocket.emit).toHaveBeenCalledWith('mcu.session.cleared', expect.objectContaining({
      type: 'mcu.session.cleared',
      interactionId: 'clear-1',
      profile: 'research',
      sessionId: 'mcu-device-1-research-ekko',
      deleted: 2,
      memoryCleared: true,
    }))
    expect(frontendSocket.emit).toHaveBeenCalledWith('session.command', {
      event: 'session.command',
      session_id: 'mcu-device-1-research-ekko',
      command: 'clear',
      action: 'clear',
      clearHistory: true,
      ok: true,
      deleted: 2,
      memoryCleared: true,
    })
  })

  it('still aborts an active foreground run when MCU starts listening again', async () => {
    vi.useFakeTimers()
    try {
      authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
      authMocks.userCanAccessProfile.mockReturnValue(true)
      const nsp = createMockNamespace()
      const io = { of: vi.fn(() => nsp) }
      const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

      const server = new GlobalAgentServer(io as any)
      server.init()
      const agentSocket = createMockSocket('agent-socket', {
        token: 'user-jwt',
        role: 'hermes-studio',
        instanceId: 'device-1',
        profile: 'research',
      })
      await new Promise<void>((resolve, reject) => {
        nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
      })
      nsp.__handlers.get('connection')?.(agentSocket)

      const runSocket = { emit: vi.fn() }
      ;(server as any).mcuSessionRuns.set('mcu-device-1-research-ekko', {
        interactionId: 'run-1',
        socket: runSocket,
      })

      agentSocket.__handlers.get('mcu.interrupt')?.({
        interactionId: 'run-1',
        profile: 'research',
      })
      await vi.advanceTimersByTimeAsync(300)

      expect(runSocket.emit).toHaveBeenCalledWith('abort', { session_id: 'mcu-device-1-research-ekko' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a pending MCU interrupt when session clear arrives in the double-click window', async () => {
    vi.useFakeTimers()
    try {
      authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
      authMocks.userCanAccessProfile.mockReturnValue(true)
      const nsp = createMockNamespace()
      const io = { of: vi.fn(() => nsp) }
      const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

      const server = new GlobalAgentServer(io as any)
      server.init()

      const agentSocket = createMockSocket('agent-socket', {
        token: 'user-jwt',
        role: 'hermes-studio',
        instanceId: 'device-1',
        profile: 'research',
      })
      await new Promise<void>((resolve, reject) => {
        nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
      })
      nsp.__handlers.get('connection')?.(agentSocket)

      const runSocket = { emit: vi.fn() }
      ;(server as any).mcuSessionRuns.set('mcu-device-1-research-ekko', {
        interactionId: 'run-1',
        socket: runSocket,
      })

      agentSocket.__handlers.get('mcu.interrupt')?.({
        interactionId: 'run-1',
        profile: 'research',
      })
      expect(runSocket.emit).not.toHaveBeenCalled()

      agentSocket.__handlers.get('mcu.session.clear')?.({
        interactionId: 'clear-1',
        profile: 'research',
      })

      await vi.advanceTimersByTimeAsync(300)

      expect(runSocket.emit).not.toHaveBeenCalled()
      expect(chatRunMocks.clearSessionHistory).toHaveBeenCalledWith('mcu-device-1-research-ekko')
      expect(agentSocket.emit).toHaveBeenCalledWith('mcu.session.cleared', expect.objectContaining({
        type: 'mcu.session.cleared',
        interactionId: 'clear-1',
        profile: 'research',
        sessionId: 'mcu-device-1-research-ekko',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not silently clear only the database when chat-run memory is unavailable', async () => {
    chatRunMocks.getChatRunServer.mockReturnValue(null)
    authMocks.authenticateUserToken.mockResolvedValue({ id: 7, username: 'ada', role: 'user' })
    authMocks.userCanAccessProfile.mockReturnValue(true)
    const nsp = createMockNamespace()
    const io = { of: vi.fn(() => nsp) }
    const { GlobalAgentServer } = await import('../../packages/server/src/modules/studio/sockets/global-agent')

    const server = new GlobalAgentServer(io as any)
    server.init()

    const agentSocket = createMockSocket('agent-socket', {
      token: 'user-jwt',
      role: 'hermes-studio',
      instanceId: 'device-1',
      profile: 'research',
    })
    await new Promise<void>((resolve, reject) => {
      nsp.__middleware[0](agentSocket, (err?: Error) => err ? reject(err) : resolve())
    })
    nsp.__handlers.get('connection')?.(agentSocket)

    agentSocket.__handlers.get('mcu.session.clear')?.({
      interactionId: 'clear-1',
      profile: 'research',
    })

    expect(chatRunMocks.clearSessionHistory).not.toHaveBeenCalled()
    expect(agentSocket.emit).toHaveBeenCalledWith('mcu.session.cleared', expect.objectContaining({
      type: 'mcu.session.cleared',
      sessionId: 'mcu-device-1-research-ekko',
      ok: false,
      error: 'chat_run_server_unavailable',
    }))
  })
})
