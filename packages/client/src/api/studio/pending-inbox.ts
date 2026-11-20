import { io } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import { onAuthInvalidated } from '../auth-invalidation'
import { socketEndpoint } from '@/utils/deployment-url'
import type { RunEvent } from './chat'

export type PendingInboxEvent = RunEvent & { profile: string; approval_id?: string; clarify_id?: string }

/** Each namespace supplies an authorized account snapshot on connection and reconnection. */
export function observeAccountPending<T>(
  namespace: '/chat-run' | '/workflow',
  onEvent: (event: T) => void,
  onSnapshot: (events: T[]) => void,
) {
  const endpoint = socketEndpoint(getBaseUrlValue(), namespace)
  const socket = io(endpoint.url, {
    forceNew: true, path: endpoint.path, auth: { token: getApiKey() },
    query: { pending_interactions: 'account' }, transports: ['websocket', 'polling'],
  })
  socket.on('pending.interaction', onEvent)
  socket.on('pending.interactions.snapshot', (data: { events: T[] }) => {
    if (Array.isArray(data?.events)) onSnapshot(data.events)
  })
  const stop = () => {
    stopAuth()
    socket.removeAllListeners()
    socket.disconnect()
    onSnapshot([])
  }
  const stopAuth = onAuthInvalidated(stop)
  return stop
}
