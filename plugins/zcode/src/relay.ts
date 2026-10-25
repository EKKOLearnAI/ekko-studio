import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { StudioError, type ModelGatewayHandle } from '@ekko-studio/plugin-sdk'

/** ZCode 0.16.9 ignores requestAuth for ordinary API-key providers. Keep the
 * host credential in memory, behind a per-Run, loopback-only native credential. */
export async function createZcodeRelay(gateway: ModelGatewayHandle, signal: AbortSignal) {
  const base = new URL(gateway.baseUrl)
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(base.hostname) || base.search || base.hash || base.username || base.password)
    throw new StudioError('INVALID_ARGUMENT', 'ZCode requires a loopback model gateway')
  const key = randomBytes(32).toString('hex'), active = new Set<AbortController>()
  let closed = false
  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (request, response) => {
    const supplied = request.headers['x-api-key'] || request.headers.authorization?.replace(/^Bearer /i, '')
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== key.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(key))) { response.writeHead(401).end(); return }
    if (closed || signal.aborted) { response.writeHead(410).end(); return }
    if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(request.url || '')) { response.writeHead(404).end(); return }
    if (active.size >= 4) { response.writeHead(429).end(); return }
    const controller = new AbortController(); active.add(controller)
    const abort = () => controller.abort()
    request.once('aborted', abort)
    const downstreamClosed = () => { if (!response.writableEnded) abort() }
    response.once('close', downstreamClosed)
    try {
      const chunks: Buffer[] = []; let bytes = 0
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > 10 * 1024 * 1024) { response.writeHead(413).end(); return }
        chunks.push(Buffer.from(chunk))
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (!body || Array.isArray(body) || body.model !== gateway.model) { response.writeHead(400).end(); return }
      const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${gateway.token}`, 'x-api-key': gateway.token }
      for (const name of ['anthropic-version', 'anthropic-beta']) {
        const value = request.headers[name]
        if (typeof value === 'string' && value.length <= 8192) headers[name] = value
      }
      const target = new URL(base)
      target.pathname = `${base.pathname.replace(/\/$/, '')}/${request.url === '/v1/messages' ? 'messages' : 'messages/count_tokens'}`
      const upstream = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', signal: controller.signal })
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); response.writeHead(502).end(); return }
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
      let outputBytes = 0
      if (upstream.body) for await (const data of upstream.body) {
        outputBytes += data.length
        if (outputBytes > 64 * 1024 * 1024) throw new Error('ZCode relay response limit exceeded')
        await write(response, data, controller.signal)
      }
      response.end()
    } catch {
      if (!response.headersSent) response.writeHead(502).end()
      else response.destroy()
    } finally {
      request.removeListener('aborted', abort); response.removeListener('close', downstreamClosed); active.delete(controller)
    }
  })
  server.maxRequestsPerSocket = 1
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  let disposal: Promise<void> | undefined
  const dispose = () => disposal ??= (async () => {
    closed = true; signal.removeEventListener('abort', abortAll)
    for (const controller of active) controller.abort()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })()
  const abortAll = () => { void dispose().catch(() => {}) }
  signal.addEventListener('abort', abortAll, { once: true })
  if (signal.aborted) await dispose()
  return { key, baseUrl, dispose }
}

function write(response: ServerResponse, data: Uint8Array, signal: AbortSignal): Promise<void> {
  if (signal.aborted || response.destroyed) return Promise.reject(new Error('ZCode relay ended'))
  return new Promise((resolve, reject) => { response.write(data, error => error ? reject(error) : resolve()) })
}
