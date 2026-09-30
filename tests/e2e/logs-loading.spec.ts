import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const files = [{ name: 'webui', size: '1 KB', modified: '2026-09-30T00:00:00Z' }]

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function expectLoading(page: Page) {
  const surface = page.locator('.logs-view')
  await expect(surface).toHaveAttribute('aria-busy', 'true')
  await expect(surface.locator('.studio-loading-logo')).toBeVisible()
  await expect(surface.locator('.studio-loading-logo')).toHaveCSS('width', '72px')
  await expect(surface.locator('.studio-loading-logo')).toHaveCSS('height', '72px')
  await expect(surface.locator('.logs-empty')).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
})

for (const { width, platform } of [
  { width: 1440 }, { width: 1280 }, { width: 900 }, { width: 769 },
  { width: 390 }, { width: 769, platform: 'win32' },
]) {
  test(`keeps log header controls usable at ${width}px ${platform || 'browser'}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    if (platform) await page.addInitScript(() => {
      ;(window as any).hermesDesktop = {
        isDesktop: true, platform: 'win32', windowKind: 'main',
        getWindowState: async () => ({ isMaximized: false }),
        windowControl: async () => ({ isMaximized: false }),
      }
    })
    const requests: string[] = []
    await page.route('**/api/studio/logs', route => route.fulfill({ json: { files } }))
    await page.route('**/api/studio/logs/webui?**', route => {
      requests.push(route.request().url())
      return route.fulfill({ json: { entries: [] } })
    })
    await page.goto('/#/hermes/logs')
    const header = page.locator('.logs-page-header')
    await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
    const checkBounds = async () => {
      const box = (await header.boundingBox())!
      expect(box.x + box.width).toBeLessThanOrEqual(width - (platform ? 138 : 0))
      expect(await header.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      const controls = await header.locator('button, input, .n-base-selection').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()).filter(rect => rect.width > 0 && rect.height > 0))
      for (const control of controls) {
        expect(control.left).toBeGreaterThanOrEqual(box.x)
        expect(control.right).toBeLessThanOrEqual(box.x + box.width + 1)
        expect(control.top).toBeGreaterThanOrEqual(box.y)
        expect(control.bottom).toBeLessThanOrEqual(box.y + box.height + 1)
      }
    }
    await checkBounds()
    await page.screenshot({ path: `/tmp/studio-logs-header-${width}-${platform || 'browser'}.png`, animations: 'disabled' })
    const filterButton = header.getByRole('button', { name: 'Filter logs', exact: true })
    const compact = await filterButton.isVisible()
    if (compact) await filterButton.click()
    const filters = compact ? page.locator('.logs-filter-popover') : header
    const level = compact ? filters.locator('.n-select').first() : header.locator('.logs-level-select')
    await level.click()
    await page.locator('.n-base-select-option').filter({ hasText: /^ERROR$/ }).click()
    await expect.poll(() => requests.some(url => new URL(url).searchParams.get('level') === 'ERROR')).toBe(true)
    await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
    const lines = compact ? filters.locator('.n-select').nth(1) : header.locator('.logs-lines-select')
    await lines.click()
    await page.locator('.n-base-select-option').filter({ hasText: /^200$/ }).click()
    await expect.poll(() => requests.some(url => new URL(url).searchParams.get('lines') === '200')).toBe(true)
    await filters.locator('.search-input').fill('error details')
    await filters.locator('.search-input').press('Enter')
    await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
    if (compact) await header.getByRole('heading', { name: 'Logs', exact: true }).click()
    await header.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
    if (width > 768) {
      await page.locator('.header-sidebar-toggle').click()
      await expect(page.locator('.header-sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')
      await expect.poll(async () => (await header.boundingBox())!.x).toBe(136)
      await checkBounds()
    }
  })
}

test('logs stay covered from file discovery through content loading without flashing the empty state', async ({ page }) => {
  const fileGate = gate()
  const entryGate = gate()
  let entriesRequested = false
  await page.route('**/api/studio/logs', async route => {
    await fileGate.promise
    await route.fulfill({ json: { files } })
  })
  await page.route('**/api/studio/logs/webui?**', async route => {
    entriesRequested = true
    await entryGate.promise
    await route.fulfill({ json: { entries: [{ timestamp: '12:00:00', level: 'INFO', logger: 'webui', message: 'Log content ready', raw: 'Log content ready' }] } })
  })
  await page.goto('/#/hermes/logs')
  await expectLoading(page)
  fileGate.release()
  await expect.poll(() => entriesRequested).toBe(true)
  await expectLoading(page)
  const surface = page.locator('.logs-view')
  expect(await surface.locator(':scope > .page-loading-overlay').boundingBox()).toEqual(await surface.boundingBox())
  expect((await surface.boundingBox())!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await surface.locator('.studio-loading-logo img').evaluate((image: HTMLImageElement) => image.decode())
  await page.screenshot({ path: '/tmp/studio-logs-page-loading.png' })
  entryGate.release()
  await expect(surface).toHaveAttribute('aria-busy', 'false')
  await expect(surface.getByText('Log content ready', { exact: true })).toBeVisible()
  await expect(surface.locator('.logs-empty')).toHaveCount(0)
})

for (const emptyFiles of [true, false]) {
  test(`shows the empty state only after ${emptyFiles ? 'an empty file list' : 'empty log contents'} finishes loading`, async ({ page }) => {
    const pending = gate()
    await page.route('**/api/studio/logs', async route => {
      if (emptyFiles) await pending.promise
      await route.fulfill({ json: { files: emptyFiles ? [] : files } })
    })
    await page.route('**/api/studio/logs/webui?**', async route => {
      await pending.promise
      await route.fulfill({ json: { entries: [] } })
    })
    await page.goto('/#/hermes/logs')
    await expectLoading(page)
    pending.release()
    await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByText('No log entries', { exact: true })).toBeVisible()
    await expect(page.locator('.logs-view .studio-loading-logo')).toHaveCount(0)
  })
}

for (const failure of ['files', 'entries']) {
  test(`releases the log page and reports a failed ${failure} request`, async ({ page }) => {
    const pending = gate()
    await page.route('**/api/studio/logs', async route => {
      if (failure === 'files') {
        await pending.promise
        await route.fulfill({ status: 503, json: { error: 'Log files unavailable' } })
      } else {
        await route.fulfill({ json: { files } })
      }
    })
    await page.route('**/api/studio/logs/webui?**', async route => {
      await pending.promise
      await route.fulfill({ status: 503, json: { error: 'Log entries unavailable' } })
    })
    await page.goto('/#/hermes/logs')
    await expectLoading(page)
    pending.release()
    await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
    await expect(page.locator('.n-message--error-type')).toContainText(`Log ${failure} unavailable`)
  })
}
