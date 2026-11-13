import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('keeps global entries independent and opens a three-page Agent settings sidebar with line icons', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII='
  let main = true, settings = true
  const wrap = (manifest: object) => ({ manifest, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] })
  const plugins = () => [
    wrap({ id: 'omp', name: 'Oh My Pi', version: '0.1.7', apiVersion: 1, permissions: ['agents', 'ui'], client: 'client.mjs', navigation: {}, views: [
      { id: 'skills', title: 'Skill 管理', slot: 'agent-settings', icon: 'skills' },
      { id: 'mcp', title: 'MCP 管理', slot: 'agent-settings', icon: 'mcp' },
      { id: 'settings', title: '配置编辑', slot: 'agent-settings', icon: 'settings' },
    ] }),
    wrap({ id: 'entry-demo', name: 'Entry demo', version: '1.0.0', apiVersion: 1, permissions: ['ui'], client: 'client.mjs', views: [{ id: 'home', title: 'Home', slot: 'page' }], navigation: {
      main: main ? [{ viewId: 'home', title: '主入口', icon: image }] : [],
      settings: settings ? [{ viewId: 'home', title: '设置入口', icon: 'code' }] : [],
    } }),
  ]
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: plugins() } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [{ id: 'plugin:omp/omp', name: 'Oh My Pi', vendor: 'Stencil Labs', origin: 'plugin', modes: ['global', 'scoped'], surfaces: ['chat'], actions: { settings: true, checkUpdate: false, upgrade: false }, status: { installed: false, version: '' } }] } })
    if (path === '/api/studio/agents/plugin:omp/omp/settings') return route.fulfill({ json: { name: 'studio.pluginAgentSettings', params: { pluginId: 'omp', viewId: 'skills' } } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: 'export function mount(root,ctx){root.textContent=ctx.slot+":"+ctx.view}' } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'entry-test', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__independent_entries__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__independent_entries__#/hermes/agentManager')
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(1)
  await expect(page.getByRole('link', { name: '主入口', exact: true }).locator('img')).toHaveAttribute('src', image)
  await page.getByTestId('agent-card-plugin:omp/omp').getByRole('button', { name: '设置', exact: true }).click()
  const sidebar = page.locator('.plugin-config-sidebar'), frame = page.frameLocator('.plugin-workspace iframe')
  await expect(sidebar.locator('.plugin-config-nav a')).toHaveCount(3)
  await expect(sidebar.locator('.plugin-config-nav svg')).toHaveCount(3)
  await expect(sidebar.locator('img')).toHaveCount(0)
  await expect(frame.locator('#root')).toHaveText('agent-settings:skills')
  await sidebar.getByRole('link', { name: 'MCP 管理', exact: true }).click()
  await page.reload()
  await expect(frame.locator('#root')).toHaveText('agent-settings:mcp')
  await page.screenshot({ path: testInfo.outputPath('agent-settings-light.png') })
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true); (window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .7 }, regions: { sidebar: { opacity: 0, blur: 4, radius: 12, backgroundColor: '#315a76' } } } }); (window as any).pluginFixture.wallpaper(true) })
  await page.screenshot({ path: testInfo.outputPath('agent-settings-dark-wallpaper.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('.studio-mobile-navigation').getByRole('link', { name: '配置编辑', exact: true }).click()
  await expect(frame.locator('#root')).toHaveText('agent-settings:settings')
  await expect(page.locator('.studio-mobile-navigation')).not.toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => (window as any).pluginFixture.navigate('/hermes/settings'))
  await expect(page.locator('.sidebar').getByRole('link', { name: '设置入口', exact: true }).locator('svg')).toHaveCount(1)
  await expect(page.locator('.sidebar').getByRole('link', { name: '设置入口', exact: true }).locator('img')).toHaveCount(0)
  await expect(page.locator('.sidebar a[href*="/omp/"]')).toHaveCount(0)
  main = false
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  await expect(page.locator('.sidebar').getByRole('link', { name: '设置入口', exact: true })).toBeVisible()
  settings = false
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(page.locator('.sidebar').getByRole('link', { name: '设置入口', exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/entry-demo/home'))
  await expect(frame.locator('#root')).toHaveText('page:home')
  expect(errors).toEqual([])
})

test('exposes plugin navigation, settings and workspaces on desktop and mobile', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let active = true
  const icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII='
  const plugin = () => ({ manifest: { id: 'rooms', name: 'Team rooms', version: '1.0.0', apiVersion: 1, client: 'client.mjs', permissions: ['ui'],
    author: { name: 'Example author' }, repository: 'https://example.com/repo', documentation: 'https://example.com/docs', license: 'MIT', keywords: ['collaboration'], icon,
    navigation: { main: [{ viewId: 'dashboard', icon }, { viewId: 'rooms', title: 'Team rooms', icon: 'chat' }], settings: [{ viewId: 'preferences', icon: 'settings' }] }, workspace: { sidebar: 'room-list' }, views: [
      { id: 'dashboard', title: 'Dashboard', slot: 'page', order: 0 },
      { id: 'history', title: 'History', slot: 'workspace', icon: 'history', order: 2 },
      { id: 'rooms', title: 'Rooms', slot: 'workspace', icon: 'chat', order: 1 },
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
  await expect(page.getByRole('dialog').getByText('Example author', { exact: true })).toBeVisible()
  await expect(page.locator('.detail-identity img')).toHaveAttribute('src', icon)
  await page.keyboard.press('Escape')
  const rail = page.locator('.studio-navigation-rail')
  await expect(rail.getByRole('link', { name: '插件中心', exact: true })).toBeVisible()
  await expect(rail.locator('.studio-navigation-rail__plugins a')).toHaveCount(2)
  await expect(rail.getByRole('link', { name: 'Room settings' })).toHaveCount(0)
  await rail.getByRole('link', { name: 'Dashboard', exact: true }).click()
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
  await expect(sidebar.locator('.plugin-config-nav-item .plugin-navigation-icon').first()).toBeVisible()
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
  await page.locator('.sidebar').getByRole('link', { name: 'Room settings', exact: true }).click()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('settings:preferences:none')
  await page.reload()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('settings:preferences:none')
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/rooms/rooms'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await expect(page.locator('.studio-mobile-navigation .plugin-config-sidebar')).toBeVisible()
  await expect(page.locator('.studio-mobile-navigation a[href*="/studio/plugin-settings/"]')).toHaveCount(0)
  await expect(page.locator('.studio-mobile-navigation .studio-navigation-rail').getByRole('link', { name: '插件中心', exact: true })).toBeVisible()
  await expect(page.locator('.studio-mobile-navigation .studio-navigation-rail__plugins a')).toHaveCount(2)
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

test('keeps plugin headers fixed while center and page content scroll on desktop and narrow windows', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const plugins = Array.from({ length: 18 }, (_, index) => ({ manifest: {
    id: `demo-${index}`, name: `Demo ${index}`, description: 'Plugin content for scrolling verification.', version: '1.0.0', apiVersion: 1,
    client: 'client.mjs', permissions: ['ui'], views: [{ id: 'home', title: `Page ${index}`, slot: 'page' }], navigation: { main: [{ viewId: 'home', icon: 'grid' }] },
  }, source: `/tmp/demo-${index}`, enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [] }))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: 'export function mount(root){const content=document.createElement("div");content.style.minHeight="2400px";content.textContent="Plugin page content";root.append(content)}' } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'layout', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_layout__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_layout__')
  await expect(page.locator('.plugin-card')).toHaveCount(18)
  const header = page.locator('.center-header'), scroll = page.locator('.center-scroll')
  await expect(page.locator('.studio-page-header .center-header')).toBeVisible()
  const top = (await header.boundingBox())!.y
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
  expect((await header.boundingBox())!.y).toBe(top)
  await expect(header.getByRole('button', { name: '刷新', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugins-fixed-header-light.png') })
  const lightText = await header.evaluate(element => getComputedStyle(element).color)
  await page.evaluate(async () => {
    await (window as any).pluginFixture.theme(true)
    ;(window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: 0.7 }, regions: { card: { opacity: 0, blur: 4, radius: 12 } } } })
    ;(window as any).pluginFixture.wallpaper(true)
  })
  await expect.poll(() => header.evaluate(element => getComputedStyle(element).color)).not.toBe(lightText)
  await page.screenshot({ path: testInfo.outputPath('plugins-fixed-header-dark-wallpaper.png') })
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } }); (window as any).pluginFixture.wallpaper(false) })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.studio-plugins > .center-header')).toBeVisible()
  await scroll.evaluate(element => { element.scrollTop = 0 })
  const narrowTop = (await header.boundingBox())!.y
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  expect((await header.boundingBox())!.y).toBe(narrowTop)
  await page.screenshot({ path: testInfo.outputPath('plugins-fixed-header-mobile.png') })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('.studio-mobile-navigation').getByRole('link', { name: 'Page 0', exact: true }).click()
  await expect(page.locator('.studio-mobile-navigation')).not.toBeVisible()
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toContainText('Plugin page content')
  await page.setViewportSize({ width: 390, height: 400 })
  const workspaceHeader = page.locator('.workspace-header'), workspace = page.locator('.workspace-content')
  const workspaceTop = (await workspaceHeader.boundingBox())!.y
  await workspace.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => workspace.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect((await workspaceHeader.boundingBox())!.y).toBe(workspaceTop)
  await expect(workspaceHeader.getByRole('button', { name: '管理插件', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugins-page-fixed-header-short-window.png') })
  expect(errors).toEqual([])
})
