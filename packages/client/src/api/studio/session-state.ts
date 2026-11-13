import { io } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import { socketEndpoint } from '@/utils/deployment-url'

export function connectSessionState() {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/chat-run')
  return io(endpoint.url, {
    // Other namespaces already use this origin. A shared Manager keeps its
    // original query, dropping session_state and silently skipping subscription.
    forceNew: true,
    path: endpoint.path, auth: { token: getApiKey() },
    query: { session_state: '1', profile: localStorage.getItem('hermes_active_profile_name') || 'default' },
    transports: ['websocket', 'polling'], reconnection: true,
    reconnectionDelay: 1000, reconnectionDelayMax: 30000,
  })
}
