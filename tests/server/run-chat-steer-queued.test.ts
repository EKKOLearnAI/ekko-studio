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
  steer: vi.fn(async () => ({ accepted: true, status: 'queued' })),
}))
const codingAgentRunManagerMock = vi.hoisted(() => ({
  hasSession: vi.fn(() => false),
  stop: vi.fn(),
  isSessionLaunchCompatible: vi.fn(() => false),
  isSessionProcessing: vi.fn(() => false),
  runIdForSession: vi.fn(() => null),
  interruptForQueueInsertion: vi.fn(),
  resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
  resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
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
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: codingAgentRunManagerMock,
  handleChatCodingAgentSessionCommand: vi.fn(),
  parseChatCodingAgentSessionCommand: vi.fn(() => null),
  getChatEkkoAgent: vi.fn(() => null),
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
 * Queued messages could only wait for the run to end or stop it to get in.
 * Steering hands one to the run that is already going, so the queue must not
 * shrink until the bridge has actually taken the text.
 */
describe('ChatRunSocket steering a queued message', () => {
  function queuedState() {
    return {
      messages: [],
      events: [],
      isWorking: true,
      profile: 'default',
      queue: [
        { queue_id: 'q1', input: 'focus on the first point only', displayInput: 'focus on the first point only' },
        { queue_id: 'q2', input: 'and then summarise', displayInput: 'and then summarise' },
      ],
    }
  }

  beforeEach(() => {
    bridgeMock.steer.mockClear()
    bridgeMock.steer.mockResolvedValue({ accepted: true, status: 'queued' })
  })

  it('hands the queued text to the active run and drops just that entry', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    const state = queuedState()
    ;(server as any).sessionMap.set('s1', state)
    ;(server as any).onConnection(socket)

    await handlers.get('steer_queued_run')?.({ session_id: 's1', queue_id: 'q1' })

    expect(bridgeMock.steer).toHaveBeenCalledWith('s1', 'focus on the first point only', 'default')
    expect(state.queue.map(item => item.queue_id)).toEqual(['q2'])
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.queued',
      payload: expect.objectContaining({ queue_length: 1 }),
    }))
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'session.command',
      payload: expect.objectContaining({ action: 'steer', ok: true, message: 'Steer instruction sent.' }),
    }))
  })

  it('keeps the message queued when the bridge refuses it', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    bridgeMock.steer.mockRejectedValueOnce(new Error('agent does not support steer'))
    const server = new ChatRunSocket(io as any)
    const state = queuedState()
    ;(server as any).sessionMap.set('s1', state)
    ;(server as any).onConnection(socket)

    await handlers.get('steer_queued_run')?.({ session_id: 's1', queue_id: 'q1' })

    // Nothing was delivered, so nothing may be lost.
    expect(state.queue.map(item => item.queue_id)).toEqual(['q1', 'q2'])
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'session.command',
      payload: expect.objectContaining({ ok: false, message: 'agent does not support steer' }),
    }))
  })

  it('ignores an unknown queue id and a session the user cannot reach', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 7, username: 'limited-user', role: 'user' }
    userCanAccessProfileMock.mockImplementation((_user: unknown, profile: string) => profile === 'default')
    getSessionMock.mockImplementation((sessionId?: string) => sessionId === 'research-session'
      ? { id: sessionId, profile: 'research', source: 'cli', model: 'gpt-test', provider: 'openai' }
      : sessionId
        ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
        : undefined)
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('s1', queuedState())
    ;(server as any).sessionMap.set('research-session', queuedState())
    ;(server as any).onConnection(socket)

    await handlers.get('steer_queued_run')?.({ session_id: 's1', queue_id: 'nope' })
    await handlers.get('steer_queued_run')?.({ session_id: 'research-session', queue_id: 'q1' })

    expect(bridgeMock.steer).not.toHaveBeenCalled()
  })
})
