import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateSessionStatsMock = vi.fn()
const updateSessionMock = vi.fn()
const flushBridgePendingToDbMock = vi.fn()
const flushResponseRunToDbMock = vi.fn()
const replaceStateMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const codingAgentRunManagerMock = vi.hoisted(() => ({
  hasSession: vi.fn(() => false),
  stop: vi.fn(() => false),
}))
const ekkoBackgroundMock = vi.hoisted(() => ({
  has: vi.fn(() => false),
  abort: vi.fn(async () => 0),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({
  flushResponseRunToDb: flushResponseRunToDbMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  replaceState: replaceStateMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

vi.mock('../../packages/server/src/modules/ekko/services/manager', () => ({
  hasGlobalEkkoBackgroundTasks: ekkoBackgroundMock.has,
  abortGlobalEkkoBackgroundTasks: ekkoBackgroundMock.abort,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  chatCodingAgentRunManager: codingAgentRunManagerMock,
  hasChatEkkoBackgroundTasks: ekkoBackgroundMock.has,
  abortChatEkkoBackgroundTasks: ekkoBackgroundMock.abort,
}))

function makeHarness() {
  const emit = vi.fn()
  const nsp = {
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
    to: vi.fn(() => ({ emit })),
  }
  const socket = {
    connected: true,
    emit: vi.fn(),
  }
  return { emit, nsp, socket }
}

describe('run chat abort goal handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    codingAgentRunManagerMock.hasSession.mockReturnValue(false)
    codingAgentRunManagerMock.stop.mockReturnValue(false)
    ekkoBackgroundMock.has.mockReturnValue(false)
    ekkoBackgroundMock.abort.mockResolvedValue(0)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 0, outputTokens: 0 })
  })

  it.each(['builtin_agent', 'group_chat', 'workflow', 'global_agent'])('aborts native Ekko on %s without calling Hermes', async source => {
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { nsp, socket } = makeHarness()
    const controller = new AbortController()
    const state = { messages: [], isWorking: true, events: [], queue: [], source, webhookAgent: 'ekko', runId: 'native-run', abortController: controller } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = { interrupt: vi.fn(), goalPause: vi.fn() }
    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, vi.fn())
    expect(controller.signal.aborted).toBe(true)
    expect(bridge.interrupt).not.toHaveBeenCalled()
    expect(state.source).toBe(source)
    expect(state.isWorking).toBe(false)
  })

  it('aborts detached Ekko background tasks after the parent run has finished', async () => {
    ekkoBackgroundMock.has.mockReturnValue(true)
    ekkoBackgroundMock.abort.mockResolvedValue(1)
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
      source: 'coding_agent',
      backgroundTasks: {
        'ekko-child': {
          runtime: 'ekko',
          subagent_id: 'ekko-child',
          status: 'running',
          goal: 'Run validation',
        },
      },
    } as any
    const sessionMap = new Map([['session-1', state]])

    await handleAbort(
      nsp as any,
      socket as any,
      'session-1',
      sessionMap,
      { interrupt: vi.fn() },
      vi.fn(),
    )

    expect(ekkoBackgroundMock.abort).toHaveBeenCalledWith('session-1')
    expect(state.backgroundTasks['ekko-child']).toEqual(expect.objectContaining({
      status: 'interrupted',
      last_event: 'subagent.complete',
    }))
    expect(emit).toHaveBeenCalledWith('subagent.complete', expect.objectContaining({
      session_id: 'session-1',
      subagent_id: 'ekko-child',
      status: 'interrupted',
    }))
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      synced: true,
    }))
  })

  it('pauses an active goal and clears hidden goal continuations when aborting a CLI run', async () => {
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue goal', profile: 'default', goalContinuation: true },
        { queue_id: 'user-1', input: 'normal follow-up', profile: 'default', source: 'cli' },
      ],
      runId: 'run-1',
      profile: 'default',
      source: 'cli',
      backgroundTasks: {
        'child-1': {
          subagent_id: 'child-1',
          status: 'running',
          task_index: 0,
          task_count: 2,
          goal: 'First task',
        },
        'child-2': {
          subagent_id: 'child-2',
          status: 'completed',
          task_index: 1,
          task_count: 2,
          goal: 'Second task',
        },
      },
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockResolvedValue({
        ok: true,
        background_interrupted: 1,
        background_delegation_ids: ['deleg-1'],
      }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused', reason: 'user-interrupted' }),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(bridge.interrupt).toHaveBeenCalledWith('session-1', 'Aborted by user', 'default')
    expect(bridge.goalPause).toHaveBeenCalledWith('session-1', 'user-interrupted', 'default')
    expect(runQueuedItem).toHaveBeenCalledWith(socket, 'session-1', expect.objectContaining({
      queue_id: 'user-1',
    }), 'default')
    expect(state.queue).toEqual([])
    expect(state.backgroundDelegations).toEqual({
      'deleg-1': expect.objectContaining({
        delegationId: 'deleg-1',
        status: 'interrupted',
      }),
    })
    expect(emit).toHaveBeenCalledWith('delegation.updated', expect.objectContaining({
      session_id: 'session-1',
      delegation_id: 'deleg-1',
      status: 'interrupted',
      delivery_status: 'cancelled',
    }))
    expect(state.backgroundTasks['child-1']).toEqual(expect.objectContaining({
      status: 'interrupted',
      last_event: 'subagent.complete',
    }))
    expect(state.backgroundTasks['child-2'].status).toBe('completed')
    expect(emit).toHaveBeenCalledWith('subagent.complete', expect.objectContaining({
      session_id: 'session-1',
      subagent_id: 'child-1',
      status: 'interrupted',
    }))
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      synced: true,
    }))
    expect(updateSessionMock).not.toHaveBeenCalled()
  })

  it('releases local working state when a CLI interrupt does not sync before timeout', async () => {
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [
        { queue_id: 'goal-1', input: 'continue goal', profile: 'default', goalContinuation: true },
      ],
      runId: 'run-1',
      profile: 'default',
      source: 'cli',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockResolvedValue({ ok: true, synced: false }),
      goalPause: vi.fn().mockResolvedValue({ handled: true, status: 'paused', reason: 'user-interrupted' }),
      destroy: vi.fn().mockResolvedValue({ destroyed: true }),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(runQueuedItem).not.toHaveBeenCalled()
    expect(bridge.destroy).toHaveBeenCalledWith('session-1', 'default')
    expect(calcAndUpdateUsageMock).toHaveBeenCalled()
    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(state.queue).toEqual([])
    expect(emit).toHaveBeenCalledWith('abort.timeout', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'run-1',
      synced: false,
    }))
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'run-1',
      synced: false,
    }))
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: expect.any(Number),
      end_reason: 'abort',
    }))
  })


  it('stops a workflow-scoped coding-agent run instead of misrouting abort through the bridge', async () => {
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    codingAgentRunManagerMock.hasSession.mockReturnValue(true)
    codingAgentRunManagerMock.stop.mockReturnValue(true)
    const state = {
      messages: [],
      isWorking: true,
      isAborting: false,
      events: [],
      queue: [],
      runId: 'coding-run-1',
      profile: 'default',
      source: 'workflow',
    } as any
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      interrupt: vi.fn().mockRejectedValue(new Error('unknown session: session-1')),
      goalPause: vi.fn(),
    }
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap, bridge, runQueuedItem)

    expect(bridge.interrupt).not.toHaveBeenCalled()
    expect(bridge.goalPause).not.toHaveBeenCalled()
    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: expect.any(Number),
      end_reason: 'abort',
    }))
    expect(flushResponseRunToDbMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'workflow',
    }), 'session-1')
    expect(flushBridgePendingToDbMock).not.toHaveBeenCalled()
    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      run_id: 'coding-run-1',
      synced: true,
    }))
  })

  it('stops a coding-agent run even when chat-run state was not marked working', async () => {
    const { handleAbort } = await import('../../packages/server/src/modules/studio/services/chat-run/abort')
    const { emit, nsp, socket } = makeHarness()
    const sessionMap = new Map()
    codingAgentRunManagerMock.hasSession.mockReturnValue(true)
    codingAgentRunManagerMock.stop.mockReturnValue(true)
    const runQueuedItem = vi.fn()

    await handleAbort(nsp as any, socket as any, 'session-1', sessionMap as any, {}, runQueuedItem)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(sessionMap.get('session-1')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: false,
      source: 'coding_agent',
    }))
    expect(flushResponseRunToDbMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'coding_agent',
    }), 'session-1')
    expect(emit).toHaveBeenCalledWith('abort.completed', expect.objectContaining({
      session_id: 'session-1',
      synced: true,
    }))
  })
})
