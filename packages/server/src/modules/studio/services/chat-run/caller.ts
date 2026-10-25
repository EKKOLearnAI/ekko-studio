import type { Socket } from 'socket.io'
import type { ChatRunCaller } from '../../contracts/runs/caller'

export type { ChatRunCaller } from '../../contracts/runs/caller'
/** Transitional input for existing runtime adapters; direct callers do not implement Socket. */
export type ChatRunCallerTarget = Socket | ChatRunCaller

export function isDirectChatRunCaller(target: ChatRunCallerTarget): target is ChatRunCaller {
  return 'kind' in target && target.kind === 'direct'
}

export function chatRunCaller(target: ChatRunCallerTarget): ChatRunCaller {
  if ('kind' in target && (target.kind === 'direct' || target.kind === 'socket' || target.kind === 'background')) return target
  const socket = target as Socket
  return {
    kind: 'socket',
    originId: socket.id,
    user: socket.data?.user,
    mobileDeviceTarget: socket.data?.mobileDeviceTarget,
    groupRunIsCurrent: socket.data?.groupRunIsCurrent,
    isActive: () => Boolean(socket.connected),
    observeSession: sessionId => { void socket.join(`session:${sessionId}`) },
    reply: (event, payload) => { socket.emit(event, payload) },
    publishToPeers: (sessionId, event, payload) => { socket.to(`session:${sessionId}`).emit(event, payload) },
  }
}
