// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { invalidateAuth } from '@/api/auth-invalidation'
import { fetchSessionPins, migrateSessionPins, setSessionPin } from '@/api/studio/session-pins'

vi.mock('@/api/studio/session-pins', () => ({
  fetchSessionPins: vi.fn(), migrateSessionPins: vi.fn(), setSessionPin: vi.fn(),
}))

describe('session browser prefs store', () => {
  let pinia: Pinia
  let server: Map<string, Set<string>>
  const pins = (profile: string) => {
    if (!server.has(profile)) server.set(profile, new Set())
    return server.get(profile)!
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    pinia = createPinia()
    setActivePinia(pinia)
    window.localStorage.clear()
    window.localStorage.setItem('hermes_api_key', 'test-key')
    server = new Map()
    vi.mocked(fetchSessionPins).mockImplementation(async profile => ({ pinnedIds: [...pins(profile)] }))
    vi.mocked(migrateSessionPins).mockImplementation(async (profile, ids) => {
      ids.forEach(id => pins(profile).add(id))
      return { pinnedIds: [...pins(profile)] }
    })
    vi.mocked(setSessionPin).mockImplementation(async (profile, id, pinned) => {
      if (pinned) pins(profile).add(id)
      else pins(profile).delete(id)
      return { pinnedIds: [...pins(profile)] }
    })
  })
  afterEach(() => {
    disposePinia(pinia)
    vi.useRealTimers()
  })

  it('persists pins to the server and restores them in a fresh device store', async () => {
    const store = useSessionBrowserPrefsStore()
    await store.togglePinned('session-1')
    await store.togglePinned('session-2')
    expect(store.pinnedIds).toEqual(['session-1', 'session-2'])
    expect(localStorage.getItem('hermes_session_pins_v1_default')).toBeNull()
    disposePinia(pinia)
    pinia = createPinia()
    setActivePinia(pinia)
    const restored = useSessionBrowserPrefsStore()
    await restored.refreshPins()
    expect(restored.pinnedIds).toEqual(['session-1', 'session-2'])
    await restored.removePinned('session-1')
    expect(restored.pinnedIds).toEqual(['session-2'])
  })

  it('migrates legacy pins once and only clears local data after success', async () => {
    localStorage.setItem('hermes_session_pins_v1_default', '["legacy"]')
    vi.mocked(migrateSessionPins).mockRejectedValueOnce(new Error('offline'))
    const store = useSessionBrowserPrefsStore()
    await expect(store.refreshPins()).rejects.toThrow('offline')
    expect(localStorage.getItem('hermes_session_pins_v1_default')).toBe('["legacy"]')
    await store.refreshPins()
    expect(store.pinnedIds).toEqual(['legacy'])
    expect(localStorage.getItem('hermes_session_pins_v1_default')).toBeNull()
    await store.refreshPins()
    expect(migrateSessionPins).toHaveBeenCalledTimes(2)
  })

  it('receives remote pins and unpins on focus and while open', async () => {
    const store = useSessionBrowserPrefsStore()
    await store.refreshPins()
    pins('default').add('other-device')
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(store.pinnedIds).toEqual(['other-device'])
    pins('default').clear()
    await vi.advanceTimersByTimeAsync(10000)
    expect(store.pinnedIds).toEqual([])
  })

  it('keeps confirmed state when saving fails and allows retry', async () => {
    const store = useSessionBrowserPrefsStore()
    await store.refreshPins()
    vi.mocked(setSessionPin).mockRejectedValueOnce(new Error('offline'))
    await expect(store.togglePinned('session')).rejects.toThrow('offline')
    expect(store.pinnedIds).toEqual([])
    await store.togglePinned('session')
    expect(store.pinnedIds).toEqual(['session'])
  })

  it('serializes rapid toggles without losing changes', async () => {
    const store = useSessionBrowserPrefsStore()
    await Promise.all([store.togglePinned('one'), store.togglePinned('two'), store.togglePinned('one')])
    expect(store.pinnedIds).toEqual(['two'])
  })

  it('discards a previous profile response and does not write after switching profiles', async () => {
    const profiles = useProfilesStore()
    const store = useSessionBrowserPrefsStore()
    await store.refreshPins()
    let resolve!: (value: { pinnedIds: string[] }) => void
    vi.mocked(fetchSessionPins).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const toggle = store.togglePinned('old-session')
    await flushPromises()
    pins('work').add('work-session')
    profiles.activeProfileName = 'work'
    resolve({ pinnedIds: ['old-session'] })
    await toggle
    await store.refreshPins()
    expect(store.pinnedIds).toEqual(['work-session'])
    expect(setSessionPin).not.toHaveBeenCalled()
  })

  it('clears pins and stops background requests after logout', async () => {
    const store = useSessionBrowserPrefsStore()
    await store.togglePinned('private-session')
    localStorage.removeItem('hermes_api_key')
    invalidateAuth()
    expect(store.pinnedIds).toEqual([])
    vi.mocked(fetchSessionPins).mockClear()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchSessionPins).not.toHaveBeenCalled()
  })

  it('keeps unrelated browser preferences local and profile scoped', async () => {
    const profiles = useProfilesStore()
    const store = useSessionBrowserPrefsStore()
    store.setHumanOnly(false)
    store.setRecentCount(24)
    store.setRecentCollapsed(true)
    store.setShowRecentSessions(false)
    expect(localStorage.getItem('hermes_recent_session_count_v1')).toBe('24')
    expect(localStorage.getItem('hermes_recent_sessions_collapsed_v1')).toBe('true')
    expect(localStorage.getItem('hermes_show_recent_sessions_v1')).toBe('false')
    profiles.activeProfileName = 'work'
    await store.refreshPins()
    expect(store.humanOnly).toBe(true)
    profiles.activeProfileName = 'default'
    await store.refreshPins()
    expect(store.humanOnly).toBe(false)
  })
})
