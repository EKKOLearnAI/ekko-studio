// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useChatStore, type Session } from '@/stores/hermes/chat'

const api = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  resumeSession: vi.fn(),
}))
vi.mock('@/api/studio/sessions', () => ({
  ...api,
  archiveSession: vi.fn(), deleteSession: vi.fn(), setSessionModel: vi.fn(),
  fetchWorkspaceRunChangeFile: vi.fn(),
}))
vi.mock('@/api/studio/chat', () => ({
  resumeSession: api.resumeSession,
  startRunViaSocket: vi.fn(), registerSessionHandlers: vi.fn(), unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(), respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(), onSessionCommand: vi.fn(), onSessionTitleUpdated: vi.fn(),
  onSessionWorkspaceUpdated: vi.fn(), onSessionSettingsUpdated: vi.fn(),
}))
vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default', hasApiKey: () => false }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(), publishSessionSync: vi.fn() }))

function session(id = 'search-session'): Session {
  return { id, profile: 'research', title: id, messages: [], createdAt: 1, updatedAt: 1 }
}

function page(offset: number, limit = 150, total = 600) {
  const end = Math.max(0, total - offset)
  const start = Math.max(0, end - limit)
  return {
    session: { id: 'search-session', title: 'Search session' },
    messages: Array.from({ length: end - start }, (_, i) => ({
      id: start + i + 1, role: 'user', content: `Message ${start + i + 1}`, timestamp: start + i + 1,
    })),
    total, offset, limit, hasMore: start > 0,
  }
}

describe('search message navigation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    api.fetchSessions.mockResolvedValue([])
    api.fetchSessionMessagesPage.mockImplementation(async (_id, offset, limit) => page(offset, limit))
    api.resumeSession.mockImplementation((id, callback) => callback({
      session_id: id, messages: page(0).messages, messageTotal: 600,
      messageLoadedCount: 150, hasMoreBefore: true, isWorking: false, events: [],
    }))
  })

  it('loads through the matching page beyond the live-chat cap, then stops', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await expect(store.switchSession('search-session', '170')).resolves.toBe(true)

    expect(api.fetchSessionMessagesPage.mock.calls).toEqual([
      ['search-session', 150, 150, 'research'],
      ['search-session', 300, 150, 'research'],
    ])
    expect(store.messages.some(message => message.id === '170')).toBe(true)
    expect(store.activeSession?.loadedMessageCount).toBe(450)
    expect(store.focusMessageId).toBe('170')
    expect(store.isLoadingMessages).toBe(false)
    expect(store.activeSession?.hasMoreBefore).toBe(true)
    await expect(store.loadOlderMessages()).resolves.toBe(false)
  })

  it('does not request older pages for a hit in the resume page', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await expect(store.switchSession('search-session', '580')).resolves.toBe(true)
    expect(api.fetchSessionMessagesPage).not.toHaveBeenCalled()
  })

  it('keeps ordinary history loading capped at 300 messages', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await store.switchSession('search-session')
    await expect(store.loadOlderMessages()).resolves.toBe(true)
    await expect(store.loadOlderMessages()).resolves.toBe(false)
    expect(store.activeSession?.loadedMessageCount).toBe(300)
  })

  it('clears the focus when the hit no longer exists', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await expect(store.switchSession('search-session', 'missing')).resolves.toBe(false)
    expect(api.fetchSessionMessagesPage).toHaveBeenCalledTimes(3)
    expect(store.focusMessageId).toBeNull()
    expect(store.isLoadingMessages).toBe(false)
  })

  it('stops on a failed page without marking the remaining history exhausted', async () => {
    api.fetchSessionMessagesPage.mockResolvedValue(null)
    const store = useChatStore()
    store.sessions = [session()]
    await expect(store.switchSession('search-session', '170')).resolves.toBe(false)
    expect(store.activeSession?.hasMoreBefore).toBe(true)
    expect(store.activeSession?.isLoadingOlderMessages).toBe(false)
    expect(store.focusMessageId).toBeNull()
  })

  it('stops if a page contains no new messages', async () => {
    api.fetchSessionMessagesPage.mockResolvedValue(page(0))
    const store = useChatStore()
    store.sessions = [session()]
    await expect(store.switchSession('search-session', '170')).resolves.toBe(false)
    expect(api.fetchSessionMessagesPage).toHaveBeenCalledTimes(1)
  })

  it('ignores a search response after a newer selection of the same session', async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void
    api.fetchSessionMessagesPage.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve }))
    const store = useChatStore()
    store.sessions = [session()]
    const oldSearch = store.switchSession('search-session', '170')
    await flushPromises()
    const newSearch = store.switchSession('search-session', '320')
    await expect(newSearch).resolves.toBe(true)
    resolvePage(page(300))
    await expect(oldSearch).resolves.toBe(false)
    expect(store.focusMessageId).toBe('320')
    expect(store.messages.some(message => message.id === '170')).toBe(false)
    expect(store.activeSession?.loadedMessageCount).toBe(300)
  })

  it('stops searching when the user switches to another session', async () => {
    let resolvePage!: (value: ReturnType<typeof page>) => void
    api.fetchSessionMessagesPage.mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve }))
    const store = useChatStore()
    store.sessions = [session(), session('other')]
    const pending = store.switchSession('search-session', '170')
    await flushPromises()
    await store.switchSession('other')
    resolvePage(page(150))
    await expect(pending).resolves.toBe(false)
    expect(store.activeSessionId).toBe('other')
    expect(store.focusMessageId).toBeNull()
    expect(api.fetchSessionMessagesPage).toHaveBeenCalledTimes(1)
  })

  it('preserves a search result outside the session list when the chat route mounts', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await store.switchSession('search-session', '170')
    await store.loadSessions(null, 'search-session')
    expect(store.activeSessionId).toBe('search-session')
    expect(store.focusMessageId).toBe('170')
    expect(store.messages.some(message => message.id === '170')).toBe(true)
  })

  it('keeps the searched history loaded when refreshing the active session', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await store.switchSession('search-session', '170')
    await store.refreshActiveSession()
    expect(api.fetchSessionMessagesPage).toHaveBeenLastCalledWith('search-session', 0, 450, 'research')
    expect(store.messages.some(message => message.id === '170')).toBe(true)
  })

  it('preserves title-only search selections outside the sidebar page on route mount', async () => {
    const store = useChatStore()
    store.sessions = [session()]
    await store.switchSession('search-session')
    await store.loadSessions(null, 'search-session')
    expect(store.activeSessionId).toBe('search-session')
    expect(store.messages).toHaveLength(150)
    expect(store.focusMessageId).toBeNull()
  })
})
