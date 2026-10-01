// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(),
}))
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
