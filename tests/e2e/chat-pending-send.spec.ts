import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('returns cancelled upload text and files to the composer for retry', async ({ page }) => {
  let uploads = 0
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/studio/uploads') { uploads++; return } // Deliberately pending until Stop aborts the fetch.
    return route.fulfill({ json: path === '/api/auth/me' ? { user: { id: 1, username: 'fixture', role: 'super_admin' } } : {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/chat-pending-send.ts').replace(/^\//, '')
  await page.route('**/__pending_send__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__pending_send__')
  const input = page.locator('textarea')
  await input.fill('retain this draft')
  await page.locator('input[type=file]').setInputFiles({ name: 'wrong.wav', mimeType: 'audio/wav', buffer: Buffer.from('audio') })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => uploads).toBe(1)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(input).toHaveValue('retain this draft')
  await expect(page.locator('.attachment-preview')).toContainText('wrong.wav')
  expect(await page.evaluate(() => (window as any).pendingSendFixture.messages.length)).toBe(0)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => uploads).toBe(2)
  // A newer draft typed during preparation must survive cancellation too.
  await input.fill('next draft')
  await page.evaluate(() => (window as any).pendingSendFixture.stopStreaming())
  await expect(input).toHaveValue('retain this draft\n\nnext draft')
  await expect(page.locator('.attachment-preview')).toHaveCount(1)
  expect(await page.evaluate(() => (window as any).pendingSendFixture.messages.length)).toBe(0)
})
