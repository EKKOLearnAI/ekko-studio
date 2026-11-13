import { socketEndpoint } from '@/utils/deployment-url'
import { io } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import type { ChatRunTransport, ResumeSessionPayload, RunEvent } from './chat'

const disconnectObservers = new Set<() => void>()

export function disconnectBackgroundStatusObservers(): void {
  for (const disconnect of [...disconnectObservers]) disconnect()
}

/** Observe aggregate activity without owning or replacing the execution socket. */
export function observeBackgroundStatus(
  sessionId: string,
  profile: string,
  transport: ChatRunTransport,
  onPending: (pending: unknown) => void,
): () => void {
  let closed = false
  const namespace = transport === 'global-agent' ? '/global-agent' : '/chat-run'
  const socket = io(socketEndpoint(getBaseUrlValue(), namespace).url, {
    path: socketEndpoint(getBaseUrlValue(), namespace).path,
    auth: { token: getApiKey() },
    query: { profile },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
    timeout: 30000,
  })
  const resume = () => {
    if (!closed) socket.emit('resume', { session_id: sessionId, profile })
  }
  socket.on('connect', resume)
  socket.on('resumed', (data: ResumeSessionPayload) => {
    if (!closed && data.session_id === sessionId) onPending(data.backgroundPending)
  })
  const onEvent = (event: RunEvent) => {
    if (closed || event.session_id !== sessionId) return
    if (event.background_pending != null || event.event === 'run.completed'
      || event.event === 'run.failed' || event.event === 'abort.completed') {
      onPending(event.background_pending)
    }
  }
  for (const event of ['delegation.updated', 'run.completed', 'run.failed', 'abort.completed']) {
    socket.on(event, onEvent)
  }
  if (socket.connected) resume()
  const dispose = () => {
    if (closed) return
    closed = true
    disconnectObservers.delete(disconnect)
    socket.removeAllListeners()
    socket.disconnect()
  }
  const disconnect = () => {
    dispose()
    onPending(0)
  }
  disconnectObservers.add(disconnect)
  return dispose
}
