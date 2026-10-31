// @vitest-environment jsdom
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sockets: [] as any[],
  pending: new Map<string, number>(),
}))

vi.mock('socket.io-client', () => {
  function createSocket(url: string, options: any) {
    const rooms = new Set<string>()
    const listeners = new Map<string, Set<(...args: any[]) => void>>()

    const addListener = (event: string, handler: (...args: any[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(handler)
    }

    const removeListener = (event: string, handler: (...args: any[]) => void) => {
      const eventListeners = listeners.get(event)
      if (!eventListeners) return
      for (const candidate of [...eventListeners]) {
        if (candidate === handler || (candidate as any).__original === handler) {
          eventListeners.delete(candidate)
        }
      }
    }

    const socket: any = {
      connected: true, url, profile: options.query.profile, token: options.auth.token,
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        addListener(event, handler)
        return socket
      }),
      once: vi.fn((event: string, handler: (...args: any[]) => void) => {
        const wrapped = (...args: any[]) => {
          removeListener(event, wrapped)
          handler(...args)
        }
        ;(wrapped as any).__original = handler
        addListener(event, wrapped)
        return socket
      }),
      off: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeListener: vi.fn((event: string, handler: (...args: any[]) => void) => {
        removeListener(event, handler)
        return socket
      }),
      removeAllListeners: vi.fn(() => {
        listeners.clear()
        return socket
      }),
      emit: vi.fn((event: string, data: any) => {
        if (event === 'run') rooms.add(data.session_id)
        if (event === 'resume') {
          if (options.query.profile !== (data.session_id === 'two' ? 'research' : 'default')) return
          rooms.add(data.session_id)
          queueMicrotask(() => socket.__trigger('resumed', {
            session_id: data.session_id, messages: [], events: [], isWorking: false,
            ...(socketState.pending.has(data.session_id) ? { backgroundPending: socketState.pending.get(data.session_id) } : {}),
          }))
        }
      }),
      disconnect: vi.fn(() => {
        socket.connected = false
      }),
      __listenerCount: (event: string) => listeners.get(event)?.size || 0,
      __trigger: (event: string, ...args: any[]) => {
        if (event === 'connect') socket.connected = true
        if (event === 'disconnect') { socket.connected = false; rooms.clear() }
        if (!['connect', 'disconnect', 'connect_error'].includes(event) &&
            (!socket.connected || !rooms.has(args[0]?.session_id))) return
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      },
    }

    return socket
  }

  return {
    io: vi.fn((url: string, options: any) => {
      const socket = createSocket(url, options)
      socketState.sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('@/router', () => ({
  default: { currentRoute: { value: { name: 'chat' } }, replace: vi.fn() },
}))
import { clearApiKey, getApiKey, request, setApiKey, setServerUrl } from '@/api/client'

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

let store: ReturnType<typeof useChatStore>
beforeEach(async () => {
  const { disconnectChatRun } = await import('@/api/studio/chat')
  disconnectChatRun()
  localStorage.clear()
  setApiKey('test-token')
  localStorage.setItem('hermes_active_profile_name', 'default')
  socketState.sockets = []
  socketState.pending.clear()
  setActivePinia(createPinia())
  store = useChatStore()
  store.setRuntimeMode('default')
  store.sessions = [session('one'), session('two', 'research')]
})
afterEach(async () => {
  vi.unstubAllGlobals()
  store.$dispose()
  const { disconnectChatRun } = await import('@/api/studio/chat')
  disconnectChatRun()
})

describe('sidebar activity through the real chat API', () => {
  it.each(['dequeue', 'peer'])('keeps inputs 1, 2 and 3 through partial queue acknowledgements and consecutive turns (%s)', async (promotion) => {
    Object.assign(store.sessions[0], { source: 'builtin_agent', agent: 'ekko-agent', agentPreset: 'person' })
    await store.switchSession('one')
    await store.sendMessage('1')
    const socket = socketState.sockets[0]
    const runs = () => socket.emit.mock.calls.filter((call: any[]) => call[0] === 'run').map((call: any[]) => call[1])
    const emit = (event: string, payload: object) => socket.__trigger(event, { event, session_id: 'one', ...payload })
    emit('run.started', { queue_id: runs()[0].queue_id, queue_length: 0 })
    await store.sendMessage('2')
    await store.sendMessage('3')
    const [, second, third] = runs()
    emit('run.queued', { queue_id: second.queue_id, queue_length: 1,
      queued_messages: [{ id: second.queue_id, content: '2', timestamp: 1 }] })
    expect(store.queuedUserMessages.get('one')?.map(message => message.content)).toEqual(['2', '3'])
    emit('message.delta', { delta: 'reply 1' })
    emit('run.completed', { output: 'reply 1', queue_remaining: 1 })
    if (promotion === 'peer') {
      emit('run.peer_user_message', { message: { id: second.queue_id, role: 'user', content: '2', timestamp: 1, queued: false } })
      expect(store.messages.map(message => message.content)).toEqual(['1', 'reply 1', '2'])
    }
    emit('run.queued', { dequeued_queue_id: second.queue_id, queue_length: 0, queued_messages: [] })
    emit('run.started', { queue_id: second.queue_id, queue_length: 0 })
    expect(store.queuedUserMessages.get('one')?.map(message => message.content)).toEqual(['3'])
    emit('run.queued', { queue_id: third.queue_id, queue_length: 1,
      queued_messages: [{ id: second.queue_id, content: '2', timestamp: 1 }, { id: third.queue_id, content: '3', timestamp: 1 }] })
    expect(store.queuedUserMessages.get('one')?.map(message => message.content)).toEqual(['3'])
    emit('message.delta', { delta: 'reply 2' })
    emit('run.completed', { output: 'reply 2', queue_remaining: 1 })
    emit('run.queued', { dequeued_queue_id: third.queue_id, queue_length: 0, queued_messages: [] })
    emit('run.started', { queue_id: third.queue_id, queue_length: 0 })
    emit('message.delta', { delta: 'reply 3' })
    emit('run.completed', { output: 'reply 3', queue_remaining: 0 })
    expect(store.messages.map(message => message.content)).toEqual(['1', 'reply 1', '2', 'reply 2', '3', 'reply 3'])
    expect(store.queuedUserMessages.get('one')).toBeUndefined()
    expect(store.isSessionLive('one')).toBe(false)
  })

  it.each(['clear', 'replace', 'server'])('does not submit a prepared send after %s invalidation', async (action) => {
    await store.switchSession('one')
    const { useAppStore } = await import('@/stores/hermes/app')
    let release!: () => void
    vi.spyOn(useAppStore(), 'waitForModelsForRun').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const sending = store.sendMessage('old-auth draft')
    if (action === 'clear') clearApiKey()
    else if (action === 'replace') setApiKey('replacement-token')
    else setServerUrl('https://replacement.example')
    setApiKey('new-login-token')
    const socketCount = socketState.sockets.length
    release()
    await sending
    expect(socketState.sockets).toHaveLength(socketCount)
    expect(socketState.sockets.flatMap(socket => socket.emit.mock.calls).filter(call => call[0] === 'run')).toHaveLength(0)
    expect(store.isSessionWorking('one')).toBe(false)
    await store.sendMessage('fresh draft')
    const fresh = socketState.sockets.at(-1)
    expect(fresh.token).toBe('new-login-token')
    expect(fresh.emit).toHaveBeenCalledWith('run', expect.objectContaining({ input: 'fresh draft' }))
  })

  it('ignores a stale preparation rejection instead of mutating the new login state', async () => {
    await store.switchSession('one')
    const { useAppStore } = await import('@/stores/hermes/app')
    let rejectPreparation!: (error: Error) => void
    vi.spyOn(useAppStore(), 'waitForModelsForRun').mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectPreparation = reject }))
    const sending = store.sendMessage('old-auth draft')
    clearApiKey()
    setApiKey('new-login-token')
    await store.sendMessage('fresh draft')
    const messageCount = store.sessions[0].messages.length
    expect(store.isSessionLive('one')).toBe(true)
    rejectPreparation(new Error('old preparation failed'))
    await sending
    expect(store.sessions[0].messages).toHaveLength(messageCount)
    expect(store.isSessionLive('one')).toBe(true)
  })

  it('ignores attachment upload results arriving after credential invalidation', async () => {
    await store.switchSession('one')
    let finishUpload!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finishUpload = resolve })))
    const sending = store.sendMessage('old attachment', [{ name: 'note.txt', type: 'text/plain', file: new File(['private'], 'note.txt') } as any])
    clearApiKey()
    setApiKey('new-login-token')
    const socketCount = socketState.sockets.length
    finishUpload(new Response(JSON.stringify({ files: [{ name: 'note.txt', path: '/uploads/old-note.txt' }] }), { status: 200 }))
    await sending
    expect(socketState.sockets).toHaveLength(socketCount)
    expect(store.sessions[0].messages.at(-1)?.attachments?.[0].url).toBeUndefined()
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it.each(['clear', '401', 'disabled403', 'replace', 'server'])('invalidates authenticated activity through %s and resumes only with fresh credentials', async (action) => {
    socketState.pending.set('one', 1)
    await store.switchSession('one')
    const execution = socketState.sockets[0]
    const observer = socketState.sockets[1]
    const oldObserverResume = observer.on.mock.calls.find((call: any[]) => call[0] === 'resumed')[1]
    await store.sendMessage('delegate')
    const oldForegroundCompletion = execution.on.mock.calls.filter((call: any[]) => call[0] === 'run.completed').map((call: any[]) => call[1])
    // Hold an initial switch resume while credentials are invalidated.
    const originalEmit = execution.emit.getMockImplementation()
    execution.emit.mockImplementation((event: string, data: any) => event === 'resume' ? undefined : originalEmit(event, data))
    const switching = store.switchSession('one')
    const oldInitialResume = execution.on.mock.calls.filter((call: any[]) => call[0] === 'resumed').at(-1)[1]

    if (action === 'clear') clearApiKey() // Desktop LoginView recovery uses this exact path.
    else if (action === 'replace') setApiKey('replacement-token')
    else if (action === 'server') setServerUrl('https://replacement.example')
    else {
      const status = action === '401' ? 401 : 403
      vi.stubGlobal('fetch', vi.fn(async () => new Response('User is disabled or does not exist', { status })))
      await expect(request('/api/studio/sessions')).rejects.toThrow()
      expect(getApiKey()).toBe('')
      expect(localStorage.getItem('hermes_active_profile_name')).toBeNull()
    }
    expect(observer.connected).toBe(false)
    expect(execution.connected).toBe(false)
    expect(observer.__listenerCount('resumed')).toBe(0)
    expect(store.isSessionWorking('one')).toBe(false)
    const socketCount = socketState.sockets.length
    const replay = () => {
      oldObserverResume({ session_id: 'one', backgroundPending: 10 })
      for (const callback of oldForegroundCompletion) callback({ event: 'run.completed', session_id: 'one', background_pending: 10 })
      oldInitialResume({ session_id: 'one', messages: [], events: [], isWorking: true, backgroundPending: 10 })
    }
    replay()
    await switching
    expect(store.isSessionWorking('one')).toBe(false)
    expect(socketState.sockets).toHaveLength(socketCount)

    setApiKey('new-login-token')
    await store.switchSession('one')
    expect(store.isSessionWorking('one')).toBe(true)
    expect(socketState.sockets.filter(socket => socket.connected).every(socket => socket.token === 'new-login-token')).toBe(true)
    replay()
    expect(socketState.sockets.filter(socket => socket.connected)).toHaveLength(2)
    for (const socket of socketState.sockets) socket.__trigger('delegation.updated', {
      event: 'delegation.updated', session_id: 'one', background_pending: 0,
    })
    expect(store.isSessionWorking('one')).toBe(false)
    await store.sendMessage('fresh authenticated run')
    const freshExecution = socketState.sockets[socketCount]
    expect(freshExecution.token).toBe('new-login-token')
    expect(freshExecution.emit).toHaveBeenCalledWith('run', expect.objectContaining({ session_id: 'one' }))
    freshExecution.__trigger('run.completed', { event: 'run.completed', session_id: 'one', background_pending: 1 })
    expect(store.isSessionWorking('one')).toBe(true)
    freshExecution.__trigger('delegation.updated', { event: 'delegation.updated', session_id: 'one', background_pending: 0 })
    expect(store.isSessionWorking('one')).toBe(false)
    const settledSocketCount = socketState.sockets.length
    replay()
    expect(store.isSessionWorking('one')).toBe(false)
    expect(socketState.sockets).toHaveLength(settledSocketCount)
  })

  it.each(['same-key', 'same-server', 'gateway401', 'forbidden403'])('preserves authenticated activity for %s', async (action) => {
    socketState.pending.set('one', 1)
    await store.switchSession('one')
    const observer = socketState.sockets[1]
    if (action === 'same-key') setApiKey('test-token')
    else if (action === 'same-server') setServerUrl('')
    else {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: action === 'gateway401' ? 401 : 403 })))
      await expect(request(action === 'gateway401' ? '/api/hermes/v1/models' : '/api/studio/sessions')).rejects.toThrow()
    }
    expect(getApiKey()).toBe('test-token')
    expect(observer.connected).toBe(true)
    expect(store.isSessionWorking('one')).toBe(true)
    expect(socketState.sockets).toHaveLength(2)
  })

  it.each([0, undefined])('clears cached activity from a fresh resume snapshot (%s)', async (pending) => {
    socketState.pending.set('one', 1)
    await store.switchSession('one')
    await store.switchSession('two')
    if (pending === undefined) socketState.pending.delete('one')
    else socketState.pending.set('one', pending)
    await store.switchSession('one')
    expect(store.isSessionWorking('one')).toBe(false)
    expect(socketState.sockets[1].connected).toBe(false)
  })

  it('rejoins a still-pending observer room and receives subsequent completion', async () => {
    socketState.pending.set('one', 1)
    store.setRuntimeMode('global_agent')
    store.sessions = [session('one')]
    await store.switchSession('one')
    const observer = socketState.sockets[1]
    expect(observer.url).toBe('/global-agent')
    observer.__trigger('disconnect', 'ping timeout')
    observer.__trigger('connect')
    await Promise.resolve()
    expect(store.isSessionWorking('one')).toBe(true)
    observer.__trigger('delegation.updated', {
      event: 'delegation.updated', session_id: 'one', background_pending: 0,
    })
    expect(store.isSessionWorking('one')).toBe(false)
    expect(observer.connected).toBe(false)
  })

  it('closes authenticated observers when chat disconnects for logout', async () => {
    socketState.pending.set('one', 1)
    await store.switchSession('one')
    const { disconnectChatRun } = await import('@/api/studio/chat')
    disconnectChatRun()
    expect(socketState.sockets.every(socket => !socket.connected)).toBe(true)
    expect(socketState.sockets.every(socket => socket.__listenerCount('resumed') === 0)).toBe(true)
  })

  it.each(['dispose', 'runtime', 'delete', 'archive'])('disposes background observers on %s and ignores retained callbacks', async (action) => {
    socketState.pending.set('one', 1)
    await store.switchSession('one')
    const observer = socketState.sockets[1]
    expect(observer.profile).toBe('default')
    expect(observer.url).toBe('/chat-run')
    const retained = observer.on.mock.calls.find((call: any[]) => call[0] === 'resumed')[1]
    if (action === 'dispose') store.$dispose()
    if (action === 'runtime') store.setRuntimeMode('global_agent')
    if (action === 'delete' || action === 'archive') {
      const api = await import('@/api/studio/sessions')
      vi.mocked(action === 'delete' ? api.deleteSession : api.archiveSession).mockResolvedValueOnce(true)
      await (action === 'delete' ? store.deleteSession('one') : store.archiveSession('one'))
    }
    expect(observer.connected).toBe(false)
    for (const event of ['connect', 'resumed', 'delegation.updated', 'abort.completed']) {
      expect(observer.__listenerCount(event)).toBe(0)
    }
    retained({ session_id: 'one', backgroundPending: 10 })
    expect(store.isSessionWorking('one')).toBe(false)
  })

  it.each(['direct', 'passive'])('receives %s completion after the execution socket changes profile', async (mode) => {
    socketState.pending.set('one', 1)
    if (mode === 'direct') socketState.pending.set('one', 0)
    await store.switchSession('one')
    const executionSocket = socketState.sockets[0]
    if (mode === 'direct') {
      await store.sendMessage('delegate')
      socketState.pending.set('one', 1)
      executionSocket.__trigger('run.completed', {
        event: 'run.completed', session_id: 'one', background_pending: 1,
      })
      await Promise.resolve()
    }
    await store.switchSession('two')
    expect(executionSocket.connected).toBe(false)
    expect(store.isSessionWorking('one')).toBe(true)
    // Broadcast only reaches connected sockets which joined this session room.
    for (const socket of socketState.sockets) socket.__trigger('delegation.updated', {
      event: 'delegation.updated', session_id: 'one', background_pending: 0,
    })
    expect(store.isSessionWorking('one')).toBe(false)
    expect(store.isSessionWorking('two')).toBe(false)
  })

  it('reconciles passive background activity after rooms are lost on reconnect', async () => {
    socketState.pending.set('one', 1)
    await store.switchSession('one')
    expect(store.isSessionWorking('one')).toBe(true)
    for (const socket of socketState.sockets) socket.__trigger('disconnect', 'transport close')
    socketState.pending.set('one', 0) // Completed while offline; there is no event to replay.
    for (const socket of socketState.sockets) socket.__trigger('connect')
    await Promise.resolve()
    expect(store.isSessionWorking('one')).toBe(false)
    expect(store.isSessionLive('one')).toBe(false)
    expect(store.isStreaming).toBe(false)
  })

  it.each(['direct', 'passive'])('clears %s activity on the server terminal abort payload', async (mode) => {
    if (mode === 'passive') socketState.pending.set('one', 1)
    await store.switchSession('one')
    if (mode === 'direct') {
      await store.sendMessage('delegate')
      socketState.sockets[0].__trigger('run.completed', {
        event: 'run.completed', session_id: 'one', background_pending: 1,
      })
    }
    expect(store.isSessionWorking('one')).toBe(true)
    socketState.sockets[0].__trigger('abort.completed', {
      event: 'abort.completed', session_id: 'one', run_id: 'run-one', synced: true,
    })
    expect(store.isSessionWorking('one')).toBe(false)
    expect(store.isSessionLive('one')).toBe(false)
  })
})
