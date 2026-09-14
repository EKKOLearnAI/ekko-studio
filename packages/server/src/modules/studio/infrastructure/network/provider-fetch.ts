import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { normalizeProviderProxyUrl } from '../../contracts/provider-request-options'

export interface ProviderFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  redirect?: RequestRedirect
}

const CONNECT_TIMEOUT_MS = 15_000
const TLS_TIMEOUT_MS = 20_000
const RESPONSE_TIMEOUT_MS = 120_000
const CONNECT_CODES = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_TLSV13_ALERT_HANDSHAKE_FAILURE',
])

class ProviderConnectError extends Error {}

function connectFailure(error: unknown): Error {
  if (error instanceof Error && (error.name === 'AbortError' || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String((error as NodeJS.ErrnoException).code)))) {
    return error
  }
  return new ProviderConnectError('Provider proxy connection failed', { cause: error })
}

export function isRetriableProviderConnectFailure(error: unknown): boolean {
  if (error instanceof ProviderConnectError) return true
  let current = error as { code?: unknown; cause?: unknown } | undefined
  for (let depth = 0; current && depth < 4; depth += 1) {
    if (typeof current.code === 'string' && CONNECT_CODES.has(current.code)) return true
    current = current.cause as typeof current
  }
  return false
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

function openTunnel(target: URL, proxy: URL, signal?: AbortSignal): Promise<net.Socket> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`
    const headers: Record<string, string> = { Host: authority }
    if (proxy.username || proxy.password) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
    }
    const client = proxy.protocol === 'https:' ? https : http
    const request = client.request({
      hostname: hostname(proxy), port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: authority, headers, agent: false,
      maxHeaderSize: 16_384, signal,
    })
    let settled = false
    const timer = setTimeout(() => request.destroy(new ProviderConnectError('Proxy CONNECT timed out')), CONNECT_TIMEOUT_MS)
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(signal?.aborted ? signal.reason : connectFailure(error))
    }
    request.once('error', fail)
    request.once('close', () => fail(new ProviderConnectError('Proxy closed before CONNECT completed')))
    request.once('connect', (response, socket, head) => {
      if (settled) {
        socket.destroy()
        return
      }
      settled = true
      clearTimeout(timer)
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`Proxy refused CONNECT (HTTP ${response.statusCode || 502})`))
        return
      }
      if (signal?.aborted) {
        socket.destroy()
        reject(signal.reason)
        return
      }
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    request.end()
  })
}

async function secureTunnel(raw: net.Socket, target: URL, signal?: AbortSignal): Promise<tls.TLSSocket> {
  if (signal?.aborted) {
    raw.destroy()
    signal.throwIfAborted()
  }
  return new Promise((resolve, reject) => {
    const host = hostname(target)
    const socket = tls.connect({
      socket: raw, host, servername: net.isIP(host) ? undefined : host,
      ALPNProtocols: ['h2', 'http/1.1'],
    })
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(signal?.aborted ? signal.reason : connectFailure(error))
    }
    const onAbort = () => fail(signal!.reason)
    const timer = setTimeout(() => fail(new ProviderConnectError('Provider TLS handshake timed out')), TLS_TIMEOUT_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('error', fail)
    socket.once('close', () => fail(new ProviderConnectError('Provider closed during TLS handshake')))
    socket.once('secureConnect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    })
  })
}

function toResponse(status: number, headers: http.IncomingHttpHeaders, stream: Readable, method?: string): Response {
  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || value === undefined) continue
    for (const item of Array.isArray(value) ? value : [String(value)]) normalized.append(name, item)
  }
  if (method === 'HEAD' || [204, 205, 304].includes(status)) {
    stream.resume()
    return new Response(null, { status, headers: normalized })
  }
  const encoding = normalized.get('content-encoding')?.toLowerCase()
  const decoder = encoding === 'gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress() : undefined
  let body = stream
  if (decoder) {
    pipeline(stream, decoder, () => {})
    body = decoder
    normalized.delete('content-encoding')
    normalized.delete('content-length')
  }
  return new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: normalized })
}

function requestHttp1(target: URL, socket: net.Socket, init: ProviderFetchInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http
    const agent = new client.Agent({ keepAlive: false })
    // agent:false ignores a request-level createConnection and silently dials
    // the destination directly. The dedicated agent must own the tunnel.
    agent.createConnection = () => socket
    const request = client.request({
      hostname: hostname(target), port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`, method: init.method || 'GET',
      headers: init.headers, signal: init.signal, agent,
    }, response => {
      response.setTimeout(RESPONSE_TIMEOUT_MS, () => response.destroy(new Error('Provider response timed out')))
      response.once('close', () => agent.destroy())
      try {
        resolve(toResponse(response.statusCode || 502, response.headers, response, init.method))
      } catch (error) {
        response.destroy()
        reject(error)
      }
    })
    request.setTimeout(RESPONSE_TIMEOUT_MS, () => request.destroy(new Error('Provider response timed out')))
    request.once('error', error => {
      agent.destroy()
      reject(error)
    })
    request.end(init.body)
  })
}

function requestHttp2(target: URL, socket: tls.TLSSocket, init: ProviderFetchInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(target.origin, { createConnection: () => socket })
    const headers: http2.OutgoingHttpHeaders = {
      ':method': init.method || 'GET', ':path': `${target.pathname}${target.search}`, ':authority': target.host,
    }
    for (const [name, value] of Object.entries(init.headers || {})) {
      const lower = name.toLowerCase()
      if (!['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'].includes(lower)) {
        headers[lower] = value
      }
    }
    const stream = client.request(headers, { signal: init.signal })
    const fail = (error: Error) => {
      client.destroy()
      reject(error)
    }
    client.once('error', error => {
      stream.destroy(error)
      fail(error)
    })
    stream.once('error', fail)
    stream.once('close', () => client.close())
    stream.setTimeout(RESPONSE_TIMEOUT_MS, () => stream.destroy(new Error('Provider response timed out')))
    stream.once('response', responseHeaders => {
      try {
        resolve(toResponse(Number(responseHeaders[':status'] || 502), responseHeaders, stream, init.method))
      } catch (error) {
        stream.destroy()
        client.destroy()
        reject(error)
      }
    })
    if (init.body) stream.end(init.body)
    else stream.end()
  })
}

export async function fetchProvider(url: string | URL, init: ProviderFetchInit = {}, proxyUrl?: string): Promise<Response> {
  init.signal?.throwIfAborted()
  const normalizedProxy = normalizeProviderProxyUrl(proxyUrl)
  if (!normalizedProxy) return fetch(url, init)
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Provider URL must use HTTP(S) without embedded credentials')
  }
  let socket: net.Socket = await openTunnel(target, new URL(normalizedProxy), init.signal)
  try {
    if (target.protocol === 'https:') socket = await secureTunnel(socket, target, init.signal)
    init.signal?.throwIfAborted()
    if (socket instanceof tls.TLSSocket && socket.alpnProtocol === 'h2') {
      return await requestHttp2(target, socket, init)
    }
    return await requestHttp1(target, socket, init)
  } catch (error) {
    socket.destroy()
    throw error
  }
}
