import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

test.beforeEach(async ({ page }) => {
  await authenticate(page, undefined, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.route('**/api/hermes/api-relay/usage', route => route.fulfill({ json: { configured: false, checkedAt: '2026-10-02T08:00:00Z', accounts: [] } }))
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/hermes/write-gate/pending**', route => route.fulfill({ json: { pending: [] } }))
})

test('opens the partner page below Models and visits the website only from its action', async ({ page, context }) => {
  await page.goto('/#/hermes/chat')
  const rail = page.locator('.studio-navigation-rail')
  const relay = rail.getByRole('link', { name: 'API Relay', exact: true })
  await expect(relay).toHaveAttribute('href', '#/hermes/api-relay')
  expect(await relay.evaluate(el => el.previousElementSibling?.getAttribute('href'))).toBe('#/hermes/models')
  await relay.click()
  await expect(page).toHaveURL(/#\/hermes\/api-relay$/)
  await expect(relay).toHaveAttribute('aria-current', 'page')
  expect(context.pages()).toHaveLength(1)
  await expect(page.locator('aside.sidebar, .session-list')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Leading AI models, one gateway' })).toBeVisible()
  const card = page.locator('.api-relay-hero')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Ekko Studio’s partner API gateway')
  await expect(card).not.toContainText(/Codex|Claude Code|Hermes/)
  for (const provider of ['Claude', 'ChatGPT', 'Grok', 'Gemini', 'Zhipu', 'Kimi', 'DeepSeek', 'MiniMax']) {
    await expect(card.locator('.api-relay-features')).toContainText(provider)
  }
  await expect.poll(() => card.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
  await expect(card.locator('img')).toHaveCSS('border-radius', '6px')

  const cardStyle = () => ({
    borderRadius: getComputedStyle(document.querySelector('section.api-relay-hero, section.app-download-hero')!).borderRadius,
    backgroundImage: getComputedStyle(document.querySelector('section.api-relay-hero, section.app-download-hero')!).backgroundImage,
    padding: getComputedStyle(document.querySelector('section.api-relay-hero, section.app-download-hero')!).padding,
  })
  const relayStyle = await page.evaluate(cardStyle)
  await page.goto('/#/hermes/connections?view=download')
  await expect(page.locator('.app-download-hero')).toBeVisible()
  expect(await page.evaluate(cardStyle)).toEqual(relayStyle)
  await page.goto('/#/hermes/api-relay')
  const action = page.getByRole('link', { name: 'View now', exact: true })
  await expect(action).toHaveAttribute('href', 'https://apikey.fan/register?aff=LIBAPI')
  await expect(action).toHaveAttribute('target', '_blank')
  await expect(action).toHaveAttribute('rel', 'noopener noreferrer')
  await context.route('https://apikey.fan/**', route => route.fulfill({ contentType: 'text/html', body: '<title>APIKEY.FAN</title>' }))
  const popupPromise = page.waitForEvent('popup')
  await action.click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  await expect(popup).toHaveURL('https://apikey.fan/register?aff=LIBAPI')
  await popup.close()
})

test('closes mobile navigation on the partner page and keeps the card within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.locator('.studio-mobile-drawer')
  await drawer.getByRole('link', { name: 'API Relay', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/api-relay$/)
  await expect(drawer).not.toBeVisible()
  await expect(page.locator('.api-relay-hero')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View now', exact: true })).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.reload()
  await expect(page.locator('.api-relay-hero')).toBeVisible()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(drawer).toHaveCSS('width', '64px')
  await expect(drawer.getByRole('link', { name: 'API Relay', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('shows the shared page loading surface until the partner logo is ready', async ({ page }) => {
  let releaseLogo!: () => void
  const logoGate = new Promise<void>(resolve => { releaseLogo = resolve })
  await page.route('**/relay-logo.png', async route => {
    await logoGate
    await route.continue()
  })
  await page.goto('/#/hermes/api-relay', { waitUntil: 'domcontentloaded' })
  const surface = page.locator('.api-relay-view')
  await expect(surface).toHaveAttribute('aria-busy', 'true')
  await expect(surface.locator('.page-loading-overlay')).toBeVisible()
  await expect(surface.locator('.api-relay-hero')).not.toBeVisible()
  releaseLogo()
  await expect(surface).toHaveAttribute('aria-busy', 'false')
  await expect(surface.locator('.page-loading-overlay')).toHaveCount(0)
  await expect(surface.locator('.api-relay-hero')).toBeVisible()
})

test('reveals the partner card when the logo cannot load', async ({ page }) => {
  await page.route('**/relay-logo.png', route => route.abort('failed'))
  await page.goto('/#/hermes/api-relay')
  await expect(page.locator('.api-relay-view')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.api-relay-hero')).toBeVisible()
  await expect(page.getByRole('link', { name: 'View now', exact: true })).toBeInViewport()
})

const relayUsage = {
  isValid: true,
  remaining: 12.25,
  unit: 'USD',
  today: { requests: 8, total_tokens: 1234, actual_cost: 0.15 },
  total: { requests: 42, total_tokens: 50000, cost: 2.5 },
  rpm: 2,
  tpm: 200,
  modelStats: [{ model: 'gpt-test', requests: 42, total_tokens: 50000, cost: 2.5 }],
}

const relayAccount = {
  id: 'credential-1',
  endpoint: 'https://api.apikey.fan/v1/usage',
  sources: [
    { profile: 'default', provider: 'custom:codex', label: 'Codex-apikey.fan' },
    { profile: 'research', provider: 'custom:codex', label: 'Codex-apikey.fan' },
  ],
  status: 'ready',
  usage: relayUsage,
}

test('shows separate keys with merged profile sources, zero balance and model usage', async ({ page }) => {
  await page.route('**/api/hermes/api-relay/usage', route => route.fulfill({ json: {
    configured: true,
    checkedAt: '2026-10-02T08:00:00Z',
    accounts: [relayAccount, { ...relayAccount, id: 'credential-2', sources: [{ profile: 'research', provider: 'deepseek', label: 'DeepSeek' }], usage: { ...relayUsage, remaining: 0, isValid: false } }],
  } }))
  await page.goto('/#/hermes/api-relay')
  const cards = page.locator('.relay-usage-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.first()).toContainText('default / Codex-apikey.fan')
  await expect(cards.first()).toContainText('research / Codex-apikey.fan')
  await expect(cards.first().locator('.relay-balance strong')).toHaveText('12.25 USD')
  await expect(cards.first().getByRole('row', { name: /Today/ })).toContainText('1,234')
  await expect(cards.first().getByRole('row', { name: /^Total / })).toContainText('50,000')
  await expect(cards.last().locator('.relay-balance strong')).toHaveText('0 USD')
  await expect(cards.last()).toContainText('Key inactive')
  await cards.first().locator('summary').click()
  await expect(cards.first().getByRole('row', { name: /gpt-test/ })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 800 })
  await cards.last().scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keeps shared loading until usage is fetched and shows the unconfigured state', async ({ page }) => {
  let releaseUsage!: () => void
  const gate = new Promise<void>(resolve => { releaseUsage = resolve })
  await page.route('**/api/hermes/api-relay/usage', async route => {
    await gate
    await route.fulfill({ json: { configured: false, accounts: [] } })
  })
  await page.goto('/#/hermes/api-relay', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.api-relay-view')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('.api-relay-hero')).not.toBeVisible()
  releaseUsage()
  await expect(page.locator('.api-relay-view')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.api-relay-usage')).toContainText('No APIKEY.FAN key is configured')
  await expect(page.locator('.relay-usage-card')).toHaveCount(0)
})

test('shows request failure, recovers on refresh and keeps successful keys on partial failure', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/hermes/api-relay/usage', route => {
    if (++attempts === 1) return route.fulfill({ status: 500, json: { error: 'Unable to load usage' } })
    return route.fulfill({ json: { configured: true, accounts: [relayAccount, {
      ...relayAccount, id: 'credential-2', status: 'error', error: 'unauthorized', usage: undefined,
      sources: [{ profile: 'research', provider: 'deepseek', label: 'DeepSeek' }],
    }] } })
  })
  await page.goto('/#/hermes/api-relay')
  await expect(page.locator('.api-relay-view')).toHaveAttribute('aria-busy', 'false')
  await expect(page.getByRole('status')).toHaveText('Unable to load usage. Refresh to try again.')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.relay-usage-card')).toHaveCount(2)
  await expect(page.locator('.relay-usage-card').first().locator('.relay-balance')).toContainText('12.25')
  await expect(page.locator('.relay-usage-card').last()).toContainText('Key authentication failed')
  await expect(page.locator('.relay-usage-card').last().locator('.relay-balance')).toHaveCount(0)
  await expect(page.locator('.api-relay-view')).toHaveAttribute('aria-busy', 'false')
})
