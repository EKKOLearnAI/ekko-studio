// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))
const sessionsApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  setSessionModel: vi.fn(),
  setSessionPushEnabled: vi.fn(),
  setSessionReasoningEffort: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: chatApi.registerSessionHandlers,
  unregisterSessionHandlers: chatApi.unregisterSessionHandlers,
  getChatRunSocket: chatApi.getChatRunSocket,
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: chatApi.onSessionSettingsUpdated,
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSession: vi.fn(),
  fetchSessions: sessionsApi.fetchSessions,
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: sessionsApi.setSessionModel,
  setSessionPushEnabled: sessionsApi.setSessionPushEnabled,
  setSessionReasoningEffort: sessionsApi.setSessionReasoningEffort,
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id = 'session-1'): Session {
  return {
    id,
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store per-session reasoning effort', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    localStorage.clear()
    sessionsApi.setSessionReasoningEffort.mockResolvedValue(true)
    sessionsApi.setSessionPushEnabled.mockResolvedValue(true)
    sessionsApi.setSessionModel.mockResolvedValue(true)
    sessionsApi.fetchSessions.mockResolvedValue([])
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  })

  it('persists the chosen effort on the server', async () => {
    const store = useChatStore()
    const session = makeSession('s1')
    store.sessions = [session]

    await store.setSessionReasoningEffort('s1', 'low')

    expect(store.sessions[0].reasoningEffort).toBe('low')
    expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledWith('s1', 'low')
  })

  it('carries a draft effort into the new session first run without a settings write', async () => {
    const store = useChatStore()
    const session = store.newChat({ model: 'draft-model', provider: 'draft-provider', reasoningEffort: 'max' })
    await store.sendMessage('First message')
    expect(chatApi.startRunViaSocket.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      session_id: session.id, reasoning_effort: 'max', model: 'draft-model', provider: 'draft-provider',
    }))
    expect(sessionsApi.setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it.each([
    { provider: 'moa', model: 'ensemble' },
    { codingAgentId: 'codex' as const, codingAgentMode: 'global' as const },
  ])('does not carry a draft effort into MoA or global CLI configuration: %j', options => {
    const session = useChatStore().newChat({ ...options, reasoningEffort: 'max' })
    expect(session.reasoningEffort).toBeUndefined()
  })

  it('persists the default value as an empty server setting', async () => {
    const store = useChatStore()
    const session = makeSession('s2')
    session.reasoningEffort = 'high'
    store.sessions = [session]

    await store.setSessionReasoningEffort('s2', '')

    expect(store.sessions[0].reasoningEffort).toBeUndefined()
    expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledWith('s2', '')
  })

  it('keeps each session independent', async () => {
    const store = useChatStore()
    const a = makeSession('a')
    const b = makeSession('b')
    store.sessions = [a, b]

    await store.setSessionReasoningEffort('a', 'minimal')
    await store.setSessionReasoningEffort('b', 'high')

    expect(store.sessions.find(s => s.id === 'a')?.reasoningEffort).toBe('minimal')
    expect(store.sessions.find(s => s.id === 'b')?.reasoningEffort).toBe('high')
  })

  it('is a no-op when the session does not exist', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('only-one')]

    await expect(store.setSessionReasoningEffort('missing', 'high')).resolves.toBe(false)
    expect(store.sessions[0].reasoningEffort).toBeUndefined()
    expect(sessionsApi.setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('loads reasoning effort from the server session summary', async () => {
    sessionsApi.fetchSessions.mockImplementation(async (source?: string) => source === 'global_agent'
      ? []
      : [{
          id: 'server-session',
          source: 'cli',
          model: 'gpt-5.5',
          title: 'server session',
          started_at: 1,
          ended_at: null,
          message_count: 0,
          tool_call_count: 0,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          billing_provider: null,
          estimated_cost_usd: 0,
          actual_cost_usd: null,
          cost_status: '',
          reasoning_effort: 'medium',
        }])
    const store = useChatStore()

    await store.refreshSessionListOnly('default')

    expect(store.sessions[0]).toEqual(expect.objectContaining({
      id: 'server-session',
      reasoningEffort: 'medium',
    }))
  })

  it('keeps a local-only choice in memory until the first run creates the server session', async () => {
    const store = useChatStore()
    const session = makeSession('local-session')
    session.isLocalOnly = true
    store.sessions = [session]

    await expect(store.setSessionReasoningEffort('local-session', 'max')).resolves.toBe(true)

    expect(session.reasoningEffort).toBe('max')
    expect(sessionsApi.setSessionReasoningEffort).not.toHaveBeenCalled()
  })

  it('persists whether an existing session should be pushed', async () => {
    const store = useChatStore()
    const session = makeSession('push-session')
    store.sessions = [session]

    await expect(store.setSessionPushEnabled(session.id, true)).resolves.toBe(true)

    expect(session.pushEnabled).toBe(true)
    expect(sessionsApi.setSessionPushEnabled).toHaveBeenCalledWith(session.id, true)
  })

  it('keeps a local-only push choice for the first run without calling the session endpoint', async () => {
    const store = useChatStore()
    const session = makeSession('local-push-session')
    session.isLocalOnly = true
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    await expect(store.setSessionPushEnabled(session.id, true)).resolves.toBe(true)
    await store.sendMessage('persist this push setting')

    expect(session.pushEnabled).toBe(true)
    expect(sessionsApi.setSessionPushEnabled).not.toHaveBeenCalled()
    expect(chatApi.startRunViaSocket.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({
      session_id: session.id,
      push_enabled: true,
    }))
  })

  it('rolls back the push choice when persistence fails', async () => {
    sessionsApi.setSessionPushEnabled.mockResolvedValue(false)
    const store = useChatStore()
    const session = makeSession('failed-push-session')
    store.sessions = [session]

    await expect(store.setSessionPushEnabled(session.id, true)).resolves.toBe(false)

    expect(session.pushEnabled).toBe(false)
  })

  it('rolls back the optimistic value when server persistence fails', async () => {
    sessionsApi.setSessionReasoningEffort.mockResolvedValue(false)
    const store = useChatStore()
    const session = makeSession('failed-session')
    session.reasoningEffort = 'low'
    store.sessions = [session]

    await expect(store.setSessionReasoningEffort('failed-session', 'high')).resolves.toBe(false)

    expect(session.reasoningEffort).toBe('low')
  })

  it('serializes rapid slider writes so the last selected effort wins on the server', async () => {
    let finishFirstWrite: ((value: boolean) => void) | undefined
    sessionsApi.setSessionReasoningEffort
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFirstWrite = resolve }))
      .mockResolvedValueOnce(true)
    const store = useChatStore()
    const session = makeSession('rapid-session')
    store.sessions = [session]

    const firstWrite = store.setSessionReasoningEffort(session.id, 'low')
    const lastWrite = store.setSessionReasoningEffort(session.id, 'max')
    await vi.waitFor(() => {
      expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledTimes(1)
    })
    finishFirstWrite?.(true)
    await Promise.all([firstWrite, lastWrite])
    expect(sessionsApi.setSessionReasoningEffort.mock.calls).toEqual([
      [session.id, 'low'],
      [session.id, 'max'],
    ])
    expect(session.reasoningEffort).toBe('max')
  })

  it('waits for pending reasoning writes before resetting to default on model switch', async () => {
    let finishWrite: ((value: boolean) => void) | undefined
    sessionsApi.setSessionReasoningEffort.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { finishWrite = resolve }),
    )
    const store = useChatStore()
    const session = makeSession('model-session')
    session.model = 'old-model'
    session.provider = 'openai'
    store.sessions = [session]

    const reasoningWrite = store.setSessionReasoningEffort(session.id, 'high')
    const modelWrite = store.switchSessionModel('new-model', 'openai', session.id)
    await vi.waitFor(() => {
      expect(sessionsApi.setSessionReasoningEffort).toHaveBeenCalledTimes(1)
    })
    expect(sessionsApi.setSessionModel).not.toHaveBeenCalled()
    finishWrite?.(true)
    await reasoningWrite
    await expect(modelWrite).resolves.toBe(true)
    expect(sessionsApi.setSessionModel).toHaveBeenCalledWith(session.id, 'new-model', 'openai', undefined)
    expect(session.reasoningEffort).toBeUndefined()
  })

  it('applies settings broadcasts from another window watching the session', async () => {
    const store = useChatStore()
    const session = makeSession('shared-session')
    session.model = 'old-model'
    session.reasoningEffort = 'low'
    session.pushEnabled = false
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    await store.sendMessage('start')
    const onEvent = chatApi.startRunViaSocket.mock.calls.at(-1)?.[1]
    onEvent?.({
      event: 'session.settings.updated',
      session_id: session.id,
      model: 'new-model',
      provider: 'openai',
      api_mode: 'codex_responses',
      reasoning_effort: '',
      push_enabled: true,
    })

    expect(session).toEqual(expect.objectContaining({
      model: 'new-model',
      provider: 'openai',
      apiMode: 'codex_responses',
      reasoningEffort: undefined,
      pushEnabled: true,
    }))
  })

  it('applies settings broadcasts while the selected session is idle', () => {
    const store = useChatStore()
    const session = makeSession('idle-shared-session')
    session.model = 'old-model'
    session.reasoningEffort = 'low'
    session.pushEnabled = false
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    const onSettingsUpdated = chatApi.onSessionSettingsUpdated.mock.calls.at(-1)?.[0]
    onSettingsUpdated?.({
      event: 'session.settings.updated',
      session_id: session.id,
      model: 'new-model',
      provider: 'openai',
      reasoning_effort: '',
      push_enabled: true,
    })

    expect(session).toEqual(expect.objectContaining({
      model: 'new-model',
      provider: 'openai',
      reasoningEffort: undefined,
      pushEnabled: true,
    }))
  })

  it('reconciles persisted settings from the resume snapshot after reconnect', async () => {
    chatApi.resumeSession.mockImplementationOnce((_sessionId: string, onResumed: (data: any) => void) => {
      onResumed({
        session_id: 'resume-session',
        messages: [],
        isWorking: false,
        events: [],
        model: 'server-model',
        provider: 'openai',
        api_mode: 'codex_responses',
        reasoning_effort: 'max',
        push_enabled: true,
      })
      return {}
    })
    const store = useChatStore()
    const session = makeSession('resume-session')
    session.model = 'stale-model'
    session.reasoningEffort = 'low'
    session.pushEnabled = false
    store.sessions = [session]

    await store.switchSession(session.id)

    expect(session).toEqual(expect.objectContaining({
      model: 'server-model',
      provider: 'openai',
      apiMode: 'codex_responses',
      reasoningEffort: 'max',
      pushEnabled: true,
    }))
  })
})
