// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  globalPendingHandler: undefined as undefined | ((event: any) => void),
  respondClarify: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
}))

const completionSoundMock = vi.hoisted(() => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: chatApi.respondClarify,
  onPeerUserMessage: vi.fn((handler: (event: any) => void) => { chatApi.globalPendingHandler = handler; return vi.fn() }),
  onApprovalRequested: vi.fn(() => vi.fn()),
  onApprovalResolved: vi.fn(() => vi.fn()),
  onClarifyRequested: vi.fn(() => vi.fn()),
  onClarifyResolved: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
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

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: completionSoundMock.primeCompletionSound,
  playCompletionSound: completionSoundMock.playCompletionSound,
}))

import { useChatStore, type Message, type Session } from '@/stores/hermes/chat'
import { useSettingsStore } from '@/stores/hermes/settings'

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store error handling - #1644', () => {
  let handlers: any

  beforeEach(() => {
    handlers = undefined
    chatApi.globalPendingHandler = undefined
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: sessionId,
        messages: [],
        isWorking: false,
        events: [],
      })
      return {} as any
    })
    chatApi.registerSessionHandlers.mockImplementation((_sessionId: string, registeredHandlers: any) => {
      handlers = registeredHandlers
      return vi.fn()
    })
  })

  it('primes approval sound on direct send when completion sound is disabled', async () => {
    const store = useChatStore()
    const settingsStore = useSettingsStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    settingsStore.display.bell_on_complete = false
    settingsStore.display.approval_bell = true

    await store.sendMessage('request approval')

    expect(completionSoundMock.primeCompletionSound).toHaveBeenCalledOnce()
  })

  it('does not prime notification sound on direct send when both sound settings are disabled', async () => {
    const store = useChatStore()
    const settingsStore = useSettingsStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    settingsStore.display.bell_on_complete = false
    settingsStore.display.approval_bell = false

    await store.sendMessage('silent request')

    expect(completionSoundMock.primeCompletionSound).not.toHaveBeenCalled()
  })

  it('tracks an approval request from an inactive session through the global socket listener', () => {
    const store = useChatStore()
    const sessionA = makeSession('session-a')
    store.sessions = [sessionA, makeSession('session-b')]
    store.activeSessionId = 'session-a'
    store.activeSession = sessionA

    chatApi.globalPendingHandler?.({
      event: 'approval.requested',
      session_id: 'session-b',
      approval_id: 'approval-b',
      command: 'pwd',
      description: 'Run command',
      choices: ['once', 'deny'],
    })

    expect(store.pendingApprovals.get('session-b')).toMatchObject({ approvalId: 'approval-b', command: 'pwd' })
    expect(store.activePendingApproval).toBeNull()
  })

  it('anchors approval and clarification countdowns to server-provided remaining time', () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-b')]
    const now = performance.now()

    chatApi.globalPendingHandler?.({
      event: 'approval.requested', session_id: 'session-b', approval_id: 'approval-b',
      choices: ['once', 'deny'], timeout_ms: 300_000, remaining_timeout_ms: 42_000,
    })
    chatApi.globalPendingHandler?.({
      event: 'clarify.requested', session_id: 'session-b', clarify_id: 'clarify-b',
      question: 'Continue?', timeout_ms: 300_000, remaining_timeout_ms: 17_000,
    })

    expect(store.pendingApprovals.get('session-b')!.countdownDeadline - now).toBeGreaterThanOrEqual(41_900)
    expect(store.pendingApprovals.get('session-b')!.countdownDeadline - now).toBeLessThanOrEqual(42_100)
    expect(store.pendingClarifies.get('session-b')!.countdownDeadline - now).toBeGreaterThanOrEqual(16_900)
    expect(store.pendingClarifies.get('session-b')!.countdownDeadline - now).toBeLessThanOrEqual(17_100)
  })

  it('keeps every clarify question from the bridge and answers them per question id', () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-b')]

    chatApi.globalPendingHandler?.({
      event: 'clarify.requested', session_id: 'session-b', clarify_id: 'clarify-b',
      question: '1. Which environment?\n2. Which checks?',
      choices: null,
      questions: [
        { qid: 'q0', question: 'Which environment?', choices: ['staging (Recommended)', 'production'], multi_select: false },
        { qid: 'q1', question: 'Which checks?', choices: ['unit', 'e2e'], multi_select: true },
      ],
      timeout_ms: 300_000,
    })

    expect(store.pendingClarifies.get('session-b')!.questions).toEqual([
      { qid: 'q0', question: 'Which environment?', choices: ['staging (Recommended)', 'production'], multiSelect: false },
      { qid: 'q1', question: 'Which checks?', choices: ['unit', 'e2e'], multiSelect: true },
    ])

    expect(store.respondToClarifyFor('session-b', 'clarify-b', 'Which environment? production', {
      q0: 'production', q1: ['unit'],
    })).toBe('submitted')
    expect(chatApi.respondClarify).toHaveBeenCalledWith(
      'session-b', 'clarify-b', 'Which environment? production', { q0: 'production', q1: ['unit'] }, 'chat-run',
    )
  })

  it('keeps a pending approval when the authoritative response is unresolved', () => {
    const store = useChatStore()
    store.sessions = [makeSession('session-a'), makeSession('session-b')]
    chatApi.globalPendingHandler?.({
      event: 'approval.requested', session_id: 'session-b', approval_id: 'approval-b', choices: ['once', 'deny'],
    })

    chatApi.globalPendingHandler?.({
      event: 'approval.resolved', session_id: 'session-b', approval_id: 'approval-b', resolved: false, error: 'stale',
    })

    expect(store.pendingApprovals.get('session-b')).toMatchObject({ approvalId: 'approval-b' })
  })

  it('waits for the server to decide whether old approval and clarification prompts expired', () => {
    const store = useChatStore()
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)
    store.sessions = [makeSession('session-b')]
    chatApi.globalPendingHandler?.({
      event: 'approval.requested', session_id: 'session-b', approval_id: 'approval-b', choices: ['once', 'deny'], timeout_ms: 1,
    })
    chatApi.globalPendingHandler?.({
      event: 'clarify.requested', session_id: 'session-b', clarify_id: 'clarify-b', question: 'Continue?', timeout_ms: 1,
    })
    store.pendingApprovals.get('session-b')!.requestedAt = Date.now() - 10
    store.pendingClarifies.get('session-b')!.requestedAt = Date.now() - 10

    expect(store.respondApprovalFor('session-b', 'approval-b', 'once')).toBe('submitted')
    expect(store.respondToClarifyFor('session-b', 'clarify-b', 'Continue')).toBe('submitted')
    expect(store.pendingApprovals.has('session-b')).toBe(true)
    expect(store.pendingClarifies.has('session-b')).toBe(true)
    expect(expired).not.toHaveBeenCalled()

    chatApi.globalPendingHandler?.({
      event: 'approval.resolved', session_id: 'session-b', approval_id: 'approval-b', resolved: false,
      stale: true, error: 'Approval is no longer pending.',
    })
    chatApi.globalPendingHandler?.({
      event: 'clarify.resolved', session_id: 'session-b', clarify_id: 'clarify-b', resolved: false,
      stale: true, error: 'Clarification is no longer pending.',
    })

    expect(store.pendingApprovals.has('session-b')).toBe(false)
    expect(store.pendingClarifies.has('session-b')).toBe(false)
    expect(expired).toHaveBeenCalledTimes(2)
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })

  it('reports a server-confirmed stale response after optimistic local removal', () => {
    const store = useChatStore()
    const session = makeSession('session-b')
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session
    chatApi.globalPendingHandler?.({
      event: 'approval.requested', session_id: session.id, approval_id: 'approval-b', choices: ['once', 'deny'], timeout_ms: 300_000,
    })

    expect(store.respondApproval('once')).toBe('submitted')
    expect(store.pendingApprovals.has(session.id)).toBe(false)
    chatApi.globalPendingHandler?.({
      event: 'approval.resolved', session_id: session.id, approval_id: 'approval-b', resolved: false,
      stale: true, error: 'Approval is no longer pending.',
    })

    expect(expired).toHaveBeenCalledOnce()
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })

  it('preserves assistant content when run.failed fires during streaming with substantial content', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    // Simulate run.started
    onEvent({ event: 'run.started', session_id: 'session-1', run_id: 'run-1' })

    // Simulate message.delta with substantial content (>100 chars)
    const longContent = 'A'.repeat(200)
    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      run_id: 'run-1',
      delta: longContent,
      output: longContent,
    })

    // At this point the assistant message should be streaming with content
    let assistantMsg = store.activeSession?.messages.find(
      (m: Message) => m.role === 'assistant',
    )
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.isStreaming).toBe(true)
    expect((assistantMsg as any)?.content).toBe(longContent)

    // Simulate run.failed (e.g., socket disconnect)
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      run_id: 'run-1',
      error: 'Socket disconnected',
    })

    // The original assistant message should be preserved (not overwritten)
    const msgs = store.activeSession?.messages || []
    assistantMsg = msgs.find((m: Message) => m.content === longContent)
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toBe(longContent)
    expect(assistantMsg?.isStreaming).toBe(false)
    expect(assistantMsg?.systemType).toBeUndefined()

    // A separate error message should be appended
    const errorMessage = msgs.find(
      (m: Message) => m.role === 'assistant' && m.systemType === 'error',
    )
    expect(errorMessage).toBeDefined()
    expect(errorMessage?.content).toBe('Error: Socket disconnected')
  })

  it('overwrites empty streaming message when run.failed fires (no substantial content)', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    // Simulate run.started
    onEvent({ event: 'run.started', session_id: 'session-1', run_id: 'run-1' })

    // Simulate message.delta with only a short content (<100 chars)
    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      run_id: 'run-1',
      delta: 'Hi',
      output: 'Hi',
    })

    // Simulate run.failed
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      run_id: 'run-1',
      error: 'Something went wrong',
    })

    const msgs = store.activeSession?.messages || []
    const assistantMsg = msgs.find((m: Message) => m.role === 'assistant')
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg?.content).toBe('Error: Something went wrong')
    expect(assistantMsg?.systemType).toBe('error')
    expect(assistantMsg?.isStreaming).toBe(false)
  })

  it('appends error as separate message when streaming has finished (isStreaming false)', async () => {
    const store = useChatStore()
    const session = makeSession('session-1')
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run claude')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void

    // Simulate run.started
    onEvent({ event: 'run.started', session_id: 'session-1', run_id: 'run-1' })

    // Simulate message.delta
    onEvent({
      event: 'message.delta',
      session_id: 'session-1',
      run_id: 'run-1',
      delta: 'Hello, how can I help you?',
      output: 'Hello, how can I help you?',
    })

    // Simulate run.completed (closes streaming)
    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      run_id: 'run-1',
    })

    // At this point isStreaming should be false
    const assistantMsg = store.activeSession?.messages.find(
      (m: Message) => m.role === 'assistant',
    )
    expect(assistantMsg?.isStreaming).toBe(false)

    // Now simulate run.failed (e.g., late socket error)
    onEvent({
      event: 'run.failed',
      session_id: 'session-1',
      run_id: 'run-1',
      error: 'Late socket error',
    })

    // Original message should be unchanged
    const msgs = store.activeSession?.messages || []
    const firstAssistant = msgs.find((m: Message) => m.content === 'Hello, how can I help you?')
    expect(firstAssistant).toBeDefined()
    expect(firstAssistant?.systemType).toBeUndefined()

    // Error appended as separate message
    const errorMessage = msgs.find((m: Message) => m.systemType === 'error')
    expect(errorMessage).toBeDefined()
    expect(errorMessage?.content).toBe('Error: Late socket error')
  })
})
