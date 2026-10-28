import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { connectPersonPresence, type PersonPresenceSnapshot } from '@/api/studio/person-presence'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import { PERSON_ANIMATIONS } from '@/utils/chat-agent-avatar'

const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

export const usePersonPresenceStore = defineStore('personPresence', () => {
  const snapshot = ref<PersonPresenceSnapshot | null>(null)
  const state = computed(() => snapshot.value?.state || 'idle')
  const avatarSrc = computed(() => PERSON_ANIMATIONS[state.value])
  const avatarKey = computed(() => snapshot.value?.feedbackId || state.value)
  const backgroundTaskCount = computed(() => {
    const count = snapshot.value?.backgroundTaskCount
    return Number.isSafeInteger(count) && count! > 0 ? count! : 0
  })
  let socket: ReturnType<typeof connectPersonPresence> | null = null
  let stopAuth: (() => void) | null = null
  let activityTimer: ReturnType<typeof setTimeout> | null = null
  let lastSent = -Infinity

  function sendActivity() {
    activityTimer = null
    if (!socket?.connected) return
    lastSent = performance.now()
    // Do not buffer activity from an offline device and wake the account on reconnect.
    socket.volatile.emit('person.activity')
  }
  function activity() {
    if (!socket?.connected || document.visibilityState === 'hidden') return
    const delay = 1000 - (performance.now() - lastSent)
    if (delay <= 0) { if (activityTimer) clearTimeout(activityTimer); sendActivity() }
    else if (!activityTimer) activityTimer = setTimeout(sendActivity, delay)
  }
  function start() {
    if (socket) return
    const connection = connectPersonPresence()
    socket = connection
    connection.on('person.presence', (next: PersonPresenceSnapshot) => {
      if (socket !== connection || !(next?.state in PERSON_ANIMATIONS)) return
      snapshot.value = next
    })
    for (const event of activityEvents) window.addEventListener(event, activity, { passive: true })
    stopAuth = onAuthInvalidated(stop)
  }
  function stop() {
    for (const event of activityEvents) window.removeEventListener(event, activity)
    if (activityTimer) clearTimeout(activityTimer)
    activityTimer = null
    const previous = socket
    socket = null
    previous?.removeAllListeners(); previous?.disconnect()
    stopAuth?.(); stopAuth = null
    lastSent = -Infinity
    snapshot.value = null
  }
  return { snapshot, state, avatarSrc, avatarKey, backgroundTaskCount, start, stop }
})
