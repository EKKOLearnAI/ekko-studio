import { createServer, request } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { COOKIE_EXTENSION_ORIGIN, BrowserCookieDiscovery } from '../../packages/desktop/src/main/browser/browser-cookie-discovery'

const discovery = new BrowserCookieDiscovery()
afterEach(async () => { await discovery.stop() })
// Reserve a free port only for this isolated test; production uses the well-known port.
async function port() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return value
}
it('only invokes connection approval for an empty extension POST with a valid Host', async () => {
  const selectedPort = await port()
  const connect = vi.fn(async () => ({ managerUrl: 'http://127.0.0.1:12345', token: 'test' }))
  await discovery.start(connect, selectedPort)
  const url = `http://127.0.0.1:${selectedPort}/api/cookie-import-helper/connect`
  const extension = { Origin: COOKIE_EXTENSION_ORIGIN }
  expect((await fetch(url, { method: 'POST', headers: { Origin: 'https://evil.test' } })).status).toBe(403)
  expect((await fetch(url, { method: 'GET', headers: extension })).status).toBe(400)
  expect((await fetch(url, { method: 'POST', headers: extension, body: 'no' })).status).toBe(400)
  const rebound = await new Promise<number>(resolve => {
    const req = request(url, { method: 'POST', headers: { ...extension, Host: 'evil.test' } }, res => {
      res.resume(); resolve(res.statusCode!)
    })
    req.end()
  })
  expect(rebound).toBe(403)
  expect(connect).not.toHaveBeenCalled()
  const response = await fetch(url, { method: 'POST', headers: extension })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ token: 'test' })
  expect(connect).toHaveBeenCalledTimes(1)
})
