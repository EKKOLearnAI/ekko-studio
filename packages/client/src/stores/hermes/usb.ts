import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  USBDeviceRecord,
  USBEventRecord,
  USBHeartbeatPayload,
  USBReadyPayload,
  USBServiceRuntimeStatus,
  USBSubscribeResponse,
} from '@/api/studio/usb-socket'

const MAX_HISTORY_ITEMS = 200

function sortDevices(devices: USBDeviceRecord[]): USBDeviceRecord[] {
  return [...devices].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
}

function sortEvents(events: USBEventRecord[]): USBEventRecord[] {
  return [...events].sort((a, b) => b.ts - a.ts)
}

export const useUSBStore = defineStore('usb', () => {
  const runtime = ref<USBServiceRuntimeStatus | null>(null)
  const devices = ref<USBDeviceRecord[]>([])
  const history = ref<USBEventRecord[]>([])
  const connected = ref(false)
  const unreadCount = ref(0)
  const latestRealtimeEvent = ref<USBEventRecord | null>(null)

  const activeDevices = computed(() => devices.value.filter(device => device.status !== 'removed'))

  function hydrate(snapshot: USBSubscribeResponse): void {
    runtime.value = snapshot.runtime
    devices.value = sortDevices(snapshot.devices)
    history.value = sortEvents(snapshot.events).slice(0, MAX_HISTORY_ITEMS)
    connected.value = snapshot.runtime.state === 'running' || snapshot.runtime.state === 'starting'
  }

  function applyReady(payload: USBReadyPayload): void {
    runtime.value = payload.runtime
    devices.value = sortDevices(payload.existingDevices)
    connected.value = true
  }

  function applyHeartbeat(payload: USBHeartbeatPayload): void {
    runtime.value = payload.runtime
    connected.value = true
  }

  function applyRealtimeEvent(event: USBEventRecord): void {
    history.value = sortEvents([event, ...history.value.filter(item => item.id !== event.id)]).slice(0, MAX_HISTORY_ITEMS)
    if (event.action === 'remove') {
      devices.value = devices.value.filter(device => device.uuid !== event.uuid)
    } else {
      const previous = devices.value.find(device => device.uuid === event.uuid)
      const nextDevice: USBDeviceRecord = {
        uuid: event.uuid,
        deviceNode: event.deviceNode,
        mountPoint: event.mountPoint || previous?.mountPoint || '',
        fsType: event.fsType,
        label: event.label || previous?.label || null,
        vendor: previous?.vendor || null,
        model: previous?.model || null,
        serial: previous?.serial || null,
        sizeBytes: previous?.sizeBytes || null,
        status: event.status === 'mount_failed' ? 'mount_failed' : 'mounted',
        error: event.error,
        ts: new Date(event.ts).toISOString(),
      }
      devices.value = sortDevices([
        nextDevice,
        ...devices.value.filter(device => device.uuid !== event.uuid),
      ])
    }
    unreadCount.value += 1
    latestRealtimeEvent.value = event
  }

  function clearUnread(): void {
    unreadCount.value = 0
  }

  return {
    runtime,
    devices,
    history,
    connected,
    unreadCount,
    latestRealtimeEvent,
    activeDevices,
    hydrate,
    applyReady,
    applyHeartbeat,
    applyRealtimeEvent,
    clearUnread,
  }
})
