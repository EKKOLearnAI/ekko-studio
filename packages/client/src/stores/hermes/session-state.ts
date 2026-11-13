import { ref, reactive, onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import type { RouteLocation, Router } from 'vue-router'
import { connectSessionState } from '@/api/studio/session-state'
import { onAuthInvalidated } from '@/api/auth-invalidation'
import type { SessionListState, SessionStateSnapshot } from '../../../../shared/session-state'

const MARK_UNREAD_TIMEOUT_MS = 10_000
/** Identifies one manual mark: its revision within one session incarnation. */
const markToken = (state: SessionListState) => state.unreadRevision == null ? null : `${state.generation ?? ''}#${state.unreadRevision}`

export const useSessionStateStore = defineStore('sessionState', () => {
  const sessions = ref(new Map<string, SessionListState>())
  let socket: ReturnType<typeof connectSessionState> | null = null
  let stopAuth: (() => void) | null = null
  const pendingReads = new Map<string, { messageId: number; attentionId: number; token?: string }>()
  // The mark token the user saw at the moment they chose to open each conversation. It is never
  // recaptured later, so passive views, slow loads and other devices cannot clear a newer mark.
  const opened = reactive(new Map<string, string>())

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
      if (pending && state.readMessageId >= pending.messageId && (state.readAttentionId || 0) >= pending.attentionId
        && (pending.token == null || !state.manualUnread || markToken(state) !== pending.token)) pendingReads.delete(state.sessionId)
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
    sessions.value.clear(); pendingReads.clear(); opened.clear()
  }

  /**
   * Call when the user chooses to open a conversation; it may clear the mark seen right now. Without
   * state there is no mark to name, so a mark that shows up later needs another selection.
   */
  function acknowledge(sessionId: string) {
    const state = sessions.value.get(sessionId)
    const token = state && markToken(state)
    if (token) opened.set(sessionId, token)
  }

  function markRead(sessionId: string) {
    const state = sessions.value.get(sessionId)
    if (!socket?.connected || state?.working || !state?.unread) return
    const messageId = state.lastMessageId
    const attentionId = state.lastAttentionId || 0
    const token = markToken(state)
    const clearsMark = !!state.manualUnread && !!token && opened.get(sessionId) === token
    if (!clearsMark && messageId <= state.readMessageId && attentionId <= (state.readAttentionId || 0)) return
    const receipt = { messageId, attentionId, token: clearsMark ? token! : undefined }
    const pending = pendingReads.get(sessionId)
    if (pending?.messageId === messageId && pending.attentionId === attentionId && pending.token === receipt.token) return
    pendingReads.set(sessionId, receipt)
    socket.emit('sessions.read', { sessionId, messageId, ...(state.lastAttentionId != null ? { attentionId } : {}),
      ...(clearsMark ? { unreadRevision: state.unreadRevision, generation: state.generation } : {}) }, (result: { ok: boolean }) => {
      if (!result?.ok && pendingReads.get(sessionId) === receipt) pendingReads.delete(sessionId)
    })
  }

  function canMarkUnread(sessionId: string) {
    const state = sessions.value.get(sessionId)
    return !!state && typeof state.unreadRevision === 'number' && typeof state.generation === 'string' && !state.working && !state.unread
  }

  /** Resolves true only when the server applied the mark; stale or failed requests change nothing. */
  function markUnread(sessionId: string): Promise<boolean> {
    const owner = socket
    const state = sessions.value.get(sessionId)
    if (!owner?.connected || !state || !canMarkUnread(sessionId)) return Promise.resolve(false)
    return new Promise(resolve => owner.timeout(MARK_UNREAD_TIMEOUT_MS).emit('sessions.unread',
      { sessionId, unreadRevision: state.unreadRevision, generation: state.generation },
      (error: Error | null, result?: { ok: boolean; changed?: boolean }) => resolve(!error && socket === owner && !!result?.ok && !!result.changed)))
  }

  onScopeDispose(stop)
  return { sessions, start, stop, markRead, acknowledge, canMarkUnread, markUnread,
    isWorking: (id: string, initialActivity = false) => sessions.value.get(id)?.working ?? initialActivity,
    isUnread: (id: string, initialUnread = false) => {
      const state = sessions.value.get(id)
      return state ? !state.working && state.unread : initialUnread
    },
    backgroundCount: (id: string) => sessions.value.get(id)?.backgroundPending ?? 0 }
})

function routedSessionId(route: Pick<RouteLocation, 'name' | 'params' | 'query'>): string | null {
  if (route.name === 'hermes.session') return typeof route.params.sessionId === 'string' ? route.params.sessionId : null
  if (route.name === 'hermes.person') return typeof route.query.session === 'string' ? route.query.session : null
  return null
}

/**
 * Back/Forward and hash links (e.g. notification clicks) to another conversation open it
 * intentionally, like selecting it. History listeners only see these traversals, at the moment the
 * user acts. Programmatic pushes and replacements, the page's initial route and refreshes stay
 * passive; explicit selections call `acknowledge` themselves.
 */
export function trackSessionOpens(router: Router) {
  router.options.history.listen(to => {
    const sessionId = routedSessionId(router.resolve(to))
    if (sessionId && sessionId !== routedSessionId(router.currentRoute.value)) useSessionStateStore().acknowledge(sessionId)
  })
}
