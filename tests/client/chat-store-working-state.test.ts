// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia, getActivePinia } from 'pinia'
import { createApp, defineComponent, h } from 'vue'
import { unregisterSessionHandlers } from '@/api/studio/chat'
vi.mock('@/api/studio/background-status', () => ({ observeBackgroundStatus: vi.fn(() => vi.fn()) }))

const api = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(), resumeSession: vi.fn(), registerSessionHandlers: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  onUnobservedRunStarted: vi.fn(() => vi.fn()),
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
import { useChatStore, provideScopedChatStore, type Session } from '@/stores/hermes/chat'

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
  it('preserves later optimistic inputs while earlier queue confirmations arrive', async () => {
    const store = useChatStore()
    store.sessions = [{ ...session('person-main-1'), source: 'builtin_agent', agent: 'ekko-agent', agentPreset: 'person' }]
    await store.switchSession('person-main-1')
    await store.sendMessage('1')
    await store.sendMessage('2')
    await store.sendMessage('3')
    const [second, onEvent] = api.startRunViaSocket.mock.calls[1]
    const [third] = api.startRunViaSocket.mock.calls[2]

    onEvent({ event: 'run.queued', session_id: 'person-main-1', queue_id: second.queue_id, queue_length: 1,
      queued_messages: [{ id: second.queue_id, role: 'user', content: '2', timestamp: 1 }] })
    expect(store.queuedUserMessages.get('person-main-1')?.map(message => message.content)).toEqual(['2', '3'])

    onEvent({ event: 'run.queued', session_id: 'person-main-1', dequeued_queue_id: second.queue_id, queue_length: 0, queued_messages: [] })
    expect(store.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['1', '2'])
    expect(store.queuedUserMessages.get('person-main-1')?.map(message => message.id)).toEqual([third.queue_id])
    onEvent({ event: 'run.started', session_id: 'person-main-1', queue_id: third.queue_id, queue_length: 0 })
    expect(store.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['1', '2', '3'])
    expect(store.queuedUserMessages.get('person-main-1')).toBeUndefined()
  })

  it('moves a locally direct input out of the transcript when the server queues it', async () => {
    const store = useChatStore()
    store.sessions = [{ ...session('person-main-1'), source: 'builtin_agent', agent: 'ekko-agent', agentPreset: 'person' }]
    await store.switchSession('person-main-1')
    await store.sendMessage('2')
    const [payload, onEvent] = api.startRunViaSocket.mock.calls[0]
    onEvent({ event: 'run.queued', session_id: 'person-main-1', queue_id: payload.queue_id, queue_length: 1,
      queued_messages: [{ id: payload.queue_id, role: 'user', content: '2', timestamp: 1 }] })
    expect(store.messages.filter(message => message.role === 'user')).toEqual([])
    expect(store.queuedUserMessages.get('person-main-1')?.map(message => message.content)).toEqual(['2'])
    onEvent({ event: 'message.delta', session_id: 'person-main-1', delta: 'reply to 1' })
    onEvent({ event: 'run.queued', session_id: 'person-main-1', dequeued_queue_id: payload.queue_id, queue_length: 0, queued_messages: [] })
    expect(store.messages.map(message => message.content)).toEqual(['reply to 1', '2'])
  })

  it('removes an optimistic Person queue entry as soon as its run starts', async () => {
    const store = useChatStore()
    store.sessions = [{ ...session('person-main-1'), source: 'builtin_agent', agent: 'ekko-agent', agentPreset: 'person' }]
    await store.switchSession('person-main-1')
    await store.sendMessage('first request')
    await store.sendMessage('follow-up request')
    const [payload, onEvent] = api.startRunViaSocket.mock.calls.at(-1)!
    expect(store.queuedUserMessages.get('person-main-1')).toHaveLength(1)

    // The server can finish the prior turn before this input arrives, so there
    // is no server-side dequeue event for this optimistically queued input.
    onEvent({ event: 'run.started', session_id: 'person-main-1', queue_id: payload.queue_id, queue_length: 0 })

    expect(store.queuedUserMessages.get('person-main-1')).toBeUndefined()
    expect(store.messages.filter(message => message.id === payload.queue_id)).toEqual([
      expect.objectContaining({ content: 'follow-up request', queued: false }),
    ])
  })

  it('reconciles a resumed Person queue by started input id while preserving later follow-ups', async () => {
    api.resumeSession.mockImplementationOnce((sid, callback) => {
      callback({ session_id: sid, isWorking: true, messages: [], events: [], queueLength: 2, queueMessages: [
        { id: 'follow-up-1', role: 'user', content: 'first follow-up', timestamp: 1 },
        { id: 'follow-up-2', role: 'user', content: 'later follow-up', timestamp: 2 },
      ] })
    })
    const store = useChatStore()
    store.sessions = [{ ...session('person-main-1'), source: 'builtin_agent', agent: 'ekko-agent', agentPreset: 'person' }]
    await store.switchSession('person-main-1')
    const handlers = api.registerSessionHandlers.mock.calls.at(-1)![1]
    const started = { event: 'run.started', session_id: 'person-main-1', queue_id: 'follow-up-1', queue_length: 1 }
    handlers.onRunStarted(started)
    handlers.onRunStarted(started)

    expect(store.queuedUserMessages.get('person-main-1')?.map(message => message.id)).toEqual(['follow-up-2'])
    expect(store.queueLengths.get('person-main-1')).toBe(1)
    expect(store.messages.filter(message => message.id === 'follow-up-1')).toEqual([
      expect.objectContaining({ content: 'first follow-up', queued: false }),
    ])
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

  it('clears a stale background-session running light by re-verifying against the server on re-sync', async () => {
    const listen = vi.spyOn(document, 'addEventListener')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const store = useChatStore()
    store.sessions = [session('one'), session('two')]
    await store.switchSession('one')
    await store.sendMessage('delegate')
    const onEvent = api.startRunViaSocket.mock.calls[0][1]
    // Foreground run ends but a background delegation keeps 'one' in serverWorking with no
    // live run socket — the exact stale-light shape from the upgrade incident.
    onEvent({ event: 'run.completed', session_id: 'one', output: 'started', background_pending: 1 })
    expect(store.isSessionWorking('one')).toBe(true)
    expect(store.isSessionLive('one')).toBe(false)
    await store.switchSession('two') // 'one' is now a background session

    const onVisible = listen.mock.calls.find((c) => c[0] === 'visibilitychange')![1] as () => void
    listen.mockRestore()
    // Server is authoritative: background 'one' is no longer working.
    api.resumeSession.mockImplementation((sid, cb) => {
      cb({ session_id: sid, isWorking: false, messages: [], events: [], backgroundPending: 0 })
    })
    onVisible()
    expect(store.isSessionWorking('one')).toBe(false) // stale background light cleared
  })

  it('keeps a genuinely-running background session (server still says working)', async () => {
    const listen = vi.spyOn(document, 'addEventListener')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    const store = useChatStore()
    store.sessions = [session('one'), session('two')]
    await store.switchSession('one')
    await store.sendMessage('delegate')
    const onEvent = api.startRunViaSocket.mock.calls[0][1]
    onEvent({ event: 'run.completed', session_id: 'one', output: 'started', background_pending: 1 })
    expect(store.isSessionWorking('one')).toBe(true)
    await store.switchSession('two')

    const onVisible = listen.mock.calls.find((c) => c[0] === 'visibilitychange')![1] as () => void
    listen.mockRestore()
    // Server says 'one' is STILL working → must not be cleared (no false-negative on live runs).
    api.resumeSession.mockImplementation((sid, cb) => {
      cb({ session_id: sid, isWorking: true, messages: [], events: [], backgroundPending: 1 })
    })
    onVisible()
    expect(store.isSessionWorking('one')).toBe(true)
  })
})


it('isolates a task drawer selection and disposes only its listeners without interrupting the main chat', async () => {
  const main = useChatStore()
  main.setRuntimeMode('default')
  main.sessions = [session('person-main-1')]
  await main.switchSession('person-main-1')
  let task!: ReturnType<typeof useChatStore>
  let child!: ReturnType<typeof useChatStore>
  const Child = defineComponent({ setup() { child = useChatStore(); return () => h('div', child.activeSessionId) } })
  const Drawer = defineComponent({ setup() { task = provideScopedChatStore('person-task-one'); return () => h(Child) } })
  const pinia = getActivePinia()!
  const app = createApp(Drawer).use(pinia)
  const target = document.createElement('div')
  document.body.append(target)
  app.mount(target)
  task.sessions = [session('person-task-one')]
  await task.switchSession('person-task-one')
  expect(child).toBe(task)
  expect(child).not.toBe(main)
  expect(main.activeSessionId).toBe('person-main-1')
  expect(localStorage.getItem('hermes_active_session_default')).toBe('person-main-1')
  app.unmount(); target.remove()
  expect(unregisterSessionHandlers).toHaveBeenCalledWith('person-task-one')
  expect(unregisterSessionHandlers).not.toHaveBeenCalledWith('person-main-1')
  expect(pinia.state.value['chat:person-task-one']).toBeUndefined()
  expect(main.activeSessionId).toBe('person-main-1')
  main.$dispose()
})
