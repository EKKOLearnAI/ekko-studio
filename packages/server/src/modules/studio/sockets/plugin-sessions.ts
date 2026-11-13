import type { Server } from 'socket.io'
import type { HostSession, Json } from '../contracts/plugins'
import { authenticateUserToken } from '../public/auth'
import { userCanAccessProfile } from '../public/users'
import { getPluginManager, resolvePluginIdentity } from '../services/plugins/host'

/** Authenticated page bridge into the same core session transport used by backend plugins. */
export function registerPluginSessions(io: Server): void {
  const namespace = io.of('/plugins')
  namespace.use(async (socket, next) => {
    const user = await authenticateUserToken(String(socket.handshake.auth?.token || ''))
    const profile = String(socket.handshake.auth?.profile || 'default')
    if (!user || user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile)) return next(new Error('Plugin session access denied'))
    socket.data.user = user; socket.data.profile = profile; next()
  })
  namespace.on('connection', socket => {
    const entries = new Map<string, { controller: AbortController; session?: HostSession }>()
    const close = async (id: string) => {
      const entry = entries.get(id)
      if (!entry) return
      entries.delete(id); entry.controller.abort(); await entry.session?.close()
    }
    socket.on('session.open', async (input, ack) => {
      if (typeof ack !== 'function') return
      let id: string | undefined
      try {
        if (!input || typeof input.id !== 'string' || !/^[\w.-]{1,128}$/.test(input.id) || !['chat', 'bot'].includes(input.kind)) throw new Error('Invalid session subscription')
        const subscriptionId = String(input.id)
        if (entries.has(subscriptionId) || entries.size >= 64) throw new Error('Session subscription already exists or capacity reached')
        id = subscriptionId
        const controller = new AbortController(), entry: { controller: AbortController; session?: HostSession } = { controller }
        entries.set(subscriptionId, entry)
        const who = resolvePluginIdentity({ userId: socket.data.user.id, profile: socket.data.profile, sessionId: input.sessionId, surface: 'ui' })
        const runtime = getPluginManager().runtime(who, input.pluginId)
        runtime.effects.controller.signal.addEventListener('abort', () => { void close(input.id); socket.emit('session.event', { id: input.id, event: { event: 'transport.closed', session_id: input.sessionId } }) }, { once: true, signal: controller.signal })
        entry.session = await runtime.connectSession(who, controller.signal, input.sessionId,
          event => { if (!controller.signal.aborted && socket.connected) socket.emit('session.event', { id: input.id, event }) }, input.kind)
        if (controller.signal.aborted || !socket.connected) { await entry.session.close(); throw new Error('Session subscription closed') }
        ack({ ok: true })
      } catch (error) { if (id) await close(id); ack({ error: error instanceof Error ? error.message : String(error) }) }
    })
    socket.on('session.command', async (input, ack) => {
      if (typeof ack !== 'function') return
      try {
        const session = entries.get(input?.id)?.session
        if (!session) throw new Error('Session subscription is unavailable')
        const args = input.args || {}
        const text = (key: string) => { if (typeof args[key] !== 'string') throw new Error(`Expected ${key}`); return args[key] as string }
        switch (input.method) {
          case 'run': await session.run(args.input as string | Record<string, Json>[], args.options); break
          case 'stop': await session.stop(); break
          case 'resume': await session.resume(); break
          case 'queue.insert': await session.queue.insert(text('queueId')); break
          case 'queue.cancel': await session.queue.cancel(text('queueId')); break
          case 'approval.respond': await session.interactions.approve(text('approvalId'), text('choice')); break
          case 'clarify.respond': await session.interactions.clarify(text('clarifyId'), text('response')); break
          default: throw new Error('Unsupported session command')
        }
        ack({ ok: true })
      } catch (error) { ack({ error: error instanceof Error ? error.message : String(error) }) }
    })
    socket.on('session.close', async (input, ack) => {
      await close(input?.id)
      if (typeof ack === 'function') ack({ ok: true })
    })
    socket.once('disconnect', () => { for (const id of entries.keys()) void close(id) })
  })
}
