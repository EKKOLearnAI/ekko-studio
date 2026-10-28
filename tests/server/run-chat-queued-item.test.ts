import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const readSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const refreshContextUsageAfterDeletionMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/services/chat-run/context-usage', () => ({
  getSessionContextOverhead: vi.fn(() => 12_000),
  refreshContextUsageAfterDeletion: refreshContextUsageAfterDeletionMock,
}))
const ensureReadyMock = vi.hoisted(() => vi.fn())
const ekkoBoundaryInterruptMock = vi.hoisted(() => vi.fn())
const respondToEkkoToolApprovalMock = vi.hoisted(() => vi.fn(() => ({ handled: false, resolved: false })))
const codingAgentRunManagerMock = vi.hoisted(() => ({
  waitForSessionExit: vi.fn(async () => {}),
  hasSession: vi.fn(() => false),
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
  cancelBoundaryInterrupt: vi.fn(async () => ({ status: 'cancelled' })),
  completeBackgroundNotification: vi.fn(async () => ({ completed: true })),
  approvalRespond: vi.fn(),
}))
const sessionStoreMocks = vi.hoisted(() => ({
  clearSessionMessages: vi.fn(),
}))
const deleteMessageGroupsMock = vi.hoisted(() => vi.fn())
vi.mock('../../packages/server/src/modules/studio/repositories/session-message-deletion', () => ({
  deleteSessionMessageGroups: deleteMessageGroupsMock,
}))
const listWorkspaceRunChangesForAssistantMessagesMock = vi.hoisted(() => vi.fn(() => []))

vi.mock('../../packages/server/src/modules/studio/services/task-plans', () => ({
  getSessionTaskPlans: vi.fn(() => []),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run', () => ({
  handleBridgeRun: handleBridgeRunMock,
  resumeBridgeRun: resumeBridgeRunMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/load-state', () => ({
  loadSessionStateFromDb: loadSessionStateFromDbMock,
  readSessionStateFromDb: readSessionStateFromDbMock,
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
  getChatCodingAgentMcpServers: vi.fn(() => ({ 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } })),
  resolveChatEkkoMcpServers: vi.fn(() => ({ 'ekko-studio-use': { command: 'studio' } })),
  createPrimaryAgentBridge: vi.fn(() => bridgeMock),
  getPrimaryAgentBridgeManager: vi.fn(() => ({ start: vi.fn(async () => {}), ensureReady: ensureReadyMock })),
  redactPrimaryAgentBridgeError: (error?: string) => error,
  chatCodingAgentRunManager: codingAgentRunManagerMock,
  handleChatCodingAgentSessionCommand: sessionCommandMocks.handleSessionCommand,
  parseChatCodingAgentSessionCommand: sessionCommandMocks.parseSessionCommand,
  getChatEkkoAgent: vi.fn(() => ({ requestBoundaryInterrupt: ekkoBoundaryInterruptMock })),
  hasChatEkkoBackgroundTasks: vi.fn(() => false),
  respondToChatEkkoToolApproval: respondToEkkoToolApprovalMock,
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
  readConfigYamlForProfile: vi.fn(async () => ({ mcp_servers: { 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } } })),
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
    respondToEkkoToolApprovalMock.mockReset().mockReturnValue({ handled: false, resolved: false })
    readSessionStateFromDbMock.mockImplementation(() => ({ messages: [], isWorking: false, events: [], queue: [] }))
    refreshContextUsageAfterDeletionMock.mockReturnValue(18_000)
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

  it.each([
    { event: 'run.completed', isAborting: false, payload: { result: { interrupted: true, boundary_interrupt: true } }, expected: 'ended' },
    { event: 'run.completed', isAborting: false, payload: { interrupted: true }, expected: 'ended' },
    { event: 'run.failed', isAborting: false, payload: { interrupted: true }, expected: 'failed' },
    { event: 'abort.completed', isAborting: false, payload: {}, expected: 'interrupted' },
    { event: 'run.completed', isAborting: true, payload: {}, expected: 'interrupted' },
  ])('settles task plans from Stop state, not stale runtime flags: $event/$expected', async ({ event, isAborting, payload, expected }) => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', { isWorking: true, isAborting, events: [], queue: [] })
    const finish = vi.spyOn((server as any).taskPlanRuns, 'finishSession').mockImplementation(() => {})
    ;(server as any).finishTaskPlanRun('session-1', event, payload)
    expect(finish).toHaveBeenCalledWith('session-1', expected)
  })

  it('drops a queued shared message when its execution-time authorization fails', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket, roomEmit } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const authorize = vi.fn(async () => { throw new Error('share_revoked') })
    ;(server as any).sessionMap.set('session-1', { isWorking: true, events: [], queue: [] })
    ;(server as any).runQueuedItem(socket, 'session-1', { queue_id: 'revoked-queue', input: 'blocked', profile: 'default', authorize })
    await vi.waitFor(() => expect(roomEmit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ queue_id: 'revoked-queue', error: 'share_access_denied' })))
    expect(handleBridgeRunMock).not.toHaveBeenCalled()
    expect((server as any).sessionMap.get('session-1').isWorking).toBe(false)
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

  it('recalls a cancelled queue insertion even when its acknowledgement arrives late', async () => {
    let resolveBoundary!: (value: any) => void
    bridgeMock.requestBoundaryInterrupt.mockImplementationOnce(() => new Promise(resolve => { resolveBoundary = resolve }))
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).onConnection(socket)
    ;(server as any).sessionMap.set('session-1', {
      messages: [], isWorking: true, events: [], source: 'cli', webhookAgent: 'bridge',
      profile: 'default', runId: 'run-1',
      queue: [{ queue_id: 'q', input: 'queued', profile: 'default', source: 'cli' }],
    })
    handlers.get('insert_queued_run')?.({ session_id: 'session-1', queue_id: 'q' })
    await vi.waitFor(() => expect(bridgeMock.requestBoundaryInterrupt).toHaveBeenCalledOnce())
    handlers.get('cancel_queued_run')?.({ session_id: 'session-1', queue_id: 'q' })
    expect(bridgeMock.cancelBoundaryInterrupt).not.toHaveBeenCalled()
    resolveBoundary({ status: 'accepted', phase: 'tool_batch' })
    await vi.waitFor(() => expect(bridgeMock.cancelBoundaryInterrupt).toHaveBeenCalledTimes(2))
    expect((server as any).sessionMap.get('session-1').queueInsertion).toBeUndefined()
  })

  it.each([false, true])('settles an old cancellation before arming a new insertion (reject=%s)', async rejectCancel => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server: any = new ChatRunSocket(io as any)
    server.onConnection(socket)
    let boundaryPending = false
    let settleCancel!: () => void
    bridgeMock.requestBoundaryInterrupt.mockImplementation(async () => {
      const status = boundaryPending ? 'already_pending' : 'accepted'
      boundaryPending = true
      return { status, phase: 'tool_batch' }
    })
    bridgeMock.cancelBoundaryInterrupt.mockImplementationOnce(() => new Promise((resolve, reject) => {
      settleCancel = () => {
        boundaryPending = false
        if (rejectCancel) reject(new Error('cancel response unavailable'))
        else resolve({ status: 'cancelled' })
      }
    }))
    const state = {
      messages: [], isWorking: true, events: [], source: 'cli', webhookAgent: 'bridge',
      profile: 'default', runId: 'run-1',
      queue: [{ queue_id: 'a', input: 'old', profile: 'default', source: 'cli' }],
    }
    server.sessionMap.set('session-1', state)
    await server.requestQueuedRunInsertion('session-1', 'a')
    handlers.get('cancel_queued_run')?.({ session_id: 'session-1', queue_id: 'a' })
    await vi.waitFor(() => expect(bridgeMock.cancelBoundaryInterrupt).toHaveBeenCalledOnce())
    state.queue.push({ queue_id: 'b', input: 'new', profile: 'default', source: 'cli' })
    const insertion = server.requestQueuedRunInsertion('session-1', 'b')
    await Promise.resolve()
    expect(bridgeMock.requestBoundaryInterrupt).toHaveBeenCalledTimes(1)
    settleCancel()
    await insertion
    expect(bridgeMock.requestBoundaryInterrupt).toHaveBeenCalledTimes(2)
    expect(boundaryPending).toBe(true)
    expect(server.sessionMap.get('session-1').queueInsertion).toMatchObject({
      queueId: 'b', phase: 'waiting_for_tool_batch',
    })
  })

  it('acknowledges a late background completion instead of restarting a stopped session', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server: any = new ChatRunSocket(io as any)
    server.sessionMap.set('session-1', {
      messages: [], events: [], queue: [], isWorking: false, backgroundWakeStopped: true,
    })
    const run = vi.spyOn(server, 'runQueuedItem')
    await server.scheduleBackgroundNotification({
      session_id: 'session-1', delegation_id: 'd', claim_id: 'c', profile: 'default', message: 'wake',
    })
    expect(bridgeMock.completeBackgroundNotification).toHaveBeenCalledWith('session-1', 'default', 'd', 'c')
    expect(run).not.toHaveBeenCalled()
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

  it.each(['socket', 'internal'])('rejects an unconfigured Person Agent before dispatch through the %s entry', async entry => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const personStore = await import('../../packages/server/src/modules/studio/repositories/person-store')
    const settings = vi.spyOn(personStore, 'personSettings').mockReturnValue({ settings: { agents: [] } } as any)
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    socket.data = { user: { id: 1, role: 'super_admin' } }
    ;(server as any).onConnection(socket)
    vi.mocked(sessions.getSession).mockReturnValueOnce({ id: 'person-main-1', studio_user_id: '1', profile: 'default' } as any)
    const input = { session_id: 'person-main-1', input: 'Start a conversation', profile: 'default' }
    try {
      if (entry === 'socket') {
        await handlers.get('run')!(input)
        expect(socket.emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({ error: expect.stringContaining('Configure at least one Agent preset') }))
      } else {
        await expect((server as any).handleRun(socket, input, 'default')).rejects.toThrow('Configure at least one Agent preset')
      }
      expect(handleBridgeRunMock).not.toHaveBeenCalled()
      expect(handleCodingAgentRunMock).not.toHaveBeenCalled()
    } finally { settings.mockRestore() }
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

  it('waits for the original handler and native process even after a terminal event releases runAndWait', async () => {
    let unwind!: () => void, exit!: () => void
    const handlerDone = new Promise<void>(resolve => { unwind = resolve })
    const nativeDone = new Promise<void>(resolve => { exit = resolve })
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent('run.failed', { error: 'Aborted' })
      await handlerDone
    })
    codingAgentRunManagerMock.waitForSessionExit.mockReturnValueOnce(nativeDone)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    expect(await server.runAndWait({ session_id: 'session-1', input: 'Work', source: 'workflow' })).toMatchObject({ ok: false })
    let stopped = false
    const stop = server.abortSession('session-1', 'Stopped', { waitForTermination: true }).then(() => { stopped = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    unwind()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(stopped).toBe(false)
    exit(); await stop
    expect(stopped).toBe(true)
    expect((server as any).runHandlers.size).toBe(0)
  })

  it('auto-responds once to approvals only when runAndWait enables it', async () => {
    handleBridgeRunMock.mockImplementationOnce(async (_nsp, _socket, data) => {
      data.onEvent?.('approval.requested', {
        run_id: 'run-workflow-approval',
        approval_id: 'approval-1',
        choices: ['once', 'session', 'deny'],
      })
      await vi.waitFor(() => expect(bridgeMock.approvalRespond).toHaveBeenCalledWith('approval-1', 'once'))
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

  it('resolves real Ekko approvals once, after the request is published, without invoking another runtime', async () => {
    const { waitForEkkoToolApproval, respondToEkkoToolApproval } = await import('../../packages/server/src/modules/ekko/services/approvals')
    respondToEkkoToolApprovalMock.mockImplementation(respondToEkkoToolApproval)
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, roomEmit } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    vi.spyOn(server as any, 'handleRun').mockImplementation(async (socket: any, data: any) => {
      expect(socket.data.internalToolApprovalChoice).toBe('once')
      const choice = await waitForEkkoToolApproval({
        approvalId: 'ekko-auto-1', toolName: 'terminal_exec', key: 'terminal:delete',
        command: 'rm -rf build', description: 'Delete generated build files',
        choices: ['once', 'session', 'always', 'deny'], allowPermanent: true, timeoutMs: 1000,
      }, {
        sessionId: 'session-1',
        onRequested: request => {
          const payload = { approval_id: request.approvalId, choices: request.choices }
          data.onEvent('approval.requested', payload)
          roomEmit('approval.requested', payload)
          data.onEvent('approval.requested', payload) // A replay must not approve twice.
        },
        onResolved: choice => roomEmit('approval.resolved', { approval_id: 'ekko-auto-1', choice }),
      })
      expect(choice).toBe('once')
      data.onEvent('run.completed', { output: 'Approved by the task host' })
    })
    const result = await server.runAndWait({ session_id: 'session-1', input: 'Work', source: 'builtin_agent' }, { approvalChoice: 'once' })
    expect(result.ok).toBe(true)
    expect(respondToEkkoToolApprovalMock).toHaveBeenCalledExactlyOnceWith('session-1', 'ekko-auto-1', 'once')
    expect(roomEmit.mock.calls[0][0]).toBe('approval.requested')
    expect(roomEmit.mock.calls.slice(1).every(call => call[0] === 'approval.resolved')).toBe(true)
    expect(codingAgentRunManagerMock.resolveApproval).not.toHaveBeenCalled()
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
    expect(respondToEkkoToolApproval('session-1', 'ekko-auto-1', 'once').handled).toBe(false)
  })

  it('keeps Coding Agent automatic approvals on their own runtime', async () => {
    codingAgentRunManagerMock.resolveApproval.mockReturnValueOnce({ handled: true, resolved: true })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    vi.spyOn(server as any, 'handleRun').mockImplementation(async (_socket, data: any) => {
      data.onEvent('approval.requested', { approval_id: 'coding-auto', choices: ['once', 'deny'] })
      await vi.waitFor(() => expect(codingAgentRunManagerMock.resolveApproval).toHaveBeenCalledWith('session-1', 'coding-auto', 'once'))
      data.onEvent('run.completed', { output: 'Done' })
    })
    expect((await server.runAndWait({ session_id: 'session-1', input: 'Work', source: 'coding_agent' }, { approvalChoice: 'once' })).ok).toBe(true)
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
  })

  it.each(['unresolved', 'unsupported', 'error'])('stops a task when automatic approval is %s', async failure => {
    respondToEkkoToolApprovalMock.mockImplementationOnce(() => {
      if (failure === 'error') throw new Error('Approval transport failed')
      return { handled: true, resolved: false }
    })
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const abort = vi.spyOn(server, 'abortSession').mockResolvedValue()
    vi.spyOn(server as any, 'handleRun').mockImplementation(async (_socket, data: any) => {
      data.onEvent('approval.requested', { approval_id: 'unavailable-approval', choices: failure === 'unsupported' ? ['deny'] : ['once', 'deny'] })
    })
    const result = await server.runAndWait({ session_id: 'session-1', input: 'Work' }, { approvalChoice: 'once' })
    expect(result).toMatchObject({ ok: false, event: 'run.failed', error: expect.any(String) })
    expect(abort).toHaveBeenCalledExactlyOnceWith('session-1', result.error)
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
  })

  it.each(['terminal', 'stopping', 'aborted'])('does not approve a late request when the task is %s', async stopState => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    vi.spyOn(server as any, 'handleRun').mockImplementation(async (_socket, data: any) => {
      data.onEvent('approval.requested', { approval_id: 'late-approval', choices: ['once', 'deny'] })
      if (stopState !== 'terminal') {
        const state = (server as any).sessionMap.get('session-1')
        if (stopState === 'stopping') state.isAborting = true
        else { state.abortController = new AbortController(); state.abortController.abort() }
        await Promise.resolve()
      }
      data.onEvent('run.failed', { error: 'Aborted' })
    })
    expect((await server.runAndWait({ session_id: 'session-1', input: 'Work' }, { approvalChoice: 'once' })).ok).toBe(false)
    expect(respondToEkkoToolApprovalMock).not.toHaveBeenCalled()
    expect(codingAgentRunManagerMock.resolveApproval).not.toHaveBeenCalled()
    expect(bridgeMock.approvalRespond).not.toHaveBeenCalled()
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
    expect(respondToEkkoToolApprovalMock).not.toHaveBeenCalled()
    expect(codingAgentRunManagerMock.resolveApproval).not.toHaveBeenCalled()
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

  it.each([
    { isWorking: true }, { isAborting: true }, { isCompressing: true }, { queue: [{ queue_id: 'q' }] },
    { backgroundDelegations: { d: { status: 'delivering' } } },
    { backgroundTasks: { d: { status: 'running' } } },
  ])('rejects deletion during run or pending work: %j', async busy => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', { isWorking: false, queue: [], ...busy })
    await expect(server.assertSessionMessagesEditable('session-1')).rejects.toMatchObject({ status: 409 })
    await expect(server.deleteSessionMessages('session-1', [1], 0)).rejects.toMatchObject({ status: 409 })
    expect(deleteMessageGroupsMock).not.toHaveBeenCalled()
  })

  it('rechecks local activity after checking the Hermes worker', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = { isWorking: false, queue: [] }
    ;(server as any).sessionMap.set('session-1', state)
    bridgeMock.statusIfLoaded.mockImplementationOnce(async () => {
      state.isWorking = true
      return { running: false }
    })
    await expect(server.deleteSessionMessages('session-1', [1], 0)).rejects.toMatchObject({ status: 409 })
    expect(deleteMessageGroupsMock).not.toHaveBeenCalled()
  })

  it('invalidates the cached transcript and broadcasts deletion only after persistence succeeds', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { logger } = await import('../../packages/server/src/modules/studio/public/logging')
    const { io, roomEmit } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('session-1', { isWorking: false, queue: [], messages: [{ id: 1 }] })
    const result = { deleted: 2, deletedGroups: 1, messageIds: [1, 2], historyRevision: 1 }
    deleteMessageGroupsMock.mockImplementationOnce(() => { throw new Error('database failed') })
    await expect(server.deleteSessionMessages('session-1', [1], 0)).rejects.toThrow('database failed')
    expect((server as any).sessionMap.has('session-1')).toBe(true)
    expect(roomEmit).not.toHaveBeenCalledWith('session.command', expect.anything())
    expect(refreshContextUsageAfterDeletionMock).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), '[chat-run-socket] session messages deleted')
    deleteMessageGroupsMock.mockReturnValueOnce(result)
    expect(await server.deleteSessionMessages('session-1', [1], 0)).toEqual({ ...result, contextTokens: 18_000 })
    expect(refreshContextUsageAfterDeletionMock).toHaveBeenCalledWith('session-1', 12_000)
    expect((server as any).sessionMap.has('session-1')).toBe(false)
    expect(logger.info).toHaveBeenCalledWith({
      sessionId: 'session-1', requestedMessageIds: [1], deletedMessageIds: [1, 2],
      deletedGroups: 1, previousHistoryRevision: 0, historyRevision: 1,
    }, '[chat-run-socket] session messages deleted')
    expect(roomEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ action: 'messages_deleted', ...result, contextTokens: 18_000 }))
  })

  it('loads retained history before dispatching the next run, then returns it on resume', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any) as any
    server.onConnection(socket)
    const retained = [
      { id: 10, role: 'user', content: 'keep old question', timestamp: 1 },
      { id: 11, role: 'assistant', content: 'keep old answer', timestamp: 2 },
    ]
    server.sessionMap.set('session-1', { messages: [...retained, { id: 12, role: 'user', content: 'remove' }], isWorking: false, events: [], queue: [] })
    deleteMessageGroupsMock.mockReturnValueOnce({ deleted: 1, deletedGroups: 1, messageIds: [12], historyRevision: 1 })
    await server.deleteSessionMessages('session-1', [12], 0)
    expect(server.sessionMap.has('session-1')).toBe(false)
    readSessionStateFromDbMock.mockReturnValueOnce({ messages: [...retained], isWorking: false, events: [], queue: [],
      messageTotal: 2, messageLoadedCount: 2, messageStateBaselineCount: 2, messagePageLimit: 150 })
    handleBridgeRunMock.mockImplementationOnce(async (...args: any[]) => {
      const state = args[4].get('session-1')
      expect(state.messages).toEqual(retained)
      state.messages.push({ id: 13, role: 'user', content: 'follow up', timestamp: 3 },
        { id: 14, role: 'assistant', content: 'new answer', timestamp: 4 })
    })
    await server.handleRun(socket, { session_id: 'session-1', input: 'follow up', source: 'cli' }, 'default')
    expect(handleBridgeRunMock).toHaveBeenCalled()
    expect(readSessionStateFromDbMock).toHaveBeenCalledOnce()
    socket.emit.mockClear()
    await handlers.get('resume')?.({ session_id: 'session-1' })
    expect(socket.emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      messages: expect.arrayContaining(retained), messageTotal: 4, messageLoadedCount: 4, hasMoreBefore: false,
    }))
    const resumed = socket.emit.mock.calls.find(([event]: any[]) => event === 'resumed')?.[1]
    expect(resumed.messages.map((m: any) => m.id)).toEqual([10, 11, 13, 14])
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
    expect(namespace.to).toHaveBeenCalledWith(['studio-account', 'session:session-1'])
    expect(namespace.to('session:session-1').emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      event: 'session.command',
      session_id: 'session-1',
      action: 'clear',
      clearHistory: true,
      deleted: 2,
    }))
    expect(namespace.to('session:session-1').emit).toHaveBeenCalledWith('resumed', expect.objectContaining({
      session_id: 'session-1',
      messages: [],
      messageTotal: 0,
      isWorking: false,
      queueLength: 0,
    }))
  })
  it('clears cached Person history after its transaction without deleting it twice or notifying other accounts', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, namespace } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const id = 'person-main-1'
    ;(server as any).sessionMap.set(id, { messages: [{ id: 1, role: 'user', content: 'Old private message' }], isWorking: false, events: [], queue: [] })
    const result = server.clearSessionHistory(id, { historyAlreadyCleared: true })
    expect(result).toEqual({ deleted: 0, hadMemoryState: true })
    expect(sessionStoreMocks.clearSessionMessages).not.toHaveBeenCalled()
    expect((server as any).sessionMap.has(id)).toBe(false)
    expect(namespace.to).not.toHaveBeenCalledWith(expect.arrayContaining(['studio-account']))
    expect(namespace.to(`session:${id}`).emit).toHaveBeenCalledWith('resumed', expect.objectContaining({ session_id: id, messages: [], isWorking: false }))
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
