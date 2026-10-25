// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(),
  onPersistedAgentMessage: vi.fn(() => vi.fn()), onAgentInteraction: vi.fn(() => vi.fn()), respondManagedAgent: vi.fn(), createOrdinaryAgentChat: vi.fn(),
}))
vi.mock('@/api/studio/agent-management', () => ({ respondManagedAgent: api.respondManagedAgent, createOrdinaryAgentChat: api.createOrdinaryAgentChat }))
vi.mock('@/api/studio/chat', () => ({
  ...api,
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(), onSessionCommand: vi.fn(),
  onSessionTitleUpdated: vi.fn(), onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(), onSessionSettingsUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(), fetchSessions: vi.fn(async () => []),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(), setSessionModel: vi.fn(),
}))
vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(), fetchAvailableModels: vi.fn(), addCustomModel: vi.fn(), removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(), updateModelVisibility: vi.fn(), triggerUpdate: vi.fn(), updateModelAlias: vi.fn(),
}))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
import { useChatStore, type Session } from '@/stores/hermes/chat'

function session(id: string, profile = 'default'): Session {
  return { id, profile, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now() }
}

beforeEach(() => {
  vi.resetAllMocks()
  setActivePinia(createPinia())
  api.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  api.resumeSession.mockImplementation((sid, callback) => {
    callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })
  })
})

describe('sidebar working state', () => {
  it('upserts native message snapshots by stored id, removes optimistic input and completes without a false empty-answer error', async () => {
    const store = useChatStore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    await store.sendMessage('Native input')
    const [body, onEvent] = api.startRunViaSocket.mock.calls[0]
    const persisted = api.onPersistedAgentMessage.mock.calls[0][0] as (event: any) => void
    onEvent({ event: 'run.started', session_id: 'one', run_id: 'native-run', agent_run_id: 'native-run' })
    const row = (id: number, role: string, content: string) => ({ id, role, content, session_id: 'one', run_marker: 'native-run', timestamp: 1 })
    const emit = (messages: any[]) => {
      const event = { event: 'message.persisted', session_id: 'one', agent_run_id: 'native-run', queue_id: body.queue_id, messages }
      persisted(event); onEvent(event)
    }
    emit([row(11, 'user', 'Native input'), row(12, 'assistant', 'Draft')])
    emit([row(12, 'assistant', 'Corrected answer')])
    emit([row(12, 'assistant', 'Corrected answer')])
    onEvent({ event: 'run.completed', session_id: 'one', run_id: 'native-run', agent_run_id: 'native-run', queue_remaining: 0 })
    expect(store.activeSession?.messages.map(message => [message.id, message.content])).toEqual([['11', 'Native input'], ['12', 'Corrected answer']])
    expect(store.activeSession?.messages.some(message => message.isStreaming)).toBe(false)
    expect(store.isSessionLive('one')).toBe(false)
  })

  it('keeps native approval choice ids and waits for a receipt before moving to another pending interaction', async () => {
    const store = useChatStore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    const notify = api.onAgentInteraction.mock.calls[0][0] as (event: any) => void
    const native = { id: 'approval-1', runId: 'run', requestId: 'private-native-id', status: 'pending', kind: 'approval', prompt: 'Allow this operation?',
      choices: [{ id: 'accept-once', label: 'Allow once' }, { id: 'decline', label: 'Decline' }], expiresAt: Date.now() + 60_000 }
    notify({ session_id: 'one', interaction: native })
    notify({ session_id: 'one', interaction: { ...native, id: 'approval-2' } })
    expect(store.activePendingClarify?.clarifyId).toBe('approval-1')
    const response = Promise.withResolvers<any>()
    api.respondManagedAgent.mockReturnValue(response.promise)
    expect(store.respondToClarifyFor('one', 'approval-1', 'arbitrary text')).toBe('missing')
    expect(api.respondManagedAgent).not.toHaveBeenCalled()
    expect(store.respondToClarifyFor('one', 'approval-1', 'Allow once')).toBe('submitted')
    expect(api.respondManagedAgent).toHaveBeenCalledWith('default', 'run', expect.objectContaining({ interactionId: 'approval-1', choiceId: 'accept-once' }))
    expect(store.activePendingClarify?.clarifyId).toBe('approval-1')
    response.resolve({ id: 'approval-1', runId: 'run', status: 'resolved' })
    await vi.waitFor(() => expect(store.activePendingClarify?.clarifyId).toBe('approval-2'))
  })

  it('reattaches passive background listeners when a visible tab resumes idle foreground work', async () => {
    const listen = vi.spyOn(document, 'addEventListener')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const store = useChatStore()
    const onVisible = listen.mock.calls.find(call => call[0] === 'visibilitychange')![1] as () => void
    listen.mockRestore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    api.resumeSession.mockImplementationOnce((sid, callback) => {
      callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 1 })
    })
    onVisible()
    expect(store.isSessionWorking('one')).toBe(true)
    expect(store.isSessionLive('one')).toBe(false)
    expect(api.registerSessionHandlers).toHaveBeenCalledTimes(1)
    const handlers = api.registerSessionHandlers.mock.calls[0][1]
    handlers.onSubagentEvent({ event: 'delegation.updated', session_id: 'one', background_pending: 0, status: 'cancelled' })
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it('clears delegated activity on runtime changes', async () => {
    const store = useChatStore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    await store.sendMessage('delegate')
    const onEvent = api.startRunViaSocket.mock.calls[0][1]
    onEvent({ event: 'run.completed', session_id: 'one', output: 'Started', background_pending: 1 })
    expect(store.isSessionWorking('one')).toBe(true)
    store.setRuntimeMode('global_agent')
    expect(store.isSessionWorking('one')).toBe(false)
    onEvent({ event: 'delegation.updated', session_id: 'one', status: 'running', background_pending: 1 })
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it.each(['completed', 'failed', 'cancelled', 'interrupted'])('keeps work until every delegation is terminal (%s)', async (status) => {
    const store = useChatStore()
    store.sessions = [session('one'), session('two', 'research')]
    await store.switchSession('one')
    await store.sendMessage('delegate')
    const onEvent = api.startRunViaSocket.mock.calls[0][1]
    expect(store.isSessionWorking('one')).toBe(true)
    onEvent({ event: 'run.completed', session_id: 'one', output: 'Started', background_pending: 2 })
    expect(store.isStreaming).toBe(false)
    expect(store.isSessionLive('one')).toBe(false)
    expect(store.isSessionWorking('one')).toBe(true)
    await store.switchSession('two')
    onEvent({ event: 'delegation.updated', session_id: 'two', background_pending: 0, status })
    expect(store.isSessionWorking('one')).toBe(true)
    expect(store.isSessionWorking('two')).toBe(false)
    onEvent({ event: 'delegation.updated', session_id: 'one', background_pending: 1, status })
    expect(store.isSessionWorking('one')).toBe(true)
    onEvent({ event: 'delegation.updated', session_id: 'one', background_pending: 0, status })
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it('reconciles reconnect snapshots and does not resurrect activity from historical tasks', async () => {
    const store = useChatStore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    await store.sendMessage('delegate')
    const reconnect = api.startRunViaSocket.mock.calls[0][5].onReconnectResume
    reconnect({ session_id: 'one', isWorking: false, backgroundPending: 1, messages: [], events: [] })
    expect(store.isSessionWorking('one')).toBe(true)
    expect(store.isStreaming).toBe(false)
    reconnect({ session_id: 'one', isWorking: false, backgroundPending: 0, messages: [], events: [
      { event: 'delegation.updated', data: { event: 'delegation.updated', background_pending: 5, status: 'running' } },
      { event: 'subagent.start', data: { event: 'subagent.start', subagent_id: 'historical', background_pending: 5 } },
    ] })
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it('handles passive listeners and replaces stale activity when returning to a session', async () => {
    api.resumeSession.mockImplementationOnce((sid, callback) => {
      callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 2 })
    })
    const store = useChatStore()
    store.sessions = [session('one'), session('two', 'research')]
    await store.switchSession('one')
    const handlers = api.registerSessionHandlers.mock.calls[0][1]
    await store.switchSession('two')
    handlers.onSubagentEvent({ event: 'delegation.updated', session_id: 'one', background_pending: 1, status: 'completed' })
    expect(store.isSessionWorking('one')).toBe(true)
    expect(store.isSessionWorking('two')).toBe(false)
    await store.switchSession('one')
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it('does not stop foreground work when the background count reaches zero', async () => {
    const store = useChatStore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    await store.sendMessage('delegate')
    const onEvent = api.startRunViaSocket.mock.calls[0][1]
    onEvent({ event: 'delegation.updated', session_id: 'one', background_pending: 0, status: 'completed' })
    expect(store.isSessionWorking('one')).toBe(true)
    onEvent({ event: 'run.failed', session_id: 'one', error: 'failed', background_pending: 1 })
    expect(store.isSessionLive('one')).toBe(false)
    expect(store.isSessionWorking('one')).toBe(true)
    onEvent({ event: 'run.failed', session_id: 'one', error: 'failed', background_pending: 0 })
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it('restores background-only work from authoritative resume without making the composer busy', async () => {
    api.resumeSession.mockImplementationOnce((sid, callback) => {
      callback({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 2 })
    })
    const store = useChatStore()
    store.sessions = [session('one')]
    await store.switchSession('one')
    expect(store.isSessionWorking('one')).toBe(true)
    expect(store.isSessionLive('one')).toBe(false)
    expect(store.isStreaming).toBe(false)
    expect(store.isRunActive).toBe(false)
  })
})

it('binds a new ordinary Agent internally before sending and keeps the captured chat when the user switches tabs', async () => {
  const store = useChatStore()
  store.setRuntimeMode('default')
  const first = store.newChat({ source: 'coding_agent', codingAgentId: 'codex', codingAgentMode: 'global', profile: 'research', model: 'native-model', workspace: '/project' })
  const binding = Promise.withResolvers<any>()
  api.createOrdinaryAgentChat.mockReturnValue(binding.promise)
  const sent = store.sendMessage('First plugin input')
  await vi.waitFor(() => expect(api.createOrdinaryAgentChat).toHaveBeenCalledOnce())
  expect(api.startRunViaSocket).not.toHaveBeenCalled()
  expect(api.createOrdinaryAgentChat.mock.calls[0]).toMatchObject(['research', { sessionId: first.id, agentTypeId: 'codex', mode: 'global', model: 'native-model', workspace: '/project' }])
  store.newChat({ profile: 'default' })
  binding.resolve({ sessionId: first.id, instanceId: 'internal-instance', configurationRevision: 1 })
  await sent
  expect(api.startRunViaSocket.mock.calls[0][0]).toMatchObject({ session_id: first.id, profile: 'research', input: 'First plugin input' })
  expect(api.startRunViaSocket.mock.calls[0][0]).not.toHaveProperty('coding_agent_id')
  expect(store.sessions.find(item => item.id === first.id)).toMatchObject({ agentInstanceId: 'internal-instance', agentChatSettings: true })
  expect(store.activeSession?.agentInstanceId).toBeUndefined()
})

it('does not start the legacy executor when internal binding fails, and can retry the same draft', async () => {
  const store = useChatStore()
  store.setRuntimeMode('default')
  const chat = store.newChat({ source: 'coding_agent', codingAgentId: 'qoder', codingAgentMode: 'global' })
  api.createOrdinaryAgentChat.mockRejectedValueOnce(new Error('Plugin unavailable'))
  await store.sendMessage('First attempt')
  expect(api.startRunViaSocket).not.toHaveBeenCalled()
  expect(store.activeSession?.agentInstanceId).toBeUndefined()
  api.createOrdinaryAgentChat.mockResolvedValueOnce({ sessionId: chat.id, instanceId: 'retry-instance', configurationRevision: 1 })
  await store.sendMessage('Second attempt')
  expect(api.startRunViaSocket).toHaveBeenCalledOnce()
  expect(api.createOrdinaryAgentChat.mock.calls.map(call => call[1].sessionId)).toEqual([chat.id, chat.id])
})

it('moves a corrected run summary off an old tool row and keeps one card on the answer', async () => {
  const store = useChatStore()
  store.setRuntimeMode('default')
  store.sessions = [session('one')]
  await store.switchSession('one')
  const persisted = api.onPersistedAgentMessage.mock.calls[0][0] as (event: any) => void
  const row = (id: number, role: string, content: string, extra = {}) => ({ id, role, content, session_id: 'one', run_marker: 'run', timestamp: 1, ...extra })
  const emit = (messages: any[]) => persisted({ session_id: 'one', agent_run_id: 'run', messages })
  emit([row(1, 'user', 'Check files'), row(2, 'assistant', 'Checking'), row(3, 'assistant', '', {
    tool_calls: [{ id: 'tool', type: 'function', function: { name: 'read_file', arguments: '{}' } }], run_usage: { runId: 'run', assistantMessageId: '3' },
  })])
  emit([row(4, 'tool', 'contents', { tool_name: 'read_file', tool_call_id: 'tool' })])
  emit([row(2, 'assistant', 'Files checked.', { run_usage: { runId: 'run', assistantMessageId: '2', inputTokens: 20, outputTokens: 5 } })])
  expect(store.activeSession?.messages.filter(message => message.runUsage)).toMatchObject([{ id: '2', content: 'Files checked.', runUsage: { inputTokens: 20, outputTokens: 5 } }])
  expect(store.activeSession?.messages.filter(message => message.runUsage)).toHaveLength(1)
  expect(store.activeSession?.messages.filter(message => message.role === 'assistant' && !message.content)).toEqual([])
  expect(store.activeSession?.messages.filter(message => message.role === 'tool')).toHaveLength(1)
})
