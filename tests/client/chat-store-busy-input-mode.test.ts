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
import { useSettingsStore } from '@/stores/hermes/settings'

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
 * Hermes exposes display.busy_input_mode with three values, and Studio carried
 * the key without honouring it: every message typed during a run was queued.
 * The mode now decides what happens to that queued message.
 */
describe('chat store busy input mode', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    setActivePinia(createPinia())
  })

  async function sendWhileWorking(mode: string | undefined, attachments?: File[]) {
    const settings = useSettingsStore()
    settings.display = mode === undefined ? {} : { busy_input_mode: mode }
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = session.id
    store.activeSession = session

    // A first message starts a run; only then is the session live and does a
    // second message go to the queue.
    await store.sendMessage('start the work')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: any) => void
    onEvent({ event: 'run.started', session_id: session.id, run_id: 'run-1' })

    await store.sendMessage('adjust the plan', attachments)
    const queued = store.queuedUserMessages.get(session.id) || []
    const queueId = queued[queued.length - 1]?.id || ''

    // The server acknowledges the queue; that is when the mode acts.
    onEvent({
      event: 'run.queued',
      session_id: session.id,
      queue_length: queued.length,
      queued_messages: queued.map(message => ({ id: message.id, role: 'user', content: message.content })),
    })
    return { store, sessionId: session.id, queueId }
  }

  it('queues and does nothing else by default', async () => {
    const { queueId } = await sendWhileWorking(undefined)

    expect(queueId).toBeTruthy()
    expect(chatApi.socketEmit).not.toHaveBeenCalledWith('steer_queued_run', expect.anything())
    expect(chatApi.socketEmit).not.toHaveBeenCalledWith('insert_queued_run', expect.anything())
  })

  it('steers the running turn when the mode says steer', async () => {
    const { sessionId, queueId } = await sendWhileWorking('steer')

    expect(chatApi.socketEmit).toHaveBeenCalledWith('steer_queued_run', {
      session_id: sessionId,
      queue_id: queueId,
    })
  })

  it('interrupts the current turn when the mode says interrupt', async () => {
    const { sessionId, queueId } = await sendWhileWorking('interrupt')

    expect(chatApi.socketEmit).toHaveBeenCalledWith('insert_queued_run', {
      session_id: sessionId,
      queue_id: queueId,
    })
  })

  it('falls back to queueing when the message carries an attachment', async () => {
    // Steering carries text only; Hermes falls back to queue for images too.
    await sendWhileWorking('steer', [new File(['x'], 'note.txt', { type: 'text/plain' })])

    expect(chatApi.socketEmit).not.toHaveBeenCalledWith('steer_queued_run', expect.anything())
  })

  it('treats an unrecognised mode as queue rather than guessing', async () => {
    await sendWhileWorking('nonsense')

    expect(chatApi.socketEmit).not.toHaveBeenCalledWith('steer_queued_run', expect.anything())
    expect(chatApi.socketEmit).not.toHaveBeenCalledWith('insert_queued_run', expect.anything())
  })
})
