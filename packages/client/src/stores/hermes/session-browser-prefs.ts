import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useProfilesStore } from './profiles'

const HUMAN_ONLY_KEY_PREFIX = 'hermes_human_only_v1_'
const RECENT_COUNT_KEY = 'hermes_recent_session_count_v1'
const RECENT_COLLAPSED_KEY = 'hermes_recent_sessions_collapsed_v1'
const SHOW_RECENT_SESSIONS_KEY = 'hermes_show_recent_sessions_v1'

function currentProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    // Fallback during store initialization
    return localStorage.getItem('hermes_active_profile_name') || 'default'
  }
}

function humanOnlyKey(profileName: string): string {
  return `${HUMAN_ONLY_KEY_PREFIX}${profileName}`
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota/storage errors — fall back to in-memory only
  }
}

export const useSessionBrowserPrefsStore = defineStore('session-browser-prefs', () => {
  const profileName = ref(currentProfileName())
  const humanOnly = ref<boolean>(loadJson<boolean>(humanOnlyKey(profileName.value), true))
  const recentCount = ref<number>(Math.min(100, Math.max(1, loadJson<number>(RECENT_COUNT_KEY, 10))))
  const recentCollapsed = ref<boolean>(loadJson<boolean>(RECENT_COLLAPSED_KEY, false))
  const showRecentSessions = ref<boolean>(loadJson<boolean>(SHOW_RECENT_SESSIONS_KEY, true))

  function reload() {
    profileName.value = currentProfileName()
    humanOnly.value = loadJson<boolean>(humanOnlyKey(profileName.value), true)
  }

  function persistHumanOnly() {
    saveJson(humanOnlyKey(profileName.value), humanOnly.value)
  }

  function setHumanOnly(value: boolean) {
    if (humanOnly.value === value) return
    humanOnly.value = value
    persistHumanOnly()
  }

  function setRecentCount(value: number) {
    recentCount.value = Math.min(100, Math.max(1, Math.floor(Number(value) || 10)))
    saveJson(RECENT_COUNT_KEY, recentCount.value)
  }

  function setRecentCollapsed(value: boolean) {
    recentCollapsed.value = value
    saveJson(RECENT_COLLAPSED_KEY, value)
  }

  function setShowRecentSessions(value: boolean) {
    showRecentSessions.value = value
    saveJson(SHOW_RECENT_SESSIONS_KEY, value)
  }

  watch(
    () => useProfilesStore().activeProfileName,
    () => reload(),
  )

  return {
    profileName,
    humanOnly,
    recentCount,
    recentCollapsed,
    showRecentSessions,
    reload,
    setHumanOnly,
    setRecentCount,
    setRecentCollapsed,
    setShowRecentSessions,
  }
})
