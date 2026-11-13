import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  connectPetStateSocket,
  disconnectPetStateSocket,
  onPetStateSnapshot,
  requestPetStateSnapshot,
  type PetActivity,
  type PetState,
  type PetStateSnapshot,
} from '@/api/studio/pet-state'

function emptySnapshot(profile = 'default'): PetStateSnapshot {
  return {
    profile,
    state: 'idle',
    activity: {},
    updatedAt: Date.now(),
    activeTools: [],
    awaiting: [],
  }
}

export const usePetStateStore = defineStore('petState', () => {
  const snapshot = ref<PetStateSnapshot>(emptySnapshot())
  const connected = ref(false)
  const error = ref('')
  let unsubscribe: (() => void) | null = null

  const state = computed<PetState>(() => snapshot.value.state)
  const activity = computed<PetActivity>(() => snapshot.value.activity)

  async function connect(profile?: string | null): Promise<void> {
    disconnect()
    error.value = ''
    const socket = connectPetStateSocket(profile)
    socket.on('connect', () => {
      connected.value = true
      error.value = ''
    })
    socket.on('disconnect', () => {
      connected.value = false
    })
    socket.on('connect_error', (err: Error) => {
      connected.value = false
      error.value = err.message
    })
    unsubscribe = onPetStateSnapshot(next => {
      snapshot.value = next
    }, profile)
    try {
      snapshot.value = await requestPetStateSnapshot(profile)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  function disconnect(): void {
    unsubscribe?.()
    unsubscribe = null
    disconnectPetStateSocket()
    connected.value = false
  }

  return {
    activity,
    connect,
    connected,
    disconnect,
    error,
    snapshot,
    state,
  }
})
