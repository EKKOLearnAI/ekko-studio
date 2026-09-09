import { beforeEach, describe, expect, it, vi } from 'vitest'

const handleBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const resumeBridgeRunMock = vi.hoisted(() => vi.fn(async () => {}))
const handleCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => {}))
const loadSessionStateFromDbMock = vi.hoisted(() => vi.fn())
const ensureReadyMock = vi.hoisted(() => vi.fn())
const getRuntimeStateMock = vi.hoisted(() => vi.fn())
const bindAppEventSubscriptionMock = vi.hoisted(() => vi.fn())
const publishAppStateMock = vi.hoisted(() => vi.fn())
const getSessionTaskPlansMock = vi.hoisted(() => vi.fn(() => [] as any[]))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/app-events', () => ({
  bindAppEventSubscription: bindAppEventSubscriptionMock,
}))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/app-event-state', async importOriginal => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')>(),
  publishAppState: publishAppStateMock,
}))
vi.mock('../../packages/server/src/modules/studio/services/task-plans', () => ({
  getSessionTaskPlans: getSessionTaskPlansMock,
}))
const userCanAccessProfileMock = vi.hoisted(() => vi.fn((_user: unknown, _profile: string) => true))
const reconcileHermesSessionHistoryMock = vi.hoisted(() => vi.fn(async () => ({ changed: false, added: 0 })))
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

vi.mock('../../packages/server/src/modules/studio/services/history/reconcile-hermes-history', () => ({
  reconcileHermesSessionHistory: reconcileHermesSessionHistoryMock,
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

vi.mock('../../packages/server/src/modules/studio/repositories/workspace-run-changes-store', () => ({
  listWorkspaceRunChangesForAssistantMessages: vi.fn(() => []),
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
    bindAppEventSubscriptionMock.mockClear()
    publishAppStateMock.mockClear()
    getSessionTaskPlansMock.mockReset().mockReturnValue([])
    ensureReadyMock.mockReset()
    getRuntimeStateMock.mockReset()
    bridgeMock.statusIfLoaded.mockReset()
    reconcileHermesSessionHistoryMock.mockReset().mockResolvedValue({ changed: false, added: 0 })
    loadSessionStateFromDbMock.mockReset()
    handleBridgeRunMock.mockClear()
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

  it.each([
    { activeRunMarker: 'turn-current', responseRun: { runMarker: 'older-response' } },
    { responseRun: { runMarker: 'turn-current' } },
  ])('uses the task card turn ID for live progress and reconnect snapshots: %j', async turnState => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { io, socket } = makeServerHarness()
    const server = new ChatRunSocket(io as any)
    const state = { messages: [], events: [], queue: [], isWorking: true, profile: 'default',
      runId: 'persistent-agent-instance', ...turnState }
    ;(server as any).sessionMap.set('s-progress', state)
    const card = { session_id: 's-progress', run_id: 'turn-current', plan_id: 'card-current', revision: 2,
      execution_state: 'running', created_at: 1, updated_at: 2,
      plan: [{ id: 'inspect', step: 'Inspect', status: 'completed' }, { id: 'verify', step: 'Verify', status: 'in_progress' }] }
    getSessionTaskPlansMock.mockReturnValue([card, { ...card, plan_id: 'card-old', run_id: 'turn-old' }])

    ;(server as any).onConnection(socket)
    const snapshot = bindAppEventSubscriptionMock.mock.calls[0][1]({ id: 1 }, 'default')
    expect(snapshot.map((event: any) => event.type)).toEqual(['chat.run.updated', 'chat.plan.updated'])
    expect(snapshot[0].subject.run_id).toBe(card.run_id)
    expect(snapshot[1].chat.task_plan).toMatchObject({ run_id: card.run_id, progress: { completed: 1, total: 2 } })
    expect(getSessionTaskPlansMock).toHaveBeenCalledWith('s-progress', [], true, card.run_id)

    ;(server as any).emitSessionActivity('default', 'run.started', { session_id: 's-progress', run_id: 'response-id' })
    expect(publishAppStateMock).toHaveBeenLastCalledWith(expect.objectContaining({
      subject: { session_id: 's-progress', run_id: card.run_id },
      payload: { state: expect.objectContaining({ status: 'running', reset_progress: true }) },
    }))
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
    expect(reconcileHermesSessionHistoryMock).toHaveBeenCalledWith('s2', expect.objectContaining({ profile: 'default' }))
  })

  it('reloads reconciled native continuation history before an idle resume', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    ;(server as any).sessionMap.set('resume-lineage', {
      messages: [{ id: 1, role: 'user', content: 'stale root' }], events: [], queue: [], isWorking: false,
    })
    reconcileHermesSessionHistoryMock.mockResolvedValueOnce({ changed: true, added: 1 })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [
        { id: 1, role: 'user', content: 'stale root' },
        { id: 2, role: 'assistant', content: 'native continuation' },
      ],
      events: [], queue: [], isWorking: false,
    })

    ;(server as any).onConnection(socket)
    await handlers.get('resume')?.({ session_id: 'resume-lineage' })

    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
    expect(resumed![1].messages.map((message: any) => message.content)).toEqual(['stale root', 'native continuation'])
    expect(loadSessionStateFromDbMock).toHaveBeenCalledWith('resume-lineage', expect.any(Map))
  })

  it('reconciles and reloads idle history before a direct bridge send', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    reconcileHermesSessionHistoryMock.mockResolvedValueOnce({ changed: true, added: 1 })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [{ id: 2, role: 'assistant', content: 'native continuation' }],
      events: [], queue: [], isWorking: false,
    })

    ;(server as any).onConnection(socket)
    await handlers.get('run')?.({ session_id: 'pre-send-lineage', input: 'next turn', source: 'cli' })

    expect(reconcileHermesSessionHistoryMock).toHaveBeenCalledWith(
      'pre-send-lineage',
      expect.objectContaining({ profile: 'default' }),
    )
    expect(loadSessionStateFromDbMock).toHaveBeenCalledWith('pre-send-lineage', expect.any(Map))
    expect(handleBridgeRunMock).toHaveBeenCalled()
    const sessionMap = handleBridgeRunMock.mock.calls[0][4] as Map<string, any>
    expect(sessionMap.get('pre-send-lineage').messages[0].content).toBe('native continuation')
  })

  it('preserves a concurrently queued second send while the first send refreshes native history', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    let finishLookup!: () => void
    const lookupPending = new Promise<void>(resolve => { finishLookup = resolve })
    reconcileHermesSessionHistoryMock.mockImplementationOnce(async (_id, options) => {
      await lookupPending
      expect(options.isSessionActive()).toBe(false)
      return { changed: true, added: 1 }
    })
    loadSessionStateFromDbMock.mockResolvedValueOnce({
      messages: [{ id: 2, role: 'assistant', content: 'native continuation' }],
      events: [], queue: [], isWorking: false,
    })

    ;(server as any).onConnection(socket)
    const first = handlers.get('run')?.({ session_id: 'concurrent-send', input: 'first', source: 'cli' })
    await vi.waitFor(() => expect(reconcileHermesSessionHistoryMock).toHaveBeenCalledTimes(1))
    const reserved = (server as any).sessionMap.get('concurrent-send')
    const startedAt = reserved.runStartedAt
    const second = handlers.get('run')?.({ session_id: 'concurrent-send', input: 'second', source: 'cli' })

    await vi.waitFor(() => expect(reserved.queue.map((item: any) => item.input)).toEqual(['second']))
    expect(reserved.isWorking).toBe(true)
    reserved.events.push({ event: 'live.event', data: { value: 1 } })
    finishLookup()
    await Promise.all([first, second])

    const current = (server as any).sessionMap.get('concurrent-send')
    expect(current).toBe(reserved)
    expect(current.messages.map((message: any) => message.content)).toEqual(['native continuation'])
    expect(current.queue.map((item: any) => item.input)).toEqual(['second'])
    expect(current.events).toEqual([{ event: 'live.event', data: { value: 1 } }])
    expect(current.runStartedAt).toBe(startedAt)
    expect(current.profile).toBe('default')
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a live send state when an idle resume lookup finishes afterward', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    const idleState = {
      messages: [{ id: 1, role: 'user', content: 'existing' }], events: [], queue: [], isWorking: false,
    }
    ;(server as any).sessionMap.set('resume-send-race', idleState)
    let finishResumeLookup!: () => void
    const resumeLookupPending = new Promise<void>(resolve => { finishResumeLookup = resolve })
    let resumeSawActive = false
    reconcileHermesSessionHistoryMock
      .mockImplementationOnce(async (_id, options) => {
        await resumeLookupPending
        resumeSawActive = options.isSessionActive()
        return { changed: false, added: 0 }
      })
      .mockResolvedValueOnce({ changed: false, added: 0 })

    ;(server as any).onConnection(socket)
    const resume = handlers.get('resume')?.({ session_id: 'resume-send-race' })
    await vi.waitFor(() => expect(reconcileHermesSessionHistoryMock).toHaveBeenCalledTimes(1))
    await handlers.get('run')?.({ session_id: 'resume-send-race', input: 'new run', source: 'cli' })
    const liveState = (server as any).sessionMap.get('resume-send-race')
    const startedAt = liveState.runStartedAt
    finishResumeLookup()
    await resume

    expect(resumeSawActive).toBe(true)
    expect((server as any).sessionMap.get('resume-send-race')).toBe(liveState)
    expect(liveState.isWorking).toBe(true)
    expect(liveState.runStartedAt).toBe(startedAt)
    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
    expect(resumed?.[1]).toMatchObject({ isWorking: true, runStartedAt: startedAt })
  })

  it('does not replace state created by a send while an initial resume load is pending', async () => {
    const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
    const { handlers, io, socket } = makeServerHarness()
    ;(socket.data as any).user = { id: 1, username: 'admin', role: 'super_admin' }
    const server = new ChatRunSocket(io as any)
    let finishLoad!: (state: any) => void
    loadSessionStateFromDbMock.mockImplementationOnce(() => new Promise(resolve => { finishLoad = resolve }))

    ;(server as any).onConnection(socket)
    const resume = handlers.get('resume')?.({ session_id: 'initial-resume-send-race' })
    await vi.waitFor(() => expect(loadSessionStateFromDbMock).toHaveBeenCalledTimes(1))
    await handlers.get('run')?.({ session_id: 'initial-resume-send-race', input: 'new run', source: 'cli' })
    const liveState = (server as any).sessionMap.get('initial-resume-send-race')
    finishLoad({
      messages: [{ id: 1, role: 'user', content: 'loaded before send' }],
      events: [], queue: [], isWorking: false,
    })
    await resume

    expect((server as any).sessionMap.get('initial-resume-send-race')).toBe(liveState)
    expect(liveState.isWorking).toBe(true)
    expect(handleBridgeRunMock).toHaveBeenCalledTimes(1)
    const resumed = socket.emit.mock.calls.find((call: any[]) => call[0] === 'resumed')
    expect(resumed?.[1].isWorking).toBe(true)
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
