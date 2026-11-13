import { onMounted, onUnmounted } from 'vue'
import {
  disconnectUSBSocket,
  onUSBDeviceEvent,
  onUSBHeartbeat,
  onUSBReady,
  onUSBSocketConnect,
  onUSBSocketDisconnect,
  subscribeUSBStream,
  unsubscribeUSBStream,
} from '@/api/studio/usb-socket'
import { useUSBStore } from '@/stores/hermes/usb'

let started = false
let mountCount = 0
let cleanupFns: Array<() => void> = []

async function startUSBStream(store: ReturnType<typeof useUSBStore>) {
  if (started) return
  started = true
  const snapshot = await subscribeUSBStream('24h')
  store.hydrate(snapshot)
  cleanupFns = [
    onUSBReady(payload => store.applyReady(payload)),
    onUSBHeartbeat(payload => store.applyHeartbeat(payload)),
    onUSBDeviceEvent(event => store.applyRealtimeEvent(event)),
    onUSBSocketConnect(() => {
      store.connected = true
    }),
    onUSBSocketDisconnect(() => {
      store.connected = false
    }),
  ]
}

async function stopUSBStream() {
  const handlers = cleanupFns.splice(0)
  handlers.forEach(cleanup => cleanup())
  try {
    await unsubscribeUSBStream()
  } catch {
    // Best-effort disconnect on teardown.
  }
  disconnectUSBSocket()
  started = false
}

export function useUSBStream() {
  const store = useUSBStore()

  onMounted(() => {
    mountCount += 1
    void startUSBStream(store)
  })

  onUnmounted(() => {
    mountCount = Math.max(mountCount - 1, 0)
    if (mountCount === 0) {
      void stopUSBStream()
    }
  })

  return store
}
