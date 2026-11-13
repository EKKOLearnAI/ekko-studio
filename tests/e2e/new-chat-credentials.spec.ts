import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('restores a manual key only while the profile still needs one', async ({ page }) => {
  page.on('pageerror', error => console.log('fixture error:', error.stack))
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    let json: any = {}
    if (path === '/api/agents/availability') json = { agents: [{ id: 'codex', installed: true, available: true, source: 'user-cli' }] }
    else if (path === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (path === '/api/hermes/profiles') json = { profiles: [{ name: 'default', active: true }] }
    else if (path.endsWith('/session-categories')) json = { categories: [] }
    else if (path.endsWith('/sessions')) json = { sessions: [] }
    else if (path.endsWith('/directories')) json = { directories: [] }
    return route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/new-chat-credentials.ts').replace(/^\//, '')
  await page.route('**/__chat_credentials__*', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__chat_credentials__')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const settings = page.getByRole('button', { name: 'Chat settings', exact: true })
  await settings.click()
  await page.locator('.new-chat-settings-panel input[type=password]').fill('stale-manual-key')
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('hermes_new_chat_form_v1:1:credential'))).toContain('stale-manual-key')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('.new-chat-compose textarea').fill('manual credentials')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).credentialFixture.created[0]?.apiKey)).toBe('stale-manual-key')

  // Reopen after the server reports a configured key_env credential for this profile/provider.
  await page.goto('/__chat_credentials__?configured=1')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await settings.click()
  await expect(page.locator('.new-chat-settings-panel input[type=password]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('.new-chat-compose textarea').fill('profile credentials')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).credentialFixture.created.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).credentialFixture.created[0].apiKey)).toBeUndefined()
})
