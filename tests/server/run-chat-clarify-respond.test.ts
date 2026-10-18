import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeMock = vi.hoisted(() => ({
  clarifyRespond: vi.fn(),
  statusIfLoaded: vi.fn(),
}))
const respondToEkkoClarificationMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/modules/ekko/services/clarifications', () => ({
  respondToEkkoClarification: respondToEkkoClarificationMock,
  waitForEkkoClarification: vi.fn(),
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
  respondToChatEkkoClarification: respondToEkkoClarificationMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const sessionStoreMock = vi.hoisted(() => ({
  getSessionNotificationPreview: vi.fn(() => null),
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default' })),
  getSessionMetadata: vi.fn(() => null),
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => sessionStoreMock)

vi.mock('../../packages/server/src/modules/studio/services/task-plans', () => ({ getSessionTaskPlans: vi.fn(() => []) }))

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

function createSocketHarness() {
  const handlers = new Map<string, Function>()
  const namespaceEmit = vi.fn()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit: namespaceEmit })),
    use: vi.fn(),
    on: vi.fn(),
  }
  const io = {
    of: vi.fn(() => namespace),
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    data: {},
    handshake: { auth: {}, query: { profile: 'default' } },
    on: vi.fn((event: string, handler: Function) => {
      handlers.set(event, handler)
    }),
    join: vi.fn(),
    emit: vi.fn(),
  }
  return { handlers, io, namespace, namespaceEmit, socket }
}

describe('ChatRunSocket clarify responses', { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStoreMock.getSession.mockReset()
    sessionStoreMock.getSession.mockReturnValue({ id: 'session-1', profile: 'default' })
    bridgeMock.clarifyRespond.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    respondToEkkoClarificationMock.mockReset()
    respondToEkkoClarificationMock.mockReturnValue({ handled: false, resolved: false })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
  })

  it.each(['socket', 'group'])('round-trips MCP questions through the %s reply path and removes replay state', async surface => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket, namespaceEmit } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const state = { isWorking: true, activeRunMarker: 'mcp-turn', events: [], profile: 'default' }
    ;(server as any).sessionMap.set('session-1', state)
    ;(server as any).clarificationRuns.begin('mcp-context', 'session-1', 'default', () => state)
    ;(server as any).onConnection(socket)
    const result = server.requestClarification('mcp-context', 'default', { question: 'Which folder?', choices: ['client', 'server'] })
    const payload = namespaceEmit.mock.calls.find(call => call[0] === 'clarify.requested')![1]
    expect(state.events).toContainEqual(expect.objectContaining({ event: 'clarify.requested' }))
    if (surface === 'socket') {
      await handlers.get('clarify.respond')?.({ session_id: 'session-1', clarify_id: payload.clarify_id, response: 'custom-folder' })
    } else {
      expect(server.respondCodingAgentClarification('session-1', payload.clarify_id, 'custom-folder')).toBe(true)
    }
    await expect(result).resolves.toMatchObject({ response: 'custom-folder', reason: 'response' })
    expect(state.events).not.toContainEqual(expect.objectContaining({ event: 'clarify.requested' }))
    expect(respondToEkkoClarificationMock).not.toHaveBeenCalled()
    expect(bridgeMock.clarifyRespond).not.toHaveBeenCalled()
  })

  it('settles MCP questions when a coding run stops and rejects expired contexts', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const state = { isWorking: true, activeRunMarker: 'mcp-turn', events: [], profile: 'default' }
    ;(server as any).sessionMap.set('session-1', state)
    ;(server as any).clarificationRuns.begin('mcp-context', 'session-1', 'default', () => state)
    const result = server.requestClarification('mcp-context', 'default', { question: 'Q' })
    server.emitExternalEvent('session-1', 'abort.completed', {})
    await expect(result).resolves.toMatchObject({ reason: 'cancelled' })
    expect(() => server.requestClarification('mcp-context', 'default', { question: 'Old Q' })).toThrow('expired')
  })

  it('routes Ekko clarification responses without calling the Hermes bridge', async () => {
    respondToEkkoClarificationMock.mockReturnValueOnce({ handled: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'ekko-clarify-1',
      response: 'B',
    })

    expect(respondToEkkoClarificationMock).toHaveBeenCalledWith(
      'session-1',
      'ekko-clarify-1',
      'B',
    )
    expect(bridgeMock.clarifyRespond).not.toHaveBeenCalled()
  })

  it('forwards clarify.respond events to the bridge and emits clarify.resolved', async () => {
    bridgeMock.clarifyRespond.mockResolvedValue({ ok: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, namespace, namespaceEmit, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option A',
    })

    expect(bridgeMock.clarifyRespond).toHaveBeenCalledWith('clarify-1', 'Use option A')
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      resolved: true,
    })
  })

  it('does not replay answered clarify prompts when the session resumes', async () => {
    bridgeMock.clarifyRespond.mockResolvedValue({ ok: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = createSocketHarness()
    const server = new ChatRunSocket(io as any)
    const toolEvent = {
      event: 'tool.started',
      data: { event: 'tool.started', tool_call_id: 'tool-1' },
    }
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      events: [
        {
          event: 'clarify.requested',
          data: {
            event: 'clarify.requested',
            clarify_id: 'clarify-1',
            question: 'Pick one',
          },
        },
        toolEvent,
      ],
      queue: [],
    })

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option A',
    })
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect((server as any).sessionMap.get('session-1').events).toEqual([toolEvent])
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: true,
      events: [toolEvent],
    }))
  })

  it('emits an unresolved clarify result when the bridge rejects the response', async () => {
    bridgeMock.clarifyRespond.mockRejectedValue(new Error('unknown clarify request'))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, namespaceEmit, socket } = createSocketHarness()
    const namespace = {
      adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
      to: vi.fn(() => ({ emit: namespaceEmit })),
      use: vi.fn(),
      on: vi.fn(),
    }
    const server = new ChatRunSocket({ of: vi.fn(() => namespace) } as any)

    ;(server as any).onConnection(socket)
    await handlers.get('clarify.respond')?.({
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      response: 'Use option B',
    })

    expect(namespaceEmit).toHaveBeenCalledWith('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: 'session-1',
      clarify_id: 'clarify-1',
      resolved: false,
      error: 'unknown clarify request',
    })
  })
})
