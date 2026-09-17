import { defineStore } from 'pinia'
import { onScopeDispose, ref, watch } from 'vue'
import { fetchSessionPins, migrateSessionPins, setSessionPin } from '@/api/studio/session-pins'
import { hasApiKey } from '@/api/client'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { useProfilesStore } from './profiles'

const PIN_KEY_PREFIX = 'hermes_session_pins_v1_'
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

function pinsKey(profileName: string): string {
  return `${PIN_KEY_PREFIX}${profileName}`
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
  const pinnedIds = ref<string[]>([])
  const humanOnly = ref<boolean>(loadJson<boolean>(humanOnlyKey(profileName.value), true))
  const recentCount = ref<number>(Math.min(100, Math.max(1, loadJson<number>(RECENT_COUNT_KEY, 10))))
  const recentCollapsed = ref<boolean>(loadJson<boolean>(RECENT_COLLAPSED_KEY, false))
  const showRecentSessions = ref<boolean>(loadJson<boolean>(SHOW_RECENT_SESSIONS_KEY, true))

  let generation = 0
  let queue: Promise<unknown> = Promise.resolve()
  let refreshPending: Promise<void> | null = null

  function enqueue(operation: (profile: string, apply: (ids: string[]) => void, isCurrent: () => boolean) => Promise<void>) {
    const version = generation
    const profile = profileName.value
    const task = queue.then(async () => {
      if (version !== generation) return
      await operation(profile, ids => {
        if (version === generation &&
            (ids.length !== pinnedIds.value.length || ids.some((id, index) => id !== pinnedIds.value[index]))) {
          pinnedIds.value = ids
        }
      }, () => version === generation)
    })
    queue = task.catch(() => undefined)
    return task
  }

  async function loadPins(profile: string) {
    const legacy = loadJson<unknown>(pinsKey(profile), [])
    const ids = Array.isArray(legacy)
      ? legacy.filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id.length <= 512)
      : []
    const result = ids.length
      ? await migrateSessionPins(profile, ids)
      : await fetchSessionPins(profile)
    // Remove the legacy cache only after the server confirms persistence.
    try { localStorage.removeItem(pinsKey(profile)) } catch { /* storage disabled */ }
    return result
  }

  function refreshPins(): Promise<void> {
    if (refreshPending) return refreshPending
    const task = enqueue(async (profile, apply) => {
      apply((await loadPins(profile)).pinnedIds)
    })
    refreshPending = task
    void task.finally(() => {
      if (refreshPending === task) refreshPending = null
    }).catch(() => undefined)
    return task
  }

  function backgroundRefresh() {
    if (!hasApiKey()) return
    void refreshPins().catch(() => undefined)
  }

  function reload() {
    generation++
    refreshPending = null
    profileName.value = currentProfileName()
    pinnedIds.value = []
    humanOnly.value = loadJson<boolean>(humanOnlyKey(profileName.value), true)
    backgroundRefresh()
  }

  function persistHumanOnly() {
    saveJson(humanOnlyKey(profileName.value), humanOnly.value)
  }

  function isPinned(sessionId: string): boolean {
    return pinnedIds.value.includes(sessionId)
  }

  function togglePinned(sessionId: string): Promise<void> {
    return enqueue(async (profile, apply, isCurrent) => {
      const pinned = !isPinned(sessionId)
      await loadPins(profile)
      if (!isCurrent()) return
      const result = await setSessionPin(profile, sessionId, pinned)
      apply(result.pinnedIds)
    })
  }

  function removePinned(sessionId: string): Promise<void> {
    return enqueue(async (profile, apply, isCurrent) => {
      await loadPins(profile)
      if (!isCurrent()) return
      apply((await setSessionPin(profile, sessionId, false)).pinnedIds)
    }).catch(() => undefined)
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
    { flush: 'sync' },
  )

  const unsubscribeAuth = onAuthInvalidated(reload)
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') backgroundRefresh()
  }, 10000)
  function onVisible() {
    if (document.visibilityState === 'visible') backgroundRefresh()
  }
  window.addEventListener('focus', backgroundRefresh)
  window.addEventListener('online', backgroundRefresh)
  document.addEventListener('visibilitychange', onVisible)
  onScopeDispose(() => {
    generation++
    clearInterval(timer)
    unsubscribeAuth()
    window.removeEventListener('focus', backgroundRefresh)
    window.removeEventListener('online', backgroundRefresh)
    document.removeEventListener('visibilitychange', onVisible)
  })
  backgroundRefresh()

  return {
    profileName,
    pinnedIds,
    humanOnly,
    recentCount,
    recentCollapsed,
    showRecentSessions,
    reload,
    isPinned,
    togglePinned,
    removePinned,
    setHumanOnly,
    setRecentCount,
    setRecentCollapsed,
    setShowRecentSessions,
    refreshPins,
  }
})
