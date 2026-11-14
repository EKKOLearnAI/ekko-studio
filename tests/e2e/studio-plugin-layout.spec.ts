import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

test('plugins own the available content window while host navigation stays usable', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const plugin = { manifest: { id: 'layout', name: 'Layout demo', version: '1.0.0', apiVersion: 1,
    client: 'client.mjs', permissions: ['ui'], views: ['page', 'workspace', 'settings', 'agent-settings'].map(slot => ({ id: slot, title: slot, slot, icon: 'settings' })) },
    enabled: true, status: 'active', config: {}, tools: [], commands: [], actions: [] }
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/health') return route.fulfill({ json: { status: 'ok', node_version: '24.0.0' } })
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [plugin] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: `export function mount(root,ctx) {
      root.dataset.view = ctx.view;
      root.innerHTML = '<div id="canvas" style="height:100vh;padding:18px;display:flex;flex-direction:column"><h2>Plugin owns this window</h2><div id="scroll" tabindex="0" style="flex:1;min-height:0;overflow:auto"><div style="height:1500px">Plugin scroll area</div><button>Plugin end</button></div></div>';
    }` } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'layout', events: [] } })
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default', active: true, alias: '', model: '' }] } })
    if (path === '/api/hermes/available-models') return route.fulfill({ json: { groups: [{ provider: 'test', label: 'Test', models: ['local'] }], profiles: [], allProviders: [], default: 'local', default_provider: 'test' } })
    if (path === '/api/studio/agents' || path.endsWith('/agent-status')) return route.fulfill({ json: { agents: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__plugin_layout__?shell=1', route => route.fulfill({ contentType: 'text/html',
    body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_layout__?shell=1#/studio/plugins/layout/page')
  const frame = page.frameLocator('.plugin-workspace iframe')
  const measure = async () => ({
    host: await page.evaluate(() => {
      const selectors = ['.app-layout', '.app-main', '.workspace-content', '.plugin-frame', '.plugin-workspace iframe']
      return Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector)!, rect = element.getBoundingClientRect(), style = getComputedStyle(element)
        return [selector, { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height, padding: style.padding, margin: style.margin,
          border: style.borderWidth, radius: style.borderRadius, shadow: style.boxShadow,
          overflow: element.scrollHeight > element.clientHeight }]
      }))
    }),
    content: await frame.locator('#root').evaluate(element => {
      const rect = element.getBoundingClientRect(), canvas = element.querySelector('#canvas')!, style = getComputedStyle(element)
      return { x: rect.x, y: rect.y, width: rect.width, padding: style.padding,
        canvasPadding: getComputedStyle(canvas).padding, canvasHeight: canvas.getBoundingClientRect().height,
        viewportWidth: innerWidth, viewportHeight: innerHeight }
    }),
  })
  const checkWindow = async (name: string, view = 'agent-settings') => {
    const shell = page.locator('.app-shell')
    if (page.viewportSize()!.width <= 768) {
      await expect(shell).not.toHaveClass(/app-shell--navigation-rail/)
      await expect(page.locator('.plugin-workspace > .workspace-header')).toBeVisible()
      if (await page.locator('.plugin-config-sidebar').count()) await expect(page.locator('.plugin-config-sidebar')).not.toBeInViewport()
    } else {
      await expect(shell).toHaveClass(/app-shell--navigation-rail/)
    }
    await expect(frame.locator('#root')).toHaveAttribute('data-view', view)
    await expect(frame.locator('#canvas')).toBeVisible()
    const data = await measure()
    await writeFile(testInfo.outputPath(name + '.json'), JSON.stringify(data, null, 2))
    await page.screenshot({ path: testInfo.outputPath(name + '.png') })
    const host = data.host, content = data.content, viewport = page.viewportSize()!
    expect(host['.app-layout'].right).toBeCloseTo(viewport.width, 0)
    expect(host['.app-layout'].bottom).toBeCloseTo(viewport.height, 0)
    for (const selector of ['.plugin-frame', '.plugin-workspace iframe']) {
      expect(host[selector].x).toBeCloseTo(host['.workspace-content'].x, 0)
      expect(host[selector].y).toBeCloseTo(host['.workspace-content'].y, 0)
      expect(host[selector].right).toBeCloseTo(host['.workspace-content'].right, 0)
      expect(host[selector].bottom).toBeCloseTo(host['.workspace-content'].bottom, 0)
      expect(host[selector].border).toBe('0px')
      expect(host[selector].radius).toBe('0px')
      expect(host[selector].shadow).toBe('none')
    }
    expect(host['.workspace-content'].padding).toBe('0px')
    expect(host['.workspace-content'].overflow).toBe(false)
    expect(host['.app-main'].border).toBe('0px')
    expect(host['.app-main'].radius).toBe('0px')
    expect(host['.app-main'].shadow).toBe('none')
    expect(content.x).toBe(0)
    expect(content.y).toBe(0)
    expect(content.padding).toBe('0px')
    expect(content.width).toBe(content.viewportWidth)
    expect(content.canvasHeight).toBe(content.viewportHeight)
    expect(content.canvasPadding).toBe('18px')
    await expect(page.locator('.workspace-header .back-link')).toBeVisible()
    await expect(page.locator('.workspace-header').getByRole('button', { name: '管理插件', exact: true })).toBeVisible()
  }
  await checkWindow('page-light', 'page')
  for (const route of ['/studio/plugins/layout/workspace', '/studio/plugin-settings/layout/settings', '/studio/plugin-agent-settings/layout/agent-settings']) {
    await page.evaluate(path => (window as any).pluginFixture.navigate(path), route)
    await checkWindow(route.split('/').at(-1)!, route.split('/').at(-1)!)
  }
  await expect(page.locator('.plugin-config-sidebar')).toBeVisible()
  const expandedWidth = (await page.locator('.plugin-config-sidebar').boundingBox())!.width
  const toggle = page.locator('.studio-page-header .header-sidebar-toggle')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(async () => (await page.locator('.plugin-config-sidebar').boundingBox())!.width).toBeCloseTo(expandedWidth, 0)
  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(true)
    fixture.wallpaper(true)
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .7, radius: 24 },
      regions: { card: { opacity: 0, radius: 28 }, content: { radius: 32, shadow: .4 } } } })
  })
  await checkWindow('dark-wallpaper')
  await page.setViewportSize({ width: 390, height: 844 })
  await checkWindow('narrow')
  await page.setViewportSize({ width: 640, height: 320 })
  await checkWindow('short')
  const scroller = frame.locator('#scroll')
  await scroller.focus()
  await page.keyboard.press('End')
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await frame.getByRole('button', { name: 'Plugin end' }).focus()
  await expect(frame.getByRole('button', { name: 'Plugin end' })).toBeInViewport()
  await page.setViewportSize({ width: 1280, height: 720 })
  const back = page.locator('.workspace-header .back-link')
  const destination = (await back.getAttribute('href'))!
  await back.click()
  await expect.poll(() => page.url().endsWith(destination)).toBe(true)
  await expect(page.locator('.plugin-workspace')).toHaveCount(0)
  await expect(page.locator('.app-layout')).not.toHaveClass(/app-layout--plugin/)
  await expect.poll(() => page.locator('.app-layout').evaluate(element => element.getBoundingClientRect().right)).toBe(1275)
  expect(errors).toEqual([])
})
