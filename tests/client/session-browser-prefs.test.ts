// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'

describe('session browser prefs store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it('persists whether the recent group is collapsed', () => {
    const store = useSessionBrowserPrefsStore()

    expect(store.recentCollapsed).toBe(false)

    store.setRecentCollapsed(true)

    expect(store.recentCollapsed).toBe(true)
    expect(window.localStorage.getItem('hermes_recent_sessions_collapsed_v1')).toBe('true')

    setActivePinia(createPinia())
    expect(useSessionBrowserPrefsStore().recentCollapsed).toBe(true)
  })

  it('persists recent visibility without changing the saved recent count', () => {
    const store = useSessionBrowserPrefsStore()

    expect(store.showRecentSessions).toBe(true)
    store.setRecentCount(24)
    store.setShowRecentSessions(false)

    expect(store.showRecentSessions).toBe(false)
    expect(store.recentCount).toBe(24)
    expect(window.localStorage.getItem('hermes_show_recent_sessions_v1')).toBe('false')
    expect(window.localStorage.getItem('hermes_recent_session_count_v1')).toBe('24')

    setActivePinia(createPinia())
    const restoredStore = useSessionBrowserPrefsStore()
    expect(restoredStore.showRecentSessions).toBe(false)
    expect(restoredStore.recentCount).toBe(24)

    restoredStore.setShowRecentSessions(true)
    expect(restoredStore.recentCount).toBe(24)
  })

  it('reloads human-only preferences automatically when the active profile changes', async () => {
    const profilesStore = useProfilesStore()
    profilesStore.activeProfileName = 'default'
    const store = useSessionBrowserPrefsStore()

    expect(store.humanOnly).toBe(true)
    store.setHumanOnly(false)

    window.localStorage.setItem('hermes_human_only_v1_work', JSON.stringify(true))

    profilesStore.activeProfileName = 'work'
    await nextTick()

    expect(store.profileName).toBe('work')
    expect(store.humanOnly).toBe(true)

    profilesStore.activeProfileName = 'default'
    await nextTick()

    expect(store.humanOnly).toBe(false)
  })
})
