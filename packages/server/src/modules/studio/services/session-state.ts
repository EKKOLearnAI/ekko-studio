import type { Socket } from 'socket.io'
import type { AuthenticatedUser } from '../public/auth'
import { logger } from '../public/logging'
import { listSessionStateRecords, markSessionRead, type SessionStateRecord } from '../repositories/session-state-store'
import type { SessionListState } from '../../../../../shared/session-state'

interface RuntimeState { working: boolean; backgroundPending: number; collaborationPending?: number }
type Subscriber = { socket: Socket; user: AuthenticatedUser }

/** Uses the authenticated chat transport, but never joins transcript rooms. */
export class SessionStateSync {
  private readonly subscribers = new Set<Subscriber>()
  private readonly foreground = new Map<string, boolean>()
  private readonly pending = new Map<string, number>()

  constructor(private readonly runtime: (sessionId: string) => RuntimeState,
    private readonly canAccessProfile: (user: AuthenticatedUser, profile: string) => boolean) {}

  private allowed(user: AuthenticatedUser, session: SessionStateRecord) {
    if (session.id.startsWith('person-main-')) return String(user.id) === String(session.studio_user_id)
    return this.canAccessProfile(user, session.profile || 'default')
  }

  private states(user: AuthenticatedUser, sessionId?: string): SessionListState[] {
    return listSessionStateRecords(user.id, sessionId).filter(session => this.allowed(user, session)).map(session => {
      const runtime = this.runtime(session.id)
      const backgroundPending = this.pending.get(session.id) ?? runtime.backgroundPending
      const working = (this.foreground.get(session.id) ?? runtime.working) || backgroundPending > 0 || (runtime.collaborationPending || 0) > 0
      return { sessionId: session.id, profile: session.profile || 'default', working,
        backgroundPending, lastMessageId: session.lastMessageId, readMessageId: session.readMessageId,
        lastAttentionId: session.lastAttentionId, readAttentionId: session.readAttentionId,
        unread: !working && (session.lastMessageId > session.readMessageId || session.lastAttentionId > session.readAttentionId) }
    })
  }

  attach(socket: Socket) {
    if (socket.data.sessionShare || socket.handshake.query?.session_state !== '1') return
    // Chat auth accepts an anonymous connection only when login is disabled.
    // Keep that installation's ordinary chats in a separate local read scope.
    const user = (socket.data.user as AuthenticatedUser | undefined)
      ?? { id: 0, username: 'local', role: 'super_admin' as const }
    const subscriber = { socket, user }
    this.subscribers.add(subscriber)
    socket.on('disconnect', () => this.subscribers.delete(subscriber))
    socket.on('sessions.state.request', () => this.send(subscriber))
    socket.on('sessions.read', (data: { sessionId?: unknown; messageId?: unknown; attentionId?: unknown }, ack?: (result: { ok: boolean }) => void) => {
      try {
        if (typeof data?.sessionId !== 'string' || !Number.isSafeInteger(data.messageId) || Number(data.messageId) < 0) throw new Error('Invalid read cursor')
        if (data.attentionId != null && (!Number.isSafeInteger(data.attentionId) || Number(data.attentionId) < 0)) throw new Error('Invalid attention cursor')
        const session = listSessionStateRecords(user.id, data.sessionId)[0]
        if (!session || !this.allowed(user, session)) throw new Error('Session not found')
        if (this.states(user, session.id)[0]?.working) throw new Error('Reply is still running')
        markSessionRead(user.id, session.id, Number(data.messageId), Number(data.attentionId || 0))
        this.publish(session.id, user.id)
        if (typeof ack === 'function') ack({ ok: true })
      } catch {
        if (typeof ack === 'function') ack({ ok: false })
      }
    })
    this.send(subscriber)
  }

  private send(subscriber: Subscriber, sessionId?: string) {
    try {
      const sessions = this.states(subscriber.user, sessionId)
      if (!sessionId) subscriber.socket.emit('sessions.state.snapshot', { sessions })
      else {
        const state = sessions.find(state => state.sessionId === sessionId)
        if (state) subscriber.socket.emit('sessions.state.updated', state)
      }
    } catch (error) { logger.warn(error, '[session-state] snapshot unavailable') }
  }

  publish(sessionId?: string, userId?: number) {
    for (const subscriber of this.subscribers) {
      if (userId == null || subscriber.user.id === userId) this.send(subscriber, sessionId)
    }
  }

  observe(event: string, payload: Record<string, any>) {
    const id = payload?.session_id
    if (typeof id !== 'string' || id.startsWith('person-task-') || payload.replayed || payload.restored || payload.background_snapshot) return
    const started = event === 'run.started' || (event === 'session.command' && payload.started === true && !payload.terminal)
    const terminal = ['run.completed', 'run.failed', 'abort.completed'].includes(event) || (event === 'session.command' && payload.terminal === true)
    if (started) this.foreground.set(id, true)
    if (terminal) this.foreground.set(id, Number(payload.queue_remaining || payload.queue_length || 0) > 0)
    if (event === 'run.queued') this.foreground.set(id, this.runtime(id).working || Number(payload.queue_length || 0) > 0)
    if (Number.isSafeInteger(payload.background_pending) && payload.background_pending >= 0) this.pending.set(id, payload.background_pending)
    if (started || terminal || event === 'run.queued' || event === 'session.command' || event === 'message.interim'
      || event === 'delegation.updated' || event === 'subagent.start' || event === 'subagent.complete') {
      if (payload.background_pending == null) this.pending.delete(id)
      this.publish(id)
    }
  }

  refreshPerson(userId: number) {
    // Person task receipts can change without a foreground run or a transcript subscriber.
    for (const id of this.pending.keys()) if (id.startsWith('person-main-')) this.pending.delete(id)
    this.publish(undefined, userId)
  }

  close() { this.subscribers.clear(); this.foreground.clear(); this.pending.clear() }
}
