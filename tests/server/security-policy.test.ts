import http from 'http'
import Koa from 'koa'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCorsOriginResolver,
  isOriginAllowed,
  parseUpgradeRequestUrl,
  securityHeaders,
  shouldRejectUpgradeOrigin,
  writeBadUpgradeRequest,
} from '../../packages/server/src/modules/studio/middleware/security'

function fakeCtx(origin: string, host: string) {
  return {
    host,
    get(name: string) {
      return name.toLowerCase() === 'origin' ? origin : ''
    },
  } as any
}

describe('server security policy', () => {
  let servers: http.Server[] = []

  afterEach(async () => {
    const closing = servers.map(server => new Promise<void>((resolve) => server.close(() => resolve())))
    servers = []
    await Promise.all(closing)
  })

  it('allows same-host browser origins without enabling wildcard CORS', async () => {
    const resolveOrigin = createCorsOriginResolver('')

    await expect(resolveOrigin(fakeCtx('http://127.0.0.1:8648', '127.0.0.1:8648'))).resolves.toBe('http://127.0.0.1:8648')
    await expect(resolveOrigin(fakeCtx('http://localhost', '192.168.10.102:8647'))).resolves.toBe('')
    await expect(resolveOrigin(fakeCtx('https://evil.example', '127.0.0.1:8648'))).resolves.toBe('')
  })

  it('allows configured origins and explicit wildcard opt-in only', () => {
    expect(isOriginAllowed('https://app.example', '127.0.0.1:8648', 'https://app.example')).toBe(true)
    expect(isOriginAllowed('https://evil.example', '127.0.0.1:8648', 'https://app.example')).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:8648', '')).toBe(false)
    expect(isOriginAllowed('null', '127.0.0.1:8648', '*')).toBe(true)
    expect(isOriginAllowed('https://evil.example', '127.0.0.1:8648', '*')).toBe(true)
  })

  it('rejects disallowed browser websocket upgrade origins', () => {
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'https://evil.example', host: '127.0.0.1:8648' } } as any, '')).toBe(true)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'null', host: '127.0.0.1:8648' } } as any, '')).toBe(true)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'http://127.0.0.1:8648', host: '127.0.0.1:8648' } } as any, '')).toBe(false)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'http://localhost', host: '192.168.10.102:8647' } } as any, '')).toBe(false)
    expect(shouldRejectUpgradeOrigin({ headers: { origin: 'http://localhost:5173', host: '192.168.10.102:8647' } } as any, '')).toBe(false)
    expect(shouldRejectUpgradeOrigin({ headers: { host: '127.0.0.1:8648' } } as any, '')).toBe(false)
  })

  it('rejects malformed websocket upgrade URLs without throwing', () => {
    expect(parseUpgradeRequestUrl({ url: '/socket', headers: { host: '127.0.0.1:8648' } } as any)?.pathname)
      .toBe('/socket')
    expect(parseUpgradeRequestUrl({ url: '/socket', headers: { host: '[' } } as any)).toBeNull()

    const socket = {
      destroyed: false,
      write: vi.fn(),
      destroy: vi.fn(),
    }
    writeBadUpgradeRequest(socket)
    expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    expect(socket.destroy).toHaveBeenCalledOnce()
  })

  it('adds baseline browser security headers', async () => {
    const app = new Koa()
    app.use(securityHeaders())
    app.use((ctx) => {
      ctx.body = { ok: true }
    })
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected tcp server')

    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { 'x-forwarded-proto': 'https' },
    })

    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000')
  })

  async function fetchContentSecurityPolicy(options?: Parameters<typeof securityHeaders>[0]): Promise<string> {
    const app = new Koa()
    app.use(securityHeaders(options))
    app.use((ctx) => {
      ctx.body = { ok: true }
    })
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected tcp server')

    const response = await fetch(`http://127.0.0.1:${address.port}/health`)
    return response.headers.get('content-security-policy') || ''
  }

  function cspDirective(policy: string, name: string): string | undefined {
    return policy.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `))
  }

  it('does not let the browser load remote images by default', async () => {
    const policy = await fetchContentSecurityPolicy()

    expect(cspDirective(policy, 'img-src')).toBe("img-src 'self' data: blob:")
    expect(policy).toContain("default-src 'self'")
    expect(cspDirective(policy, 'connect-src')).toBe("connect-src 'self' http: https: ws: wss:")
  })

  it('re-allows remote https images only when explicitly enabled', async () => {
    const policy = await fetchContentSecurityPolicy({ allowRemoteImages: true })

    expect(cspDirective(policy, 'img-src')).toBe("img-src 'self' data: blob: https:")

    const disabled = await fetchContentSecurityPolicy({ allowRemoteImages: false })
    expect(cspDirective(disabled, 'img-src')).toBe("img-src 'self' data: blob:")
  })

  it('preserves the opener only for the dedicated group chat Agent authorization document', async () => {
    const app = new Koa()
    app.use(securityHeaders())
    app.use((ctx) => {
      ctx.body = '<!doctype html>'
    })
    const server = app.listen(0)
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected tcp server')

    const authorizationDocument = await fetch(
      `http://127.0.0.1:${address.port}/?groupChatAgentLink=1`,
    )
    const unrelatedPath = await fetch(
      `http://127.0.0.1:${address.port}/health?groupChatAgentLink=1`,
    )
    const unrelatedQuery = await fetch(
      `http://127.0.0.1:${address.port}/?groupChatAgentLink=unexpected`,
    )

    expect(authorizationDocument.headers.get('cross-origin-opener-policy')).toBe('unsafe-none')
    expect(unrelatedPath.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
    expect(unrelatedQuery.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
  })
})
