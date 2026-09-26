// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  resumeSession: vi.fn((sessionId: string, onResumed: (data: any) => void) => {
    onResumed({ session_id: sessionId, messages: [], isWorking: false, events: [], queueLength: 0 })
    return {} as any
  }),
  sessionCommandHandlers: [] as Array<(event: any) => void>,
  peerUserMessageHandlers: [] as Array<(event: any) => void>,
  sessionTitleUpdatedHandlers: [] as Array<(event: any) => void>,
  sessionWorkspaceUpdatedHandlers: [] as Array<(event: any) => void>,
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
  onSessionWorkspaceUpdated: vi.fn((handler: (event: any) => void) => {
    chatApi.sessionWorkspaceUpdatedHandlers.push(handler)
    return vi.fn()
  }),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
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
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
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
