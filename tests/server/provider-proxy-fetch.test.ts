import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProvider } from '../../packages/server/src/modules/studio/public/provider-network'
import { AgentRunGateway } from '../../packages/server/src/modules/coding-agents/protocol/gateway'

const cleanup: Array<() => Promise<void>> = []
// Public, test-only certificate. Verification stays enabled; only these local
// connections trust this fixture.
const cert = readFileSync(new URL('../fixtures/provider-tls/cert.pem', import.meta.url))
const key = readFileSync(new URL('../fixtures/provider-tls/key.pem', import.meta.url))

function trustTestCertificate() {
  const connect = tls.connect
  vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) =>
    connect({ ...options, ca: cert })) as typeof tls.connect)
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(close => close()))
  vi.restoreAllMocks()
})

async function serve(handler: http.RequestListener) {
  return listen(http.createServer(handler))
}

async function listen<T extends net.Server>(server: T) {
  const sockets = new Set<net.Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { server, sockets, port: (server.address() as net.AddressInfo).port }
}

async function tunnelTo(port: number, status = 200, secure = false) {
  const requests: http.IncomingMessage[] = []
  let bytes = 0
  const proxy = await listen(secure
    ? https.createServer({ cert, key }, (_req, res) => res.writeHead(405).end())
    : http.createServer((_req, res) => res.writeHead(405).end()))
  proxy.server.on('connect', (req, socket, head) => {
    requests.push(req)
    if (status !== 200) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\n\r\n`)
      return
    }
    const upstream = net.connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.on('data', chunk => { bytes += chunk.length })
      socket.pipe(upstream).pipe(socket)
    })
    socket.on('close', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  })
  return { url: `http://127.0.0.1:${proxy.port}`, requests, bytes: () => bytes }
}

describe('provider proxy fetch', () => {
  it.each(['http/1.1', 'h2'])('negotiates real TLS %s, preserves authority and decompresses responses', async protocol => {
    trustTestCertificate()
    let receivedHeaders: http.IncomingHttpHeaders = {}
    let receivedVersion = ''
    let receivedBody = ''
    const handler = (req: http.IncomingMessage | http2.Http2ServerRequest, res: http.ServerResponse | http2.Http2ServerResponse) => {
      receivedHeaders = req.headers
      receivedVersion = req.httpVersion
      req.on('data', chunk => { receivedBody += chunk.toString() })
      req.on('end', () => {
        res.writeHead(200, { 'content-encoding': 'gzip' })
        res.end(gzipSync('{"ok":true}'))
      })
    }
    const upstream = await listen(protocol === 'h2'
      ? http2.createSecureServer({ cert, key }, handler)
      : https.createServer({ cert, key }, handler))
    const proxy = await tunnelTo(upstream.port)
    const response = await fetchProvider(`https://provider.example:${upstream.port}/v1/responses?test=1`, {
      method: 'POST', headers: { Authorization: 'Bearer test-key', 'X-Route': 'a' }, body: '{"input":"hello"}',
    }, proxy.url)

    expect(await response.json()).toEqual({ ok: true })
    expect(receivedVersion).toBe(protocol === 'h2' ? '2.0' : '1.1')
    expect(receivedHeaders[':authority'] || receivedHeaders.host).toBe(`provider.example:${upstream.port}`)
    expect(receivedHeaders.authorization).toBe('Bearer test-key')
    expect(receivedHeaders['x-route']).toBe('a')
    expect(receivedBody).toBe('{"input":"hello"}')
    expect(response.headers.has('content-encoding')).toBe(false)
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it('supports a verified HTTPS CONNECT proxy', async () => {
    const request = https.request
    vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions) =>
      request({ ...options, ca: cert })) as typeof https.request)
    const upstream = await serve((_req, res) => res.end('ok'))
    const proxy = await tunnelTo(upstream.port, 200, true)
    const response = await fetchProvider('http://provider.example/v1/models', {}, proxy.url.replace('http:', 'https:'))
    expect(await response.text()).toBe('ok')
    expect(proxy.requests).toHaveLength(1)
  })

  it.each(['signal', 'reader'])('releases an HTTP/2 stream and tunnel on %s cancellation', async mode => {
    trustTestCertificate()
    const upstream = await listen(http2.createSecureServer({ cert, key }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
    }))
    const proxy = await tunnelTo(upstream.port)
    const controller = new AbortController()
    const response = await fetchProvider('https://provider.example/v1/responses', { signal: controller.signal }, proxy.url)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
    if (mode === 'reader') await reader.cancel()
    else {
      controller.abort()
      await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    }
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it('does not retry a certificate validation failure', async () => {
    const upstream = await listen(https.createServer({ cert, key }, (_req, res) => res.end('{}')))
    const proxy = await tunnelTo(upstream.port)
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {}, proxyUrl: proxy.url,
    })).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(proxy.requests).toHaveLength(1)
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it('cancels a stalled TLS handshake and releases its tunnel', async () => {
    const upstream = await listen(net.createServer(socket => socket.resume()))
    const proxy = await tunnelTo(upstream.port)
    const controller = new AbortController()
    const pending = fetchProvider('https://provider.example/v1/responses', { signal: controller.signal }, proxy.url)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect.poll(() => upstream.sockets.size).toBe(1)
    controller.abort()
    await rejected
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it.each(['http/1.1', 'h2'])('honors the caller deadline while waiting for %s response headers', async protocol => {
    trustTestCertificate()
    const handler = vi.fn((_req, _res) => {})
    const upstream = await listen(protocol === 'h2'
      ? http2.createSecureServer({ cert, key }, handler)
      : https.createServer({ cert, key }, handler))
    const proxy = await tunnelTo(upstream.port)
    await expect(new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {},
      proxyUrl: proxy.url, signal: AbortSignal.timeout(500),
    })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(handler).toHaveBeenCalledOnce()
    expect(proxy.requests).toHaveLength(1)
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it('does not replay an HTTP/2 request after response headers have arrived', async () => {
    trustTestCertificate()
    const server = http2.createSecureServer({ cert, key })
    server.on('stream', stream => {
      stream.on('error', () => {})
      stream.respond({ ':status': 200, 'content-type': 'application/json' })
      stream.write('{')
      setImmediate(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR))
    })
    const upstream = await listen(server)
    const proxy = await tunnelTo(upstream.port)
    const result = await new AgentRunGateway().completeJson({
      url: 'https://provider.example/v1/responses', apiKey: 'test-key', body: {}, proxyUrl: proxy.url,
    })
    expect(result).toEqual({ error: { message: '{' } })
    expect(proxy.requests).toHaveLength(1)
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it.each(['http/1.1', 'h2'])('closes the tunnel when %s request construction fails', async protocol => {
    trustTestCertificate()
    const handler = vi.fn((_req, res) => res.end('{}'))
    const upstream = await listen(protocol === 'h2'
      ? http2.createSecureServer({ cert, key }, handler)
      : https.createServer({ cert, key }, handler))
    const proxy = await tunnelTo(upstream.port)
    await expect(fetchProvider('https://provider.example/v1/responses', {
      headers: { 'invalid header name': 'invalid' },
    }, proxy.url)).rejects.toThrow()
    expect(handler).not.toHaveBeenCalled()
    await expect.poll(() => upstream.sockets.size).toBe(0)
  })

  it('uses the CONNECT tunnel even when the destination cannot resolve locally', async () => {
    let received: http.IncomingMessage | undefined
    let body = ''
    const upstream = await serve((req, res) => {
      received = req
      req.on('data', chunk => { body += chunk })
      req.on('end', () => res.end('{"ok":true}'))
    })
    const proxy = await tunnelTo(upstream.port)
    const response = await fetchProvider('http://provider.invalid:8080/v1/responses?test=1', {
      method: 'POST', headers: { Authorization: 'Bearer test-key' }, body: '{"text":"hello"}',
    }, proxy.url.replace('http://', 'http://user:p%40ss@'))
    expect(await response.json()).toEqual({ ok: true })
    expect(proxy.requests[0]?.url).toBe('provider.invalid:8080')
    expect(proxy.requests[0]?.headers['proxy-authorization']).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`)
    expect(proxy.bytes()).toBeGreaterThan(0)
    expect(received?.url).toBe('/v1/responses?test=1')
    expect(received?.headers.host).toBe('provider.invalid:8080')
    expect(received?.headers.authorization).toBe('Bearer test-key')
    expect(received?.headers['proxy-authorization']).toBeUndefined()
    expect(body).toBe('{"text":"hello"}')
  })

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ] as const)('decodes %s without leaving stale length headers', async (encoding, compress) => {
    const bytes = compress('{"ok":true}')
    const upstream = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': encoding, 'content-length': bytes.length })
      res.end(bytes)
    })
    const proxy = await tunnelTo(upstream.port)
    const response = await fetchProvider('http://provider.invalid/v1/models', {}, proxy.url)
    expect(await response.text()).toBe('{"ok":true}')
    expect(response.headers.has('content-length')).toBe(false)
  })

  it.each([204, 205, 304])('supports bodyless HTTP %s responses', async status => {
    const upstream = await serve((_req, res) => res.writeHead(status).end())
    const proxy = await tunnelTo(upstream.port)
    const response = await fetchProvider('http://provider.invalid/v1/models', {}, proxy.url)
    expect(response.status).toBe(status)
    expect(response.body).toBeNull()
  })

  it('streams SSE immediately and cancels the upstream socket with the reader', async () => {
    let requestSocket: net.Socket | undefined
    const upstream = await serve((req, res) => {
      requestSocket = req.socket
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
    })
    const proxy = await tunnelTo(upstream.port)
    const response = await fetchProvider('http://provider.invalid/v1/responses', {}, proxy.url)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n')
    const closed = once(requestSocket!, 'close')
    await reader.cancel()
    await closed
  })

  it('rejects CONNECT failures without exposing credentials or retrying', async () => {
    const proxy = await tunnelTo(1, 407)
    const pending = fetchProvider('https://provider.invalid/v1/responses', {}, proxy.url.replace('http://', 'http://user:private-password@'))
    await expect(pending).rejects.toThrow('407')
    await expect(pending).rejects.not.toThrow('private-password')
    expect(proxy.requests).toHaveLength(1)
  })

  it('honors cancellation before opening a socket', async () => {
    const proxy = await tunnelTo(1)
    await expect(fetchProvider('http://provider.invalid/v1/models', {
      signal: AbortSignal.abort(),
    }, proxy.url)).rejects.toMatchObject({ name: 'AbortError' })
    expect(proxy.requests).toHaveLength(0)
  })

  it('honors cancellation while waiting for CONNECT', async () => {
    const proxy = await serve((_req, res) => res.end())
    proxy.server.on('connect', () => {})
    const controller = new AbortController()
    const connected = once(proxy.server, 'connect')
    const pending = fetchProvider('https://provider.invalid/v1/models', {
      signal: controller.signal,
    }, `http://127.0.0.1:${proxy.port}`)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await connected
    controller.abort()
    await rejection
  })
})
