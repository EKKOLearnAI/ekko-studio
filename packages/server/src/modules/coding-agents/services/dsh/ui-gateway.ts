import { randomBytes } from 'node:crypto'
import { Readable, type Duplex } from 'node:stream'
import { request as httpRequest, type Server, type IncomingMessage } from 'node:http'
import type { Context, Next } from 'koa'
import { authenticateUserToken } from '../../../studio/public/auth'
import { DshPluginError } from './errors'
import { DshManagement, type DshUiTarget } from './management'
import { dshUiDocument } from './ui-slot'

const PREFIX = '/api/coding-agents/dsh/ui/'
interface Frame { target: DshUiTarget; userToken: string; expires: number; connections: Set<Duplex> }

/** Authenticated, fixed-target native HTTP/SSE transport. Never a URL proxy.
 * Browser tickets cannot authorize any Studio API and contain no DSH cookie. */
export class DshUiGateway {
  private frames = new Map<string, Frame>()
  constructor(private management: DshManagement) {}
  async create(userToken: string) {
    const user = await authenticateUserToken(userToken)
    if (user?.role !== 'super_admin') throw new DshPluginError(403, 'DSH_UI_FORBIDDEN', 'Super administrator required')
    for (const [id, frame] of this.frames) if (frame.expires < Date.now()) this.remove(id, frame.userToken)
    if (this.frames.size >= 32) throw new DshPluginError(409, 'DSH_UI_BUSY', 'Close an existing DSH configuration panel')
    const target = await this.management.open()
    const id = randomBytes(24).toString('hex')
    this.frames.set(id, { target, userToken, expires: Date.now() + 2 * 60 * 60_000, connections: new Set() })
    return { id, path: `${PREFIX}${id}/` }
  }
  remove(id: string, userToken: string) {
    const frame = this.frames.get(id)
    if (frame?.userToken !== userToken) return
    this.frames.delete(id)
    for (const connection of frame.connections) connection.destroy()
  }
  handlesUpgrade(req: IncomingMessage) { return (req.url || '').startsWith(PREFIX) }
  attach(servers: Server[]) {
    const tunnels = new Set<Duplex>()
    const upgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!this.handlesUpgrade(req)) return
      const reject = () => { if (!socket.destroyed) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy() } }
      try {
        const url = new URL(req.url!, 'http://studio.invalid')
        const match = url.pathname.slice(PREFIX.length).match(/^([a-f0-9]{48})\/(.*)$/)
        const frame = match ? this.frames.get(match[1]) : undefined
        if (!frame || frame.expires < Date.now() || (await authenticateUserToken(frame.userToken))?.role !== 'super_admin') return reject()
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return reject()
        this.management.touch(frame.target.generation)
        const headers: Record<string, string> = { connection: 'Upgrade', upgrade: 'websocket', cookie: frame.target.cookie, origin: frame.target.endpoint }
        for (const key of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
          if (typeof req.headers[key] === 'string') headers[key] = req.headers[key]!
        }
        const revalidate = setInterval(() => {
          void authenticateUserToken(frame.userToken).then(user => { if (frame.expires < Date.now() || user?.role !== 'super_admin' || !this.frames.has(match![1])) socket.destroy() }).catch(() => socket.destroy())
        }, 60_000)
        revalidate.unref()
        frame.connections.add(socket)
        socket.once('close', () => { clearInterval(revalidate); frame.connections.delete(socket) })
        const upstream = httpRequest(frame.target.endpoint + '/' + match![2] + url.search, { headers })
        const timer = setTimeout(() => { upstream.destroy(); reject() }, 10_000)
        socket.once('close', () => { clearTimeout(timer); upstream.destroy(); tunnels.delete(socket) })
        upstream.once('error', reject); upstream.once('response', response => { response.resume(); reject() })
        upstream.once('upgrade', (response, peer, upstreamHead) => {
          clearTimeout(timer)
          if (socket.destroyed) { peer.destroy(); return }
          const lines = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket']
          for (const key of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
            const value = response.headers[key]; if (typeof value === 'string') lines.push(key + ': ' + value)
          }
          socket.write(lines.join('\r\n') + '\r\n\r\n')
          if (upstreamHead.length) socket.write(upstreamHead)
          if (head.length) peer.write(head)
          tunnels.add(socket); tunnels.add(peer)
          peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy())
          peer.once('close', () => { socket.destroy(); tunnels.delete(peer) })
          socket.once('close', () => peer.destroy())
          socket.pipe(peer); peer.pipe(socket)
        })
        upstream.end()
      } catch { reject() }
    }
    for (const server of servers) server.on('upgrade', upgrade)
    return () => { for (const server of servers) server.off('upgrade', upgrade); for (const socket of tunnels) socket.destroy() }
  }
  middleware = async (ctx: Context, next: Next) => {
    if (!ctx.path.startsWith(PREFIX)) return next()
    const match = ctx.path.slice(PREFIX.length).match(/^([a-f0-9]{48})\/(.*)$/)
    const frame = match ? this.frames.get(match[1]) : undefined
    ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer')
    ctx.set('X-Frame-Options', 'SAMEORIGIN')
    ctx.set('Content-Security-Policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' http: https: ws: wss:")
    if (!frame || frame.expires < Date.now() || (await authenticateUserToken(frame.userToken))?.role !== 'super_admin') {
      ctx.status = 401; ctx.body = 'DSH configuration session expired'; return
    }
    if (ctx.get('Origin')) {
      try { if (new URL(ctx.get('Origin')).host !== ctx.host) { ctx.status = 403; return } }
      catch { ctx.status = 403; return }
    }
    const mount = `${PREFIX}${match![1]}/`
    try {
      this.management.touch(frame.target.generation)
      if (match![2] === '__studio_ping' && ctx.method === 'GET') { ctx.status = 204; return }
      const nativePath = '/' + match![2] + ctx.search
      const headers = new Headers({ cookie: frame.target.cookie, origin: frame.target.endpoint })
      for (const name of ['content-type', 'accept', 'last-event-id', 'range', 'if-none-match', 'if-modified-since']) {
        const value = ctx.get(name); if (value) headers.set(name, value)
      }
      const abort = new AbortController()
      const disconnected = () => abort.abort()
      ctx.res.once('close', disconnected)
      try {
        const response = await fetch(frame.target.endpoint + nativePath, {
          method: ctx.method, headers, redirect: 'manual', signal: abort.signal,
          ...(['GET', 'HEAD'].includes(ctx.method) ? {} : { body: Readable.toWeb(ctx.req), duplex: 'half' }),
        } as RequestInit)
        ctx.status = response.status
        for (const name of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
          const value = response.headers.get(name); if (value) ctx.set(name, value)
        }
        const location = response.headers.get('location')
        if (location) {
          const url = new URL(location, frame.target.endpoint)
          if (url.origin !== frame.target.endpoint) throw new Error('Unsupported native redirect')
          ctx.set('Location', mount + url.pathname.slice(1) + url.search + url.hash)
        }
        if (match![2] === '' && response.headers.get('content-type')?.includes('text/html')) {
          ctx.body = dshUiDocument(await response.text(), mount)
        } else if (response.body) ctx.body = Readable.fromWeb(response.body as any)
      } catch (error) { abort.abort(); throw error }
    } catch (error) {
      ctx.status = error instanceof DshPluginError ? error.status : 502
      ctx.body = 'DSH configuration runtime unavailable; refresh the panel'
    }
  }
}
