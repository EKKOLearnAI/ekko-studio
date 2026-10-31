import type { Context, Middleware } from 'koa'
import type { IncomingMessage } from 'http'

interface CorsPolicy {
  allowAll: boolean
  allowedOrigins: Set<string>
}

function normalizeOrigin(origin: string | undefined | null): string | null {
  const value = String(origin || '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function normalizeHost(host: string | undefined | null): string {
  return String(host || '').trim().toLowerCase()
}

function parseCorsPolicy(corsOrigins: string | undefined): CorsPolicy {
  const value = String(corsOrigins || '').trim()
  if (!value) return { allowAll: false, allowedOrigins: new Set() }

  const tokens = value.split(/[\s,]+/).map(token => token.trim()).filter(Boolean)
  if (tokens.includes('*')) return { allowAll: true, allowedOrigins: new Set() }

  const allowedOrigins = new Set<string>()
  for (const token of tokens) {
    const normalized = normalizeOrigin(token)
    if (normalized) allowedOrigins.add(normalized)
  }
  return { allowAll: false, allowedOrigins }
}

function isSameHostOrigin(origin: string, host: string): boolean {
  const requestHost = normalizeHost(host)
  if (!requestHost) return false
  try {
    const parsed = new URL(origin)
    return parsed.host.toLowerCase() === requestHost
  } catch {
    return false
  }
}

function isLocalAppDevelopmentOrigin(origin: string | undefined | null): boolean {
  const normalized = normalizeOrigin(origin)
  if (!normalized) return false
  // App-Plus' native uni.connectSocket client sends this fixed Origin for
  // LAN WebSocket upgrades. Keep it scoped to Socket.IO/upgrade checks; the
  // regular HTTP CORS resolver intentionally does not call this helper.
  if (normalized === 'http://localhost') return true
  try {
    const url = new URL(normalized)
    const hostname = url.hostname.toLowerCase()
    return url.port === '5173' && (
      hostname === 'localhost'
      || hostname === '127.0.0.1'
      || hostname === '[::1]'
      || hostname === '::1'
    )
  } catch {
    return false
  }
}

export function isOriginAllowed(origin: string | undefined | null, host: string | undefined | null, corsOrigins = ''): boolean {
  const originValue = String(origin || '').trim()
  if (!originValue) return true

  const policy = parseCorsPolicy(corsOrigins)
  const normalizedOrigin = normalizeOrigin(originValue)
  if (!normalizedOrigin) return policy.allowAll

  if (policy.allowAll) return true
  if (policy.allowedOrigins.has(normalizedOrigin)) return true
  return isSameHostOrigin(normalizedOrigin, String(host || ''))
}

export function createCorsOriginResolver(corsOrigins = '') {
  return async (ctx: Context): Promise<string> => {
    const origin = ctx.get('Origin')
    if (!origin) return ''
    if (!isOriginAllowed(origin, ctx.host, corsOrigins)) return ''
    return normalizeOrigin(origin) || ''
  }
}

export function createSocketIoCorsOrigin(corsOrigins = '') {
  return (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void): void => {
    if (!origin) {
      callback(null, true)
      return
    }
    callback(null, isOriginAllowed(origin, '', corsOrigins) || isLocalAppDevelopmentOrigin(origin))
  }
}

export function shouldRejectUpgradeOrigin(req: IncomingMessage, corsOrigins = ''): boolean {
  const origin = req.headers.origin
  if (!origin) return false
  const selectedOrigin = Array.isArray(origin) ? origin[0] : origin
  return !isOriginAllowed(selectedOrigin, req.headers.host, corsOrigins)
    && !isLocalAppDevelopmentOrigin(selectedOrigin)
}

export function parseUpgradeRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url || '', `http://${req.headers.host}`)
  } catch {
    return null
  }
}

export function writeBadUpgradeRequest(socket: {
  destroyed?: boolean
  write: (chunk: string) => void
  destroy: () => void
}): void {
  if (socket.destroyed) return
  try {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  } finally {
    socket.destroy()
  }
}

export function writeForbiddenOrigin(socket: { write: (chunk: string) => void; destroy: () => void }): void {
  socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
  socket.destroy()
}

function isHttpsRequest(ctx: Context): boolean {
  if (ctx.secure) return true
  const forwardedProto = ctx.get('x-forwarded-proto').split(',')[0]?.trim().toLowerCase()
  return forwardedProto === 'https'
}

function isGroupChatAgentLinkDocument(ctx: Context): boolean {
  return ctx.method === 'GET'
    && ctx.path === '/'
    && ctx.query.groupChatAgentLink === '1'
}

export interface SecurityHeadersOptions {
  /** Add `https:` to CSP `img-src` so the browser may load remote images. Default: off. */
  allowRemoteImages?: boolean
}

export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  // Rendered chat markdown can contain `![](https://...)`. The browser would fetch
  // that URL without a click, so remote images are opt-in rather than the default.
  const imgSrc = options.allowRemoteImages
    ? "img-src 'self' data: blob: https:"
    : "img-src 'self' data: blob:"

  return async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('X-Frame-Options', 'DENY')
    ctx.set('Referrer-Policy', 'no-referrer')
    ctx.set(
      'Cross-Origin-Opener-Policy',
      isGroupChatAgentLinkDocument(ctx) ? 'unsafe-none' : 'same-origin-allow-popups',
    )
    ctx.set('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      imgSrc,
      "font-src 'self' data:",
      "media-src 'self' data: blob:",
      "connect-src 'self' http: https: ws: wss:",
      "form-action 'self'",
    ].join('; '))

    if (isHttpsRequest(ctx)) {
      ctx.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }

    await next()
  }
}
