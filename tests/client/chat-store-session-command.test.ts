// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
  socketHandlers: new Map<string, (event: any) => void>(),
  socket: {
    emit: vi.fn(),
    on: vi.fn((name: string, handler: (event: any) => void) => { chatApi.socketHandlers.set(name, handler) }),
    off: vi.fn((name: string) => { chatApi.socketHandlers.delete(name) }),
  },
  getChatRunSocket: vi.fn(() => chatApi.socket),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [], queueLength: 0 })
    return {} as any
  }),
  sessionCommandHandlers: [] as Array<(event: any) => void>,
  peerUserMessageHandlers: [] as Array<(event: any) => void>,
  sessionTitleUpdatedHandlers: [] as Array<(event: any) => void>,
  sessionWorkspaceUpdatedHandlers: [] as Array<(event: any) => void>,
  sessionSettingsUpdatedHandlers: [] as Array<(event: any) => void>,
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => {
    chatApi.peerUserMessageHandlers.push(handler)
    return vi.fn()
  }),
  onSessionCommand: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionCommandHandlers.push(handler)
    return vi.fn()
  }),
  onSessionTitleUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionTitleUpdatedHandlers.push(handler)
    return vi.fn()
  }),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionWorkspaceUpdatedHandlers.push(handler)
    return vi.fn()
  }),
  onSessionSettingsUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionSettingsUpdatedHandlers.push(handler)
    return vi.fn()
  }),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'
import { fetchSessions, setSessionModel } from '@/api/studio/sessions'

function makeSession(): Session {
  return {
    id: 'session-1',
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store session.command fanout', () => {
  afterEach(() => { if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore() })
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.socketHandlers.clear()
    chatApi.socket.emit.mockImplementation(chatApi.socketEmit)
    chatApi.socket.on.mockImplementation((name: string, handler: (event: any) => void) => { chatApi.socketHandlers.set(name, handler) })
    chatApi.socket.off.mockImplementation((name: string) => { chatApi.socketHandlers.delete(name) })
    chatApi.getChatRunSocket.mockReturnValue(chatApi.socket)
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.sessionSettingsUpdatedHandlers = []
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
  })

  it.each(['context', 'usage', 'status', 'compact'])('sends Ekko /%s as a built-in command with compatible transport', async command => {
    const store = useChatStore()
    const session = { ...makeSession(), source: 'coding_agent', agent: 'ekko-agent', codingAgentId: 'ekko-agent' as const, codingAgentMode: 'scoped' as const, model: 'gpt-test', provider: 'openai' }
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    await store.sendMessage(`/${command}`)
    expect(store.messages[0]).toMatchObject({ role: 'command', content: `/${command}`, queued: false })
    expect(chatApi.startRunViaSocket.mock.calls[0]?.[0]).toMatchObject({ source: 'builtin_agent', agent_id: 'ekko-agent', mode: 'scoped', input: `/${command}` })
    expect(chatApi.startRunViaSocket.mock.calls[0]?.[0]).not.toHaveProperty('coding_agent_id')
    expect(store.isStreaming).toBe(false)
  })

  it('creates an Ekko direct chat with the real builtin source even from legacy options', () => {
    const store = useChatStore()
    const session = store.newChat({ agent: 'ekko-agent', source: 'coding_agent', codingAgentMode: 'global', model: 'native-model', provider: 'native-provider' })
    expect(session).toMatchObject({ source: 'builtin_agent', agent: 'ekko-agent', codingAgentMode: 'scoped', model: 'native-model', provider: 'native-provider' })
  })

  it.each(['cursor', 'codex', 'claude-code', 'pi', 'grok', 'opencode', 'dsh'])('keeps %s cumulative usage through partial updates and session refresh', async agent => {
    const store = useChatStore()
    store.sessions = [
      { ...makeSession(), source: 'coding_agent', agent, inputTokens: 24_003, outputTokens: 474, contextTokens: 8000 },
      { ...makeSession(), id: 'other-session', source: 'coding_agent', agent, inputTokens: 900_000, outputTokens: 1000 },
    ]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    chatApi.sessionCommandHandlers[0]({
      event: 'session.command', session_id: 'session-1', command: 'usage', action: 'usage',
      available: true, cacheReadTokens: 20_736, cacheWriteTokens: 0, contextTokens: null,
    })
    const expected = { inputTokens: 24_003, outputTokens: 474, cacheReadTokens: 20_736, cacheWriteTokens: 0, contextTokens: 8000 }
    expect(store.activeSession).toMatchObject(expected)
    expect(store.sessions[1]).toMatchObject({ inputTokens: 900_000, outputTokens: 1000 })
    vi.mocked(fetchSessions).mockResolvedValue([{
      id: 'session-1', source: 'coding_agent', agent, input_tokens: 24_003, output_tokens: 474,
      cache_read_tokens: 20_736, cache_write_tokens: 0, started_at: 1, last_active: 2,
    }] as any)
    await store.refreshSessionListOnly('default')
    expect(store.activeSession).toMatchObject(expected)
  })

  it('keeps known counters when native usage is unavailable, while retaining the command result', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [{ ...session, inputTokens: 123, outputTokens: 45 }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command', session_id: 'session-1', command: 'usage', action: 'usage',
      available: false, inputTokens: null, outputTokens: null,
      message: 'Usage: unknown.', messageKey: 'nativeUsageUnknown',
    })

    expect(store.sessions[0]).toMatchObject({ inputTokens: 123, outputTokens: 45 })
    expect(store.messages.at(-1)).toMatchObject({ role: 'command', commandData: { available: false } })
  })

  it('attaches to a goal resume run started from another window', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    expect(chatApi.sessionCommandHandlers).toHaveLength(1)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })

    expect(store.isStreaming).toBe(true)
    expect(chatApi.registerSessionHandlers).toHaveBeenCalledWith('session-1', expect.objectContaining({
      onRunStarted: expect.any(Function),
      onSessionCommand: expect.any(Function),
    }))
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'command',
        content: 'Goal resumed',
        commandAction: 'resume',
      }),
    ])
  })

  it('receives external context metadata without mixing cumulative billing and caches', () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), model: 'test-model', inputTokens: 100000, cacheReadTokens: 50000 }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    chatApi.sessionCommandHandlers[0]({ event: 'session.command', session_id: 'session-1', action: 'resume', started: true, terminal: false })
    const handlers = chatApi.registerSessionHandlers.mock.calls.at(-1)?.[1]
    const metadata = { contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active', contextObservedAt: Date.now(), contextGeneration: 'g2', contextModel: 'test-model', contextWindow: 32000, contextTokens: 0 }
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', ...metadata })
    expect(store.activeSession).toMatchObject({ ...metadata, inputTokens: 100000, cacheReadTokens: 50000 })
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', ...metadata, contextObservedAt: metadata.contextObservedAt - 1, contextTokens: 9000, outputTokens: 120 })
    expect(store.activeSession).toMatchObject({ ...metadata, outputTokens: 120 })
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', contextTokens: 60000, outputTokens: 121 })
    expect(store.activeSession).toMatchObject({ ...metadata, outputTokens: 121 })
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', contextManager: 'bili', contextSource: 'estimate', contextManagerStatus: 'active', contextTokens: 60000 })
    expect(store.activeSession).toMatchObject(metadata)
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', contextManager: 'bili', contextSource: 'unavailable', contextManagerStatus: 'unavailable', contextTokens: null })
    expect(store.activeSession).toMatchObject({ contextSource: 'unavailable', contextManagerStatus: 'unavailable', inputTokens: 100000, cacheReadTokens: 50000 })
    expect(store.activeSession?.contextTokens).toBeUndefined()
    expect(store.activeSession?.contextWindow).toBeUndefined()
  })

  it('consumes the actual context.manager fallback event and clears it on recovery', async () => {
    const store = useChatStore()
    const session = { ...makeSession(), model: 'test-model', inputTokens: 100000, cacheReadTokens: 50000 }
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = store.sessions[0]
    await store.sendMessage('start')
    const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)?.[1]
    const metadata = { contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active', contextObservedAt: Date.now(), contextGeneration: 'g2', contextModel: 'test-model', contextWindow: 32000, contextTokens: 9000, contextFallback: false }
    onEvent({ event: 'usage.updated', session_id: session.id, ...metadata })
    expect(chatApi.socket.on).toHaveBeenCalledWith('context.manager', expect.any(Function))
    chatApi.socketHandlers.get('context.manager')!({ event: 'context.manager', session_id: session.id, selectedManager: 'bili', manager: 'native', fallback: true })
    expect(store.activeSession).toMatchObject({ contextManager: 'native', contextFallback: true, contextSource: 'unavailable', inputTokens: 100000, cacheReadTokens: 50000 })
    expect(store.activeSession?.contextTokens).toBeUndefined()
    expect(store.activeSession?.contextWindow).toBeUndefined()
    onEvent({ event: 'usage.updated', session_id: session.id, contextManager: 'native', contextSource: 'unavailable', contextManagerStatus: 'unavailable', contextFallback: true, contextTokens: null })
    expect(store.activeSession).toMatchObject({ contextManager: 'native', contextFallback: true, contextSource: 'unavailable' })
    chatApi.socketHandlers.get('context.manager')!({ event: 'context.manager', session_id: session.id, selectedManager: 'bili', manager: 'bili', fallback: false })
    expect(store.activeSession).toMatchObject({ contextManager: 'bili', contextFallback: false, contextSource: 'unavailable' })
    onEvent({ event: 'usage.updated', session_id: session.id, ...metadata, contextGeneration: 'g3' })
    expect(store.activeSession).toMatchObject({ ...metadata, contextGeneration: 'g3' })
  })

  it.each(['local', 'settings', 'resume'])('invalidates observations after a %s model change and rejects late old-model usage', async path => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), model: 'old-model', provider: 'openai', inputTokens: 123, cacheReadTokens: 50 }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    chatApi.sessionCommandHandlers[0]({ event: 'session.command', session_id: 'session-1', action: 'resume', started: true, terminal: false })
    const handlers = chatApi.registerSessionHandlers.mock.calls.at(-1)?.[1]
    const metadata = { contextManager: 'bili', contextFallback: false, contextSource: 'usage', contextManagerStatus: 'active', contextObservedAt: Date.now(), contextGeneration: 'g2', contextModel: 'old-model', contextWindow: 32000, contextTokens: 9000 }
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', ...metadata })
    if (path === 'local') {
      vi.mocked(setSessionModel).mockResolvedValue(true)
      expect(await store.switchSessionModel('new-model', 'openai')).toBe(true)
    } else if (path === 'settings') {
      chatApi.sessionSettingsUpdatedHandlers[0]({ event: 'session.settings.updated', session_id: 'session-1', model: 'new-model' })
    } else {
      chatApi.resumeSession.mockImplementationOnce((sid: string, onResumed: (data: any) => void) => {
        onResumed({ session_id: sid, model: 'new-model', messages: [], isWorking: false, ...metadata })
        return {} as any
      })
      await store.switchSession('session-1')
    }
    expect(store.activeSession).toMatchObject({ model: 'new-model', contextSource: 'unavailable', inputTokens: 123, cacheReadTokens: 50 })
    for (const key of ['contextTokens', 'contextModel', 'contextWindow', 'contextObservedAt', 'contextGeneration'] as const) expect(store.activeSession?.[key]).toBeUndefined()
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', ...metadata, contextObservedAt: Date.now() + 1, outputTokens: 100 })
    expect(store.activeSession?.contextTokens).toBeUndefined()
    expect(store.activeSession?.outputTokens).toBe(100)
    handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', ...metadata, contextModel: 'new-model', contextGeneration: 'g3' })
    expect(store.activeSession).toMatchObject({ ...metadata, contextModel: 'new-model', contextGeneration: 'g3' })
  })

  it.each([-900001, 60001])('rejects external observation age offset %s at event ingestion without changing billing', async offset => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), model: 'test-model' }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    await store.sendMessage('start')
    const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)?.[1]
    onEvent({ event: 'usage.updated', session_id: 'session-1', inputTokens: 500, contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active', contextObservedAt: now + offset, contextGeneration: 'g2', contextModel: 'test-model', contextWindow: 32000, contextTokens: 9000 })
    expect(store.activeSession?.contextTokens).toBeUndefined()
    expect(store.activeSession?.inputTokens).toBe(500)
  })

  it('applies a new-model observation from the reconnect resume after updating settings', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), model: 'old-model' }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    await store.sendMessage('start')
    const options = chatApi.startRunViaSocket.mock.calls.at(-1)?.[5]
    options.onReconnectResume({ session_id: 'session-1', model: 'new-model', messages: [], isWorking: false,
      contextManager: 'bili', contextFallback: false, contextSource: 'usage', contextManagerStatus: 'active',
      contextTokens: 1200, contextModel: 'new-model', contextWindow: 32000, contextObservedAt: Date.now(), contextGeneration: 'g3' })
    expect(store.activeSession).toMatchObject({ model: 'new-model', contextModel: 'new-model', contextTokens: 1200, contextGeneration: 'g3' })
  })

  it.each(['send', 'passive', 'resume', 'reconnect'])('does not let a %s compression result overwrite a verified external observation without metadata', async path => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), model: 'test-model' }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    const metadata = { contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active', contextTokens: 1200,
      contextWindow: 32000, contextModel: 'test-model', contextObservedAt: Date.now(), contextGeneration: 'g2' }
    const compression = { event: 'compression.completed', session_id: 'session-1', compressed: true, contextTokens: 9000 }
    if (path === 'passive') {
      chatApi.sessionCommandHandlers[0]({ event: 'session.command', session_id: 'session-1', action: 'resume', started: true, terminal: false })
      const handlers = chatApi.registerSessionHandlers.mock.calls.at(-1)?.[1]
      handlers.onUsageUpdated({ event: 'usage.updated', session_id: 'session-1', ...metadata })
      handlers.onCompressionCompleted(compression)
    } else if (path === 'resume') {
      chatApi.resumeSession.mockImplementationOnce((sid: string, onResumed: (data: any) => void) => {
        onResumed({ session_id: sid, messages: [], isWorking: false, ...metadata, events: [{ data: compression }] })
        return {} as any
      })
      await store.switchSession('session-1')
    } else {
      await store.sendMessage('start')
      const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)?.[1]
      onEvent({ event: 'usage.updated', session_id: 'session-1', ...metadata })
      if (path === 'send') onEvent(compression)
      else chatApi.startRunViaSocket.mock.calls.at(-1)?.[5].onReconnectResume({
        session_id: 'session-1', messages: [], isWorking: false, ...metadata, events: [{ data: compression }],
      })
    }
    expect(store.activeSession).toMatchObject(metadata)
    expect(store.compressionState?.afterTokens).toBe(9000)
  })

  it('does not let a legacy context-only event overwrite a verified native estimate', async () => {
    const store = useChatStore()
    store.sessions = [makeSession()]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    await store.sendMessage('start')
    const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)?.[1]
    onEvent({ event: 'usage.updated', session_id: 'session-1', contextManager: 'native', contextSource: 'estimate', contextManagerStatus: 'native', contextTokens: 1200 })
    onEvent({ event: 'usage.updated', session_id: 'session-1', contextTokens: 900000, inputTokens: 900000 })
    expect(store.activeSession).toMatchObject({ contextManager: 'native', contextSource: 'estimate', contextTokens: 1200, inputTokens: 900000 })
  })

  it('accepts native unavailable from bili and clears fallback on resume', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), model: 'test-model', inputTokens: 123 }]
    store.activeSessionId = 'session-1'
    store.activeSession = store.sessions[0]
    await store.sendMessage('start')
    const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)?.[1]
    onEvent({ event: 'usage.updated', session_id: 'session-1', contextManager: 'bili', contextSource: 'usage', contextManagerStatus: 'active', contextObservedAt: Date.now(), contextGeneration: 'g2', contextModel: 'test-model', contextWindow: 32000, contextTokens: 9000 })
    onEvent({ event: 'usage.updated', session_id: 'session-1', contextManager: 'native', contextSource: 'unavailable', contextManagerStatus: 'unavailable', contextFallback: true, contextTokens: null })
    expect(store.activeSession).toMatchObject({ contextManager: 'native', contextFallback: true, contextSource: 'unavailable', inputTokens: 123 })
    expect(store.activeSession?.contextTokens).toBeUndefined()
    chatApi.resumeSession.mockImplementationOnce((sid: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sid, messages: [], isWorking: false, contextManager: 'native', contextSource: 'unavailable', contextManagerStatus: 'unavailable', contextFallback: false })
      return {} as any
    })
    await store.switchSession('session-1')
    expect(store.activeSession).toMatchObject({ contextFallback: false, contextManager: 'native', contextSource: 'unavailable', inputTokens: 123 })
  })

  it('requests insertion for a queued message and mirrors boundary or immediate server state', () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.agent = 'hermes'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      started: true,
      terminal: false,
    })
    const handlers = chatApi.registerSessionHandlers.mock.calls.at(-1)?.[1]
    handlers.onRunQueued({
      event: 'run.queued',
      session_id: 'session-1',
      queue_length: 1,
      queued_messages: [
        { id: 'queue-follow-up', role: 'user', content: 'follow up', timestamp: 2, queued: true },
      ],
    })

    store.insertQueuedMessage('session-1', 'queue-follow-up')
    expect(chatApi.socketEmit).toHaveBeenCalledWith('insert_queued_run', {
      session_id: 'session-1',
      queue_id: 'queue-follow-up',
    })

    handlers.onQueueInsertionUpdated({
      event: 'run.queue_insertion.updated',
      session_id: 'session-1',
      generation: 'generation-1',
      run_id: 'run-1',
      queue_id: 'queue-follow-up',
      runtime: 'hermes',
      phase: 'waiting_for_tool_batch',
      guarantee: 'strict',
      requested_at: 123,
    })
    expect(store.queueInsertionStates.get('session-1')).toEqual({
      generation: 'generation-1',
      runId: 'run-1',
      queueId: 'queue-follow-up',
      runtime: 'hermes',
      phase: 'waiting_for_tool_batch',
      guarantee: 'strict',
      requestedAt: 123,
    })

    handlers.onQueueInsertionUpdated({
      event: 'run.queue_insertion.updated',
      session_id: 'session-1',
      generation: 'generation-1',
      run_id: 'run-1',
      queue_id: 'queue-follow-up',
      runtime: 'codex',
      phase: 'stopping_current_turn',
      guarantee: 'immediate',
      requested_at: 124,
    })
    expect(store.queueInsertionStates.get('session-1')).toEqual({
      generation: 'generation-1',
      runId: 'run-1',
      queueId: 'queue-follow-up',
      runtime: 'codex',
      phase: 'stopping_current_turn',
      guarantee: 'immediate',
      requestedAt: 124,
    })

    handlers.onQueueInsertionUpdated({
      event: 'run.queue_insertion.updated',
      session_id: 'session-1',
      generation: 'generation-1',
      run_id: 'run-1',
      queue_id: 'queue-follow-up',
      runtime: 'cursor',
      phase: 'stopping_current_turn',
      guarantee: 'immediate',
      requested_at: 125,
    })
    expect(store.queueInsertionStates.get('session-1')).toEqual({
      generation: 'generation-1',
      runId: 'run-1',
      queueId: 'queue-follow-up',
      runtime: 'cursor',
      phase: 'stopping_current_turn',
      guarantee: 'immediate',
      requestedAt: 125,
    })

    handlers.onQueueInsertionUpdated({
      event: 'run.queue_insertion.updated',
      session_id: 'session-1',
      generation: 'generation-1',
      queue_id: 'queue-follow-up',
      runtime: 'codex',
      phase: 'starting_queued_message',
      guarantee: 'immediate',
      requested_at: 123,
    })
    expect(store.queueInsertionStates.get('session-1')).toBeUndefined()
  })

  it('does not clear the transcript for goal done commands', () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [
      { id: 'user-1', role: 'user', content: 'keep me', timestamp: 1 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'clear',
      message: 'Goal cleared.',
      terminal: true,
    })

    expect(store.messages).toEqual([
      expect.objectContaining({ id: 'user-1', content: 'keep me' }),
      expect.objectContaining({
        role: 'command',
        content: 'Goal cleared.',
        commandAction: 'clear',
      }),
    ])
  })

  it('updates session title from the global generated-title event', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    expect(chatApi.sessionTitleUpdatedHandlers).toHaveLength(1)

    chatApi.sessionTitleUpdatedHandlers[0]({
      event: 'session.title.updated',
      session_id: 'session-1',
      title: 'Generated Title',
    })

    expect(store.sessions[0].title).toBe('Generated Title')
    expect(store.activeSession?.title).toBe('Generated Title')
  })

  it('forwards maximum reasoning effort from the active session to the run request', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.reasoningEffort = 'max'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('use the maximum reasoning budget')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'use the maximum reasoning budget',
        session_id: 'session-1',
        reasoning_effort: 'max',
      }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Object),
    )
  })

  it('does not show a thinking/streaming state while submitting terminal fork commands', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messageCount = 2
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Previous question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Previous answer', timestamp: 2 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/fork')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledWith(
      expect.objectContaining({ input: '/fork', session_id: 'session-1', source: 'cli' }),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Object),
    )
    expect(store.isStreaming).toBe(false)
  })

  it('debounces terminal fork commands until the session.command settles', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messageCount = 2
    session.messages = [
      { id: 'user-1', role: 'user', content: 'Previous question', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'Previous answer', timestamp: 2 },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/fork')
    await store.sendMessage('/fork')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(store.isStreaming).toBe(false)
    expect(store.isForkPending).toBe(true)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'fork',
      action: 'branch',
      ok: false,
      message: 'Cannot branch: no conversation messages found to copy.',
      terminal: true,
    })

    expect(store.isForkPending).toBe(false)
  })

  it('clears stale working state when terminal session commands complete', () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'resume',
      message: 'Goal resumed',
      started: true,
      terminal: false,
    })
    expect(store.isStreaming).toBe(true)

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'done',
      message: 'Goal done.',
      terminal: true,
    })

    expect(store.isStreaming).toBe(false)
  })

  it('settles stale runtime tool rows when terminal session commands complete', () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [
      { id: 'tool-1', role: 'tool', content: '', timestamp: 1, toolName: 'shell', toolStatus: 'running' },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'status',
      action: 'status',
      message: 'Status: idle',
      terminal: true,
    })

    expect(store.messages[0]).toEqual(expect.objectContaining({
      role: 'tool',
      toolName: 'shell',
      toolStatus: 'done',
    }))
    expect(store.isStreaming).toBe(false)
  })

  it('settles stale runtime tool rows before sending an idle slash command', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    session.messages = [
      { id: 'tool-1', role: 'tool', content: '', timestamp: 1, toolName: 'weather', toolStatus: 'running' },
    ]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/status')

    expect(store.messages[0]).toEqual(expect.objectContaining({
      role: 'tool',
      toolName: 'weather',
      toolStatus: 'done',
    }))
    expect(store.messages[1]).toEqual(expect.objectContaining({
      role: 'command',
      content: '/status',
    }))
  })

  it('adds peer command messages to the transcript even after the session command marks the run live', () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers.forEach(handler => handler({
      event: 'session.command',
      session_id: 'session-1',
      command: 'moa',
      action: 'moa',
      message: 'MoA one-shot queued with preset default.',
      started: true,
      terminal: false,
    }))
    chatApi.peerUserMessageHandlers.forEach(handler => handler({
      event: 'run.peer_user_message',
      session_id: 'session-1',
      message: {
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        timestamp: 2,
      },
    }))

    expect(store.queuedUserMessages.get('session-1')).toBeUndefined()
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'command',
        content: 'MoA one-shot queued with preset default.',
        commandAction: 'moa',
      }),
      expect.objectContaining({
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        queued: false,
      }),
    ])
  })

  it('adds an explicitly non-queued peer user message after another window starts the run', () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'codex'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers.forEach(handler => handler({
      event: 'session.command',
      session_id: 'session-1',
      action: 'resume',
      started: true,
      terminal: false,
    }))
    chatApi.peerUserMessageHandlers.forEach(handler => handler({
      event: 'run.peer_user_message',
      session_id: 'session-1',
      message: {
        id: 'phone-message-1',
        role: 'user',
        content: 'Message from phone',
        timestamp: 2,
        queued: false,
      },
    }))

    expect(store.queuedUserMessages.get('session-1')).toBeUndefined()
    expect(store.messages).toContainEqual(expect.objectContaining({
      id: 'phone-message-1',
      role: 'user',
      content: 'Message from phone',
      queued: false,
    }))
  })

  it('moves an existing peer command queue entry into the transcript when the command starts', () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.sessionCommandHandlers.forEach(handler => handler({
      event: 'session.command',
      session_id: 'session-1',
      action: 'moa',
      started: true,
      terminal: false,
    }))
    chatApi.registerSessionHandlers.mock.calls.at(-1)?.[1]?.onRunQueued?.({
      event: 'run.queued',
      session_id: 'session-1',
      queue_length: 1,
      queued_messages: [
        { id: 'queue-moa', role: 'command', content: '/moa test', timestamp: 2, queued: true },
      ],
    })

    chatApi.peerUserMessageHandlers.forEach(handler => handler({
      event: 'run.peer_user_message',
      session_id: 'session-1',
      message: {
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        timestamp: 3,
      },
    }))

    expect(store.queuedUserMessages.get('session-1')).toBeUndefined()
    expect(store.messages).toEqual([
      expect.objectContaining({
        id: 'queue-moa',
        role: 'command',
        content: '/moa test',
        queued: false,
      }),
    ])
  })

  it('applies empty history snapshots and restores plans without persisted message bodies', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [{ id: 'stale', role: 'user', content: 'Old cached message', timestamp: 1 }]
    store.sessions = [session]
    const plan = {
      session_id: session.id, run_id: 'run-1', plan_id: 'run-1', revision: 1,
      execution_state: 'running', created_at: 2, updated_at: 2,
      plan: [{ id: 'a', step: 'Verify', status: 'pending' }],
    }
    chatApi.resumeSession.mockImplementationOnce((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], taskPlans: [plan], messageTotal: 0, isWorking: false })
      return {} as any
    })

    await store.switchSession(session.id)
    expect(store.activeSession?.messages).toEqual([
      expect.objectContaining({ taskPlan: plan }),
    ])
    expect(store.activeSession?.loadedMessageCount).toBe(0)

    chatApi.resumeSession.mockImplementationOnce((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], taskPlans: [], messageTotal: 0, isWorking: false })
      return {} as any
    })
    await store.switchSession(session.id)
    expect(store.activeSession?.messages).toEqual([])
  })

  it('adds and switches to a branched child session from session.command branch events', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: sessionId === 'branch-1' ? [
          { id: 1, role: 'user', content: 'Previous question', timestamp: 1 },
          { id: 2, role: 'assistant', content: 'Previous answer', timestamp: 2 },
        ] : [
          { id: 3, role: 'command', content: 'Branched session "Side path" from session-1.', timestamp: 3 },
        ],
        parentSessionId: 'session-1',
        forkPointMessageId: '2',
        parentTitle: 'session',
        parentLastMessage: 'Previous answer',
        parentLastMessageRole: 'assistant',
        messageLoadedCount: sessionId === 'branch-1' ? 2 : 1,
        messageTotal: sessionId === 'branch-1' ? 2 : 1,
        hasMoreBefore: false,
        isWorking: false,
        events: [],
        queueLength: 0,
      })
      return {} as any
    })

    chatApi.sessionCommandHandlers[0]({
      event: 'session.command',
      session_id: 'session-1',
      command: 'fork',
      action: 'branch',
      ok: true,
      parentSessionId: 'session-1',
      newSessionId: 'branch-1',
      newSessionTitle: 'Side path',
      branchSession: {
        id: 'branch-1',
        profile: 'default',
        source: 'cli',
        title: 'Side path',
        model: 'openai/gpt-5.4',
        provider: 'openai-codex',
        parentSessionId: 'session-1',
        forkPointMessageId: '2',
        parentTitle: 'session',
        parentLastMessage: 'Previous answer',
        parentLastMessageRole: 'assistant',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        messageCount: 2,
        workspace: '/repo',
      },
      message: 'Branched session "Side path" from session-1.',
    })
    await Promise.resolve()

    const branch = store.sessions.find((item: Session) => item.id === 'branch-1')
    expect(branch).toMatchObject({
      title: 'Side path',
      source: 'cli',
      profile: 'default',
      model: 'openai/gpt-5.4',
      provider: 'openai-codex',
      parentSessionId: 'session-1',
      forkPointMessageId: '2',
      parentTitle: 'session',
      parentLastMessage: 'Previous answer',
      parentLastMessageRole: 'assistant',
      messageCount: 2,
      workspace: '/repo',
    })
    expect(store.activeSessionId).toBe('branch-1')
    expect(chatApi.resumeSession).toHaveBeenCalledWith('branch-1', expect.any(Function), 'default', 'chat-run')

    expect(store.sessions.find((item: Session) => item.id === 'session-1')?.messages.at(-1)).toMatchObject({
      role: 'command',
      commandAction: 'branch',
      content: 'Branched session "Side path" from session-1.',
    })

    await store.switchSession('session-1')
    expect(store.activeSessionId).toBe('session-1')
    expect(store.activeSession?.id).toBe('session-1')
    expect(store.sessions.find((item: Session) => item.id === 'session-1')?.messages.at(-1)).toMatchObject({
      role: 'command',
      content: 'Branched session "Side path" from session-1.',
    })

    await store.switchSession('branch-1')
    expect(store.activeSessionId).toBe('branch-1')
    expect(store.activeSession?.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Previous question' }),
      expect.objectContaining({ role: 'assistant', content: 'Previous answer' }),
    ])
  })
})
