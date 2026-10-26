import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MCU_VOICE_SYSTEM_INSTRUCTIONS } from '../../packages/server/src/modules/studio/services/global-agent/mcu-voice-instructions'

const { mockIo, mockSocket, sockets, socketHandlers, mockWebSockets, MockWebSocket, resetMockSockets } = vi.hoisted(() => {
  function createMockSocket(id: string, url = '') {
    const handlers = new Map<string, (...args: any[]) => void>()
    const anyHandlers: Array<(event: string, ...args: any[]) => void> = []
    const socket: any = {
      id,
      __url: url,
      connected: false,
      io: { opts: {} },
      __handlers: handlers,
      __anyHandlers: anyHandlers,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, (...args: any[]) => {
          if (event === 'connect') socket.connected = true
          if (event === 'disconnect') socket.connected = false
          return handler(...args)
        })
        return socket
      }),
      onAny: vi.fn((handler: (event: string, ...args: any[]) => void) => {
        anyHandlers.push(handler)
        return socket
      }),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(() => {
        socket.connected = false
      }),
    }
    socket.volatile = socket
    return socket
  }

  const sockets: any[] = []
  const mockSocket: any = createMockSocket('socket-1')
  const socketHandlers = mockSocket.__handlers as Map<string, (...args: any[]) => void>
  const mockIo = vi.fn((url = '') => {
    const socket = sockets.length === 0 ? mockSocket : createMockSocket(`socket-${sockets.length + 1}`, url)
    socket.__url = url
    sockets.push(socket)
    return socket
  })
  const resetMockSockets = () => {
    sockets.length = 0
    mockSocket.__handlers.clear()
    mockSocket.__anyHandlers.length = 0
    mockWebSockets.length = 0
  }

  const mockWebSockets: any[] = []
  class MockWebSocket {
    static OPEN = 1
    readyState = MockWebSocket.OPEN
    __handlers = new Map<string, (...args: any[]) => void>()
    send = vi.fn()
    close = vi.fn()

    constructor(public url: string) {
      mockWebSockets.push(this)
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.__handlers.set(event, handler)
      return this
    }
  }

  return {
    socketHandlers,
    sockets,
    mockSocket,
    mockIo,
    mockWebSockets,
    MockWebSocket,
    resetMockSockets,
  }
})

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('ws', () => ({
  default: MockWebSocket,
}))

describe('outbound relay client', () => {
  beforeEach(async () => {
    const { stopOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    stopOutboundRelayClient()
    resetMockSockets()
    vi.clearAllMocks()
  })

  function connectRemoteSocket() {
    const socket = sockets[0]
    socket.__handlers.get('connect')?.()
    return socket
  }

  function emitRemote(socket: any, event: string, payload: unknown) {
    const authorizedPayload = payload && typeof payload === 'object' && !Array.isArray(payload) && event !== 'mcu.auth.ok' && event !== 'relay.replaced'
      ? { apiToken: 'user-jwt', ...(payload as Record<string, unknown>) }
      : payload
    for (const handler of socket.__anyHandlers) {
      handler(event, authorizedPayload)
    }
  }

  function findEmittedPayload(socket: any, event: string, predicate: (payload: any) => boolean = () => true) {
    return socket.emit.mock.calls
      .filter(([eventName]: [string]) => eventName === event)
      .map(([, payload]: [string, any]) => payload)
      .find(predicate)
  }

  function socketForUrl(url: string) {
    return sockets.find(socket => socket.__url === url)
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

  function startHermesPrimaryMockRun(socket: any, runId = 'run-primary'): string {
    const runCall = socket.emit.mock.calls
      .filter(([event]: [string]) => event === 'run')
      .at(-1)
    expect(runCall?.[1]).toMatchObject({
      session_id: 'mcu-device-research-hermes',
      source: 'global_agent',
      session_source: 'global_agent',
      instructions: MCU_VOICE_SYSTEM_INSTRUCTIONS,
    })
    expect(runCall?.[1]).not.toHaveProperty('coding_agent_id')
    const queueId = runCall?.[1]?.queue_id
    expect(queueId).toMatch(/^mcu_/)
    socket.__handlers.get('run.started')?.({ run_id: runId, queue_id: queueId })
    return queueId
  }

  it('stays disabled when no relay url is passed explicitly', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    const client = startOutboundRelayClient({ relayUrl: '' })

    expect(client).toBeNull()
    expect(mockIo).not.toHaveBeenCalled()
  })

  it('connects to the configured remote relay as a socket client', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    const client = startOutboundRelayClient({
      relayUrl: 'https://user:pass@relay.example.com/hermes',
      relayToken: 'relay-token',
      instanceId: 'studio-1',
      localBaseUrl: 'http://127.0.0.1:9999',
      fetchImpl: vi.fn() as any,
    })

    expect(client).not.toBeNull()
    expect(mockIo).toHaveBeenCalledWith('https://user:pass@relay.example.com/hermes', expect.objectContaining({
      auth: {
        token: 'relay-token',
        instanceId: 'studio-1',
        role: 'hermes-studio',
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
    }))

    socketHandlers.get('connect')?.()
    expect(mockSocket.emit).toHaveBeenCalledWith('relay.ready', {
      capabilities: ['http.request', 'socket.chat-run'],
      instanceId: 'studio-1',
    })
  })

  it('queues missing-STT prompt audio from Socket.IO MCU voice turns', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      audio: {
        text: 'STT is not configured',
        url: 'https://cdn.example.com/missing-stt.pcm',
        mimeType: 'audio/x-pcm',
        sampleRate: 16000,
        channels: 2,
        durationMs: 1800,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'http://device.local:8787/',
      relayProtocol: 'mcu-socket.io',
      userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    expect(mockIo).toHaveBeenCalledWith('http://device.local:8787/global-agent', expect.objectContaining({
      auth: expect.objectContaining({
        clientRole: 'web',
        relayRole: 'web',
      }),
    }))
    const remoteSocket = connectRemoteSocket()
    emitRemote(remoteSocket, 'voice.recorded', {
      type: 'voice.recorded',
      interactionId: 'voice-1',
      mimeType: 'audio/wav',
      profile: 'default',
    })
    emitRemote(remoteSocket, 'voice.stream.chunk', {
      type: 'voice.stream.chunk',
      data: Buffer.from('wav-audio').toString('base64'),
    })

    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.any(Object))
    })
    const enqueuePayload = findEmittedPayload(remoteSocket, 'audio.enqueue')
    expect(enqueuePayload).toMatchObject({
      type: 'audio.enqueue',
      interactionId: 'voice-1',
      segmentId: 'voice-1-prompt',
      text: 'STT is not configured',
      url: 'https://cdn.example.com/missing-stt.pcm',
      mimeType: 'audio/x-pcm',
      channels: 2,
      sampleRate: 16000,
    })
    expect(enqueuePayload).not.toHaveProperty('completionManagedByServer')

    emitRemote(remoteSocket, 'audio.done', {
      type: 'audio.done',
      segmentId: 'voice-1-prompt',
    })
    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('interaction.status', expect.objectContaining({
        status: 'completed',
      }))
    })
  })

  it('does not reconnect the Socket.IO relay client after it is replaced remotely', async () => {
    vi.useFakeTimers()
    try {
      const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

      startOutboundRelayClient({
        relayUrl: 'http://relay.example.com',
        relayProtocol: 'mcu-socket.io',
        userToken: 'user-jwt',
        deviceCode: 'device-code-1',
        localBaseUrl: 'http://127.0.0.1:8648',
        fetchImpl: vi.fn() as any,
      })

      const remoteSocket = connectRemoteSocket()
      const localSocket = sockets[1]

      emitRemote(remoteSocket, 'relay.replaced', {
        type: 'relay.replaced',
        deviceCode: 'device-code-1',
        role: 'web',
      })
      remoteSocket.__handlers.get('disconnect')?.('io server disconnect')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(localSocket.disconnect).toHaveBeenCalled()
      expect(sockets).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reconnect the Socket.IO relay client after device-code auth is rejected', async () => {
    vi.useFakeTimers()
    try {
      const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

      startOutboundRelayClient({
        relayUrl: 'http://relay.example.com',
        relayProtocol: 'mcu-socket.io',
        deviceCode: 'device-code-1',
        localBaseUrl: 'http://127.0.0.1:8648',
        fetchImpl: vi.fn() as any,
      })

      const remoteSocket = sockets[0]
      remoteSocket.__handlers.get('connect_error')?.(new Error('非官方设备码'))
      await vi.advanceTimersByTimeAsync(60_000)

      expect(sockets).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bridges Socket.IO MCU voice streams to the local global-agent server without completing early', async () => {
    const fetchImpl = vi.fn()
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'http://device.local:8787',
      relayProtocol: 'mcu-socket.io',
      userToken: 'user-jwt',
      instanceId: 'mcu-1',
      deviceCode: 'device-code-1',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const remoteSocket = connectRemoteSocket()
    const localGlobalAgentSocket = sockets.at(-1)
    expect(mockIo).toHaveBeenCalledWith('http://127.0.0.1:8648/global-agent', expect.objectContaining({
      auth: expect.objectContaining({
        token: 'user-jwt',
        role: 'hermes-studio',
        instanceId: 'mcu-1',
      }),
    }))

    emitRemote(remoteSocket, 'voice.stream.start', {
      type: 'voice.stream.start',
      interactionId: 'voice-stream-1',
      agentRuntime: 'hermes',
      mimeType: 'audio/x-ima-adpcm',
      frameFormat: 'hadp-chunk-v1',
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      profile: 'default',
    })
    emitRemote(remoteSocket, 'voice.stream.chunk', {
      type: 'voice.stream.chunk',
      data: Buffer.from([1, 2, 3, 4]).toString('base64'),
    })
    emitRemote(remoteSocket, 'voice.stream.end', {
      type: 'voice.stream.end',
      interactionId: 'voice-stream-1',
      bytes: 4,
    })

    expect(localGlobalAgentSocket.emit).toHaveBeenCalledWith('voice.stream.start', expect.objectContaining({
      type: 'voice.stream.start',
      interactionId: 'voice-stream-1',
      mimeType: 'audio/x-ima-adpcm',
      frameFormat: 'hadp-chunk-v1',
      profile: 'default',
      agentRuntime: 'hermes',
    }))
    expect(localGlobalAgentSocket.emit).toHaveBeenCalledWith('voice.stream.chunk', expect.objectContaining({
      interactionId: 'voice-stream-1',
      offset: 0,
      bytes: 4,
      data: Buffer.from([1, 2, 3, 4]),
    }))
    expect(localGlobalAgentSocket.emit).toHaveBeenCalledWith('voice.stream.end', expect.objectContaining({
      type: 'voice.stream.end',
      interactionId: 'voice-stream-1',
      bytes: 4,
    }))
    expect(fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining('/api/studio/mcu/voice-turn'), expect.any(Object))
    expect(remoteSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({ status: 'completed' }))

    localGlobalAgentSocket.__anyHandlers[0]('interaction.status', {
      type: 'interaction.status',
      interactionId: 'voice-stream-1',
      status: 'thinking',
      text: '你好',
    })
    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('interaction.status', expect.objectContaining({
        status: 'thinking',
      }))
    })
  })

  it('preserves local MCU audio enqueue order while uploading audio to the relay', async () => {
    let uploadCount = 0
    let releaseFirstUpload: (() => void) | undefined
    const firstUploadStarted = new Promise<void>((resolve) => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('/api/studio/mcu/audio/slow.pcm')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'content-type': 'audio/x-pcm' },
          })
        }
        if (url.includes('/api/studio/mcu/audio/fast.pcm')) {
          return new Response(new Uint8Array([4, 5, 6]), {
            status: 200,
            headers: { 'content-type': 'audio/x-pcm' },
          })
        }
        if (url === 'http://device.local:8787/global-agent/audio') {
          uploadCount += 1
          const uploadIndex = uploadCount
          if (uploadIndex === 1) {
            resolve()
            await new Promise<void>((release) => {
              releaseFirstUpload = release
            })
          }
          return new Response(JSON.stringify({
            ok: true,
            url: `http://device.local:8787/global-agent/audio/audio-${uploadIndex}?token=download-token`,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      })

      void import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client').then(({ startOutboundRelayClient }) => {
        startOutboundRelayClient({
          relayUrl: 'http://device.local:8787',
          relayProtocol: 'mcu-socket.io',
          userToken: 'user-jwt',
          instanceId: 'mcu-1',
          deviceCode: 'device-code-1',
          localBaseUrl: 'http://127.0.0.1:8648',
          fetchImpl: fetchImpl as any,
        })
      })
    })

    await vi.waitFor(() => {
      expect(sockets.length).toBeGreaterThan(0)
    })
    const remoteSocket = connectRemoteSocket()
    emitRemote(remoteSocket, 'mcu.auth.ok', {
      type: 'mcu.auth.ok',
      audioUpload: {
        url: '/global-agent/audio',
        token: 'upload-token',
      },
    })
    emitRemote(remoteSocket, 'voice.stream.start', {
      type: 'voice.stream.start',
      interactionId: 'voice-order',
      profile: 'default',
    })
    const localGlobalAgentSocket = sockets.at(-1)

    localGlobalAgentSocket.__anyHandlers[0]('audio.enqueue', {
      type: 'audio.enqueue',
      interactionId: 'voice-order',
      segmentId: 'voice-order-tts-1',
      url: '/api/studio/mcu/audio/slow.pcm',
    })
    localGlobalAgentSocket.__anyHandlers[0]('audio.enqueue', {
      type: 'audio.enqueue',
      interactionId: 'voice-order',
      segmentId: 'voice-order-tts-2',
      url: '/api/studio/mcu/audio/fast.pcm',
    })

    await firstUploadStarted
    expect(remoteSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.any(Object))
    releaseFirstUpload?.()

    await vi.waitFor(() => {
      const enqueues = remoteSocket.emit.mock.calls.filter(([event]: [string]) => event === 'audio.enqueue')
      expect(enqueues).toHaveLength(2)
    })
    const segmentIds = remoteSocket.emit.mock.calls
      .filter(([event]: [string]) => event === 'audio.enqueue')
      .map(([, payload]: [string, { segmentId: string }]) => payload.segmentId)
    expect(segmentIds).toEqual(['voice-order-tts-1', 'voice-order-tts-2'])
  })

  it('uploads Socket.IO MCU TTS audio to the remote relay before enqueueing playback', async () => {
    const pcm = Buffer.from('pcm-audio')
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/studio/mcu/voice-turn')) {
        return new Response(JSON.stringify({ ok: true, transcript: '你好' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/studio/tts/synthesize')) {
        return new Response(pcm, {
          status: 200,
          headers: { 'content-type': 'audio/x-pcm' },
        })
      }
      if (url === 'http://device.local:8787/global-agent/audio') {
        return new Response(JSON.stringify({
          ok: true,
          url: 'http://device.local:8787/global-agent/audio/audio-1?token=download-token',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'unexpected url' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    })
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'http://device.local:8787',
      relayProtocol: 'mcu-socket.io',
      userToken: 'user-jwt',
      deviceCode: 'device-code-1',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const remoteSocket = connectRemoteSocket()
    emitRemote(remoteSocket, 'mcu.auth.ok', {
      type: 'mcu.auth.ok',
      audioUpload: {
        url: '/global-agent/audio',
        token: 'upload-token',
      },
    })
    emitRemote(remoteSocket, 'voice.recorded', {
      type: 'voice.recorded',
      interactionId: 'voice-tts-ok',
      mimeType: 'audio/wav',
      profile: 'research',
      agentRuntime: 'hermes',
    })
    emitRemote(remoteSocket, 'voice.stream.chunk', {
      type: 'voice.stream.chunk',
      data: Buffer.from('wav-audio').toString('base64'),
    })

    await vi.waitFor(() => {
      expect(socketForUrl('http://127.0.0.1:8648/chat-run')).toBeTruthy()
    })
    const localSocket = socketForUrl('http://127.0.0.1:8648/chat-run')
    localSocket.__handlers.get('connect')?.()
    startHermesPrimaryMockRun(localSocket)
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      'X-Hermes-Mcu-Agent-Runtime': 'hermes',
    })
    localSocket.__handlers.get('message.delta')?.({ delta: '我来查一下。\n' })
    localSocket.__handlers.get('tool.started')?.({
      tool: 'weather',
      preview: 'tool arguments must stay local'.repeat(1_000),
    })
    localSocket.__handlers.get('tool.completed')?.({
      tool: 'weather',
      preview: 'tool result must stay local'.repeat(1_000),
    })
    expect(remoteSocket.emit).toHaveBeenCalledWith('tool.started', {
      type: 'tool.started',
      interactionId: 'voice-tts-ok',
      tool: 'weather',
    })
    expect(remoteSocket.emit).toHaveBeenCalledWith('tool.completed', {
      type: 'tool.completed',
      interactionId: 'voice-tts-ok',
      tool: 'weather',
      error: undefined,
    })
    localSocket.__handlers.get('run.completed')?.({ output: '厦门今天晴。' })

    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
        text: '我来查一下。',
        url: 'http://device.local:8787/global-agent/audio/audio-1?token=download-token',
      }))
    })
    emitRemote(remoteSocket, 'audio.done', {
      type: 'audio.done',
      interactionId: 'voice-tts-ok',
      segmentId: 'voice-tts-ok-tts-1',
    })
    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
        interactionId: 'voice-tts-ok',
        segmentId: 'voice-tts-ok-tts-2',
        text: '厦门今天晴。',
      }))
    })
    const uploadCall = fetchImpl.mock.calls.find(([url]: [string]) => url === 'http://device.local:8787/global-agent/audio')
    expect(uploadCall).toBeTruthy()
    expect(uploadCall?.[1].headers).toMatchObject({
      Authorization: 'Bearer upload-token',
      'Content-Type': 'audio/x-ima-adpcm',
      'X-Device-Code': 'device-code-1',
      'X-Audio-Sample-Rate': '24000',
      'X-Audio-Channels': '1',
    })
    expect(uploadCall?.[1].body).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(uploadCall?.[1].body as Uint8Array).subarray(0, 4).toString('ascii')).toBe('HADP')
  })

  it('keeps direct relay background work non-blocking and sends only the final autonomous agent response', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/studio/mcu/voice-turn')) {
        return new Response(JSON.stringify({ ok: true, transcript: '后台查询天气' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url.includes('/api/studio/tts/synthesize')) {
        return new Response(Buffer.from('pcm-audio'), {
          status: 200,
          headers: { 'content-type': 'audio/x-pcm' },
        })
      }
      return new Response('not found', { status: 404 })
    })
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'http://device.local:8787',
      relayProtocol: 'mcu-socket.io',
      userToken: 'user-jwt',
      deviceCode: 'device-code-1',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const remoteSocket = connectRemoteSocket()
    emitRemote(remoteSocket, 'voice.recorded', {
      type: 'voice.recorded',
      interactionId: 'voice-background',
      mimeType: 'audio/wav',
      profile: 'research',
    })
    emitRemote(remoteSocket, 'voice.stream.chunk', {
      type: 'voice.stream.chunk',
      data: Buffer.from('wav-audio').toString('base64'),
    })

    await vi.waitFor(() => {
      expect(socketForUrl('http://127.0.0.1:8648/chat-run')).toBeTruthy()
    })
    const localSocket = socketForUrl('http://127.0.0.1:8648/chat-run')
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

    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('interaction.status', expect.objectContaining({
        interactionId: 'voice-background',
        status: 'completed',
      }))
    })
    expect(localSocket.disconnect).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls.filter(([url]: [string]) => url.includes('/api/studio/tts/synthesize'))).toHaveLength(0)

    remoteSocket.emit.mockClear()
    localSocket.__handlers.get('run.started')?.({
      run_id: 'run-background-delivery',
      autonomous: true,
      delegation_id: 'delegation-1',
    })
    localSocket.__handlers.get('message.delta')?.({
      run_id: 'run-background-delivery',
      delta: '厦门明天晴，最高温度 30 度。',
    })
    expect(remoteSocket.emit).not.toHaveBeenCalledWith('interaction.status', expect.objectContaining({ status: 'thinking' }))
    expect(remoteSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.anything())

    localSocket.__handlers.get('run.completed')?.({
      run_id: 'run-background-delivery',
      autonomous: true,
      delegation_id: 'delegation-1',
      output: '厦门明天晴，最高温度 30 度。',
      background_pending: 0,
    })

    await vi.waitFor(() => {
      const ttsCalls = fetchImpl.mock.calls.filter(([url]: [string]) => url.includes('/api/studio/tts/synthesize'))
      expect(ttsCalls).toHaveLength(1)
      expect(JSON.parse(String(ttsCalls[0][1]?.body))).toMatchObject({
        text: '厦门明天晴，最高温度 30 度。',
      })
    })
    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
        interactionId: 'mcu-background-delegation-1',
        segmentId: 'mcu-background-delegation-1-tts-1',
        text: '厦门明天晴，最高温度 30 度。',
        completionManagedByServer: true,
      }))
    })
    expect(localSocket.disconnect).toHaveBeenCalled()

    emitRemote(remoteSocket, 'audio.done', {
      type: 'audio.done',
      interactionId: 'mcu-background-delegation-1',
      segmentId: 'mcu-background-delegation-1-tts-1',
    })
    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('interaction.status', expect.objectContaining({
        interactionId: 'mcu-background-delegation-1',
        status: 'completed',
      }))
    })
  })

  it('queues the hosted TTS-failed prompt when Socket.IO MCU speech synthesis fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/api/studio/mcu/voice-turn')) {
        return new Response(JSON.stringify({ ok: true, transcript: '你好' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ error: 'tts down' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    })
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'http://device.local:8787/',
      relayProtocol: 'mcu-socket.io',
      userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const remoteSocket = connectRemoteSocket()
    emitRemote(remoteSocket, 'voice.recorded', {
      type: 'voice.recorded',
      interactionId: 'voice-tts-fail',
      mimeType: 'audio/wav',
      profile: 'research',
    })
    emitRemote(remoteSocket, 'voice.stream.chunk', {
      type: 'voice.stream.chunk',
      data: Buffer.from('wav-audio').toString('base64'),
    })

    await vi.waitFor(() => {
      expect(socketForUrl('http://127.0.0.1:8648/chat-run')).toBeTruthy()
    })
    const localSocket = socketForUrl('http://127.0.0.1:8648/chat-run')
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket)
    localSocket.__handlers.get('message.delta')?.({ delta: '你好' })
    localSocket.__handlers.get('run.completed')?.({})

    await vi.waitFor(() => {
      expect(remoteSocket.emit).toHaveBeenCalledWith('audio.enqueue', expect.objectContaining({
        url: '/api/studio/mcu/audio/tts-failed-24k.s16le.pcm',
      }))
    })
    const ttsCalls = fetchImpl.mock.calls.filter(([url]: [string]) => url.includes('/api/studio/tts/synthesize'))
    expect(ttsCalls).toHaveLength(2)
    expect(ttsCalls[0][1].headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    expect(ttsCalls[1][1].headers).toMatchObject({
      'X-Hermes-Profile': 'research',
    })
    const enqueuePayload = findEmittedPayload(remoteSocket, 'audio.enqueue', payload => payload.url === '/api/studio/mcu/audio/tts-failed-24k.s16le.pcm')
    expect(enqueuePayload).toMatchObject({
      type: 'audio.enqueue',
      interactionId: 'voice-tts-fail',
      segmentId: 'voice-tts-fail-tts-1-failed-prompt',
      text: '当前文字转语音失败了，请配置下文字转语音再使用哦',
      url: '/api/studio/mcu/audio/tts-failed-24k.s16le.pcm',
      mimeType: 'audio/x-pcm',
      format: 's16le',
      channels: 1,
      sampleRate: 24000,
    })
    expect(enqueuePayload).not.toHaveProperty('completionManagedByServer')
  })

  it('aborts in-flight Socket.IO MCU TTS synthesis when playback is interrupted', async () => {
    let ttsSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/studio/mcu/voice-turn')) {
        return new Response(JSON.stringify({ ok: true, transcript: '你好' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      ttsSignal = init?.signal || undefined
      return await new Promise<Response>((_resolve, reject) => {
        ttsSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    startOutboundRelayClient({
      relayUrl: 'http://device.local:8787/',
      relayProtocol: 'mcu-socket.io',
      userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const remoteSocket = connectRemoteSocket()
    emitRemote(remoteSocket, 'voice.recorded', {
      type: 'voice.recorded',
      interactionId: 'voice-abort',
      mimeType: 'audio/wav',
      profile: 'research',
    })
    emitRemote(remoteSocket, 'voice.stream.chunk', {
      type: 'voice.stream.chunk',
      data: Buffer.from('wav-audio').toString('base64'),
    })

    await vi.waitFor(() => {
      expect(socketForUrl('http://127.0.0.1:8648/chat-run')).toBeTruthy()
    })
    const localSocket = socketForUrl('http://127.0.0.1:8648/chat-run')
    localSocket.__handlers.get('connect')?.()
    startPrimaryMockRun(localSocket)
    localSocket.__handlers.get('message.delta')?.({ delta: '这段正在合成。\n' })

    await vi.waitFor(() => {
      expect(ttsSignal).toBeDefined()
    })
    expect(ttsSignal?.aborted).toBe(false)

    emitRemote(remoteSocket, 'audio.interrupted', {
      type: 'audio.interrupted',
      interactionId: 'voice-abort',
      segmentId: 'voice-abort-tts-1',
    })

    await vi.waitFor(() => {
      expect(ttsSignal?.aborted).toBe(true)
    })
    expect(localSocket.emit).toHaveBeenCalledWith('abort', { session_id: 'mcu-device-research-ekko' })
    expect(remoteSocket.emit).not.toHaveBeenCalledWith('audio.enqueue', expect.any(Object))
  })

  it('bridges MCU Webhook subscriptions and restores them after a local reconnect', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    startOutboundRelayClient({
      relayUrl: 'https://relay.example.com', relayProtocol: 'mcu-socket.io', userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
    })
    const remote = connectRemoteSocket()
    const local = socketForUrl('http://127.0.0.1:8648/global-agent')
    const selection = { type: 'mcu.events.subscribe', schema_version: 1, profile: 'default', types: ['chat.task.completed'] }
    emitRemote(remote, 'mcu.events.subscribe', selection)
    expect(local.emit).not.toHaveBeenCalledWith('mcu.events.subscribe', expect.anything())
    local.__handlers.get('connect')()
    expect(local.emit).toHaveBeenCalledWith('mcu.events.subscribe', { ...selection, apiToken: 'user-jwt' })
    local.emit.mockClear()
    local.__handlers.get('disconnect')('transport close')
    local.__handlers.get('connect')()
    expect(local.emit).toHaveBeenCalledTimes(1)
    expect(mockIo).toHaveBeenCalledTimes(2)

    const envelope = { type: 'mcu.webhook.event', schema_version: 1, event: { type: 'chat.task.completed', id: 'task-event' } }
    const subscribed = { type: 'mcu.events.subscribed', schema_version: 1, ok: true }
    for (const handler of local.__anyHandlers) {
      handler('mcu.events.subscribed', subscribed)
      handler('mcu.webhook.event', envelope)
    }
    expect(remote.emit).toHaveBeenCalledWith('mcu.events.subscribed', subscribed)
    expect(remote.emit).toHaveBeenCalledWith('mcu.webhook.event', envelope)

    emitRemote(remote, 'mcu.events.unsubscribe', { type: 'mcu.events.unsubscribe' })
    expect(local.emit).toHaveBeenCalledWith('mcu.events.unsubscribe', expect.objectContaining({ apiToken: 'user-jwt' }))
    local.emit.mockClear()
    local.__handlers.get('disconnect')('transport close')
    local.__handlers.get('connect')()
    expect(local.emit).not.toHaveBeenCalledWith('mcu.events.subscribe', expect.anything())
  })

  it('preserves the MCU subscriber identity across relay login and drops the old subscription', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    startOutboundRelayClient({
      relayUrl: 'https://relay.example.com', relayProtocol: 'mcu-socket.io', userToken: 'user-jwt',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ token: 'new-login-jwt' }), {
        headers: { 'content-type': 'application/json' },
      })),
    })
    const remote = connectRemoteSocket()
    const local = socketForUrl('http://127.0.0.1:8648/global-agent')
    local.__handlers.get('connect')()
    emitRemote(remote, 'mcu.events.subscribe', { type: 'mcu.events.subscribe', schema_version: 1 })
    await new Promise<void>(resolve => remote.__handlers.get('http.request')(
      { id: 'login', method: 'POST', path: '/api/auth/mcu-login', body: {} }, () => resolve(),
    ))
    expect(local.disconnect).toHaveBeenCalledOnce()
    emitRemote(remote, 'mcu.events.subscribe', { type: 'mcu.events.subscribe', schema_version: 1, apiToken: 'new-login-jwt' })
    const replacement = sockets.at(-1)
    expect(replacement).not.toBe(local)
    replacement.__handlers.get('connect')()
    expect(replacement.emit).toHaveBeenCalledWith('mcu.events.subscribe', expect.objectContaining({ apiToken: 'new-login-jwt' }))
    remote.emit.mockClear()
    for (const handler of local.__anyHandlers) handler('mcu.webhook.event', { type: 'mcu.webhook.event', event: { id: 'old-user' } })
    expect(remote.emit).not.toHaveBeenCalledWith('mcu.webhook.event', expect.anything())
  })

  it('forwards an allowed HTTP request to the local Web UI server', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: {
        'content-type': 'application/json',
        'x-result': 'accepted',
        'transfer-encoding': 'chunked',
      },
    }))
    const { OutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    const client = new OutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      relayToken: '',
      instanceId: '',
      localBaseUrl: 'http://127.0.0.1:8648/',
      fetchImpl: fetchImpl as any,
    })

    const response = await client.handleHttpRequest({
      id: 'req-1',
      method: 'POST',
      path: '/api/studio/sessions?profile=default',
      headers: {
        authorization: 'Bearer user-jwt',
        'content-type': 'application/json',
        connection: 'keep-alive',
        host: 'relay.example.com',
        'x-hermes-profile': 'default',
      },
      body: { message: 'hello' },
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8648/api/studio/sessions?profile=default', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ message: 'hello' }),
    }))
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(Array.from((init.headers as Headers).entries())).toEqual([
      ['authorization', 'Bearer user-jwt'],
      ['content-type', 'application/json'],
      ['x-hermes-profile', 'default'],
    ])
    expect(response).toEqual({
      id: 'req-1',
      status: 202,
      headers: {
        'content-type': 'application/json',
        'x-result': 'accepted',
      },
      body: '{"ok":true}',
      truncated: false,
    })
  })

  it('forwards non-v1 local paths through the relay', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ users: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const { OutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    const client = new OutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      relayToken: '',
      instanceId: '',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const response = await client.handleHttpRequest({
      id: 'req-2',
      method: 'GET',
      path: '/api/auth/users',
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8648/api/auth/users', expect.objectContaining({
      method: 'GET',
    }))
    expect(response).toEqual({
      id: 'req-2',
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
      body: '{"users":[]}',
      truncated: false,
    })
  })

  it('rejects /v1 paths without calling local fetch', async () => {
    const fetchImpl = vi.fn()
    const { OutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    const client = new OutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      relayToken: '',
      instanceId: '',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: fetchImpl as any,
    })

    const response = await client.handleHttpRequest({
      id: 'req-3',
      method: 'GET',
      path: '/v1/runs',
    })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(response).toEqual({
      id: 'req-3',
      status: 403,
      error: {
        code: 'path_not_allowed',
        message: 'Relay request path is not allowed',
      },
    })
  })

  it('opens a local /chat-run socket and relays chat events both ways', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    const client = startOutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    expect(client).not.toBeNull()

    const openAck = vi.fn()
    socketHandlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
      auth: { token: 'user-jwt' },
      query: { profile: 'default' },
    }, openAck)

    const localSocket = sockets[1]
    expect(mockIo).toHaveBeenCalledWith('http://127.0.0.1:8648/chat-run', expect.objectContaining({
      auth: { token: 'user-jwt' },
      query: { profile: 'default' },
      transports: ['websocket', 'polling'],
    }))
    expect(openAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', stream: true })

    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'hello' })
    expect(mockSocket.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'message.delta',
      payload: { session_id: 's1', delta: 'hello' },
    })

    const eventAck = vi.fn()
    socketHandlers.get('socket.event')?.({
      id: 'chat-1',
      event: 'run',
      payload: { session_id: 's1', input: 'hi' },
    }, eventAck)
    expect(localSocket.emit).toHaveBeenCalledWith('run', { session_id: 's1', input: 'hi' })
    expect(eventAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', event: 'run', stream: true })
  })

  it('supports non-streaming chat-run mode by suppressing deltas and returning final output', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    startOutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    const openAck = vi.fn()
    socketHandlers.get('socket.open')?.({
      id: 'chat-1',
      namespace: '/chat-run',
      stream: false,
    }, openAck)
    expect(openAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', stream: false })

    const localSocket = sockets[1]
    const eventAck = vi.fn()
    socketHandlers.get('socket.event')?.({
      id: 'chat-1',
      event: 'run',
      stream: false,
      payload: { session_id: 's1', input: 'hi' },
    }, eventAck)
    expect(eventAck).toHaveBeenCalledWith({ id: 'chat-1', ok: true, namespace: '/chat-run', event: 'run', stream: false })

    mockSocket.emit.mockClear()
    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'Hello ' })
    localSocket.__handlers.get('message.delta')?.({ session_id: 's1', delta: 'world' })
    localSocket.__handlers.get('reasoning.delta')?.({ session_id: 's1', delta: 'thinking' })
    expect(mockSocket.emit).not.toHaveBeenCalled()

    localSocket.__handlers.get('run.completed')?.({ session_id: 's1', run_id: 'run-1' })
    expect(mockSocket.emit).toHaveBeenCalledWith('socket.event', {
      id: 'chat-1',
      namespace: '/chat-run',
      event: 'run.completed',
      payload: {
        session_id: 's1',
        run_id: 'run-1',
        output: 'Hello world',
        reasoning: 'thinking',
      },
    })
  })

  it('rejects socket namespaces and events outside the chat-run allowlist', async () => {
    const { startOutboundRelayClient } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')
    startOutboundRelayClient({
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    const openAck = vi.fn()
    socketHandlers.get('socket.open')?.({ id: 'room-1', namespace: '/group-chat' }, openAck)
    expect(openAck).toHaveBeenCalledWith({
      id: 'room-1',
      ok: false,
      error: {
        code: 'namespace_not_allowed',
        message: 'Relay socket namespace is not allowed',
      },
    })

    const eventAck = vi.fn()
    socketHandlers.get('socket.event')?.({ id: 'chat-1', event: 'not.allowed', payload: {} }, eventAck)
    expect(eventAck).toHaveBeenCalledWith({
      id: 'chat-1',
      ok: false,
      error: {
        code: 'event_not_allowed',
        message: 'Relay socket event is not allowed',
      },
    })
  })

  it('manages multiple active relay clients by connection id', async () => {
    const {
      getOutboundRelayClient,
      getOutboundRelayClients,
      startOutboundRelayClient,
      stopOutboundRelayClient,
    } = await import('../../packages/server/src/modules/studio/services/global-agent/outbound-relay-client')

    const first = startOutboundRelayClient({
      connectionId: 'primary',
      relayUrl: 'https://relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const second = startOutboundRelayClient({
      connectionId: 'backup',
      relayUrl: 'https://other-relay.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })
    const duplicate = startOutboundRelayClient({
      connectionId: 'primary',
      relayUrl: 'https://duplicate.example.com',
      localBaseUrl: 'http://127.0.0.1:8648',
      fetchImpl: vi.fn() as any,
    })

    expect(first).not.toBeNull()
    expect(second).not.toBe(first)
    expect(duplicate).toBe(first)
    expect(getOutboundRelayClient()).toBe(first)
    expect(getOutboundRelayClient('primary')).toBe(first)
    expect(getOutboundRelayClient('backup')).toBe(second)
    expect(getOutboundRelayClients().size).toBe(2)
    expect(mockIo).toHaveBeenCalledTimes(2)

    stopOutboundRelayClient('primary')

    expect(mockSocket.disconnect).toHaveBeenCalledTimes(1)
    expect(getOutboundRelayClient('primary')).toBeNull()
    expect(getOutboundRelayClient('backup')).toBe(second)

    stopOutboundRelayClient()

    expect(sockets[1].disconnect).toHaveBeenCalledTimes(1)
    expect(getOutboundRelayClients().size).toBe(0)
  })
})
