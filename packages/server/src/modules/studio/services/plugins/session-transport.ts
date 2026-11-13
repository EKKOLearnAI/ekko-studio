import { io, type Socket } from 'socket.io-client'
import type { HostSession, Json, SessionEvent, SessionListener } from '../../contracts/plugins'
import { json } from './schema'

/** Adapts the existing chat protocol without implementing another run lifecycle. */
export async function connectPluginSession(options: {
  baseUrl: string; sessionId: string; profile: string; signal: AbortSignal
  token(): Promise<string>; listener: SessionListener
}): Promise<HostSession> {
  const { sessionId, profile, signal, listener } = options
  signal.throwIfAborted()
  let closed = false
  let failOpening: (error: Error) => void = () => {}
  const socket: Socket = io(`${options.baseUrl}/chat-run`, {
    autoConnect: false, forceNew: true, transports: ['websocket'], reconnection: true,
    reconnectionDelay: 1000, reconnectionDelayMax: 30_000, query: { profile },
    auth: callback => { void options.token().then(token => callback({ token })).catch(error => {
      publish({ event: 'transport.error', session_id: sessionId, error: 'Session authorization is unavailable' })
      failOpening(error instanceof Error ? error : new Error('Session authorization is unavailable')); close()
    }) },
  })
  const publish = (event: SessionEvent) => { if (!closed && !signal.aborted) listener(event) }
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    socket.removeAllListeners(); socket.offAny(); socket.disconnect()
  }
  signal.addEventListener('abort', close, { once: true })
  socket.onAny((event: string, value: unknown) => {
    if (!value || typeof value !== 'object' || (value as { session_id?: string }).session_id !== sessionId) return
    try { publish(json({ ...value, event, session_id: sessionId }) as SessionEvent) }
    catch { publish({ event: 'transport.error', session_id: sessionId, error: 'Session event could not be delivered within the SDK JSON limit; reload its snapshot.' }) }
  })
  socket.on('connect', () => {
    publish({ event: 'transport.connected', session_id: sessionId })
    socket.emit('resume', { session_id: sessionId, profile })
  })
  socket.on('disconnect', reason => publish({ event: 'transport.disconnected', session_id: sessionId, reason }))
  try {
    await new Promise<void>((resolve, reject) => {
      failOpening = error => finish(error)
      const timer = setTimeout(() => finish(new Error('Session connection timed out')), 15_000)
      const abort = () => finish(signal.reason || new Error('Session connection cancelled'))
      const connected = () => finish()
      const failed = (error: Error) => finish(error)
      function finish(error?: Error) {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        socket.off('connect', connected); socket.off('connect_error', failed)
        if (error) reject(error); else resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
      socket.once('connect', connected); socket.once('connect_error', failed)
      socket.connect()
    })
  } catch (error) { close(); throw error }
  const command = async (event: string, payload: Record<string, Json> = {}) => {
    signal.throwIfAborted()
    if (closed || !socket.connected) throw new Error('Session transport is disconnected; wait for restoration before sending commands')
    socket.emit(event, json({ ...payload, session_id: sessionId, profile }))
  }
  return {
    sessionId, run: (input, extra = {}) => command('run', { ...extra, input }),
    stop: () => command('abort'), resume: () => command('resume'), close,
    queue: { insert: queueId => command('insert_queued_run', { queue_id: queueId }), cancel: queueId => command('cancel_queued_run', { queue_id: queueId }) },
    interactions: {
      approve: (approvalId, choice) => command('approval.respond', { approval_id: approvalId, choice }),
      clarify: (clarifyId, response) => command('clarify.respond', { clarify_id: clarifyId, response }),
    },
  }
}
