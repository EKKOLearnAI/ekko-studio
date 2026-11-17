import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
// @ts-expect-error Shared MCP JavaScript transport.
import { fetchLongRequest } from '../../bin/long-request.mjs'

it('preserves delayed structured responses, cancellation, and a bounded transport deadline', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/hang') return
    setTimeout(() => { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end('{"error":"business timeout"}') }, 20)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as any).port}`
  try {
    const response = await fetchLongRequest(base, { method: 'POST', body: '{}' }, 200)
    expect(response.status).toBe(504); expect(await response.text()).toBe('{"error":"business timeout"}')
    await expect(fetchLongRequest(base + '/hang', {}, 10)).rejects.toThrow('transport timed out')
    const controller = new AbortController(), pending = fetchLongRequest(base + '/hang', { signal: controller.signal }, 200)
    controller.abort(); await expect(pending).rejects.toThrow(/abort/i)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
