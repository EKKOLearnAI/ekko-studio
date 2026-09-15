import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async (): Promise<any> => undefined))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const ekkoBoundaryInterruptMock = vi.hoisted(() => vi.fn())
const codingAgentRunManagerMock = vi.hoisted(() => ({
  interruptForQueueInsertion: vi.fn(),
  resolveApproval: vi.fn(() => ({ handled: false, resolved: false })),
  resolveClarification: vi.fn(() => ({ handled: false, resolved: false })),
  stop: vi.fn(),
}))
const sessionCommandMocks = vi.hoisted(() => ({
  handleSessionCommand: vi.fn(),
  isSessionCommand: vi.fn(() => false),
  parseSessionCommand: vi.fn(() => null),
}))
const bridgeMock = vi.hoisted(() => ({
  status: vi.fn(),
  statusIfLoaded: vi.fn(),
  interrupt: vi.fn(),
  requestBoundaryInterrupt: vi.fn(),
  approvalRespond: vi.fn(),
}))
const sessionStoreMocks = vi.hoisted(() => ({
  clearSessionMessages: vi.fn(),
}))
const listWorkspaceRunChangesForAssistantMessagesMock = vi.hoisted(() => vi.fn(() => []))

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

vi.mock('../../packages/server/src/modules/studio/services/chat-run/session-command', () => sessionCommandMocks)

vi.mock('../../packages/server/src/modules/hermes/services/bridge/index', () => ({
  AgentBridgeClient: vi.fn(() => bridgeMock),
}))

vi.mock('../../packages/server/src/modules/hermes/services/bridge/manager', () => ({
  getAgentBridgeManager: vi.fn(() => ({
    ensureReady: ensureReadyMock,
  })),
}))

vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  getGlobalEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: ekkoBoundaryInterruptMock })),
  hasGlobalEkkoBackgroundTasks: vi.fn(() => false),
  abortGlobalEkkoBackgroundTasks: vi.fn(async () => 0),
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(async () => {}), ensureReady: ensureReadyMock })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: codingAgentRunManagerMock,
  handleChatCodingAgentSessionCommand: sessionCommandMocks.handleSessionCommand,
  parseChatCodingAgentSessionCommand: sessionCommandMocks.parseSessionCommand,
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: ekkoBoundaryInterruptMock })),
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
  clearSessionMessages: sessionStoreMocks.clearSessionMessages,
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default', source: 'cli' })),
  getSessionMetadata: vi.fn(() => ({
    id: 'session-1',
    profile: 'default',
    source: 'cli',
    model: 'gpt-5.5',
    provider: 'openai',
    api_mode: 'responses',
    reasoning_effort: 'high',
    push_enabled: 1,
  })),
  getSessionDetail: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/workspace-run-changes-store', () => ({
  listWorkspaceRunChangesForAssistantMessages: listWorkspaceRunChangesForAssistantMessagesMock,
}))

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

function makeServerHarness() {
  const handlers = new Map<string, Function>()
  const sockets = new Map<string, any>()
  const roomEmit = vi.fn()
  const namespace = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    sockets,
    emit: vi.fn(),
    to: vi.fn(() => ({ emit: roomEmit })),
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
  sockets.set(socket.id, socket)
  return { handlers, io, namespace, roomEmit, socket }
}

describe('ChatRunSocket queued bridge runs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listWorkspaceRunChangesForAssistantMessagesMock.mockReset()
    listWorkspaceRunChangesForAssistantMessagesMock.mockReturnValue([])
    ensureReadyMock.mockResolvedValue({
      reachable: true,
      status: 'ready',
      endpoint: 'ipc:///tmp/hermes-agent-bridge.sock',
    })
    bridgeMock.statusIfLoaded.mockResolvedValue({ ok: true, exists: false, running: false, loaded: false })
    bridgeMock.interrupt.mockResolvedValue({ ok: true })
    bridgeMock.requestBoundaryInterrupt.mockResolvedValue({
      ok: true,
      status: 'accepted',
      session_id: 'session-1',
      run_id: 'run-1',
      phase: 'tool_batch',
      guarantee: 'strict',
    })
    ekkoBoundaryInterruptMock.mockReturnValue({
      status: 'accepted', runId: 'run-ekko', phase: 'model',
    })
    codingAgentRunManagerMock.interruptForQueueInsertion.mockReturnValue({
      status: 'interrupted', runId: 'run-codex', responseId: 'response-codex',
    })
    bridgeMock.approvalRespond.mockResolvedValue({ resolved: true })
    sessionStoreMocks.clearSessionMessages.mockReturnValue(2)
    loadSessionStateFromDbMock.mockResolvedValue({
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    })
  })

  it('acknowledges a persisted coding-agent submission with its queue identity', async () => {
    handleCodingAgentRunMock.mockResolvedValueOnce({
      runId: 'coding-run-1',
      messageId: 'stored-message-1',
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    await handlers.get('run')?.({
      session_id: 'session-1',
      input: 'annotation context',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'annotation-message-1',
    })

    expect(socket.emit).toHaveBeenCalledWith('run.accepted', {
      event: 'run.accepted',
      session_id: 'session-1',
      run_id: 'coding-run-1',
      queue_id: 'annotation-message-1',
    })
  })

  it('promotes a selected queued Hermes message and arms one strict boundary request', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, roomEmit, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, isAborting: false, events: [],
      source: 'cli', webhookAgent: 'bridge', profile: 'default', runId: 'run-1',
      queue: [
        { queue_id: 'queue-first', input: 'first', profile: 'default', source: 'cli' },
        { queue_id: 'queue-selected', input: 'selected', profile: 'default', source: 'cli' },
      ],
    })

    handlers.get('insert_queued_run')?.({ session_id: 'session-1', queue_id: 'queue-selected' })

    await vi.waitFor(() => expect(bridgeMock.requestBoundaryInterrupt).toHaveBeenCalledOnce())
    expect(bridgeMock.requestBoundaryInterrupt).toHaveBeenCalledWith('session-1', 'run-1', 'default')
    expect((server as any).sessionMap.get('session-1').queue.map((item: any) => item.queue_id))
      .toEqual(['queue-selected', 'queue-first'])
    expect((server as any).sessionMap.get('session-1').queueInsertion).toEqual(expect.objectContaining({
      queueId: 'queue-selected',
      runId: 'run-1',
      runtime: 'hermes',
      phase: 'waiting_for_tool_batch',
      guarantee: 'strict',
    }))
    expect(roomEmit).toHaveBeenCalledWith('run.queued', expect.objectContaining({
      queued_messages: [
        expect.objectContaining({ id: 'queue-selected', content: 'selected' }),
        expect.objectContaining({ id: 'queue-first', content: 'first' }),
      ],
    }))
    expect(roomEmit).toHaveBeenCalledWith('run.queue_insertion.updated', expect.objectContaining({
      queue_id: 'queue-selected',
      phase: 'waiting_for_tool_batch',
      guarantee: 'strict',
    }))
  })

  it('deduplicates rapid queue insertion clicks for the same active run', async () => {
    let resolveBoundary!: (value: any) => void
    bridgeMock.requestBoundaryInterrupt.mockImplementationOnce(() => new Promise(resolve => { resolveBoundary = resolve }))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, events: [], source: 'cli', webhookAgent: 'bridge',
      profile: 'default', runId: 'run-1',
      queue: [
        { queue_id: 'queue-first', input: 'first', profile: 'default', source: 'cli' },
        { queue_id: 'queue-second', input: 'second', profile: 'default', source: 'cli' },
      ],
    })

    handlers.get('insert_queued_run')?.({ session_id: 'session-1', queue_id: 'queue-first' })
    handlers.get('insert_queued_run')?.({ session_id: 'session-1', queue_id: 'queue-second' })
    await vi.waitFor(() => expect(bridgeMock.requestBoundaryInterrupt).toHaveBeenCalledOnce())
    expect((server as any).sessionMap.get('session-1').queue.map((item: any) => item.queue_id))
      .toEqual(['queue-first', 'queue-second'])

    resolveBoundary({
      ok: true, status: 'accepted', session_id: 'session-1', run_id: 'run-1',
      phase: 'model', guarantee: 'strict',
    })
    await vi.waitFor(() => expect((server as any).sessionMap.get('session-1').queueInsertion.phase)
      .toBe('stopping_current_turn'))
  })

  it('tags a Bridge run.failed terminal event as an intentional queue insertion stop', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, events: [], source: 'cli', webhookAgent: 'bridge',
      profile: 'default', runId: 'run-1',
      queue: [{ queue_id: 'queue-next', input: 'next', profile: 'default', source: 'cli' }],
      queueInsertion: {
        generation: 'generation-1', queueId: 'queue-next', runId: 'run-1', runtime: 'hermes',
        phase: 'stopping_current_turn', guarantee: 'strict', requestedAt: 123,
      },
    })
    const payload = {
      event: 'run.failed',
      run_id: 'run-1',
      error: 'Agent reported failure',
      queue_remaining: 1,
    }

    ;(server as any).observeQueueInsertionRunEvent('session-1', 'run.failed', payload)

    expect(payload).toEqual(expect.objectContaining({
      interrupted: true,
      stop_reason: 'queue_insertion',
      boundary_guarantee: 'strict',
    }))
  })

  it('immediately interrupts a Codex run before starting the selected queued message', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, events: [], source: 'coding_agent', webhookAgent: 'codex',
      profile: 'default', runId: 'run-codex',
      queue: [{ queue_id: 'queue-codex', input: 'later', profile: 'default', source: 'coding_agent' }],
    })

    handlers.get('insert_queued_run')?.({ session_id: 'session-1', queue_id: 'queue-codex' })
    await vi.waitFor(() => expect(codingAgentRunManagerMock.interruptForQueueInsertion).toHaveBeenCalledOnce())

    expect(bridgeMock.requestBoundaryInterrupt).not.toHaveBeenCalled()
    expect(codingAgentRunManagerMock.interruptForQueueInsertion)
      .toHaveBeenCalledWith('session-1', 'run-codex')
    expect((server as any).sessionMap.get('session-1').queueInsertion).toEqual(expect.objectContaining({
      queueId: 'queue-codex',
      runtime: 'codex',
      phase: 'stopping_current_turn',
      guarantee: 'immediate',
    }))

    server.markExternalRunCompleted('session-1', 'run.failed')
    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalledOnce())
    expect(handleCodingAgentRunMock.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      session_id: 'session-1',
      input: 'later',
    }))
    expect((server as any).sessionMap.get('session-1')).toEqual(expect.objectContaining({
      queue: [],
      queueInsertion: undefined,
      isWorking: true,
    }))
  })

  it('routes Ekko and Global Agent queue insertion through the Ekko-owned boundary', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, events: [], source: 'coding_agent', webhookAgent: 'ekko',
      profile: 'default', runId: 'run-ekko',
      queue: [{
        queue_id: 'queue-global-ekko', input: 'follow up', profile: 'default',
        source: 'coding_agent', sessionSource: 'global_agent', codingAgentId: 'ekko-agent',
      }],
    })

    handlers.get('insert_queued_run')?.({ session_id: 'session-1', queue_id: 'queue-global-ekko' })

    await vi.waitFor(() => expect(ekkoBoundaryInterruptMock).toHaveBeenCalledOnce())
    expect(ekkoBoundaryInterruptMock).toHaveBeenCalledWith({
      sessionId: 'session-1', expectedRunId: 'run-ekko',
    })
    expect((server as any).sessionMap.get('session-1').queueInsertion).toEqual(expect.objectContaining({
      runtime: 'ekko', phase: 'stopping_current_turn', queueId: 'queue-global-ekko',
    }))
  })

  it('broadcasts insertion completion before dequeuing the selected message', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, roomEmit, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, events: [], source: 'cli', profile: 'default', runId: 'run-1',
      queue: [{ queue_id: 'queue-selected', input: 'selected', profile: 'default', source: 'cli' }],
      queueInsertion: {
        generation: 'generation-1', queueId: 'queue-selected', runId: 'run-1', runtime: 'hermes',
        phase: 'waiting_for_tool_batch', guarantee: 'strict', requestedAt: 123,
      },
    })

    expect((server as any).dequeueNextQueuedRun(socket, 'session-1', 'default')).toBe(true)

    expect(roomEmit).toHaveBeenCalledWith('run.queue_insertion.updated', expect.objectContaining({
      generation: 'generation-1', queue_id: 'queue-selected', phase: 'starting_queued_message',
    }))
    expect((server as any).sessionMap.get('session-1').queueInsertion).toBeUndefined()
    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    expect(handleBridgeRunMock.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      queue_id: 'queue-selected', input: 'selected',
    }))
  })

  it('restores the authoritative insertion phase when another page resumes the session', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, isAborting: false, events: [], source: 'cli', profile: 'default',
      runId: 'run-1',
      queue: [{ queue_id: 'queue-selected', input: 'selected', profile: 'default', source: 'cli' }],
      queueInsertion: {
        generation: 'generation-1', queueId: 'queue-selected', runId: 'run-1', runtime: 'hermes',
        phase: 'waiting_for_tool_batch', guarantee: 'strict', requestedAt: 123,
      },
    })
    ;(server as any).onConnection(socket)

    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      queueInsertion: {
        generation: 'generation-1', run_id: 'run-1', queue_id: 'queue-selected', runtime: 'hermes',
        phase: 'waiting_for_tool_batch', guarantee: 'strict', requested_at: 123,
      },
    }))
  })

  it('dispatches unknown slash bridge input through the normal bridge run path', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)

    sessionCommandMocks.parseSessionCommand.mockReturnValueOnce(null)
    sessionCommandMocks.isSessionCommand.mockReturnValueOnce(false)

    await handlers.get('run')?.({
      session_id: 'session-1',
      input: '/terminal pwd',
      source: 'cli',
      queue_id: 'queue-terminal',
      profile: 'default',
    })

    expect(sessionCommandMocks.parseSessionCommand).toHaveBeenCalledWith('/terminal pwd')
    expect(sessionCommandMocks.handleSessionCommand).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: '/terminal pwd',
      source: 'cli',
      queue_id: 'queue-terminal',
    }))
    expect(call[6]).toBe(false)
  })

  it('persists normal queued bridge messages when they are dequeued', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-normal',
      input: 'queued follow-up',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: 'queued follow-up',
      display_input: undefined,
      storage_message: undefined,
      queue_id: 'queue-normal',
    }))
    expect(call[6]).toBe(false)
  })

  it('preserves response annotation display and storage envelopes through queue dequeue', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const displayInput = '{"__hermes_studio_response_annotations__":1}'
    const storageMessage = '<response_annotations>quoted context</response_annotations>'

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-annotation', input: storageMessage, displayInput,
      storageMessage, source: 'cli', profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    expect(handleBridgeRunMock.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      input: storageMessage,
      display_input: displayInput,
      storage_message: storageMessage,
      queue_id: 'queue-annotation',
    }))
  })

  it('supports bridge peer broadcasts during runAndWait workflow runs', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, socket, data) => {
      socket.to(`session:${data.session_id}`).emit('run.peer_user_message', {
        event: 'run.peer_user_message',
        session_id: data.session_id,
      })
      data.onEvent?.('run.completed', {
        run_id: 'run-workflow-1',
        output: 'done',
      })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'workflow node',
      source: 'workflow',
      session_source: 'workflow',
    }, { profile: 'default' })

    expect(result).toMatchObject({
      ok: true,
      run_id: 'run-workflow-1',
      output: 'done',
    })
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it('notifies an optional runAndWait observer without changing accumulated output', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('reasoning.delta', { delta: 'thought' })
      data.onEvent?.('message.delta', { delta: 'answer' })
      data.onEvent?.('run.completed', { run_id: 'run-observed', output: 'answer' })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const onEvent = vi.fn()

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'observed workflow node',
      source: 'workflow',
      session_source: 'workflow',
    }, { profile: 'default', onEvent })

    expect(onEvent.mock.calls.map(call => call[0])).toEqual([
      'reasoning.delta',
      'message.delta',
      'run.completed',
    ])
    expect(result).toMatchObject({
      ok: true,
      run_id: 'run-observed',
      output: 'answer',
      reasoning: 'thought',
    })
  })

  it('auto-responds once to approvals only when runAndWait enables it', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('approval.requested', {
        run_id: 'run-workflow-approval',
        approval_id: 'approval-1',
        choices: ['once', 'session', 'deny'],
      })
      data.onEvent?.('run.completed', {
        run_id: 'run-workflow-approval',
        output: 'approved',
      })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'workflow node',
      source: 'workflow',
      session_source: 'workflow',
    }, { profile: 'default', approvalChoice: 'once' })

    expect(result).toMatchObject({
      ok: true,
      run_id: 'run-workflow-approval',
      output: 'approved',
    })
    expect(bridgeMock.approvalRespond).toHaveBeenCalledWith('approval-1', 'once')
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it('does not auto-respond to approvals for normal runAndWait calls', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('approval.requested', {
        run_id: 'run-normal-approval',
        approval_id: 'approval-normal',
        choices: ['once', 'session', 'deny'],
      })
      data.onEvent?.('run.completed', {
        run_id: 'run-normal-approval',
        output: 'manual approval path',
      })
    })

    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    const result = await server.runAndWait({
      session_id: 'session-1',
      input: 'normal node',
      source: 'cli',
    }, { profile: 'default' })

    expect(result.ok).toBe(true)
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
  })

  it('persists the visible plan command when dequeuing expanded plan command runs', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).runQueuedItem(socket, 'session-1', {
      queue_id: 'queue-plan',
      input: '[IMPORTANT: expanded plan skill prompt]',
      displayInput: '/plan build the feature',
      displayRole: 'command',
      storageMessage: '/plan build the feature',
      source: 'cli',
      profile: 'default',
    }, 'default')

    await vi.waitFor(() => expect(handleBridgeRunMock).toHaveBeenCalled())
    const call = handleBridgeRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: '[IMPORTANT: expanded plan skill prompt]',
      display_input: '/plan build the feature',
      display_role: 'command',
      storage_message: '/plan build the feature',
      queue_id: 'queue-plan',
    }))
    expect(call[6]).toBe(false)
  })

  it('queues coding-agent messages while a coding-agent turn is active', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, namespace, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      source: 'coding_agent',
    })

    await handlers.get('run')?.({
      session_id: 'session-1',
      input: 'queued codex follow-up',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'queue-codex',
      model: 'gpt-5-codex',
      provider: 'openai-codex',
      profile: 'default',
    })

    expect(handleCodingAgentRunMock).not.toHaveBeenCalled()
    expect((server as any).sessionMap.get('session-1').queue).toEqual([
      expect.objectContaining({
        queue_id: 'queue-codex',
        input: 'queued codex follow-up',
        source: 'coding_agent',
        codingAgentId: 'codex',
      }),
    ])
    expect(namespace.to).toHaveBeenCalledWith('session:session-1')
  })

  it('dequeues coding-agent messages when an external coding-agent run completes', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [{
        queue_id: 'queue-codex',
        input: 'queued codex follow-up',
        source: 'coding_agent',
        codingAgentId: 'codex',
        model: 'gpt-5-codex',
        provider: 'openai-codex',
        profile: 'default',
        originSocketId: socket.id,
      }],
      source: 'coding_agent',
    })

    ;(server as any).markExternalRunCompleted('session-1', 'run.completed')

    await vi.waitFor(() => expect(handleCodingAgentRunMock).toHaveBeenCalled())
    const call = handleCodingAgentRunMock.mock.calls.at(-1)!
    expect(call[2]).toEqual(expect.objectContaining({
      input: 'queued codex follow-up',
      source: 'coding_agent',
      coding_agent_id: 'codex',
      queue_id: 'queue-codex',
    }))
    expect((server as any).sessionMap.get('session-1').queue).toEqual([])
  })

  it('checks bridge resume status without cold-starting the profile worker', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(bridgeMock.statusIfLoaded).toHaveBeenCalledWith('session-1', 'default', { timeoutMs: 1000 })
    expect(bridgeMock.status).not.toHaveBeenCalled()
    expect(resumeBridgeRunMock).not.toHaveBeenCalled()
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      isWorking: false,
      model: 'gpt-5.5',
      provider: 'openai',
      api_mode: 'responses',
      reasoning_effort: 'high',
      push_enabled: true,
    }))
  })

  it('serves App resume messages once and then accepts their cache id', async () => {
    listWorkspaceRunChangesForAssistantMessagesMock.mockReturnValue([{
      change_id: 'change-1',
      assistant_message_id: '2',
      files: [],
    }])
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', {
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'session-1', role: 'assistant', content: 'world', timestamp: 2 },
      ],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    })

    ;(server as any).onConnection(socket)
    await handlers.get('app.resume')?.({ session_id: 'session-1', id: '' })
    const initial = socket.emit.mock.calls.find(([event]) => event === 'app.resumed')?.[1]

    expect(initial).toMatchObject({
      session_id: 'session-1',
      messages: expect.any(Array),
      workspaceRunChanges: [expect.objectContaining({ change_id: 'change-1' })],
      messagesCached: false,
    })
    expect(initial.id).toMatch(/^[a-f0-9]{32}$/)
    expect(socket.join).toHaveBeenCalledWith('session:session-1')

    socket.emit.mockClear()
    await handlers.get('app.resume')?.({ session_id: 'session-1', id: initial.id })

    expect(socket.emit).toHaveBeenCalledWith('app.resumed', expect.objectContaining({
      session_id: 'session-1',
      id: initial.id,
      messagesCached: true,
    }))
    const cached = socket.emit.mock.calls.find(([event]) => event === 'app.resumed')?.[1]
    expect(cached).not.toHaveProperty('messages')
    expect(cached).not.toHaveProperty('workspaceRunChanges')

    listWorkspaceRunChangesForAssistantMessagesMock.mockReturnValue([{
      change_id: 'change-2',
      assistant_message_id: '2',
      files: [],
    }])
    socket.emit.mockClear()
    await handlers.get('app.resume')?.({ session_id: 'session-1', id: initial.id })

    const changedDiff = socket.emit.mock.calls.find(([event]) => event === 'app.resumed')?.[1]
    expect(changedDiff).toMatchObject({
      messagesCached: false,
      workspaceRunChanges: [expect.objectContaining({ change_id: 'change-2' })],
    })
    expect(changedDiff.id).not.toBe(initial.id)
  })

  it('reattaches a loaded running bridge run during resume', async () => {
    bridgeMock.statusIfLoaded.mockResolvedValueOnce({
      ok: true,
      exists: true,
      running: true,
      current_run_id: 'run-1',
      loaded: true,
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'session-1' })

    expect(resumeBridgeRunMock).toHaveBeenCalledWith(
      expect.anything(),
      socket,
      expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        profile: 'default',
      }),
      expect.any(Map),
      bridgeMock,
      expect.any(Function),
    )
  })

  it('clears chat-run memory state when an external MCU clear removes history', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abortController = new AbortController()
    ;(server as any).sessionMap.set('session-1', {
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'old', timestamp: 1 },
      ],
      messageTotal: 1,
      messageLoadedCount: 1,
      messagePageLimit: 50,
      hasMoreBefore: false,
      isWorking: true,
      isAborting: false,
      events: [{ event: 'message.delta', data: { session_id: 'session-1', delta: 'old' } }],
      queue: [{
        queue_id: 'q1',
        input: 'next',
        profile: 'default',
      }],
      abortController,
      runId: 'run-1',
      activeRunMarker: 'marker-1',
      profile: 'default',
      source: 'global_agent',
      inputTokens: 10,
      outputTokens: 5,
      contextTokens: 15,
      bridgePendingAssistantContent: 'old',
      bridgeOutput: 'old',
    })
    const abortSpy = vi.spyOn(abortController, 'abort')

    const result = server.clearSessionHistory('session-1')

    expect(result).toEqual({ deleted: 2, hadMemoryState: true })
    expect(sessionStoreMocks.clearSessionMessages).toHaveBeenCalledWith('session-1')
    expect(abortSpy).toHaveBeenCalled()
    expect(bridgeMock.interrupt).toHaveBeenCalledWith('session-1', 'Session cleared', 'default')
    expect((server as any).sessionMap.has('session-1')).toBe(false)
    expect(namespace.emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      event: 'session.command',
      session_id: 'session-1',
      action: 'clear',
      clearHistory: true,
      deleted: 2,
    }))
    expect(namespace.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      messages: [],
      messageTotal: 0,
      isWorking: false,
      queueLength: 0,
    }))
  })
  it('aborts the underlying runner when runAndWait reaches its timeout', async () => {
    vi.useFakeTimers()
    handleBridgeRunMock.mockImplementationOnce(async () => new Promise(() => {}))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abortSpy = vi.spyOn(server, 'abortSession').mockResolvedValue(undefined)
    try {
      const resultPromise = server.runAndWait({
        session_id: 'session-1', input: 'slow workflow node', source: 'workflow', session_source: 'workflow',
      }, { profile: 'default', timeoutMs: 25 })
      await vi.advanceTimersByTimeAsync(25)
      await expect(resultPromise).resolves.toMatchObject({ ok: false, error: 'chat-run timed out after 25ms' })
      expect(abortSpy).toHaveBeenCalledWith('session-1', 'chat-run timed out after 25ms')
    } finally { vi.useRealTimers() }
  })

})
