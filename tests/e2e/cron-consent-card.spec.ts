import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { containPage } from './fixtures/contained-page'

// Mounts the real consent card with i18n and global styles. Every request outside Vite's own modules is
// blocked before navigation (see fixtures/contained-page.ts); /api is answered locally and never proxied,
// and the content-free `cron_consent.updated` hint is delivered through the chat socket's own listener.
const pending = (overrides: Record<string, unknown> = {}) => ({
  id: 'req-1', kind: 'cron_session_binding', mode: 'existing', action: 'subscribe_job', profile: 'default',
  session_id: 'chat-1', session_title: 'Chat one', context_kind: 'prepared', requested_via: 'model_run',
  created_at: Date.now(), expires_at: Date.now() + 600_000, job_id: 'agent1', name: '<b>Digest</b>',
  schedule: 'every 1h', prompt: 'summarize <i>news</i>', ...overrides,
})

type Decision = { path: string; profile: string | undefined; auth: string | undefined; body: string | null }

async function openCard(page: Page, list: () => unknown, decide: (path: string) => unknown = () => ({ status: 'approved' })) {
  await page.addInitScript(() => {
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_api_key', 'login-token')
    ;(window as any).__APP_VERSION__ = 'test'
  })
  const decisions: Decision[] = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (/\/consent-requests\/[^/]+\/(approve|deny)$/.test(path)) {
      decisions.push({ path, profile: request.headers()['x-hermes-profile'], auth: request.headers().authorization, body: request.postData() })
    }
  })
  const guard = await containPage(page, (path, method) =>
    method === 'GET' && path === '/api/hermes/cron/consent-requests' ? list() : decide(path))
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/cron-consent-card.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__cron_consent__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__cron_consent__')
  await page.waitForFunction(() => !!(window as any).cronConsentFixture)
  return { guard, decisions }
}

test('shows the frozen values as text and approves once with the login credential and profile', async ({ page }) => {
  let requests = [pending()]
  const { guard, decisions } = await openCard(page, () => ({ requests }), () => { requests = []; return { status: 'approved' } })
  const request = page.getByTestId('cron-consent-request')
  await expect(request).toContainText('<b>Digest</b> (agent1)')
  await expect(request).toContainText('summarize <i>news</i>')
  await expect(request.locator('b, i')).toHaveCount(0)
  await request.getByTestId('cron-consent-approve').click()
  await expect(page.getByTestId('cron-consent-outcome')).toContainText('Approved: “<b>Digest</b>”')
  await expect(page.getByTestId('cron-consent-approve')).toHaveCount(0)
  expect(decisions).toEqual([{ path: '/api/hermes/cron/consent-requests/req-1/approve', profile: 'default',
    auth: 'Bearer login-token', body: JSON.stringify({ profile: 'default' }) }])
  // No HTTP request left the page; the only refused sockets are same-origin (chat socket, Vite client).
  const origin = new URL(page.url()).host
  expect(guard.blocked.filter(url => !url.startsWith('ws'))).toEqual([])
  expect(guard.blocked.every(url => new URL(url).host === origin)).toBe(true)
})

test('refreshes on the hint for its own session only, and shows a denial and a refused approval', async ({ page }) => {
  let requests: unknown[] = []
  let listed = 0
  await openCard(page, () => { listed++; return { requests } }, path => {
    if (path.endsWith('/deny')) { requests = requests.filter((item: any) => item.id !== 'req-2'); return { status: 'denied' } }
    return {}
  })
  // A refused approval is a real HTTP error status; registered after the guard so it takes precedence.
  await page.route('**/api/hermes/cron/consent-requests/req-3/approve', route => route.fulfill({ status: 409, json: { error: 'job_changed' } }))
  await expect.poll(() => listed).toBeGreaterThan(0)
  const before = listed
  await page.evaluate(() => (window as any).cronConsentFixture.hint('other-session'))
  await page.waitForTimeout(300)
  expect(listed).toBe(before)

  requests = [pending({ id: 'req-2', name: 'Nightly', job_id: 'agent2' }), pending({ id: 'req-3', name: 'Changed', job_id: 'agent3' })]
  await page.evaluate(() => (window as any).cronConsentFixture.hint())
  const card = page.getByTestId('cron-consent-card')
  await expect(card.getByTestId('cron-consent-request')).toHaveCount(2)
  await card.getByTestId('cron-consent-request').filter({ hasText: 'Nightly' }).getByTestId('cron-consent-deny').click()
  await expect(card).toContainText('Denied: “Nightly”')
  await card.getByTestId('cron-consent-request').filter({ hasText: 'Changed' }).getByTestId('cron-consent-approve').click()
  const refused = card.getByTestId('cron-consent-outcome').filter({ hasText: 'Not applied: “Changed”' })
  await expect(refused).toContainText('job_changed')
})

test('fits a narrow viewport on the card theme surface', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 })
  await openCard(page, () => ({ requests: [pending({ prompt: 'a long prompt '.repeat(30), name: 'Very long job name '.repeat(6) })] }))
  const card = page.getByTestId('cron-consent-card')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-theme-surface', 'card')
  const layout = await card.evaluate(element => {
    const box = element.getBoundingClientRect()
    return { right: box.right, viewport: window.innerWidth, overflow: element.scrollWidth > element.clientWidth + 1,
      background: getComputedStyle(element).backgroundColor }
  })
  expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1)
  expect(layout.overflow).toBe(false)
  expect(layout.background).not.toBe('rgba(0, 0, 0, 0)')
})
