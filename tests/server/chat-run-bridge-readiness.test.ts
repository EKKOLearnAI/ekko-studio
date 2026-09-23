import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordSessionUploadAttachmentsMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../packages/server/src/modules/studio/services/files/session-uploads', () => ({
  recordSessionUploadAttachments: recordSessionUploadAttachmentsMock,
}))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/socket-access', () => ({
  bindSessionShareSocket: vi.fn(),
}))

const saveTaskPlanMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/repositories/task-plan-store', () => ({
  saveTaskPlan: saveTaskPlanMock, listTaskPlansForPage: vi.fn(() => []),
}))

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleEkkoAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run', () => ({
  handleEkkoAgentRun: handleEkkoAgentRunMock,
}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const startBridgeMock = vi.hoisted(() => vi.fn())
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
    start: startBridgeMock,
    ensureReady: ensureReadyMock,
    getRuntimeState: getRuntimeStateMock,
  })),
  redactPrimaryAgentBridgeError: (error?: string, endpoint?: string, replacement = '[redacted endpoint]') => {
    if (!error) return error
    const values = [endpoint, endpoint?.replace(/^(?:ipc|tcp):\/\//, '')].filter(Boolean) as string[]
    return values.reduce((value, candidate) => value.split(candidate).join(replacement), error)
  },
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
  getSessionNotificationPreview: vi.fn(() => null),
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

describe('ChatRunSocket global pending interactions', () => {
  it('publishes a running snapshot and lightweight completion activity for the profile', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-running', {
      messages: [],
      events: [],
      queue: [],
      isWorking: true,
      profile: 'default',
    })

    ;(server as any).onConnection(socket)

    expect(socket.emit).toHaveBeenCalledWith('session.activity.snapshot', expect.objectContaining({
      event: 'session.activity.snapshot',
      profile: 'default',
      sessions: [{ session_id: 'session-running', status: 'running' }],
    }))

    ;(server as any).emitSessionActivity('default', 'run.completed', {
      session_id: 'session-running',
      queue_remaining: 0,
    })
    expect(emitted).toContainEqual({
      room: ['pending-interactions:default', 'session:session-running'],
      event: 'session.activity',
      payload: expect.objectContaining({
        session_id: 'session-running',
        status: 'completed',
      }),
    })
  })

  it('publishes approval and clarify lifecycle events to the authenticated profile audience', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    ;(server as any).emitToSession(socket, 'session-b', 'approval.requested', {
      event: 'approval.requested', approval_id: 'approval-b',
    })
    ;(server as any).emitToSession(socket, 'session-b', 'clarify.resolved', {
      event: 'clarify.resolved', clarify_id: 'clarify-b', resolved: true,
    })

    expect(socket.join).toHaveBeenCalledWith('pending-interactions:default')
    expect(emitted).toContainEqual(expect.objectContaining({
      room: 'pending-interactions:default', event: 'approval.requested',
      payload: expect.objectContaining({ session_id: 'session-b', approval_id: 'approval-b' }),
    }))
    expect(emitted).toContainEqual(expect.objectContaining({
      room: 'pending-interactions:default', event: 'clarify.resolved',
      payload: expect.objectContaining({ session_id: 'session-b', clarify_id: 'clarify-b' }),
    }))
  })

  it('does not republish group-chat approvals through the generic chat pending audience', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('gc_run_group', {
      messages: [], isWorking: true, events: [], queue: [], source: 'group_chat', profile: 'default',
    })

    ;(server as any).emitToSession(socket, 'gc_run_group', 'approval.requested', {
      event: 'approval.requested', approval_id: 'approval-group',
    })
    ;(server as any).emitToSession(socket, 'gc_run_group', 'clarify.requested', {
      event: 'clarify.requested', clarify_id: 'clarify-group', question: 'Which environment?',
    })

    expect(emitted).toContainEqual(expect.objectContaining({
      room: 'session:gc_run_group', event: 'approval.requested',
      payload: expect.objectContaining({ session_id: 'gc_run_group', approval_id: 'approval-group' }),
    }))
    expect(emitted).not.toContainEqual(expect.objectContaining({
      room: 'pending-interactions:default', event: 'approval.requested',
      payload: expect.objectContaining({ approval_id: 'approval-group' }),
    }))
    expect(emitted).not.toContainEqual(expect.objectContaining({
      room: 'pending-interactions:default', event: 'clarify.requested',
      payload: expect.objectContaining({ clarify_id: 'clarify-group' }),
    }))
  })

  it('rejects cross-profile resume, approval, and clarify requests before joining or calling the bridge', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 7, username: 'limited-user', role: 'user' }
    userCanAccessProfileMock.mockImplementation((_user: unknown, profile: string) => profile === 'default')
    getSessionMock.mockImplementation((sessionId?: string) => sessionId === 'research-session'
      ? { id: sessionId, profile: 'research', source: 'cli', model: 'gpt-test', provider: 'openai' }
      : sessionId
        ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
        : undefined)
    bridgeMock.approvalRespond.mockClear()
    bridgeMock.clarifyRespond.mockClear()
    const server = new ChatRunSocket(io as any)
    const state = {
      messages: [], isWorking: true, queue: [],
      events: [{ event: 'clarify.requested', data: { clarify_id: 'clarify-default' } }],
    }
    ;(server as any).sessionMap.set('default-session', state)

    ;(server as any).onConnection(socket)
    socket.join.mockClear()
    await handlers.get('resume')?.({ session_id: 'research-session' })
    await handlers.get('approval.respond')?.({
      session_id: 'research-session', approval_id: 'approval-research', choice: 'once',
    })
    await handlers.get('clarify.respond')?.({
      session_id: 'research-session', clarify_id: 'clarify-research', response: 'secret',
    })
    await handlers.get('cancel_queued_run')?.({ session_id: 'research-session', queue_id: 'queue-research' })
    await handlers.get('abort')?.({ session_id: 'research-session' })

    bridgeMock.clarifyRespond.mockResolvedValueOnce({ resolved: false })
    await handlers.get('clarify.respond')?.({
      session_id: 'default-session', clarify_id: 'clarify-default', response: 'retry me',
    })

    expect(socket.join).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
    expect(bridgeMock.clarifyRespond).toHaveBeenCalledTimes(1)
    expect(state.events).toEqual([
      { event: 'clarify.requested', data: { clarify_id: 'clarify-default' } },
    ])
    expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      session_id: 'research-session', error: expect.stringContaining('not available'),
    }))
    expect(socket.emit).toHaveBeenCalledWith('approval.resolved', expect.objectContaining({
      approval_id: 'approval-research', resolved: false,
    }))
    expect(socket.emit).toHaveBeenCalledWith('clarify.resolved', expect.objectContaining({
      clarify_id: 'clarify-research', resolved: false,
    }))
    expect(socket.emit).toHaveBeenCalledWith('clarify.resolved', expect.objectContaining({
      clarify_id: 'clarify-default',
      resolved: false,
      stale: true,
      error: 'Clarification is no longer pending.',
    }))
  })
})

describe('ensureBridgeReadyForChatRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startBridgeMock.mockReset()
    startBridgeMock.mockResolvedValue(undefined)
    ensureReadyMock.mockReset()
    getRuntimeStateMock.mockReset()
    bridgeMock.status.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    bridgeMock.releaseBackgroundNotification.mockReset()
    bridgeMock.close.mockReset()
    bridgeMock.releaseBackgroundNotification.mockResolvedValue({ ok: true, released: true })
    bridgeMock.close.mockResolvedValue(undefined)
    handleBridgeRunMock.mockReset()
    resumeBridgeRunMock.mockReset()
    handleCodingAgentRunMock.mockReset()
    loadSessionStateFromDbMock.mockReset()
    getSessionMock.mockReset()
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'cli', model: 'gpt-test', provider: 'openai' }
      : undefined)
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
  })

  it('allows reachable bridge readiness', async () => {
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/modules/studio/sockets/chat-run')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({ ok: true })
    expect(startBridgeMock).toHaveBeenCalledTimes(1)
    expect(ensureReadyMock).toHaveBeenCalledWith({ timeoutMs: 1000, connectRetryMs: 0, recover: false })
  })

  it('returns a visible error when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      error: 'connect ECONNREFUSED ipc:///tmp/hermes-agent-bridge.sock',
    })
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/modules/studio/sockets/chat-run')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
      ok: false,
      error: 'connect ECONNREFUSED configured endpoint',
    })
  })

  it('redacts configured tcp host:port when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'tcp://example.internal:43123',
      error: 'connect ECONNREFUSED example.internal:43123',
    })
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/modules/studio/sockets/chat-run')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
      ok: false,
      error: 'connect ECONNREFUSED configured endpoint',
    })
  })

  it('handles thrown ensureReady failures', async () => {
    ensureReadyMock.mockRejectedValueOnce(new Error('bridge startup timed out'))
    const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/modules/studio/sockets/chat-run')

    await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
      ok: false,
      error: 'bridge startup timed out',
    })
  })

  it('returns the recorded Runtime failure without starting the bridge when Runtime is unavailable', async () => {
    const previousSource = process.env.HERMES_RUNTIME_SOURCE
    process.env.HERMES_RUNTIME_SOURCE = 'none'
    const registry = await import('../../packages/server/src/modules/studio/public/agent-status-registry')
    registry.updateAgentStatus('hermes', {
      installed: false,
      source: 'not-installed',
      error: 'Runtime 0.21.0 is missing python/run_agent.py',
    })
    try {
      const { ensureBridgeReadyForChatRun } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
      await expect(ensureBridgeReadyForChatRun()).resolves.toEqual({
        ok: false,
        error: 'Runtime 0.21.0 is missing python/run_agent.py',
        runtimeUnavailable: true,
      })
      expect(startBridgeMock).not.toHaveBeenCalled()
      expect(ensureReadyMock).not.toHaveBeenCalled()
    } finally {
      if (previousSource === undefined) delete process.env.HERMES_RUNTIME_SOURCE
      else process.env.HERMES_RUNTIME_SOURCE = previousSource
      registry.resetAgentStatusRegistryForTests()
    }
  })
})

describe('ChatRunSocket bridge readiness gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    startBridgeMock.mockReset()
    startBridgeMock.mockResolvedValue(undefined)
    ensureReadyMock.mockReset()
    getRuntimeStateMock.mockReset()
    bridgeMock.status.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    bridgeMock.releaseBackgroundNotification.mockReset()
    bridgeMock.close.mockReset()
    bridgeMock.releaseBackgroundNotification.mockResolvedValue({ ok: true, released: true })
    bridgeMock.close.mockResolvedValue(undefined)
    handleBridgeRunMock.mockReset()
    resumeBridgeRunMock.mockReset()
    handleCodingAgentRunMock.mockReset()
    loadSessionStateFromDbMock.mockReset()
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    getRuntimeStateMock.mockReturnValue({ endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    loadSessionStateFromDbMock.mockResolvedValue({
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    })
  })

  it('emits run.failed before starting a cli run when the bridge is unreachable', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      error: 'bridge offline',
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({ input: 'hello', session_id: 'session-1', source: 'cli' })

    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      error: 'Agent Bridge is not reachable: bridge offline',
    })
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      profile: undefined,
    }))
  })

  it('routes legacy api_server runs through the bridge path', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({ input: 'hello', session_id: 'session-1', source: 'api_server' })

    expect(ensureReadyMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      input: 'hello',
      source: 'api_server',
    }))
    expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
  })

  it('routes global-agent Hermes runs through the bridge run path while preserving session source', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({
      input: 'hello',
      session_id: 'session-1',
      source: 'cli',
      session_source: 'global_agent',
    })

    expect(ensureReadyMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      source: 'cli',
      session_source: 'global_agent',
    }))
    expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
  })

  it('keeps workflow Hermes runs behind the broker readiness gate', async () => {
    ensureReadyMock.mockResolvedValueOnce({
      reachable: false,
      status: 'unreachable',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      error: 'bridge offline',
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({
      input: 'next workflow node',
      session_id: 'workflow-session-1',
      source: 'workflow',
      session_source: 'workflow',
    })

    expect(ensureReadyMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'workflow-session-1',
      error: 'Agent Bridge is not reachable: bridge offline',
    })
  })

  it('routes global coding-agent runs through the coding-agent path while preserving session source', async () => {
    handleCodingAgentRunMock.mockResolvedValueOnce({ runId: 'coding-run-1', messageId: 42 })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({
      input: 'hello',
      session_id: 'session-1',
      source: 'coding_agent',
      session_source: 'global_agent',
      coding_agent_id: 'codex',
      queue_id: 'phone-message-1',
    })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(handleCodingAgentRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        source: 'coding_agent',
        session_source: 'global_agent',
        coding_agent_id: 'codex',
      }),
      'default',
      expect.any(Map),
    )
    expect(socket.to).toHaveBeenCalledWith('session:session-1')
    expect(socket.to.mock.results[0].value.emit).toHaveBeenCalledWith('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id: 'session-1',
      message: {
        id: 'phone-message-1',
        role: 'user',
        content: 'hello',
        timestamp: expect.any(Number),
        queued: false,
      },
    })
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
  })

  it('continues with remaining queued bridge runs when readiness fails before a dequeued run starts', async () => {
    ensureReadyMock
      .mockResolvedValueOnce({
        reachable: false,
        status: 'unreachable',
        endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
        error: 'bridge offline',
      })
      .mockResolvedValueOnce({
        reachable: true,
        status: 'ready',
        endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
      })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{
        queue_id: 'queue-next',
        input: 'second queued message',
        source: 'cli',
        profile: 'default',
      }],
      profile: 'default',
      source: 'cli',
    })

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-failed',
      input: 'first queued message',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(ensureReadyMock).toHaveBeenCalledTimes(2))
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(handleBridgeRunMock.mock.calls[0][2]).toEqual(expect.objectContaining({
      input: 'second queued message',
      queue_id: 'queue-next',
    }))
    expect(socket.emit).toHaveBeenCalledWith('run.failed', {
      event: 'run.failed',
      session_id: 'session-1',
      queue_id: 'queue-failed',
      error: 'Agent Bridge is not reachable: bridge offline',
      queue_remaining: 1,
    })
    expect(emitted).toContainEqual({
      room: 'session:session-1',
      event: 'run.queued',
      payload: expect.objectContaining({
        event: 'run.queued',
        session_id: 'session-1',
        queue_length: 0,
        dequeued_queue_id: 'queue-next',
      }),
    })
  })

  it('reattaches a loaded running bridge run without probing manager readiness again', async () => {
    bridgeMock.statusIfLoaded
      .mockResolvedValueOnce({
        ok: true,
        exists: true,
        running: true,
        current_run_id: 'run-1',
        loaded: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        exists: true,
        running: true,
        current_run_id: 'run-1',
        loaded: true,
      })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).toHaveBeenCalledTimes(1)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
    }))
    expect(emitted.some(({ event }) => event === 'run.failed')).toBe(false)
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: true,
      isAborting: false,
      runId: 'run-1',
      activeRunMarker: undefined,
      profile: 'default',
      source: 'cli',
      events: [],
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })

  it('emits a non-terminal reattach warning and preserves stale state when bridge status lookup throws during resume', async () => {
    bridgeMock.statusIfLoaded.mockRejectedValueOnce(new Error('connect ECONNREFUSED ipc:///tmp/hermes-agent-bridge.sock'))
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: true,
      runId: 'stale-run',
      activeRunMarker: 'marker-1',
      profile: 'default',
      source: 'cli',
      events: [{ event: 'run.started', data: { run_id: 'stale-run' } }],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted).toContainEqual({
      room: 'session:session-1',
      event: 'run.reattach_failed',
      payload: {
        event: 'run.reattach_failed',
        session_id: 'session-1',
        error: 'connect ECONNREFUSED configured endpoint',
        message: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
        text: 'Unable to confirm Agent Bridge status while resuming: connect ECONNREFUSED configured endpoint',
      },
    })
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      isAborting: true,
      events: [expect.objectContaining({
        event: 'run.reattach_failed',
        data: expect.objectContaining({
          error: 'connect ECONNREFUSED configured endpoint',
        }),
      })],
    }))
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: true,
      runId: 'stale-run',
      activeRunMarker: 'marker-1',
      profile: 'default',
      source: 'cli',
      events: expect.arrayContaining([
        expect.objectContaining({ event: 'run.started' }),
        expect.objectContaining({
          event: 'run.reattach_failed',
          data: expect.objectContaining({
            error: 'connect ECONNREFUSED configured endpoint',
          }),
        }),
      ]),
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })

  it('suppresses transient bridge status timeout warnings while resuming', async () => {
    bridgeMock.statusIfLoaded.mockRejectedValueOnce(new Error('Agent bridge request timed out after 1000ms'))
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'cli',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      events: [],
    }))
    expect((server as any).bridgeResumePolls.size).toBe(0)
  })

  it('does not query Hermes bridge status when resuming a coding agent session', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'coding_agent', model: 'codex', provider: 'codex' }
      : undefined)
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'coding_agent',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
  })

  it('reattaches workflow bridge runs with the workflow source preserved', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'workflow', agent: 'hermes', model: 'gpt-test', provider: 'openai' }
      : undefined)
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: true,
      running: true,
      loaded: true,
      current_run_id: 'run-workflow',
    })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    let sourceAtResume = ''
    resumeBridgeRunMock.mockImplementationOnce((...args: any[]) => {
      const sessionMap = args[3] as Map<string, any>
      sourceAtResume = sessionMap.get('session-1').source
      return Promise.resolve()
    })

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(sourceAtResume).toBe('workflow')
    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(resumeBridgeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-workflow',
        source: 'workflow',
      }),
      expect.any(Map),
      bridgeMock,
      expect.any(Function),
    )
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
  })

  it('reattaches global-agent bridge runs with the global source preserved', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'global_agent', model: 'gpt-test', provider: 'openai' }
      : undefined)
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: true,
      running: true,
      loaded: true,
      current_run_id: 'run-global',
    })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'global_agent',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(resumeBridgeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-global',
        source: 'global_agent',
      }),
      expect.any(Map),
      bridgeMock,
      expect.any(Function),
    )
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
      events: [],
    }))
  })

  it('checks Hermes bridge status when resuming an api server session', async () => {
    getSessionMock.mockImplementation((sessionId?: string) => sessionId
      ? { id: sessionId, profile: 'default', source: 'api_server', model: 'gpt-test', provider: 'openai' }
      : undefined)
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: false,
      running: false,
      loaded: false,
    })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [],
      isWorking: false,
      isAborting: false,
      runId: undefined,
      activeRunMarker: undefined,
      profile: 'default',
      source: 'api_server',
      events: [],
      queue: [],
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(ensureReadyMock).not.toHaveBeenCalled()
    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(emitted.some(({ event }) => event === 'run.reattach_failed')).toBe(false)
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      events: [],
    }))
  })

  it('releases queued background completion claims before closing bridge clients', async () => {
    const order: string[] = []
    bridgeMock.releaseBackgroundNotification.mockImplementationOnce(async () => {
      order.push('release')
      return { ok: true, released: true }
    })
    bridgeMock.close.mockImplementation(async () => {
      order.push('close')
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{
        queue_id: 'delegation-d1',
        input: 'completion',
        profile: 'default',
        source: 'cli',
        backgroundDelegationId: 'd1',
        backgroundClaimId: 'claim-1',
      }],
    })

    await server.close()

    expect(bridgeMock.releaseBackgroundNotification).toHaveBeenCalledWith(
      'session-1',
      'default',
      'd1',
      'claim-1',
    )
    expect(order[0]).toBe('release')
    expect(order.slice(1)).toEqual(['close', 'close'])
    expect((server as any).sessionMap.size).toBe(0)
    expect((server as any).closing).toBe(true)
  })
})


describe('ChatRunSocket MCP task plan lifecycle', () => {
  it.each(['coding_agent', 'workflow', 'group_chat'])('does not inject shared planning into Ekko on %s', async source => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const begin = vi.spyOn((server as any).taskPlanRuns, 'begin')
    handleEkkoAgentRunMock.mockClear()
    await (server as any).handleRun(socket, {
      session_id: 'session-1', source, coding_agent_id: 'ekko-agent', input: 'Implement a feature',
    }, 'default')
    expect(handleEkkoAgentRunMock).toHaveBeenCalledTimes(1)
    const data = (handleEkkoAgentRunMock.mock.calls as any)[0][2]
    expect(data.instructions || '').not.toContain('ekko_studio_update_plan')
    expect(data.instructions || '').not.toContain('context_id=')
    expect(data.task_plan_context_id).toBeUndefined()
    expect(begin).not.toHaveBeenCalled()
  })

  it.each(['coding_agent', 'group_chat', 'workflow', 'global_agent'])('binds interactive contexts only on user-facing Coding Agent turns: %s', async source => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    handleCodingAgentRunMock.mockReset()
    let planContext = ''
    let interactionContext: string | undefined
    handleCodingAgentRunMock.mockImplementationOnce((async (_nsp: any, _socket: any, data: any, _profile: any, sessions: any) => {
      planContext = data.task_plan_context_id
      interactionContext = data.interaction_context_id
      Object.assign(sessions.get(data.session_id), { isWorking: true, responseRun: { runMarker: 'coding-turn-1' } })
      return { runId: 'reused-runtime-id', messageId: 42 }
    }) as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source: source === 'global_agent' ? 'coding_agent' : source, session_source: source === 'coding_agent' ? undefined : source, coding_agent_id: 'codex', input: 'Implement a feature' }, 'default')
    expect(handleCodingAgentRunMock).toHaveBeenCalledTimes(1)
    expect(planContext).toBeTruthy()
    if (source === 'workflow' || source === 'global_agent') {
      expect(interactionContext).toBeUndefined()
      expect(() => server.requestClarification(planContext, 'default', { question: 'Q' })).toThrow('expired')
    } else {
      expect(interactionContext).toBe(planContext)
      const result = server.requestClarification(interactionContext!, 'default', { question: 'Q' })
      const prompt = emitted.find(item => item.event === 'clarify.requested')!
      expect(prompt.payload.run_id).toBe('coding-turn-1')
      expect(server.respondCodingAgentClarification('session-1', prompt.payload.clarify_id, 'A')).toBe(true)
      await expect(result).resolves.toMatchObject({ response: 'A' })
    }
    server.emitExternalEvent('session-1', 'run.completed', {})
    expect(() => server.requestClarification(planContext, 'default', { question: 'Q' })).toThrow('expired')
  })

  const input = { plan: [{ id: 'verify', step: 'Verify the change', status: 'in_progress' }] }

  it.each(['run.completed', 'run.failed', 'abort.completed'])('settles a Codex plan before delivering %s', async event => {
    saveTaskPlanMock.mockClear()
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    let contextId = ''
    handleCodingAgentRunMock.mockImplementationOnce((async (_nsp: any, _socket: any, data: any, _profile: any, sessions: any) => {
      contextId = data.task_plan_context_id
      Object.assign(sessions.get(data.session_id), { isWorking: true, responseRun: { runMarker: 'coding-turn-1' } })
      return { runId: 'reused-runtime-id', messageId: 42 }
    }) as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source: 'coding_agent', coding_agent_id: 'codex', input: 'Implement a feature' }, 'default')
    const snapshot = server.updateTaskPlan(contextId, 'default', input)
    expect(snapshot.run_id).toBe('coding-turn-1')
    expect(saveTaskPlanMock).toHaveBeenCalledWith(snapshot)
    server.emitExternalEvent('session-1', event, { event, run_id: 'reused-runtime-id' })
    const updates = emitted.filter(item => item.event === 'plan.updated')
    expect(updates).toHaveLength(2)
    expect(updates[1].payload).toMatchObject({ execution_state: event === 'run.completed' ? 'ended' : event === 'run.failed' ? 'failed' : 'interrupted', revision: 2 })
    expect(emitted.indexOf(updates[1])).toBeLessThan(emitted.findIndex(item => item.event === event))
    expect(() => server.updateTaskPlan(contextId, 'default', input)).toThrow('expired')
  })

  it.each([false, true])('keeps Hermes plans alive until its stream completes (interrupted=%s)', async interrupted => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { emitted, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ensureReadyMock.mockResolvedValue({ reachable: true, status: 'ready' })
    let contextId = ''
    handleBridgeRunMock.mockImplementationOnce((async (_nsp: any, _socket: any, data: any, _profile: any, sessions: any) => {
      contextId = data.task_plan_context_id
      const state = sessions.get(data.session_id)
      Object.assign(state, { isWorking: true, activeRunMarker: 'cli-turn-1' })
      server.updateTaskPlan(contextId, 'default', input)
      state.activeRunMarker = undefined
      state.isWorking = false
      data.onEvent('run.completed', { event: 'run.completed', result: { interrupted } })
    }) as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source: 'cli', input: 'Implement a feature' }, 'default')
    expect(emitted.filter(item => item.event === 'plan.updated').map(item => item.payload.execution_state)).toEqual(['running', interrupted ? 'interrupted' : 'ended'])
    expect(() => server.updateTaskPlan(contextId, 'default', input)).toThrow('expired')
  })
})

describe('MCP-aware run guidance', () => {
  it.each(['cli', 'workflow', 'group_chat'])('omits Hermes task contexts when MCPs are disabled on %s', async source => {
    const { readConfigYamlForProfile } = await import('../../packages/server/src/modules/studio/public/profile-config')
    vi.mocked(readConfigYamlForProfile).mockResolvedValueOnce({ mcp_servers: { 'ekko-studio-interaction': { enabled: false } } })
    ensureReadyMock.mockResolvedValue({ reachable: true, status: 'ready' })
    handleBridgeRunMock.mockReset()
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source, input: 'Plan this work' }, 'research')
    const data = (handleBridgeRunMock.mock.calls as any)[0][2]
    expect(data.task_plan_context_id).toBeUndefined()
    expect(data.instructions).not.toContain('ekko_studio_')
    expect(readConfigYamlForProfile).toHaveBeenLastCalledWith('research')
  })

  it.each(['coding_agent', 'workflow', 'group_chat'])('does not create Coding Agent interaction contexts without the MCP on %s', async source => {
    const { getChatCodingAgentMcpServers } = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    vi.mocked(getChatCodingAgentMcpServers).mockReturnValueOnce({})
    handleCodingAgentRunMock.mockReset()
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source, coding_agent_id: 'codex', input: 'Plan work' }, 'research')
    const data = (handleCodingAgentRunMock.mock.calls as any)[0][2]
    expect(data.task_plan_context_id).toBeUndefined()
    expect(data.interaction_context_id).toBeUndefined()
    expect(data.instructions || '').not.toContain('ekko_studio_')
    expect(getChatCodingAgentMcpServers).toHaveBeenLastCalledWith('codex', 'research')
  })

  it.each([
    ['ios', true, true, true],
    ['android', true, true, false],
    ['ios', false, false, false],
    [undefined, true, false, false],
  ])('gates mobile guidance by bound device and use MCP: %s / %s', async (platform, enabled, mobile, health) => {
    const { getChatCodingAgentMcpServers } = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    vi.mocked(getChatCodingAgentMcpServers).mockReturnValueOnce({ 'ekko-studio-use': { enabled } })
    handleCodingAgentRunMock.mockReset()
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    if (platform) (socket.data as any).mobileDeviceTarget = { profile: 'default', platform, deviceCode: 'phone', userId: 1 }
    const server = new ChatRunSocket(io as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source: 'coding_agent', coding_agent_id: 'codex', input: 'Hello' }, 'default')
    const instructions = (handleCodingAgentRunMock.mock.calls as any)[0][2].instructions || ''
    expect(instructions.includes('ekko_studio_use_mobile_location')).toBe(mobile)
    expect(instructions.includes('ekko_studio_use_mobile_calendar')).toBe(mobile)
    expect(instructions.includes('ekko_studio_use_mobile_health')).toBe(health)
  })
  it.each(['workflow', 'group_chat'])('does not expose mobile guidance through a coding_agent transport for %s', async session_source => {
    handleCodingAgentRunMock.mockReset()
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    ;(socket.data as any).mobileDeviceTarget = { profile: 'default', platform: 'ios', deviceCode: 'phone', userId: 1 }
    const server = new ChatRunSocket(io as any)
    await (server as any).handleRun(socket, { session_id: 'session-1', source: 'coding_agent', session_source, coding_agent_id: 'codex', input: 'Hello' }, 'default')
    expect((handleCodingAgentRunMock.mock.calls as any)[0][2].instructions || '').not.toContain('ekko_studio_use_mobile_')
  })

})

describe('session upload provenance at the socket boundary', () => {
  it.each([false, true])('registers host attachments but never recipient-provided paths (shared=%s)', async shared => {
    recordSessionUploadAttachmentsMock.mockClear()
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    if (shared) socket.data = { sessionShare: { share: { session_id: 'session-1', profile: 'default' } } }
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', { isWorking: true, queue: [], events: [] })
    const input = [{ type: 'file', path: '/uploads/attachment.txt', name: 'attachment.txt' }]
    await handlers.get('run')!({ session_id: 'session-1', input })
    if (shared) expect(recordSessionUploadAttachmentsMock).not.toHaveBeenCalled()
    else expect(recordSessionUploadAttachmentsMock).toHaveBeenCalledWith('session-1', 'default', input)
    expect((server as any).sessionMap.get('session-1').queue).toHaveLength(1)
  })
})

describe('first image message on a brand-new (not-yet-persisted) session', () => {
  it('does not fail with "Session not found" when the DB row does not exist yet', async () => {
    recordSessionUploadAttachmentsMock.mockClear()
    getSessionMock.mockReset()
    // Brand-new session row does not exist in the DB yet — getSession returns null.
    ;(getSessionMock as ReturnType<typeof vi.fn>).mockImplementation(
      (id?: string) => (id === 'new-local-session' ? null : undefined),
    )
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('new-local-session', { isWorking: false, queue: [], events: [] })
    // Stub the real run so the assertion isolates the access gate, not bridge readiness.
    const handleRunMock = vi.fn(async () => {})
    ;(server as any).handleRun = handleRunMock
    // ContentBlock[] input is exactly what an image attachment produces — the branch
    // that used to call requireSocketSessionAccess unconditionally and 404.
    const input = [{ type: 'image', path: '/uploads/img.png', name: 'img.png', media_type: 'image/png' }]
    await handlers.get('run')!({ session_id: 'new-local-session', input })
    // Under the buggy code this throws "Session not found" and returns before any of
    // these run. Asserting they were reached proves the access gate let a not-yet-persisted
    // session through.
    expect(recordSessionUploadAttachmentsMock).toHaveBeenCalledWith('new-local-session', 'default', input)
    expect(handleRunMock).toHaveBeenCalled()
    // No failure may be attributed to the access gate.
    expect(socket.emit).not.toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: 'Session not found' }))
  })

  it('still rejects a persisted session owned by a different profile', async () => {
    getSessionMock.mockReset()
    ;(getSessionMock as ReturnType<typeof vi.fn>).mockImplementation(
      (id?: string) => (id === 'other-profile-session'
        ? { id, profile: 'research', source: 'cli', model: 'gpt-test', provider: 'openai' }
        : undefined),
    )
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('other-profile-session', { isWorking: false, queue: [], events: [] })
    const input = [{ type: 'image', path: '/uploads/img.png', name: 'img.png', media_type: 'image/png' }]
    await handlers.get('run')!({ session_id: 'other-profile-session', input })
    // Socket is on the 'default' profile but the persisted row belongs to 'research' → cross-profile guard still fires.
    expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      session_id: 'other-profile-session',
      error: 'Profile "research" is not available on this connection',
    }))
  })
})
