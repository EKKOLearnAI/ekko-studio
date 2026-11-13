import { ref, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { connectSessionState } from '@/api/studio/session-state'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import type { SessionListState, SessionStateSnapshot } from '../../../../shared/session-state'

export const useSessionStateStore = defineStore('sessionState', () => {
  const sessions = ref(new Map<string, SessionListState>())
  let socket: ReturnType<typeof connectSessionState> | null = null
  let stopAuth: (() => void) | null = null
  const pendingReads = new Map<string, { messageId: number; attentionId: number }>()

  function start() {
    if (socket) return
    const owner = connectSessionState()
    socket = owner
    owner.on('sessions.state.snapshot', (snapshot: SessionStateSnapshot) => {
      if (socket !== owner) return
      pendingReads.clear()
      sessions.value = new Map(snapshot.sessions.map(state => [state.sessionId, state]))
    })
    owner.on('sessions.state.updated', (state: SessionListState) => {
      if (socket !== owner) return
      sessions.value.set(state.sessionId, state)
      const pending = pendingReads.get(state.sessionId)
      if (pending && state.readMessageId >= pending.messageId && (state.readAttentionId || 0) >= pending.attentionId) pendingReads.delete(state.sessionId)
    })
    // Do not replay buffered read receipts after a reconnect; use its fresh snapshot.
    owner.on('disconnect', () => pendingReads.clear())
    stopAuth = onAuthInvalidated(stop)
  }

  function stop() {
    const previous = socket
    socket = null
    previous?.removeAllListeners(); previous?.disconnect()
    stopAuth?.(); stopAuth = null
    sessions.value.clear(); pendingReads.clear()
  }

  function markRead(sessionId: string) {
    const state = sessions.value.get(sessionId)
    if (!socket?.connected || state?.working || !state?.unread) return
    const messageId = state.lastMessageId
    const attentionId = state.lastAttentionId || 0
    const pending = pendingReads.get(sessionId)
    if (pending?.messageId === messageId && pending.attentionId === attentionId) return
    const receipt = { messageId, attentionId }
    pendingReads.set(sessionId, receipt)
    socket.emit('sessions.read', { sessionId, messageId, ...(state.lastAttentionId != null ? { attentionId } : {}) }, (result: { ok: boolean }) => {
      if (!result?.ok && pendingReads.get(sessionId) === receipt) pendingReads.delete(sessionId)
    })
  }

  onScopeDispose(stop)
  return { sessions, start, stop, markRead,
    isWorking: (id: string, initialActivity = false) => sessions.value.get(id)?.working ?? initialActivity,
    isUnread: (id: string, initialUnread = false) => {
      const state = sessions.value.get(id)
      return state ? !state.working && state.unread : initialUnread
    },
    backgroundCount: (id: string) => sessions.value.get(id)?.backgroundPending ?? 0 }
})
