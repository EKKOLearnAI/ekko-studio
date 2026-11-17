import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { Server, type Socket } from 'socket.io'
import { resolve } from 'node:path'

test('registers a local Desktop for plugin browser calls and revokes it on disconnect', async ({ page, baseURL }) => {
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/local-browser-relay.ts').replace(/^\//, '')
  const http = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<output>connecting</output><button>Disconnect browser</button><script type="module" src="${baseURL}${entry}"></script>`)
  })
  const io = new Server(http), namespace = io.of('/desktop-browser')
  let peer: Socket | undefined
  namespace.on('connection', socket => { peer = socket })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address() as { port: number }
  try {
    await page.addInitScript(() => {
      localStorage.setItem('hermes_api_key', 'browser-relay-fixture-token')
      localStorage.setItem('hermes_active_profile_name', 'travel-profile')
      ;(window as any).browserRelayCalls = []
      ;(window as any).hermesDesktop = { isDesktop: true, remoteMode: false, browser: {
        setRemoteControl: async (enabled: boolean) => { (window as any).browserRelayGranted = enabled; return enabled },
        remoteRequest: async (body: any) => {
          ;(window as any).browserRelayCalls.push(body)
          const results: Record<string, any> = {
            'tabs.list': { tabs: [{ id: 'local-tab', title: 'Logged-in page', url: 'https://example.com' }] },
            'cdp.attach': { cursor: 0, sessions: [] },
            'cdp.send': { result: { value: 'Local Desktop title' } },
            'lease.release': { ok: true },
          }
          return { result: results[body.method] }
        },
        onRemoteControlState: () => () => {},
      } }
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    await expect(page.locator('output')).toHaveText('connected')
    await expect.poll(() => peer?.connected).toBe(true)
    expect(peer!.handshake.auth).toMatchObject({ token: 'browser-relay-fixture-token', profile: 'travel-profile' })
    const call = (method: string, params = {}) => peer!.timeout(5000).emitWithAck('browser.request', { method, params })
    expect(await call('tabs.list')).toMatchObject({ envelope: { result: { tabs: [{ id: 'local-tab' }] } } })
    await call('cdp.attach', { tab_id: 'local-tab' })
    expect(await call('cdp.send', { tab_id: 'local-tab', method: 'Runtime.evaluate', params: { expression: 'document.title' } })).toEqual({ envelope: { result: { result: { value: 'Local Desktop title' } } } })
    await call('lease.release', { tab_id: 'local-tab' })
    expect(await page.evaluate(() => (window as any).browserRelayCalls.map((call: any) => call.method))).toEqual(['tabs.list', 'cdp.attach', 'cdp.send', 'lease.release'])
    await page.getByRole('button', { name: 'Disconnect browser' }).click()
    await expect(page.locator('output')).toHaveText('disconnected')
    await expect.poll(() => peer?.connected).toBe(false)
    expect(await page.evaluate(() => (window as any).browserRelayGranted)).toBe(false)
  } finally { await new Promise<void>(resolve => io.close(() => resolve())) }
})
