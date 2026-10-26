import type { Server, Socket } from 'socket.io'
import { authenticateUserToken } from '../public/auth'
import { userCanAccessProfile } from '../public/users'
import { desktopBrowserRelays } from '../services/browser/desktop-relay'

export function registerDesktopBrowserRelay(io: Server): void {
  const namespace = io.of('/desktop-browser')
  namespace.use(async (socket, next) => {
    const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
    const profile = String(socket.handshake.auth?.profile || 'default').trim()
    // Unlike ordinary chat, browser sharing always requires an identified account.
    if (!user || !profile || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile))) {
      next(new Error('Desktop browser authentication/profile access denied'))
      return
    }
    socket.data.user = user
    socket.data.profile = profile
    next()
  })
  namespace.on('connection', (socket: Socket) => {
    const release = desktopBrowserRelays.register({
      id: socket.id, userId: socket.data.user.id, profile: socket.data.profile,
      revoke: () => { socket.emit('browser.revoked') },
      ownerState: state => { socket.emit('browser.owner-state', state) },
      request: async body => {
        const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
        if (!user || user.id !== socket.data.user.id ||
          (user.role !== 'super_admin' && !userCanAccessProfile(user.id, socket.data.profile))) {
          socket.disconnect(true)
          throw new Error('Desktop browser authorization expired')
        }
        const reply = await socket.timeout(300_000).emitWithAck('browser.request', body)
        if (!reply || typeof reply !== 'object' || reply.error) throw new Error(String(reply?.error || 'Invalid Desktop browser response'))
        return reply.envelope
      },
    })
    let lastActivity = 0
    socket.on('browser.user-activity', () => {
      const now = Date.now()
      if (now - lastActivity < 1000) return
      lastActivity = now
      desktopBrowserRelays.activity(socket.id)
    })
    socket.once('disconnect', release)
  })
}
