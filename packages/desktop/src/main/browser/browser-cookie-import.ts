import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { CookiesSetDetails } from 'electron'

const TTL_MS = 5 * 60_000
const MAX_BYTES = 1024 * 1024
const MAX_COOKIES = 1000
const VALIDATION_ERRORS = new Set([
  'Invalid cookie count', 'Invalid cookie', 'Invalid cookie domain',
  'Partitioned cookies are not supported', 'Invalid cookie path',
  'Invalid SameSite', 'SameSite=None requires Secure', 'Invalid or expired cookie',
  'Invalid secure cookie prefix', 'Invalid host cookie prefix', 'Duplicate cookie',
])

export interface CookieImportStatus {
  profileId: string
  managerUrl: string
  token: string
  expiresAt: number
  phase: 'waiting' | 'review'
  domains: string[]
  cookieCount: number
}

/** Convert the extension's transport format without exposing cookie values to the UI. */
export function normalizeImportCookies(input: unknown): CookiesSetDetails[] {
  if (!Array.isArray(input) || !input.length || input.length > MAX_COOKIES) throw new Error('Invalid cookie count')
  const keys = new Set<string>()
  return input.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid cookie')
    const cookie = item as Record<string, unknown>
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
      || cookie.name.length + cookie.value.length > 16_384 || /[\x00-\x1f\x7f;]/.test(cookie.name)
      || /[\x00-\x1f\x7f]/.test(cookie.value)) throw new Error('Invalid cookie')
    if (typeof cookie.domain !== 'string' || !/^\.?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(cookie.domain)
      || cookie.domain.length > 253) throw new Error('Invalid cookie domain')
    // Dropping a partition key would silently turn a partitioned cookie into an unpartitioned one.
    if (cookie.partitionKey !== undefined) throw new Error('Partitioned cookies are not supported')
    const hostname = cookie.domain.replace(/^\./, '').toLowerCase()
    const path = cookie.path === undefined ? '/' : cookie.path
    if (typeof path !== 'string' || !path.startsWith('/') || /[\x00-\x20\x7f?#]/.test(path)) throw new Error('Invalid cookie path')
    const sameSiteValues: Record<string, CookiesSetDetails['sameSite']> = { Strict: 'strict', Lax: 'lax', None: 'no_restriction', unspecified: 'unspecified' }
    const sameSite = Object.hasOwn(sameSiteValues, String(cookie.sameSite)) ? sameSiteValues[String(cookie.sameSite)] : undefined
    if (cookie.sameSite !== undefined && !sameSite) throw new Error('Invalid SameSite')
    const secure = cookie.secure === true
    if (sameSite === 'no_restriction' && !secure) throw new Error('SameSite=None requires Secure')
    const expirationDate = cookie.expires
    if (expirationDate !== undefined && (typeof expirationDate !== 'number' || !Number.isFinite(expirationDate)
      || expirationDate <= Date.now() / 1000)) throw new Error('Invalid or expired cookie')
    const hostOnly = typeof cookie.hostOnly === 'boolean' ? cookie.hostOnly : !cookie.domain.startsWith('.')
    if (cookie.name.startsWith('__Secure-') && !secure) throw new Error('Invalid secure cookie prefix')
    if (cookie.name.startsWith('__Host-') && (!secure || !hostOnly || path !== '/')) throw new Error('Invalid host cookie prefix')
    const url = new URL(`${secure ? 'https' : 'http'}://${hostname}`)
    url.pathname = path
    const key = JSON.stringify([hostname, hostOnly, path, cookie.name])
    if (keys.has(key)) throw new Error('Duplicate cookie')
    keys.add(key)
    return {
      url: url.href, name: cookie.name, value: cookie.value, path,
      ...(hostOnly ? {} : { domain: cookie.domain }),
      secure, httpOnly: cookie.httpOnly === true, sameSite: sameSite || 'unspecified',
      ...(expirationDate === undefined ? {} : { expirationDate: expirationDate as number }),
    }
  })
}

/** Ephemeral loopback receiver. HTTP can only stage; trusted Desktop IPC must approve writes. */
export class BrowserCookieImport {
  private server?: Server
  private status?: CookieImportStatus
  private pending?: CookiesSetDetails[]
  private timer?: NodeJS.Timeout
  private generation = 0

  constructor(private readonly onPending?: () => Promise<{ imported: number; failed: number } | undefined>) {}

  async start(profileId: string, allowedOrigin?: string): Promise<CookieImportStatus> {
    await this.cancel()
    const generation = ++this.generation
    const token = randomBytes(32).toString('hex')
    const server = createServer((req, res) => {
      const reply = (code: number, body: object) => {
        res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      const origin = req.headers.origin || ''
      const address = server.address()
      const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
      if (req.headers.host !== expectedHost || (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || (allowedOrigin !== undefined && origin !== allowedOrigin))) {
        reply(403, { detail: 'Only a Chrome extension on this computer may submit' }); return
      }
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      if (req.url !== '/api/cookie-import-helper/submit') { reply(404, { detail: 'Not found' }); return }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        res.writeHead(204); res.end(); return
      }
      if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        reply(415, { detail: 'Expected JSON POST' }); return
      }
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) {
          if (!res.writableEnded) reply(413, { detail: 'Payload too large' })
          chunks.length = 0
        } else if (!res.writableEnded) chunks.push(chunk)
      })
      req.on('error', () => { chunks.length = 0 })
      req.on('end', async () => {
        if (res.writableEnded) return
        let applying = false
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const current = this.getStatus()
          const supplied = typeof input.token === 'string' ? Buffer.from(input.token) : Buffer.alloc(0)
          const expected = Buffer.from(token)
          if (generation !== this.generation || !current || current.phase !== 'waiting' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
            reply(403, { detail: 'Invalid, expired or already used import code' }); return
          }
          const cookies = normalizeImportCookies(input.cookies)
          this.pending = cookies
          current.phase = 'review'
          current.token = ''
          current.domains = [...new Set(cookies.map(cookie => new URL(cookie.url).hostname))].sort()
          current.cookieCount = cookies.length
          this.status = current
          applying = true
          const result = await this.onPending?.()
          if (result) {
            reply(200, { cookie_count: result.imported, failed: result.failed, status: 'imported' })
            setImmediate(() => { void this.cancel() })
          } else reply(202, { cookie_count: cookies.length, status: 'pending_confirmation' })
        } catch (error) {
          // Only expose fixed messages from our own validator, never raw Electron
          // or filesystem errors, which may contain cookie values.
          const message = error instanceof Error ? error.message : ''
          const reason = applying ? 'Cookie import failed while applying or saving cookies'
            : error instanceof SyntaxError ? 'Invalid JSON payload'
              : VALIDATION_ERRORS.has(message) ? message : 'Invalid cookie payload'
          console.warn(`[desktop-browser] Cookie import ${applying ? 'apply' : 'validation'} failed: ${reason}`)
          reply(applying ? 500 : 400, { detail: reason })
          // Automatic imports reconnect with a fresh capability on each click.
          // Keep manual codes reusable, but release rejected automatic sessions.
          if (allowedOrigin !== undefined || this.status?.phase !== 'waiting') setImmediate(() => { void this.cancel() })
        } finally { chunks.length = 0 }
      })
    })
    server.maxConnections = 8
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    if (generation !== this.generation) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw new Error('Import receiver was cancelled')
    }
    server.on('error', () => { void this.cancel() })
    this.server = server
    const address = server.address()
    if (!address || typeof address === 'string') { await this.cancel(); throw new Error('Import receiver unavailable') }
    this.status = { profileId, managerUrl: `http://127.0.0.1:${address.port}`, token,
      expiresAt: Date.now() + TTL_MS, phase: 'waiting', domains: [], cookieCount: 0 }
    this.timer = setTimeout(() => { void this.cancel() }, TTL_MS)
    this.timer.unref()
    return this.getStatus()!
  }

  getStatus(): CookieImportStatus | null {
    if (!this.status || this.status.expiresAt <= Date.now()) return null
    return { ...this.status, domains: [...this.status.domains] }
  }

  async take(keepReceiver = false): Promise<{ profileId: string; cookies: CookiesSetDetails[] }> {
    const status = this.getStatus()
    if (!status || status.phase !== 'review' || !this.pending) throw new Error('No pending cookie import')
    const result = { profileId: status.profileId, cookies: this.pending }
    if (keepReceiver) { this.status = undefined; this.pending = undefined }
    else await this.cancel()
    return result
  }

  async cancel(): Promise<void> {
    this.generation++
    this.status = undefined
    this.pending = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const server = this.server
    this.server = undefined
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
