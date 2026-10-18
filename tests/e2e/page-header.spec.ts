import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

test.beforeEach(async ({ page }) => {
  await authenticate(page, undefined, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page)
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/studio/logs', route => route.fulfill({ json: { files: [] } }))
})

test('replaces the shared header on navigation and leaves page content below it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/hermes/chat')
  const host = page.locator('.studio-page-header')
  const rail = page.locator('.studio-navigation-rail')
  await expect(host.locator('.chat-header')).toBeVisible()
  await expect(page.locator('.chat-main > .chat-header')).toHaveCount(0)
  const toggle = host.locator('.header-sidebar-toggle')
  const sidebarControl = host.locator('.header-sidebar-control')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebarControl).toHaveCSS('border-right-width', '1px')
  expect(await sidebarControl.boundingBox()).toMatchObject({ x: 64, y: 0, width: 240, height: 40 })
  expect((await toggle.boundingBox())?.x).toBe(72)
  expect((await host.locator('.header-session-title').boundingBox())?.x).toBe(312)
  await page.mouse.move(700, 450)
  await page.screenshot({ path: '/tmp/studio-header-sidebar-aligned.png', animations: 'disabled' })
  await toggle.click()
  await expect.poll(async () => (await page.locator('.chat-main').boundingBox())?.x).toBe(64)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect((await toggle.boundingBox())?.x).toBe(72)
  await expect.poll(async () => (await sidebarControl.boundingBox())?.width).toBe(44)
  await expect(sidebarControl).toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)')
  expect((await host.locator('.header-session-title').boundingBox())?.x).toBe(116)
  await toggle.click()
  await expect.poll(async () => (await sidebarControl.boundingBox())?.width).toBe(240)
  await expect(sidebarControl).not.toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)')
  expect((await host.locator('.header-session-title').boundingBox())?.x).toBe(312)

  for (const name of ['History', 'Workflow', 'Device connections', 'Agent Manager', 'Models', 'Settings', 'Chat']) {
    const link = rail.getByRole('link', { name, exact: true })
    const href = await link.getAttribute('href')
    await link.click()
    await expect.poll(() => new URL(page.url()).hash).toBe(href)
    const pageHeader = host.locator(':scope > :not(.header-sidebar-control)')
    await expect(pageHeader).toHaveCount(1)
    await expect(pageHeader).toBeVisible()
    await expect.poll(async () => (await pageHeader.boundingBox())?.y).toBe(0)
    await expect.poll(async () => (await pageHeader.boundingBox())?.height).toBe(40)
    const hasSessionList = !['Device connections', 'Agent Manager', 'Models'].includes(name)
    await expect(host.locator('.header-sidebar-control')).toHaveCount(hasSessionList ? 1 : 0)
    if (!hasSessionList) {
      await expect(page.locator('.chat-panel > .session-list')).toHaveCount(0)
      await expect(page.locator('.chat-panel > .session-backdrop')).toHaveCount(0)
      await expect.poll(async () => (await page.locator('.chat-main').boundingBox())?.x).toBe(64)
      expect((await host.locator('.header-title').boundingBox())?.x).toBe(80)
    }
    await expect(page.locator('.app-main .page-header, .app-main .chat-header')).toHaveCount(0)
    expect((await page.locator('.app-main').boundingBox())?.y).toBe(40)
  }
  await page.screenshot({ path: '/tmp/studio-outer-header.png', animations: 'disabled' })
})

test('returns the header to the page on narrow windows and restores it without duplication', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/#/hermes/jobs')
  const host = page.locator('.studio-page-header')
  await expect(host.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
  await expect(page.locator('.hermes-config-sidebar')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 800 })
  await expect(host).toBeHidden()
  await expect(page.locator('.jobs-view > .page-loading-content > .page-header')).toBeVisible()
  await expect(host.locator('.header-sidebar-toggle')).toHaveCount(0)
  await page.locator('.hamburger-btn').click()
  await expect(page.locator('.hermes-config-sidebar')).toHaveClass(/open/)
  await page.mouse.click(380, 300)
  await expect(page.locator('.hermes-config-sidebar')).not.toHaveClass(/open/)
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(host.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
  await expect(page.locator('.jobs-view > .page-loading-content > .page-header')).toHaveCount(0)
  await expect(page.locator('.page-header')).toHaveCount(1)
  await host.getByRole('button', { name: 'Create Job' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

for (const [route, sidebarSelector] of [
  ['/hermes/settings', '.sidebar'],
  ['/hermes/config/settings', '.hermes-config-sidebar'],
]) {
  test(`collapses the settings sidebar from the outer header on ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/#${route}`)
    const host = page.locator('.studio-page-header')
    const toggle = host.locator('.header-sidebar-toggle')
    const control = host.locator('.header-sidebar-control')
    const sidebar = page.locator(sidebarSelector)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(240)
    expect((await toggle.boundingBox())?.x).toBe(72)
    expect((await host.locator('.header-title').boundingBox())?.x).toBe(312)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(64)
    await expect.poll(async () => (await control.boundingBox())?.width).toBe(64)
    await expect(control).toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)')
    expect((await host.locator('.header-title').boundingBox())?.x).toBe(136)
    expect((await page.locator('.app-main').boundingBox())?.x).toBe(128)

    await page.reload()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(sidebar).toHaveClass(/collapsed/)
    await toggle.click()
    await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(240)
    await expect.poll(async () => (await control.boundingBox())?.width).toBe(240)
    await expect(control).not.toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)')
    expect((await host.locator('.header-title').boundingBox())?.x).toBe(312)
  })
}

test('keeps crowded toolbar controls within the outer header on smaller desktop windows', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  for (const route of ['logs', 'usage', 'skills-usage', 'skills', 'kanban']) {
    await page.goto(`/#/hermes/${route}`)
    const header = page.locator('.studio-page-header > .page-header')
    await expect(header).toBeVisible()
    await expect.poll(async () => (await header.boundingBox())?.height).toBe(40)
    await expect.poll(() => header.locator('button, input, .n-base-selection').evaluateAll(elements =>
      elements.filter(el => el.getBoundingClientRect().height > 0).every(el => {
        const box = el.getBoundingClientRect()
        return box.top >= 0 && box.bottom <= 40
      }),
    )).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
})
