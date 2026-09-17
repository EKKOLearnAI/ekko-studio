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
  resumeSession: vi.fn(),
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

function makeSession(id: string): Session {
  return {
    id,
    title: id,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * A resume payload is the server's authoritative answer about whether a run is
 * still going. A stream entry the client still holds after the run died without
 * a terminal event (abort, server restart, dropped socket) must not survive an
 * idle resume: while it does, the session renders as busy and the thinking timer
 * restarts from zero every time it is opened.
 */
describe('chat store stale stream entry on resume', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    chatApi.sessionCommandHandlers = []
    chatApi.peerUserMessageHandlers = []
    chatApi.sessionTitleUpdatedHandlers = []
    chatApi.sessionWorkspaceUpdatedHandlers = []
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

  it('drops the stale stream entry when the resumed session reports idle', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any

    resumeWith({ isWorking: true, runStartedAt: 1_787_000_000_000 })
    await store.switchSession('a')
    expect(store.isRunActive).toBe(true)

    resumeWith({ isWorking: false })
    await store.switchSession('a')

    expect(store.isRunActive).toBe(false)
    expect(store.runStartedAt.has('a')).toBe(false)
  })

  it('keeps the stream entry while the resumed session is still working', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any

    resumeWith({ isWorking: true, runStartedAt: 1_787_000_000_000 })
    await store.switchSession('a')
    resumeWith({ isWorking: true, runStartedAt: 1_787_000_000_000 })
    await store.switchSession('a')

    expect(store.isRunActive).toBe(true)
  })
})
