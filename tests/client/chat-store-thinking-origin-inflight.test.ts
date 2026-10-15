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

vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(), deleteSession: vi.fn(), fetchSession: vi.fn(), fetchSessions: vi.fn(),
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []), fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_p: string, n: string) => `/download/${n}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))

import { useChatStore, type Session } from '@/stores/hermes/chat'

function makeSession(id: string): Session {
  return { id, title: id, messages: [], createdAt: Date.now(), updatedAt: Date.now() }
}

const RUN_START = 1_787_000_000_000

/**
 * Replicates the MessageList timer watch exactly:
 *   visible = isRunIndicatorActive (isRunActive || abortState)
 *   reportedStart = runStartedAt.get(activeSessionId) || 0
 *   thinkingStartedAt = reportedStart > 0 ? reportedStart : Date.now()
 * and records what origin the timer would adopt on every change.
 */
function timerOrigins(store: ReturnType<typeof useChatStore>) {
  const seen: Array<{ visible: boolean; reportedStart: number; adopted: number; at: number }> = []
  const deps = () => [
    store.isRunActive || !!store.abortState,
    store.activeSessionId,
    store.activeSessionId ? store.runStartedAt.get(store.activeSessionId) || 0 : 0,
  ] as const
  let prev = deps()
  const record = () => {
    const [visible, sid] = prev
    const reportedStart = sid ? store.runStartedAt.get(sid) || 0 : 0
    seen.push({ visible, reportedStart, adopted: reportedStart > 0 ? reportedStart : Date.now(), at: Date.now() })
  }
  const check = () => {
    const next = deps()
    if (next[0] !== prev[0] || next[1] !== prev[1] || next[2] !== prev[2]) {
      prev = next
      record()
    }
  }
  record()
  return { seen, check }
}

describe('thinking timer origin during a switch into a working session', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
  })

  it('adopts a fresh Date.now() origin while the working session resume is in flight', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any

    let fire: (() => void) | null = null
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (d: any) => void) => {
      fire = () => onResumed({
        session_id: sessionId, messages: [], events: [], queueLength: 0,
        isWorking: true, runStartedAt: RUN_START,
      })
      return {} as any
    })

    const timer = timerOrigins(store)
    const switching = store.switchSession('a')

    // Window: session is active, server has not answered yet.
    timer.check()
    const inFlight = timer.seen[timer.seen.length - 1]
    expect(inFlight.reportedStart).toBe(0)
    // This is the reset: the origin becomes "now" instead of the run's real start.
    expect(inFlight.adopted).toBeGreaterThan(RUN_START)

    fire!()
    await switching
    timer.check()
    const settled = timer.seen[timer.seen.length - 1]
    expect(settled.reportedStart).toBe(RUN_START)
    expect(settled.adopted).toBe(RUN_START)
  })

  it('never adopts a fresh origin for a session whose run start is already known', async () => {
    const store = useChatStore()
    store.sessions = [makeSession('a')] as any
    chatApi.resumeSession.mockImplementation((sessionId: string, onResumed: (d: any) => void) => {
      onResumed({
        session_id: sessionId, messages: [], events: [], queueLength: 0,
        isWorking: true, runStartedAt: RUN_START,
      })
      return {} as any
    })

    await store.switchSession('a')
    const timer = timerOrigins(store)
    const adopted = timer.seen.map(s => s.adopted)
    expect(adopted).toContain(RUN_START)
    // No entry may have fallen back to "now".
    expect(adopted.every(v => v <= Date.now())).toBe(true)
    expect(adopted.filter(v => v !== RUN_START)).toHaveLength(0)
  })
})
