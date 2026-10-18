import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeMock = vi.hoisted(() => ({
  statusIfLoaded: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(async () => {}), ensureReady: vi.fn() })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: {
    resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
    resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
    stop: vi.fn(),
  },
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: vi.fn() })),
  respondToChatEkkoToolApproval: vi.fn(() => ({ handled: false, resolved: false })),
  respondToChatEkkoClarification: vi.fn(() => ({ handled: false, resolved: false })),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const sessionStoreMock = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionNotificationPreview: vi.fn(() => null),
  getSessionMetadata: vi.fn(() => null),
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => sessionStoreMock)

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default']),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: vi.fn(() => true),
}))

function createHarness() {
  const handlers = new Map<string, Function>()
  const emitted: Array<{ room: string; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets: new Map(),
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })),
    })),
    use: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: {},
    handshake: { auth: {}, query: { profile: 'default' } },
    on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
    join: vi.fn(),
    emit: vi.fn(),
  }
  return {
    emitted,
    handlers,
    io: { of: vi.fn(() => namespace) },
    namespace,
    socket,
  }
}

describe('ChatRunSocket mobile location', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessionStoreMock.getSession.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'cli',
    })
  })

  it('requests one-time WGS84 coordinates and returns only sanitized location fields', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = createHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      events: [],
      queue: [],
      isWorking: true,
      profile: 'default',
      source: 'cli',
    })
    ;(server as any).onConnection(socket)

    const resultPromise = server.requestMobileLocation({
      sessionId: 'session-1',
      profile: 'default',
      purpose: 'Find nearby restaurants',
      accuracy: 'precise',
      timeoutMs: 10_000,
    })
    const requested = emitted.find(item =>
      item.room === 'session:session-1' && item.event === 'location.requested')
    expect(requested?.payload).toMatchObject({
      event: 'location.requested',
      session_id: 'session-1',
      purpose: 'Find nearby restaurants',
      accuracy: 'precise',
      timeout_ms: 10_000,
      max_age_ms: 0,
    })

    await handlers.get('location.respond')?.({
      session_id: 'session-1',
      location_request_id: requested?.payload.location_request_id,
      status: 'success',
      location: {
        latitude: 31.2304,
        longitude: 121.4737,
        accuracyMeters: 65,
        altitudeMeters: 12,
        speedMetersPerSecond: 2,
        coordinateSystem: 'wgs84',
        timestamp: 123456789,
        address: { street: 'must not be retained' },
      },
    })

    await expect(resultPromise).resolves.toEqual({
      status: 'success',
      location: {
        latitude: 31.2304,
        longitude: 121.4737,
        accuracyMeters: 65,
        altitudeMeters: 12,
        speedMetersPerSecond: 2,
        coordinateSystem: 'wgs84',
        timestamp: 123456789,
      },
    })
    expect((server as any).sessionMap.get('session-1').events).toEqual([])
    expect(emitted).toContainEqual(expect.objectContaining({
      room: 'pending-interactions:default',
      event: 'location.resolved',
      payload: expect.objectContaining({
        session_id: 'session-1',
        status: 'success',
        resolved: true,
      }),
    }))
  })

  it.each([
    { latitude: null },
    { longitude: '' },
    { latitude: undefined },
    { longitude: ' ' },
    { latitude: false },
    { longitude: true },
    { latitude: [] },
    { longitude: {} },
    { latitude: '31.2304' },
    { longitude: '121.4737' },
    { latitude: NaN },
    { longitude: Infinity },
    { latitude: -91 },
    { latitude: 91 },
    { longitude: -181 },
    { longitude: 181 },
    { coordinateSystem: 'gcj02' },
    { coordinateSystem: 'bd09' },
    { coordinateSystem: undefined },
    { coordinateSystem: null },
    { coordinateSystem: '' },
  ])('rejects invalid location fields %j and resolves the pending request', async (invalidFields) => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = createHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], events: [], queue: [], isWorking: true, profile: 'default', source: 'cli',
    })
    ;(server as any).onConnection(socket)
    const resultPromise = server.requestMobileLocation({
      sessionId: 'session-1', profile: 'default', purpose: 'Use current location',
    })
    const request = emitted.find(item => item.event === 'location.requested')
    handlers.get('location.respond')!({
      session_id: 'session-1',
      location_request_id: request?.payload.location_request_id,
      status: 'success',
      location: {
        latitude: 31.2304, longitude: 121.4737, coordinateSystem: 'wgs84', ...invalidFields,
      },
    })
    await expect(resultPromise).resolves.toEqual({
      status: 'error', error: { code: 'location_invalid_result' },
    })
    expect((server as any).pendingMobileLocations.size).toBe(0)
    expect((server as any).sessionMap.get('session-1').events).toEqual([])
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'location.resolved',
      payload: expect.objectContaining({
        resolved: true, status: 'error', error: { code: 'location_invalid_result' },
      }),
    }))
  })

  it.each([
    { latitude: 0, longitude: 0 },
    { latitude: -90, longitude: -180 },
    { latitude: 90, longitude: 180 },
  ])('preserves valid WGS84 coordinates %j without inventing optional values', async (coordinates) => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = createHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    const resultPromise = server.requestMobileLocation({
      sessionId: 'session-1', profile: 'default', purpose: 'Use current location',
    })
    const request = emitted.find(item => item.event === 'location.requested')
    handlers.get('location.respond')!({
      session_id: 'session-1',
      location_request_id: request?.payload.location_request_id,
      status: 'success',
      location: {
        ...coordinates, coordinateSystem: 'wgs84', accuracyMeters: 10,
        timestamp: 123456789, altitudeMeters: null, speedMetersPerSecond: '',
      },
    })
    await expect(resultPromise).resolves.toEqual({
      status: 'success',
      location: { ...coordinates, coordinateSystem: 'wgs84', accuracyMeters: 10, timestamp: 123456789 },
    })
  })

  it('returns a denial without storing location data', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = createHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], events: [], queue: [], isWorking: true, profile: 'default', source: 'cli',
    })
    ;(server as any).onConnection(socket)

    const resultPromise = server.requestMobileLocation({
      sessionId: 'session-1',
      profile: 'default',
      purpose: 'Use current location',
    })
    const request = emitted.find(item => item.event === 'location.requested')
    await handlers.get('location.respond')?.({
      session_id: 'session-1',
      location_request_id: request?.payload.location_request_id,
      status: 'denied',
    })

    await expect(resultPromise).resolves.toEqual({ status: 'denied' })
    expect(JSON.stringify((server as any).sessionMap.get('session-1'))).not.toContain('latitude')
  })

  it('rejects cross-profile and non-direct-chat requests', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = createHarness()
    const server = new ChatRunSocket(io as any)

    expect(() => server.requestMobileLocation({
      sessionId: 'session-1',
      profile: 'research',
      purpose: 'test',
    })).toThrow('Session is not available for this profile')

    sessionStoreMock.getSession.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      source: 'workflow',
    })
    expect(() => server.requestMobileLocation({
      sessionId: 'session-1',
      profile: 'default',
      purpose: 'test',
    })).toThrow('Mobile location is available only in direct chats')
  })
})


describe('App business event production', () => {
  it('normalizes external Coding Agent terminal and interaction events on the common bus', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
    const events: any[] = []
    const stop = businessEvents.subscribe('test-producer', event => events.push(event))
    const { io } = createHarness()
    sessionStoreMock.getSession.mockReturnValue({id:'external',profile:'default',source:'coding_agent',agent:'codex'})
    const server = new ChatRunSocket(io as any)
    try {
      server.emitExternalEvent('external','run.completed',{run_id:'run-1'})
      server.emitExternalEvent('external','approval.requested',{approval_id:'a'})
      server.emitExternalEvent('external','approval.resolved',{approval_id:'a',resolved:true})
      expect(events.map(event=>event.type)).toEqual(['chat.run.completed','chat.run.updated','chat.approval.requested','chat.approval.resolved'])
      expect(events[1]).toMatchObject({
        subject: { session_id: 'external', run_id: 'run-1' },
        payload: { state: { session_id: 'external', status: 'completed' } },
      })
      expect(events[2].subject.approval_id).toBe(events[3].subject.approval_id)
      expect(events[2].id).not.toBe(events[3].id)
    } finally { stop() }
  })
})
