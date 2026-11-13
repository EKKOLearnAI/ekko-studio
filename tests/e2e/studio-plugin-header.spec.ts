import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('keeps the sidebar toggle before the teleported plugin header when the catalog arrives late', async ({ page }, testInfo) => {
  let releaseCatalog!: () => void
  const catalogReady = new Promise<void>(resolve => { releaseCatalog = resolve })
  const plugin = { manifest: { id: 'omp', name: 'Oh My Pi', version: '1.0.0', apiVersion: 1, client: 'client.mjs', permissions: ['ui'], views: [{ id: 'settings', title: 'Settings', slot: 'agent-settings', icon: 'settings' }] },
    enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [] }
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/health') return route.fulfill({ json: { status: 'ok', node_version: '24.0.0' } })
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') { await catalogReady; return route.fulfill({ json: { revision: 1, plugins: [plugin] } }) }
    if (path.endsWith('/client')) return route.fulfill({ json: { source: 'export function mount(root){root.textContent="Plugin settings"}' } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'header', events: [] } })
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true, alias: '', model: '' }] } })
    if (path === '/api/hermes/available-models') return route.fulfill({ json: { groups: [{ provider: 'test', label: 'Test', models: ['local'] }], profiles: [], allProviders: [], default: 'local', default_provider: 'test' } })
    if (path === '/api/studio/agents' || path.endsWith('/agent-status')) return route.fulfill({ json: { agents: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_header__?shell=1', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_header__?shell=1#/studio/plugin-agent-settings/omp/settings')
  const header = page.locator('.studio-page-header .workspace-header')
  await expect(header).toBeVisible()
  await expect(page.locator('.studio-page-header .header-sidebar-control')).toBeHidden()
  releaseCatalog()
  const toggle = page.locator('.studio-page-header .header-sidebar-toggle')
  const sidebar = page.locator('.plugin-config-sidebar')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.frameLocator('.plugin-workspace iframe').locator('#root')).toHaveText('Plugin settings')
  await page.screenshot({ path: testInfo.outputPath('plugin-header-expanded-light.png') })
  const assertOrder = async () => {
    const button = (await toggle.boundingBox())!, heading = (await header.boundingBox())!
    expect(button.x + button.width).toBeLessThanOrEqual(heading.x + 1)
    const control = (await page.locator('.studio-page-header .header-sidebar-control').boundingBox())!
    const sidebar = (await page.locator('.plugin-config-sidebar').boundingBox())!
    expect(Math.abs(control.x - sidebar.x)).toBeLessThan(2)
    expect(heading.x + heading.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  }
  await assertOrder()
  await toggle.focus()
  await page.keyboard.press('Tab')
  await expect(header.locator('.back-link')).toBeFocused()
  const expandedWidth = (await sidebar.boundingBox())!.width
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar).toHaveClass(/collapsed/)
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeLessThan(100)
  await assertOrder()
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(expandedWidth, 0)
  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(true)
    fixture.wallpaper(true)
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .7 }, regions: { chrome: { opacity: 0, blur: 4, radius: 12, backgroundColor: '#315a76' } } } })
  })
  await assertOrder()
  await page.screenshot({ path: testInfo.outputPath('plugin-header-dark-wallpaper.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(toggle).toBeHidden()
  await expect(sidebar).not.toBeInViewport()
  await expect(page.locator('.plugin-workspace > .workspace-header')).toBeVisible()
  await expect(page.locator('.workspace-header').getByRole('button', { name: '管理插件', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('plugin-header-mobile.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(toggle).toBeVisible()
  await assertOrder()
  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(false)
    fixture.wallpaper(false)
    fixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } })
  })
  await assertOrder()
})
