import { expect, test } from '@playwright/test'
import { containPage } from './fixtures/contained-page'
import { fakeChatRunSockets } from './fixtures/session-state-socket'

const sessions = ['Current conversation', 'Remote conversation'].map((title, index) => ({
  id: `manual-unread-${index}`, title, profile: 'default', source: 'builtin_agent', agent: 'ekko-agent',
  model: 'test-model', provider: 'test-provider', started_at: 2 - index, last_active: 2 - index, message_count: 1,
}))

// The real app, contained: /api answered locally, chat-run sockets served by the spec over the real transport.
async function openChat(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'en'); localStorage.setItem('hermes_api_key', 'journey-key'); (window as any).__APP_VERSION__ = 'test'
  })
  await containPage(page, path => {
    if (path === '/api/auth/me') return { user: { id: 1, username: 'playwright', role: 'super_admin', status: 'active' } }
    if (path === '/api/hermes/profiles') return { profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test', alias: 'Default' }] }
    if (path === '/api/studio/sessions') return { sessions }
    if (path === '/api/hermes/available-models') return { default: 'test-model', default_provider: 'test-provider',
      groups: [{ provider: 'test-provider', label: 'Test Provider', base_url: 'https://example.invalid/v1', models: ['test-model'], available_models: ['test-model'] }] }
    if (path === '/api/studio/session-categories') return { categories: [] }
    if (path.startsWith('/api/studio/sessions/manual-unread-')) return { session: sessions.find(s => path.includes(s.id)), messages: [], total: 0 }
    return {}
  })
  const sockets = await fakeChatRunSockets(page)
  await page.goto('/#/hermes/session/manual-unread-0')
  return sockets
}

test('marks the open chat unread from its context menu and reads it only when selected again', async ({ page }, testInfo) => {
  const sockets = await openChat(page)
  const current = page.locator('.session-item').filter({ hasText: 'Current conversation' }).first()
  const remote = page.locator('.session-item').filter({ hasText: 'Remote conversation' }).first()
  await expect(current).toBeVisible()
  await expect.poll(sockets.connected).toBe(true)
  const read = { working: false, backgroundPending: 0, lastMessageId: 10, readMessageId: 10, unread: false, manualUnread: false, unreadRevision: 0, generation: 'g1' }
  sockets.publish({ sessionId: 'manual-unread-0', ...read })
  sockets.publish({ sessionId: 'manual-unread-1', ...read, readMessageId: 0, unread: true })
  const option = page.locator('.n-dropdown-option').filter({ hasText: 'Mark as unread' })

  // An unread conversation offers no Mark as unread.
  await remote.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-option').filter({ hasText: 'Rename' })).toBeVisible()
  await expect(option).toHaveCount(0)
  await page.mouse.click(900, 250)
  await expect(page.locator('.n-dropdown-option:visible')).toHaveCount(0)

  // Marking the open conversation sends exactly its revision and generation.
  await current.click({ button: 'right' })
  await option.click()
  await expect.poll(() => sockets.unreads.map(entry => entry.payload)).toEqual([{ sessionId: 'manual-unread-0', unreadRevision: 0, generation: 'g1' }])
  sockets.unreads[0].ack({ ok: true, changed: true })
  sockets.publish({ sessionId: 'manual-unread-0', ...read, unread: true, manualUnread: true, unreadRevision: 7 })
  await expect(current.locator('.session-item-unread-dot')).toBeVisible()
  await expect(page).toHaveURL(/manual-unread-0/)

  // Passive focus of the already open chat does not read it.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(200)
  expect(sockets.reads).not.toContainEqual(expect.objectContaining({ sessionId: 'manual-unread-0' }))
  await page.screenshot({ path: testInfo.outputPath('chat-manual-unread-open.png') })

  // Selecting it again reads exactly the marked revision.
  await current.click()
  await expect.poll(() => sockets.reads).toContainEqual({ sessionId: 'manual-unread-0', messageId: 10, unreadRevision: 7, generation: 'g1' })
  sockets.publish({ sessionId: 'manual-unread-0', ...read, unreadRevision: 7 })
  await expect(current.locator('.session-item-unread-dot')).toHaveCount(0)
})
