import type { Socket } from 'socket.io'
import { SessionShareError } from '../../contracts/session-shares'
import { prepareSessionShareRun, refreshSessionShare, watchSessionShare, type SessionShareAccess } from './access'

const READ_EVENTS = new Set(['resume', 'app.resume'])
const INPUT_EVENTS = new Set(['run', 'abort', 'insert_queued_run', 'cancel_queued_run', 'approval.respond', 'clarify.respond'])

export function bindSessionShareSocket(socket: Socket, access: SessionShareAccess, invalidate: () => void) {
  socket.join('session-share')
  socket.use(([event, data, ack], next) => {
    void (async () => {
      if (!READ_EVENTS.has(event) && !INPUT_EVENTS.has(event)) throw new SessionShareError('share_event_forbidden')
      if (!data || typeof data !== 'object' || typeof data.session_id !== 'string') throw new SessionShareError('share_session_required', 400)
      await refreshSessionShare(access, READ_EVENTS.has(event) ? 'read' : 'input', data.session_id)
      if (!socket.connected) throw new SessionShareError('share_disconnected')
      if (event === 'run') prepareSessionShareRun(access, data)
      next()
    })().catch(error => {
      const code = error instanceof SessionShareError ? error.code : 'share_access_denied'
      if (typeof ack === 'function') ack({ ok: false, error: code })
      socket.emit('run.failed', { event: 'run.failed', session_id: access.share.session_id, error: code })
      // Not calling next is deliberate: forbidden packets never reach business handlers.
    })
  })
  const dispose = watchSessionShare(access, 'read', () => {
    socket.emit('share.revoked', { session_id: access.share.session_id })
    socket.disconnect(true)
    // Finish disconnecting every invalidated observer before broadcasting queue changes.
    queueMicrotask(invalidate)
  })
  socket.once('disconnect', dispose)
}
