import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { connectPersonPresence, type PersonPresenceSnapshot } from '@/api/studio/person-presence'
import { onAuthInvalidated } from '@/api/auth-invalidation'

export const usePersonPresenceStore = defineStore('personPresence', () => {
  const snapshot = ref<PersonPresenceSnapshot | null>(null)
  const backgroundTaskCount = computed(() => {
    const count = snapshot.value?.backgroundTaskCount
    return Number.isSafeInteger(count) && count! > 0 ? count! : 0
  })
  let socket: ReturnType<typeof connectPersonPresence> | null = null
  let stopAuth: (() => void) | null = null
  function start() {
    if (socket) return
    const connection = connectPersonPresence()
    socket = connection
    connection.on('person.presence', (next: PersonPresenceSnapshot) => {
      if (socket !== connection) return
      snapshot.value = next
    })
    stopAuth = onAuthInvalidated(stop)
  }
  function stop() {
    const previous = socket
    socket = null
    previous?.removeAllListeners(); previous?.disconnect()
    stopAuth?.(); stopAuth = null
    snapshot.value = null
  }
  return { snapshot, backgroundTaskCount, start, stop }
})
