import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import { onAuthInvalidated } from '../auth-invalidation'
import { socketEndpoint } from '@/utils/deployment-url'
import type { RunEvent } from './chat'

export type PendingInboxEvent = RunEvent & { approval_id?: string; clarify_id?: string }
let inbox: { profile: string; socket: Socket } | undefined

export function pendingChatInboxSocket(profile?: string): Socket | undefined {
  return inbox && inbox.profile === profile ? inbox.socket : undefined
}

/** The Studio shell stays subscribed even when a conversation switches execution sockets. */
export function observePendingChatInbox(
  profile: string,
  onEvent: (event: PendingInboxEvent) => void,
  onSnapshot: (events: PendingInboxEvent[]) => void,
) {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/chat-run')
  const socket = io(endpoint.url, {
    forceNew: true, path: endpoint.path, auth: { token: getApiKey() },
    query: { profile, pending_interactions: '1' }, transports: ['websocket', 'polling'],
  })
  inbox = { profile, socket }
  for (const event of ['approval.requested', 'approval.resolved', 'clarify.requested', 'clarify.resolved']) {
    const handle = (data: PendingInboxEvent) => onEvent({ ...data, event })
    socket.on(event, handle)
    socket.on(`person.${event.replace('clarify.', 'clarification.')}`, handle)
  }
  socket.on('pending.interactions.snapshot', (data: { events: PendingInboxEvent[] }) => {
    if (Array.isArray(data?.events)) onSnapshot(data.events)
  })
  const stop = () => {
    stopAuth()
    socket.removeAllListeners()
    socket.disconnect()
    if (inbox?.socket === socket) {
      inbox = undefined
      onSnapshot([])
    }
  }
  const stopAuth = onAuthInvalidated(stop)
  return stop
}
