import { io } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import { socketEndpoint } from '@/utils/deployment-url'
import type { SessionEvent } from '../../../../plugin-sdk/src'

/** One frame owns this bridge; closing it releases only its subscriptions. */
export function createPluginSessionBridge(profile: string, pluginId: string, signal: AbortSignal, deliver: (id: string, event: SessionEvent) => void) {
  const endpoint = socketEndpoint(getBaseUrlValue(), '/plugins')
  const socket = io(endpoint.url, { autoConnect: false, forceNew: true, path: endpoint.path,
    auth: callback => callback({ token: getApiKey(), profile }), transports: ['websocket', 'polling'], reconnection: true })
  const subscriptions = new Map<string, { id: string; sessionId: string; kind: string }>()
  const pending = new Set<(error: Error) => void>()
  signal.addEventListener('abort', () => {
    for (const reject of pending) reject(new Error('Plugin page closed'))
    pending.clear(); subscriptions.clear(); socket.removeAllListeners(); socket.disconnect()
  }, { once: true })
  socket.on('session.event', ({ id, event }) => { if (!signal.aborted && subscriptions.has(id)) deliver(id, event) })
  const request = async (event: string, input: unknown) => {
    signal.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { pending.delete(fail); reject(error) }
      pending.add(fail)
      socket.timeout(30_000).emit(event, input, (error: Error | null, response: { error?: string } | undefined) => {
        pending.delete(fail)
        if (signal.aborted) return reject(new Error('Plugin page closed'))
        if (error || !response || response.error) reject(error || new Error(response?.error || 'Invalid session bridge response'))
        else resolve()
      })
    })
  }
  let connectedOnce = false
  socket.on('connect', () => {
    if (connectedOnce) for (const input of subscriptions.values()) void request('session.open', { ...input, pluginId }).catch(error => deliver(input.id, { event: 'transport.error', session_id: input.sessionId, error: String(error) }))
    connectedOnce = true
  })
  socket.on('disconnect', reason => { for (const input of subscriptions.values()) deliver(input.id, { event: 'transport.disconnected', session_id: input.sessionId, reason }) })
  return async (operation: string, args: { id: string; sessionId: string; kind: string; method?: string; args?: unknown }) => {
    signal.throwIfAborted()
    if (operation === 'session-open') {
      subscriptions.set(args.id, { id: args.id, sessionId: args.sessionId, kind: args.kind })
      socket.connect()
      try { await request('session.open', { id: args.id, sessionId: args.sessionId, kind: args.kind, pluginId }) }
      catch (error) {
        subscriptions.delete(args.id)
        if (socket.connected && !signal.aborted) void request('session.close', { id: args.id }).catch(() => {})
        throw error
      }
    } else if (operation === 'session-close') {
      subscriptions.delete(args.id)
      if (socket.connected) await request('session.close', { id: args.id })
    } else {
      if (!socket.connected) throw new Error('Session bridge is disconnected; wait for restoration before sending commands')
      await request('session.command', { id: args.id, method: args.method, args: args.args })
    }
    return null
  }
}
