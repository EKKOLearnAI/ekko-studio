import { onMounted, onBeforeUnmount, watchEffect } from 'vue'
import { useSessionStateStore } from '@/stores/hermes/session-state'

/** Only a visible conversation that finished loading may acknowledge its messages. */
export function useSessionReadState(viewedSession: () => string | null | undefined) {
  const states = useSessionStateStore()
  const markVisible = () => {
    const sessionId = viewedSession()
    if (sessionId && document.visibilityState === 'visible') states.markRead(sessionId)
  }
  onMounted(() => {
    states.start()
    document.addEventListener('visibilitychange', markVisible)
    window.addEventListener('focus', markVisible)
    markVisible()
  })
  watchEffect(markVisible)
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', markVisible)
    window.removeEventListener('focus', markVisible)
  })
  return states
}
