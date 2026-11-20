import type { Socket } from 'socket.io'
import { authenticateUserToken, type AuthenticatedUser } from '../public/auth'
import { logger } from '../public/logging'
import { onUserAccessChanged } from '../repositories/user-access-updates'

export const isAccountPendingInbox = (socket: Socket) => socket.handshake.query?.pending_interactions === 'account'

type Delivery<T> = (event: T, visible: (user: AuthenticatedUser) => boolean) => void

/** Read-only shell subscription. Preserve event order while checking the login and its current grants. */
export class AccountPendingInbox<T> {
  private readonly subscribers = new Set<Delivery<T>>()

  attach(socket: Socket, snapshot: (user: AuthenticatedUser) => T[]) {
    if (!socket.data.user || socket.data.sessionShare) return
    const accountId = socket.data.user.id
    const token = String(socket.handshake.auth?.token || '')
    let queued = Promise.resolve()
    const send = (deliver: (user: AuthenticatedUser) => void) => {
      queued = queued.then(async () => {
        if (!socket.connected) return
        const user = await authenticateUserToken(token)
        if (!socket.connected) return
        if (!user || user.id !== accountId) {
          socket.emit('pending.interactions.snapshot', { events: [] })
          socket.disconnect()
          return
        }
        deliver(user)
      }).catch(error => logger.warn(error, '[pending-inbox] could not deliver to account %s', accountId))
    }
    const refresh = () => send(user => socket.emit('pending.interactions.snapshot', { events: snapshot(user) }))
    const publish: Delivery<T> = (event, visible) => send(user => {
      if (visible(user)) socket.emit('pending.interaction', event)
    })
    this.subscribers.add(publish)
    const stop = onUserAccessChanged(accountId, refresh)
    socket.on('disconnect', () => {
      stop()
      this.subscribers.delete(publish)
    })
    refresh()
  }

  publish(event: T, visible: (user: AuthenticatedUser) => boolean) {
    for (const deliver of this.subscribers) deliver(event, visible)
  }
}
