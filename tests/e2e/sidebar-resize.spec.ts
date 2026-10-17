import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function setup(page: Page, theme = {}, sessions: unknown[] = []) {
  await page.setViewportSize({ width: 1440, height: 900 })
  await authenticate(page, undefined, 'research')
  await mockChatSocket(page)
  await mockHermesApi(page, { theme, sessions })
  await page.route('**/api/studio/sessions/hermes/groups**', route => route.fulfill({ json: { groups: [], included: [] } }))
  await page.route('**/api/studio/logs', route => route.fulfill({ json: { files: [] } }))
}

async function dragSidebar(page: Page, width: number) {
  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  const box = (await handle.boundingBox())!
  const sidebar = (await handle.locator('..').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + width - sidebar.width, box.y + 100, { steps: 5 })
  return handle
}

test('drags within bounds, aligns the header, and remembers width across routes and reloads', async ({ page }, testInfo) => {
  await setup(page, {}, [{
    id: 'resize-session', title: 'A long conversation title that should remain readable while resizing the sidebar',
    profile: 'research', source: 'api_server', model: 'test-model', provider: 'test-provider',
    started_at: 1, last_active: 1, message_count: 2,
  }])
  await page.addInitScript(() => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      'resize-session': { session_id: 'resize-session', isWorking: false, messages: [], events: [] },
    }
  })
  await page.goto('/#/hermes/chat')
  const sidebar = page.locator('.session-list')
  await expect(sidebar).toHaveCSS('width', '240px')
  await dragSidebar(page, 340)
  // The content follows the pointer while it is held, without a width transition.
  await expect(sidebar).toHaveCSS('width', '340px')
  await expect(page.locator('.header-sidebar-control')).toHaveCSS('width', '340px')
  await page.mouse.up()
  await expect(page.locator('.sidebar-resize-shield')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('hermes_sidebar_width'))).toBe('340')

  for (const [path, selector] of [
    ['/hermes/history', '.session-list'],
    ['/hermes/workflow', '.workflow-sidebar'],
    ['/hermes/group-chat', '.room-sidebar'],
    ['/hermes/settings', 'aside.sidebar'],
    ['/hermes/jobs', '.hermes-config-sidebar'],
    ['/ekko/settings', '.ekko-config-sidebar'],
    ['/studio/agents/codex/settings', '.coding-agent-config-sidebar'],
  ]) {
    await page.goto(`/#${path}`)
    await expect(page.locator(selector)).toHaveCSS('width', '340px')
    const handle = page.getByRole('separator', { name: 'Resize sidebar' })
    await expect(handle).toBeVisible()
    const sidebarBox = (await page.locator(selector).boundingBox())!
    const handleBox = (await handle.boundingBox())!
    expect(handleBox.x + handleBox.width).toBe(sidebarBox.x + sidebarBox.width - 1)
    await expect(page.locator('.header-sidebar-control')).toHaveCSS('width', '340px')
  }
  await page.goto('/#/hermes/chat')
  await page.reload()
  await expect(sidebar).toHaveCSS('width', '340px')
  const toggle = page.locator('.studio-page-header .header-sidebar-toggle')
  await toggle.click()
  await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeHidden()
  await toggle.click()
  await expect(sidebar).toHaveCSS('width', '340px')

  await dragSidebar(page, 50)
  await page.mouse.up()
  await expect(sidebar).toHaveCSS('width', '200px')
  await expect(sidebar.locator('.session-item').first()).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('sidebar-min-width.png'), animations: 'disabled' })
  await dragSidebar(page, 900)
  await page.mouse.up()
  await expect(sidebar).toHaveCSS('width', '480px')
  await page.screenshot({ path: testInfo.outputPath('sidebar-max-width.png'), animations: 'disabled' })

  await page.setViewportSize({ width: 769, height: 900 })
  await expect(sidebar).toHaveCSS('width', '369px')
  await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toHaveAttribute('aria-valuemax', '369')
  await expect(page.locator('.header-sidebar-control')).toHaveCSS('width', '369px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(sidebar).toHaveCSS('width', '480px')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.locator('.studio-mobile-navigation .session-list')).toBeVisible()
  await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toBeHidden()
  const drawerSidebar = (await page.locator('.studio-mobile-navigation .session-list').boundingBox())!
  expect(drawerSidebar.x + drawerSidebar.width).toBeLessThanOrEqual(390)
})

test('supports keyboard resizing and releases the drag when focus is lost', async ({ page }) => {
  await setup(page)
  await page.goto('/#/hermes/chat')
  const handle = page.getByRole('separator', { name: 'Resize sidebar' })
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '250')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(handle).toHaveAttribute('aria-valuenow', '210')
  await page.keyboard.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', '200')
  await page.keyboard.press('End')
  await expect(handle).toHaveAttribute('aria-valuenow', '480')
  await expect(page.locator('.session-list')).toHaveCSS('width', '480px')
  await dragSidebar(page, 320)
  await expect(page.locator('.sidebar-resize-shield')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(page.locator('.sidebar-resize-shield')).toHaveCount(0)
  await page.mouse.up()
  await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--resizing-sidebar/)
  await page.getByRole('button', { name: 'Collapse menu', exact: true }).click()
  await expect(handle).toBeHidden()
})

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`keeps resizing usable with ${brightness} theme and wallpaper ${wallpaper}`, async ({ page }, testInfo) => {
      await setup(page, {
        brightness,
        ...(wallpaper ? { background: { name: 'wallpaper.svg', mime: 'image/svg+xml', updatedAt: 1 } } : {}),
        appearance: { global: { opacity: 0.5 }, regions: { sidebar: { opacity: 0, blur: 8, radius: 8 } } },
      })
      await page.route('**/api/theme/background?*', route => route.fulfill({
        contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#789" d="M0 0h16v16H0z"/></svg>',
      }))
      await page.goto('/#/hermes/chat')
      const handle = await dragSidebar(page, 360)
      await page.mouse.up()
      await expect(page.locator('.session-list')).toHaveCSS('width', '360px')
      await expect(page.locator('.header-sidebar-control')).toHaveCSS('width', '360px')
      await handle.focus()
      await expect(handle).toHaveCSS('outline-style', 'solid')
      await page.screenshot({ path: testInfo.outputPath('sidebar-theme.png'), animations: 'disabled' })
    })
  }
}
