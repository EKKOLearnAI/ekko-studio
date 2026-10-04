// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  socketEmit: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
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
  getDownloadUrl: (_p: string, n: string) => `/download/${n}`,
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now() }
}

const RUN_START = 1_787_000_000_000

/**
 * The thinking timer reads `runStartedAt.get(activeSessionId)`. switchSession
 * sets activeSessionId synchronously but only learns runStartedAt from the
 * async resume payload, so there is a window where the newly activated session
 * has no start recorded yet. The timer must not treat that window as "no run".
 */
describe('thinking timer origin across session switches', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  })

  /** Defer the resume callback so the switch window can be observed. */
  function deferredResume(payload: Record<string, any>) {
    let fire: (() => void) | null = null
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (d: any) => void) => {
      fire = () => onResumed({ session_id: sessionId, messages: [], events: [], queueLength: 0, ...payload })
      return {} as any
    })
    return () => fire?.()
  }

  it('has no start recorded for the session while the resume is still in flight', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any
    const fire = deferredResume({ isWorking: true, runStartedAt: RUN_START })

    const switching = store.switchSession('a')
    // The switch has activated the session but the payload has not arrived.
    expect(store.activeSessionId).toBe('a')
    expect(store.runStartedAt.get('a')).toBeUndefined()

    fire!()
    await switching
    expect(store.runStartedAt.get('a')).toBe(RUN_START)
  })

  it('keeps the origin of an already-known working session when re-entering it', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any

    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (d: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], events: [], queueLength: 0, isWorking: true, runStartedAt: RUN_START })
      return {} as any
    })
    await store.switchSession('a')
    expect(store.runStartedAt.get('a')).toBe(RUN_START)

    // Re-entering the same working session must not move the origin forward.
    await store.switchSession('a')
    expect(store.runStartedAt.get('a')).toBe(RUN_START)
  })

  it('drops the origin only when the resumed run is genuinely finished', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (d: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], events: [], queueLength: 0, isWorking: true, runStartedAt: RUN_START })
      return {} as any
    })
    await store.switchSession('a')
    expect(store.runStartedAt.get('a')).toBe(RUN_START)

    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (d: any) => void) => {
      onResumed({ session_id: sessionId, messages: [], events: [], queueLength: 0, isWorking: false })
      return {} as any
    })
    await store.switchSession('a')
    expect(store.runStartedAt.has('a')).toBe(false)
  })
})
