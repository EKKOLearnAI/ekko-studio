import { expect, test, type Locator } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function expectRelayBadgeInCorner(entry: Locator) {
  const target = (await entry.boundingBox())!
  const logo = (await entry.locator('.api-relay-logo').boundingBox())!
  const badge = (await entry.locator('.relay-campaign-badge').boundingBox())!
  const navigation = await entry.evaluate(element => {
    const rect = element.closest('nav')!.getBoundingClientRect()
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }
  })
  expect(logo.width).toBe(24)
  expect(logo.height).toBe(24)
  expect(logo.x + logo.width / 2).toBeCloseTo(target.x + target.width / 2, 1)
  expect(logo.y + logo.height / 2).toBeCloseTo(target.y + target.height / 2, 1)
  const overlap = badge.y + badge.height - logo.y
  expect(overlap).toBeGreaterThan(0)
  expect(overlap).toBeLessThanOrEqual(logo.height / 6)
  expect(badge.x + badge.width / 2).toBeGreaterThan(logo.x + logo.width / 2)
  expect(badge.x).toBeGreaterThanOrEqual(navigation.x)
  expect(badge.x + badge.width).toBeLessThanOrEqual(navigation.right)
  expect(badge.y).toBeGreaterThanOrEqual(navigation.y)
  expect(badge.y + badge.height).toBeLessThanOrEqual(navigation.bottom)
}

test.beforeEach(async ({ page }) => {
  await authenticate(page, undefined, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.route('**/api/hermes/api-relay/usage', route => route.fulfill({ json: { configured: false, checkedAt: '2026-10-02T08:00:00Z', accounts: [] } }))
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/hermes/write-gate/pending**', route => route.fulfill({ json: { pending: [] } }))
})

test('opens the partner page below Usage and visits the website only from its action', async ({ page, context }, testInfo) => {
  await page.goto('/#/hermes/chat')
  const rail = page.locator('.studio-navigation-rail')
  const relay = rail.getByRole('link', { name: 'API Relay', exact: true })
  await expect(relay).toHaveAttribute('aria-description', 'Double 11')
  await expect(relay.locator('.relay-campaign-badge')).toBeVisible()
  await expectRelayBadgeInCorner(relay)
  await expect(relay).toHaveAttribute('href', '#/hermes/api-relay')
  expect(await relay.evaluate(el => el.previousElementSibling?.getAttribute('href'))).toBe('#/hermes/usage')
  await relay.click()
  await expect(page).toHaveURL(/#\/hermes\/api-relay$/)
  await expect(relay).toHaveAttribute('aria-current', 'page')
  await expectRelayBadgeInCorner(relay)
  const entryBox = (await relay.boundingBox())!
  await page.screenshot({ path: testInfo.outputPath('relay-entry-corner.png'), clip: { x: entryBox.x - 8, y: entryBox.y - 14, width: 60, height: 68 } })
  expect(context.pages()).toHaveLength(1)
  await expect(page.locator('aside.sidebar, .session-list')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Double 11: 11.11% bonus credit on recharges, up to 1111 in bonus credit' })).toBeVisible()
  await expect(page.getByText('Leading AI models, one gateway', { exact: true })).toBeVisible()
  const card = page.locator('.api-relay-hero')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Ekko Studio’s partner API gateway')
  await expect(card).not.toContainText(/Codex|Claude Code|Hermes/)
  for (const provider of ['Claude', 'ChatGPT', 'Grok', 'Gemini', 'Zhipu', 'Kimi', 'DeepSeek', 'MiniMax']) {
    await expect(card.locator('.api-relay-features')).toContainText(provider)
  }
  await expect.poll(() => card.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
  await expect(card.locator('.relay-campaign-badge')).toContainText('Double 11')
  await expect(card).not.toContainText(/2026|limited.time|USD/i)
  const action = page.getByRole('link', { name: 'View now', exact: true })
  await expect(action).toHaveAttribute('href', 'https://apikey.fan/activities/double11-2026?aff=LIBAPI')
  await expect(action).toHaveAttribute('target', '_blank')
  await expect(action).toHaveAttribute('rel', 'noopener noreferrer')
  await context.route('https://apikey.fan/**', route => route.fulfill({ contentType: 'text/html', body: '<title>APIKEY.FAN</title>' }))
  const popupPromise = page.waitForEvent('popup')
  await action.click()
  const popup = await popupPromise
  await popup.waitForLoadState()
  await expect(popup).toHaveURL('https://apikey.fan/activities/double11-2026?aff=LIBAPI')
  await popup.close()
})

test('closes mobile navigation on the partner page and keeps the card within the viewport', async ({ page }, testInfo) => {
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
  await expect.poll(async () => (await drawer.locator('.studio-navigation-rail').boundingBox())?.x).toBe(0)
  await expect(drawer.getByRole('link', { name: 'API Relay', exact: true })).toHaveAttribute('aria-current', 'page')
  await expectRelayBadgeInCorner(drawer.getByRole('link', { name: 'API Relay', exact: true }))
  await page.screenshot({ path: testInfo.outputPath('relay-mobile-drawer-corner.png') })
})

test('shows the shared page loading surface until the partner logo is ready', async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath('campaign-loading.png') })
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

for (const brightness of ['light', 'dark']) {
  test(`campaign respects wallpaper, regional opacity and reset in ${brightness} mode`, async ({ page }, testInfo) => {
    await mockHermesApi(page, { theme: { brightness } })
    await page.route('**/api/hermes/api-relay/usage', route => route.fulfill({ json: { configured: false, accounts: [] } }))
    const card = page.locator('.api-relay-hero')
    const action = page.getByRole('link', { name: 'View now', exact: true })
    const openRelay = async () => {
      await page.goto('/#/hermes/api-relay')
      await expect(card).toBeVisible()
      await expect(action).toBeInViewport()
      await expect(card).toHaveCSS('opacity', '1')
    }
    await openRelay()
    await expect(card).toHaveCSS('color', 'rgb(255, 241, 203)')
    await page.screenshot({ path: testInfo.outputPath(`campaign-${brightness}.png`) })

    await page.goto('/#/hermes/theme')
    await page.locator('.file-input').setInputFiles({
      name: 'wall.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2V9sAAAAASUVORK5CYII=', 'base64'),
    })
    await expect(page.locator('.app-shell')).toHaveClass(/app-shell--custom-background/)
    await openRelay()
    await expect(card).toHaveCSS('background-color', brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)')
    await expect(card).toHaveCSS('color', brightness === 'dark' ? 'rgb(224, 224, 224)' : 'rgb(26, 26, 26)')
    await page.screenshot({ path: testInfo.outputPath(`campaign-${brightness}-wallpaper.png`) })

    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-backgroundColor').fill('#8c8070')
    await page.getByTestId('theme-card-borderColor').fill('#6688aa')
    for (const [key, value] of [['opacity', '0.25'], ['blur', '12'], ['radius', '16']]) {
      await page.getByTestId(`theme-card-${key}`).fill(value)
      await page.getByTestId(`theme-card-${key}`).dispatchEvent('change')
    }
    await openRelay()
    await expect(card).toHaveCSS('background-color', 'rgba(140, 128, 112, 0.25)')
    await expect(card).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    await expect(card).toHaveCSS('border-radius', '16px')
    await expect(card).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
    await page.screenshot({ path: testInfo.outputPath(`campaign-${brightness}-custom.png`) })

    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await openRelay()
    await expect(card).toHaveCSS('background-color', 'rgba(140, 128, 112, 0)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
    await openRelay()
    await expect(card).toHaveCSS('background-color', 'rgba(140, 128, 112, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await openRelay()
    await expect(card).toHaveCSS('color', 'rgb(255, 241, 203)')
    await expect(card).toHaveCSS('background-image', /linear-gradient/)
  })
}

test('campaign fits narrow screens and enlarged text with keyboard access', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/hermes/api-relay')
  const card = page.locator('.api-relay-hero')
  const action = page.getByRole('link', { name: '立即查看', exact: true })
  await expect(card.getByRole('heading')).toHaveText('双十一充值加赠11.11%额度，最高加赠1111额度')
  for (const width of [1600, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(card).toBeVisible()
    await expect(action).toBeInViewport()
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`campaign-zh-${width}.png`) })
  }
  await page.goto('/#/hermes/theme')
  await page.locator('.font-size-input input').fill('20')
  await page.locator('.font-size-input input').press('Tab')
  await page.goto('/#/hermes/api-relay')
  await expect(card).toBeVisible()
  await expect(card).toHaveCSS('font-size', '20px')
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await action.scrollIntoViewIfNeeded()
  await expect(action).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('campaign-zh-320-large-text.png') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectRelayBadgeInCorner(page.locator('.studio-navigation-rail').getByRole('link', { name: '中转站', exact: true }))
  await page.locator('.studio-navigation-rail').getByRole('link', { name: '中转站', exact: true }).focus()
  for (let i = 0; i < 12 && !await action.evaluate(el => el === document.activeElement); i++) {
    await page.keyboard.press('Tab')
  }
  await expect(action).toBeFocused()
  await expect(action).toHaveCSS('outline-width', '3px')
  await expect(action).toHaveCSS('transition-duration', '0s')
  await page.screenshot({ path: testInfo.outputPath('campaign-keyboard-focus.png') })
})

test('campaign supports right-to-left navigation and content', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'ar'))
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#/hermes/api-relay')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  const card = page.locator('.api-relay-hero')
  await expect(card).toBeVisible()
  await expect(card.locator('.api-relay-action')).toBeInViewport()
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('campaign-ar-390.png') })
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

test('shows separate keys with merged profile sources, zero balance and model usage', async ({ page }, testInfo) => {
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
  await page.screenshot({ path: testInfo.outputPath('campaign-populated.png') })
  await page.setViewportSize({ width: 390, height: 800 })
  await cards.last().scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('keeps shared loading until usage is fetched and only shows the partner card without keys', async ({ page }) => {
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
  await expect(page.locator('.api-relay-hero')).toBeVisible()
  await expect(page.locator('.api-relay-usage')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Key usage', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0)
  await expect(page.locator('.relay-usage-card')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 800 })
  await expect(page.locator('.api-relay-hero')).toBeVisible()
  await expect(page.locator('.api-relay-usage')).toHaveCount(0)
})

test('hides the usage section after refresh confirms all keys have been removed', async ({ page }) => {
  let attempts = 0
  await page.route('**/api/hermes/api-relay/usage', route => route.fulfill({ json: ++attempts === 1
    ? { configured: true, accounts: [relayAccount] }
    : { configured: false, accounts: [] },
  }))
  await page.goto('/#/hermes/api-relay')
  await expect(page.locator('.relay-usage-card')).toBeVisible()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.locator('.api-relay-usage')).toHaveCount(0)
  await expect(page.locator('.api-relay-hero')).toBeVisible()
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
