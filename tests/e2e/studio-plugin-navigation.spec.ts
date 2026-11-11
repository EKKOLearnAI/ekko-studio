import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('hides public plugin navigation while direct pages, settings and workspaces remain usable', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let active = true
  const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII='
  const plugin = () => ({ manifest: { id: 'rooms', name: 'Team rooms', version: '1.0.0', apiVersion: 1, client: 'client.mjs', capabilities: ['ui'],
    author: { name: 'Example author' }, repository: 'https://example.com/repo', documentation: 'https://example.com/docs', license: 'MIT', keywords: ['collaboration'], icon,
    workspace: { sidebar: 'room-list' }, views: [
      { id: 'dashboard', title: 'Dashboard', slot: 'page', order: 0 },
      { id: 'history', title: 'History', slot: 'workspace', order: 2 },
      { id: 'rooms', title: 'Rooms', slot: 'workspace', order: 1 },
      { id: 'preferences', title: 'Room settings', slot: 'settings', order: 3 },
    ] }, source: '/tmp/rooms', installedAt: 0, enabled: active, status: active ? 'active' : 'disabled', config: {}, tools: [], commands: [], actions: [] })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: `export function mount(root, ctx) {
      if (ctx.slot === 'workspace-sidebar') { const button = document.createElement('button'); button.textContent = 'Project Alpha'; button.onclick = () => ctx.ui.navigate('/studio/plugins/rooms/rooms?room=alpha'); root.append(button); return }
      root.textContent = ctx.slot + ':' + ctx.view + ':' + (ctx.location.query.room || 'none');
      const input = document.createElement('input'); input.setAttribute('aria-label', 'Draft'); root.append(input);
    }` } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'test', events: [] } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: active ? 1 : 2, plugins: [plugin()] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_navigation__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_navigation__')
  await page.getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByRole('link', { name: '代码仓库' })).toHaveAttribute('href', 'https://example.com/repo')
  await expect(page.getByText('Example author', { exact: true })).toBeVisible()
  await expect(page.locator('.detail-identity img')).toHaveAttribute('src', icon)
  await page.keyboard.press('Escape')
  const rail = page.locator('.studio-navigation-rail')
  await expect(rail.getByRole('link', { name: '插件', exact: true })).toHaveCount(0)
  await expect(rail.locator('.studio-navigation-rail__plugins')).toHaveCount(0)
  await expect(rail.getByRole('link', { name: 'Room settings' })).toHaveCount(0)
  await page.getByRole('button', { name: '详情', exact: true }).click()
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
  await expect(page.locator('.plugin-config-sidebar')).toHaveCount(0)
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('page:dashboard:none')
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/rooms/rooms'))
  const sidebar = page.locator('.plugin-config-sidebar')
  await expect(sidebar.locator('nav > a')).toHaveText(['Rooms', 'History'])
  await sidebar.getByRole('link', { name: 'History', exact: true }).click()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('workspace:history:none')
  await page.frameLocator('.plugin-config-sidebar iframe').getByRole('button', { name: 'Project Alpha' }).click()
  await expect(page).toHaveURL(/rooms\/rooms\?room=alpha$/)
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('workspace:rooms:alpha')
  await page.reload()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('workspace:rooms:alpha')
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await expect(sidebar).toHaveClass(/collapsed/)
  await expect(sidebar.locator('.plugin-config-nav-item .plugin-icon').first()).toBeVisible()
  await page.getByRole('button', { name: 'Toggle sidebar' }).click()
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(200)
  const lightColor = await sidebar.evaluate(element => getComputedStyle(element).color)
  await page.screenshot({ path: testInfo.outputPath('plugin-workspace-light.png'), fullPage: true })
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: 0.7 }, regions: { sidebar: { opacity: 0, backgroundColor: '#315a76', blur: 4, radius: 12 } } } }); (window as any).pluginFixture.wallpaper(true) })
  await expect.poll(() => sidebar.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(49, 90, 118, 0)')
  await expect.poll(() => sidebar.evaluate(element => getComputedStyle(element).color)).not.toBe(lightColor)
  await page.screenshot({ path: testInfo.outputPath('plugin-workspace-dark-wallpaper.png'), fullPage: true })
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } }); (window as any).pluginFixture.wallpaper(false) })
  await expect.poll(() => sidebar.evaluate(element => getComputedStyle(element).color)).toBe(lightColor)
  await rail.getByRole('link', { name: '设置', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.sidebar').getByRole('link', { name: 'Room settings', exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugin-settings/rooms/preferences'))
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('settings:preferences:none')
  await page.reload()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('settings:preferences:none')
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/rooms/rooms'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.locator('.studio-mobile-navigation .plugin-config-sidebar')).toBeVisible()
  await expect(page.locator('.studio-mobile-navigation a[href*="/studio/plugin-settings/"]')).toHaveCount(0)
  await expect(page.locator('.studio-mobile-navigation .studio-navigation-rail a[href*="/studio/plugins"]')).toHaveCount(0)
  await page.locator('.studio-mobile-navigation').getByRole('link', { name: 'History', exact: true }).click()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('workspace:history:none')
  await expect(page.locator('.studio-mobile-navigation')).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-workspace-mobile.png'), fullPage: true })
  active = false
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.plugin-config-sidebar')).toHaveCount(0)
  await expect(page.getByText('插件已禁用，请在插件中心启用。')).toBeVisible()
  expect(errors).toEqual([])
})
