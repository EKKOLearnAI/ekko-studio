import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../public/auth'
import { logger } from '../public/logging'
import { personPresenceSnapshot, recordPersonActivity, clearPersonPresenceRuntime, type PersonPresenceSnapshot } from '../services/person/presence'
import { onPersonUpdated } from '../repositories/person-updates'

/** Account scope is independent of the model Profile and the visible conversation. */
export class PersonPresenceSocketServer {
  private readonly nsp: ReturnType<Server['of']>
  private readonly subscribers = new Map<number, Set<Socket>>()
  private readonly published = new Map<number, string>()
  private readonly lastWrites = new Map<number, number>()
  private readonly boundaries = new Map<number, ReturnType<typeof setTimeout>>()
  private stopUpdates?: () => void
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private closed = false

  constructor(io: Server) { this.nsp = io.of('/person-presence') }

  init(): void {
    this.nsp.use(async (socket, next) => {
      try {
        const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
        if (!user) return next(new Error('Studio login is required'))
        socket.data.user = user
        next()
      } catch { next(new Error('Authentication failed')) }
    })
    this.nsp.on('connection', socket => this.connect(socket))
    this.stopUpdates = onPersonUpdated(userId => {
      if (!this.closed && this.subscribers.has(userId)) {
        try { this.publish(userId) }
        catch (error) { logger.warn(error, '[person-presence] update unavailable') }
      }
    })
    // Server time drives sleep even when every browser is backgrounded. Poll only connected accounts.
    this.timer = setInterval(() => void this.refresh(), 1000)
    this.timer.unref?.()
  }

  private connect(socket: Socket): void {
    const userId = Number(socket.data.user.id)
    let sockets = this.subscribers.get(userId)
    if (!sockets) { sockets = new Set(); this.subscribers.set(userId, sockets) }
    sockets.add(socket)
    socket.join(`person-presence:${userId}`)
    try {
      const snapshot = personPresenceSnapshot(userId)
      socket.emit('person.presence', snapshot)
      this.scheduleBoundary(userId, snapshot)
    }
    catch (error) { logger.warn(error, '[person-presence] snapshot unavailable') }
    socket.on('person.activity', () => {
      // Neither an account id nor a client clock is accepted from the payload.
      if (Date.now() - (this.lastWrites.get(userId) ?? -Infinity) < 500) return
      this.lastWrites.set(userId, Date.now())
      void this.activity(socket, userId)
    })
    socket.on('disconnect', () => {
      sockets!.delete(socket)
      if (!sockets!.size) {
        this.subscribers.delete(userId); this.published.delete(userId); this.lastWrites.delete(userId)
        clearTimeout(this.boundaries.get(userId)); this.boundaries.delete(userId)
      }
    })
  }

  private async authorized(socket: Socket, userId: number): Promise<boolean> {
    const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
    if (this.closed || !socket.connected) return false
    if (user?.id === userId) return true
    socket.disconnect(true)
    return false
  }

  private async activity(socket: Socket, userId: number): Promise<void> {
    try {
      if (!await this.authorized(socket, userId)) return
      recordPersonActivity(userId)
      this.publish(userId)
    } catch (error) { logger.warn(error, '[person-presence] activity unavailable') }
  }

  private publish(userId: number): void {
    const snapshot = personPresenceSnapshot(userId)
    const key = JSON.stringify(snapshot)
    if (this.published.get(userId) === key) return
    this.published.set(userId, key)
    this.nsp.to(`person-presence:${userId}`).emit('person.presence', snapshot)
    this.scheduleBoundary(userId, snapshot)
  }

  private scheduleBoundary(userId: number, snapshot: PersonPresenceSnapshot): void {
    clearTimeout(this.boundaries.get(userId)); this.boundaries.delete(userId)
    const deadline = snapshot.feedbackUntil ?? (snapshot.state === 'idle' ? snapshot.sleepAt : undefined)
    if (!deadline || this.closed) return
    const timer = setTimeout(() => {
      this.boundaries.delete(userId)
      if (this.closed || !this.subscribers.has(userId)) return
      try { this.publish(userId) }
      catch (error) { logger.warn(error, '[person-presence] transition unavailable') }
    }, Math.max(1, deadline - Date.now()))
    timer.unref?.()
    this.boundaries.set(userId, timer)
  }

  private async refresh(): Promise<void> {
    if (this.polling || this.closed) return
    this.polling = true
    try {
      for (const [userId, sockets] of this.subscribers) {
        const valid = await Promise.all([...sockets].map(socket => this.authorized(socket, userId)))
        if (!this.closed && valid.some(Boolean)) this.publish(userId)
      }
    } catch (error) { logger.warn(error, '[person-presence] refresh unavailable') }
    finally { this.polling = false }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.stopUpdates?.()
    for (const timer of this.boundaries.values()) clearTimeout(timer)
    this.boundaries.clear()
    this.nsp.disconnectSockets(true)
    this.subscribers.clear(); this.published.clear(); this.lastWrites.clear()
    clearPersonPresenceRuntime()
  }
}
