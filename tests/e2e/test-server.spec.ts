import { expect, test } from '@playwright/test'

test('serves the built client with a mockable socket boundary and no backend proxy', async ({ request }) => {
  test.skip(process.env.PLAYWRIGHT_DEV_SERVER === '1', 'Built-server contract; dev mode uses Vite directly')
  const index = await request.get('/')
  expect(index.ok()).toBe(true)
  const html = await index.text()
  expect(html).toMatch(/src="\/assets\/js\/index-[^"]+\.js"/)
  expect(html).not.toContain('/@vite/client')

  const socket = await request.get('/__e2e/socket__io-client.js')
  expect(socket.ok()).toBe(true)
  expect(socket.headers()['content-type']).toContain('javascript')
  expect(await socket.text()).toContain('export')

  const missingMock = await request.get('/api/__playwright_unmocked_probe__')
  expect(missingMock.status()).toBe(503)
  await expect(missingMock.json()).resolves.toEqual({ error: 'Unmocked browser-test request' })
})
