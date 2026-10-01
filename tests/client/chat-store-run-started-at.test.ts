// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  sessionHandlers: new Map<string, any>(),
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
  onRunUsageUpdated: vi.fn(() => vi.fn()),
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

/**
 * The run clock is per session and belongs to one run. It has to survive a
 * resume, be dropped the moment that run ends, and never be inherited by the
 * next run or by another session.
 */
describe('chat store run start bookkeeping', () => {
  const RUN_STARTED_AT = 1_787_000_000_000

  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.sessionHandlers = new Map()
    chatApi.registerSessionHandlers.mockImplementation((sessionId: string, handlers: any) => {
      chatApi.sessionHandlers.set(sessionId, handlers)
    })
    chatApi.unregisterSessionHandlers.mockImplementation((sessionId: string) => {
      chatApi.sessionHandlers.delete(sessionId)
    })
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
  })

  function resumeWith(payload: Record<string, any>) {
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], events: [], queueLength: 0, ...payload })
      return {} as any
    })
  }

  it('keeps the reported start while the run is working', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), id: 'a' }] as any
    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT })

    await store.switchSession('a')

    expect(store.runStartedAt.get('a')).toBe(RUN_STARTED_AT)
  })

  it('drops it when the resumed session is no longer working', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), id: 'a' }] as any
    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT })
    await store.switchSession('a')

    resumeWith({ isWorking: false })
    await store.switchSession('a')

    // A finished run must not leave its start behind for the next one.
    expect(store.runStartedAt.has('a')).toBe(false)
  })

  it('keeps two working sessions on their own starts', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), id: 'a' }, { ...makeSession(), id: 'b' }] as any

    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT })
    await store.switchSession('a')
    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT + 60_000 })
    await store.switchSession('b')

    expect(store.runStartedAt.get('a')).toBe(RUN_STARTED_AT)
    expect(store.runStartedAt.get('b')).toBe(RUN_STARTED_AT + 60_000)
  })

  it('forgets the start when the run ends, so the next run does not inherit it', async () => {
    const store = useChatStore()
    const session = { ...makeSession(), id: 'a' } as any
    store.sessions = [session]
    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT })
    await store.switchSession('a')
    expect(store.runStartedAt.get('a')).toBe(RUN_STARTED_AT)

    store.activeSessionId = 'a'
    store.activeSession = session
    await store.sendMessage('go on then')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    onEvent({ event: 'run.started', session_id: 'a', run_id: 'run-1' })
    expect(store.runStartedAt.get('a')).not.toBe(RUN_STARTED_AT)
    onEvent({ event: 'run.completed', session_id: 'a', run_id: 'run-1', output: 'done' })

    // The finished run's start must not linger for whatever runs next.
    expect(store.runStartedAt.has('a')).toBe(false)
  })

  it('ignores a start that arrives without the session working', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), id: 'a' }] as any
    resumeWith({ isWorking: false, runStartedAt: RUN_STARTED_AT })

    await store.switchSession('a')

    expect(store.runStartedAt.has('a')).toBe(false)
  })

  it('clears the start when a resumed run ends and refreshes it for the next queued run', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), id: 'a' }] as any
    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT })

    await store.switchSession('a')
    const handlers = chatApi.sessionHandlers.get('a')
    expect(handlers).toBeTruthy()

    handlers.onRunCompleted({
      event: 'run.completed',
      session_id: 'a',
      run_id: 'run-1',
      output: 'done',
      queue_remaining: 1,
      background_pending: 0,
    })
    expect(store.runStartedAt.has('a')).toBe(false)

    handlers.onRunStarted({ event: 'run.started', session_id: 'a', run_id: 'run-2' })
    expect(store.runStartedAt.get('a')).toBeGreaterThan(RUN_STARTED_AT)
  })

  it('drops a stale start when a working resume has no timestamp', async () => {
    const store = useChatStore()
    store.sessions = [{ ...makeSession(), id: 'a' }] as any
    resumeWith({ isWorking: true, runStartedAt: RUN_STARTED_AT })
    await store.switchSession('a')

    resumeWith({ isWorking: true })
    await store.switchSession('a')

    expect(store.runStartedAt.has('a')).toBe(false)
  })
})
