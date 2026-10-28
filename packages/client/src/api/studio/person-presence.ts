import { io } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '@/api/client'
import { socketEndpoint } from '@/utils/deployment-url'

export type PersonPresenceState = 'idle' | 'thinking' | 'searching' | 'done' | 'error' | 'sleeping'
export interface PersonPresenceSnapshot { state: PersonPresenceState; backgroundTaskCount: number; lastActivityAt: number; sleepAt: number; feedbackId?: string; feedbackUntil?: number }

export function connectPersonPresence() {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/person-presence')
  return io(endpoint.url, {
    path: endpoint.path, auth: { token: getApiKey() },
    transports: ['websocket', 'polling'], reconnection: true,
    reconnectionDelay: 1000, reconnectionDelayMax: 30000,
  })
}
