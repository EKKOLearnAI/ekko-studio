import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
const userCanAccessProfileMock = vi.hoisted(() => vi.fn((_user: unknown, _profile: string) => true))
const getSessionMock = vi.hoisted(() => vi.fn((sessionId?: string) => sessionId
  ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
  : undefined))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
  releaseBackgroundNotification: vi.fn(async () => ({ ok: true, released: true })),
  close: vi.fn(async () => {}),
  approvalRespond: vi.fn(async () => ({ resolved: true })),
  clarifyRespond: vi.fn(async () => ({ resolved: true })),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  resolveRunSource: vi.fn((source?: string) => source || 'cli'),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run', () => ({
  handleCodingAgentRun: handleCodingAgentRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  getChatCodingAgentMcpServers: vi.fn(() => ({ 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } })),
  resolveChatEkkoMcpServers: vi.fn(() => ({ 'ekko-studio-use': { command: 'studio' } })),
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({
    start: vi.fn(async () => {}),
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  getSessionMetadata: getSessionMock,
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ mcp_servers: { 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } } })),
  getActiveProfileName: vi.fn(() => 'default'),
  getProfileDir: vi.fn(() => '/tmp/hermes-default'),
  listProfileNamesFromDisk: vi.fn(() => ['default', 'research']),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  authenticateUserToken: vi.fn(),
  isAuthEnabled: vi.fn(async () => false),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: userCanAccessProfileMock,
}))

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const emitted: Array<{ room: string; event: string; payload: any }> = []
  const namespace = {
    adapter: { rooms: new Map() },
    to: vi.fn((room: string) => ({
      emit: vi.fn((event: string, payload: any) => emitted.push({ room, event, payload })),
    })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = { of: vi.fn(() => namespace) }
  const socket = {
    id: 'socket-1',
    connected: true,
    handshake: { auth: {}, query: { profile: 'default' } },
    data: {},
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
  }
  return { emitted, handlers, io, namespace, socket }
}

/**
 * The thinking timer used to start at the client's first render, so reopening
 * a session mid-run showed the agent as having just started, and two devices
 * disagreed about the same run. The run's real start is only known server-side.
 */
describe('ChatRunSocket reports when the run started', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    ensureReadyMock.mockReset()
    getRuntimeStateMock.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
  })

  it('sends the run start to a client resuming a working session', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    const startedAt = 1_787_000_000_000
    ;(server as any).sessionMap.set('s1', {
      messages: [], events: [], queue: [], isWorking: true, profile: 'default', runStartedAt: startedAt,
    })

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 's1' })

    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
    expect(resumed).toBeTruthy()
    expect(resumed![1]).toMatchObject({ isWorking: true, runStartedAt: startedAt })
  })

  it('leaves it unset for a session that is not working', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('s2', {
      messages: [], events: [], queue: [], isWorking: false, profile: 'default',
    })

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 's2' })

    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
    expect(resumed![1].isWorking).toBe(false)
    expect(resumed![1].runStartedAt).toBeUndefined()
  })

  it('refreshes the start when a queued run becomes active', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const previousStart = 1_787_000_000_000
    const nextStart = previousStart + 60_000
    const state = {
      messages: [],
      events: [],
      queue: [{ queue_id: 'q2', input: 'second', profile: 'default', source: 'cli' }],
      isWorking: false,
      profile: 'default',
      runStartedAt: previousStart,
    }
    ;(server as any).sessionMap.set('s3', state)
    vi.spyOn(server as any, 'handleRun').mockResolvedValue(undefined)
    vi.spyOn(Date, 'now').mockReturnValue(nextStart)

    ;(server as any).dequeueNextQueuedRun(socket, 's3', 'default')

    expect(state.runStartedAt).toBe(nextStart)
  })

  it('uses a new shared fallback when the server reattaches an existing bridge run', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    const previousStart = 1_787_000_000_000
    const reattachedAt = previousStart + 60_000
    ;(server as any).sessionMap.set('s4', {
      messages: [], events: [], queue: [], isWorking: false, profile: 'default', runStartedAt: previousStart,
    })
    bridgeMock.statusIfLoaded.mockResolvedValue({ running: true, current_run_id: 'run-4' })
    vi.spyOn(Date, 'now').mockReturnValue(reattachedAt)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 's4' })

    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
    expect(resumed![1]).toMatchObject({ isWorking: true, runStartedAt: reattachedAt })
  })
})
