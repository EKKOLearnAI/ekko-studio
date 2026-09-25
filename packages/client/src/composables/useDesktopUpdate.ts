import { onMounted, onUnmounted, ref } from 'vue'
import { desktopBridge, type DesktopUpdateState, type DesktopUpdaterBridge } from '@/utils/desktop-bridge'

export function useDesktopUpdate() {
  const state = ref<DesktopUpdateState | null>(null)
  const busy = ref(false)
  const actionFailed = ref(false)
  let updater: DesktopUpdaterBridge | undefined
  let stopListening: (() => void) | undefined
  let disposed = false

  function applyState(next: DesktopUpdateState): void {
    // IPC replies can arrive after a newer progress event.
    if (!disposed && (!state.value || next.revision >= state.value.revision)) state.value = next
  }

  onMounted(() => {
    const desktop = desktopBridge()
    if (!desktop?.isDesktop || !desktop.updater) return
    updater = desktop.updater
    stopListening = updater.onStateChange(applyState)
    void updater.getState().then(applyState).catch(() => undefined)
  })

  onUnmounted(() => {
    disposed = true
    stopListening?.()
  })

  async function act(action: 'cancel' | 'download' | 'install'): Promise<void> {
    if (!updater || busy.value) return
    busy.value = true
    actionFailed.value = false
    try {
      applyState(await updater[action]())
    } catch {
      if (!disposed) actionFailed.value = true
    } finally {
      busy.value = false
    }
  }

  return { state, busy, actionFailed, act }
}
