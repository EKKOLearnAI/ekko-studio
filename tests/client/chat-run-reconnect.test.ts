import { beforeEach, describe, expect, it, vi } from 'vitest'

const socketState = vi.hoisted(() => ({
  sockets: [] as any[],
  initiallyConnected: true,
}))

vi.mock('socket.io-client', () => {
  function createSocket() {
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
      connected: socketState.initiallyConnected,
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
      emit: vi.fn(),
      disconnect: vi.fn(() => {
        socket.connected = false
      }),
      __listenerCount: (event: string) => listeners.get(event)?.size || 0,
      __trigger: (event: string, ...args: any[]) => {
        if (event === 'connect') socket.connected = true
        if (event === 'disconnect') socket.connected = false
        for (const handler of [...(listeners.get(event) || [])]) handler(...args)
      },
    }
    socket.__volatileEmit = vi.fn()
    socket.volatile = { emit: socket.__volatileEmit }

    return socket
  }

  return {
    io: vi.fn(() => {
      const socket = createSocket()
      socketState.sockets.push(socket)
      return socket
    }),
  }
})

vi.mock('../../packages/client/src/api/client', () => ({
  getApiKey: () => 'test-token',
  getBaseUrlValue: () => '',
}))

describe('chat-run socket reconnect handling', () => {
  beforeEach(() => {
    vi.resetModules()
    socketState.sockets = []
    socketState.initiallyConnected = true
  })

  it('waits for a connection and sends acceptance-tracked runs without buffering', async () => {
    socketState.initiallyConnected = false
    const { startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const body = {
      session_id: 'session-annotation', input: 'annotated', queue_id: 'message-1', profile: 'default', source: 'cli' as const,
    }
    const controller = startRunViaSocket(
      body, vi.fn(), vi.fn(), vi.fn(), undefined, { trackAcceptance: true },
    )
    const socket = socketState.sockets[0]

    expect(socket.emit).not.toHaveBeenCalledWith('run', body)
    expect(socket.__volatileEmit).not.toHaveBeenCalled()
    socket.__trigger('connect')
    expect(socket.__volatileEmit).toHaveBeenCalledWith('run', body)
    socket.__trigger('run.started', {
      event: 'run.started', session_id: 'session-annotation', queue_id: 'message-1', run_id: 'run-1',
    })
    await expect(controller.accepted).resolves.toBe(true)
  })

  it('does not transmit a rejected acceptance-tracked run after reconnect', async () => {
    socketState.initiallyConnected = false
    const { startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const body = {
      session_id: 'session-annotation', input: 'annotated', queue_id: 'message-1', profile: 'default', source: 'cli' as const,
    }
    const controller = startRunViaSocket(
      body, vi.fn(), vi.fn(), vi.fn(), undefined, { trackAcceptance: true },
    )
    const socket = socketState.sockets[0]

    socket.__trigger('connect_error', new Error('offline'))
    await expect(controller.accepted).resolves.toBe(false)
    socket.__trigger('connect')
    expect(socket.__volatileEmit).not.toHaveBeenCalled()
    expect(socket.emit).not.toHaveBeenCalledWith('run', body)
  })

  it('keeps transient mobile disconnects alive and resumes after reconnect', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    const onReconnectResume = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      onError,
      undefined,
      { onReconnectResume },
    )

    const socket = socketState.sockets[0]
    expect(socket.emit).toHaveBeenCalledWith('run', expect.objectContaining({ session_id: 'session-1' }))

    socket.__trigger('disconnect', 'ping timeout')
    expect(onError).not.toHaveBeenCalled()

    socket.__trigger('connect_error', new Error('temporary reconnect failure'))
    expect(onError).not.toHaveBeenCalled()

    socket.__trigger('connect')
    expect(socket.emit).toHaveBeenCalledWith('resume', { session_id: 'session-1', profile: 'default' })

    const resumed = { session_id: 'session-1', messages: [], isWorking: true, events: [] }
    socket.__trigger('resumed', resumed)
    expect(onReconnectResume).toHaveBeenCalledWith(resumed)

    socket.__trigger('message.delta', { event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    expect(onEvent).toHaveBeenCalledWith({ event: 'message.delta', session_id: 'session-1', delta: 'after reconnect' })
    socket.__trigger('message.interim', {
      event: 'message.interim',
      session_id: 'session-1',
      text: 'after reconnect',
      already_streamed: true,
    })
    expect(onEvent).toHaveBeenCalledWith({
      event: 'message.interim',
      session_id: 'session-1',
      text: 'after reconnect',
      already_streamed: true,
    })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('keeps concurrent resume callbacks scoped to their requested session', async () => {
    const { resumeSession } = await import('../../packages/client/src/api/studio/chat')
    const onSessionA = vi.fn()
    const onSessionB = vi.fn()

    resumeSession('session-a', onSessionA, 'default')
    resumeSession('session-b', onSessionB, 'default')

    const socket = socketState.sockets[0]
    const resumedB = { session_id: 'session-b', messages: [], isWorking: false, events: [] }
    socket.__trigger('resumed', resumedB)

    expect(onSessionA).not.toHaveBeenCalled()
    expect(onSessionB).toHaveBeenCalledWith(resumedB)
    expect(socket.__listenerCount('resumed')).toBe(1)

    const resumedA = { session_id: 'session-a', messages: [], isWorking: false, events: [] }
    socket.__trigger('resumed', resumedA)

    expect(onSessionA).toHaveBeenCalledWith(resumedA)
    expect(socket.__listenerCount('resumed')).toBe(0)
  })

  it('keeps fatal disconnects fatal and removes per-run listeners', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const onError = vi.fn()

    startRunViaSocket(
      { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' },
      vi.fn(),
      vi.fn(),
      onError,
    )

    const socket = socketState.sockets[0]
    socket.__trigger('disconnect', 'io server disconnect')

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toBe('Socket disconnected: io server disconnect')
    expect(socket.__listenerCount('connect')).toBe(0)
    expect(socket.__listenerCount('disconnect')).toBe(0)
    expect(socket.__listenerCount('connect_error')).toBe(0)
  })

  it('does not attach extra reconnect listeners when the session already has handlers', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const body = { session_id: 'session-1', input: 'hello', profile: 'default', source: 'cli' as const }

    startRunViaSocket(body, vi.fn(), vi.fn(), vi.fn())
    const socket = socketState.sockets[0]
    expect(socket.__listenerCount('connect')).toBe(1)
    expect(socket.__listenerCount('disconnect')).toBe(1)

    startRunViaSocket(body, vi.fn(), vi.fn(), vi.fn())
    expect(socket.__listenerCount('connect')).toBe(1)
    expect(socket.__listenerCount('disconnect')).toBe(1)
    expect(socket.emit).toHaveBeenCalledWith('run', body)
  })

  it('fans session.command events to run-local and global handlers', async () => {
    const { onSessionCommand, startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const onEvent = vi.fn()
    const onGlobalCommand = vi.fn()
    const offGlobalCommand = onSessionCommand(onGlobalCommand)

    startRunViaSocket(
      { session_id: 'session-1', input: '/goal status', profile: 'default', source: 'cli' },
      onEvent,
      vi.fn(),
      vi.fn(),
    )

    const socket = socketState.sockets[0]
    const event = {
      event: 'session.command',
      session_id: 'session-1',
      command: 'goal',
      action: 'status',
      message: 'Goal (active, 0/20 turns): write site',
    }

    socket.__trigger('session.command', event)

    expect(onEvent).toHaveBeenCalledWith(event)
    expect(onGlobalCommand).toHaveBeenCalledWith(event)

    offGlobalCommand()
    socket.__trigger('session.command', { ...event, message: 'next status' })
    expect(onGlobalCommand).toHaveBeenCalledTimes(1)
  })

  it('fans session settings updates to idle global listeners without a running stream', async () => {
    const { onSessionSettingsUpdated, resumeSession } = await import('../../packages/client/src/api/studio/chat')
    const onSettingsUpdated = vi.fn()
    const offSettingsUpdated = onSessionSettingsUpdated(onSettingsUpdated)

    resumeSession('session-1', vi.fn(), 'default')
    const socket = socketState.sockets[0]
    const event = {
      event: 'session.settings.updated',
      session_id: 'session-1',
      model: 'gpt-5.5',
      provider: 'openai',
      reasoning_effort: 'high',
    }

    socket.__trigger('session.settings.updated', event)

    expect(onSettingsUpdated).toHaveBeenCalledWith(event)
    offSettingsUpdated()
    socket.__trigger('session.settings.updated', { ...event, reasoning_effort: 'low' })
    expect(onSettingsUpdated).toHaveBeenCalledTimes(1)
  })

  it('keeps the session listener alive while background delegations remain', async () => {
    const { startRunViaSocket } = await import('../../packages/client/src/api/studio/chat')
    const onEvent = vi.fn()
    const onDone = vi.fn()

    startRunViaSocket(
      { session_id: 'session-background', input: 'delegate this', profile: 'default', source: 'cli' },
      onEvent,
      onDone,
      vi.fn(),
    )

    const socket = socketState.sockets[0]
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: 'session-background',
      background_pending: 1,
    })
    expect(onDone).toHaveBeenCalledTimes(1)

    const childText = {
      event: 'subagent.text',
      session_id: 'session-background',
      subagent_id: 'child-1',
      text: 'still working',
    }
    socket.__trigger('subagent.text', childText)
    expect(onEvent).toHaveBeenCalledWith(childText)

    socket.__trigger('run.started', {
      event: 'run.started',
      session_id: 'session-background',
      autonomous: true,
      delegation_id: 'deleg-1',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: 'session-background',
      autonomous: true,
      delegation_id: 'deleg-1',
      background_pending: 0,
    })
    expect(onDone).toHaveBeenCalledTimes(2)

    const callsAfterCompletion = onEvent.mock.calls.length
    socket.__trigger('subagent.text', { ...childText, text: 'late event' })
    expect(onEvent).toHaveBeenCalledTimes(callsAfterCompletion)
  })
})
