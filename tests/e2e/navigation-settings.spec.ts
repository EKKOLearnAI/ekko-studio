import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { defaultNavigationSettings } from '../../packages/shared/navigation-settings'

async function setup(page: Page) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const selections = new Map<number, string[]>()
  let registered = true, active = true, rejectSave = false, navigationWrites = 0
  const wrap = (id: string, extra: object) => ({ manifest: { id, name: id, version: '1.0.0', apiVersion: 1, permissions: ['ui'], client: 'client.mjs', ...extra }, status: 'active', enabled: true, config: {}, tools: [], commands: [], actions: [] })
  const plugins = () => [
    { ...wrap('notes', { name: '笔记插件', views: [{ id: 'home', title: '笔记', slot: 'page' }, { id: 'board', title: '看板', slot: 'page' }], navigation: { main: registered ? [{ viewId: 'home', icon: 'book' }, { viewId: 'board', icon: 'grid' }] : [] } }), status: active ? 'active' : 'disabled' },
    wrap('pages-only', { views: [{ id: 'home', title: '未注册页面', slot: 'page' }] }),
    wrap('settings-only', { views: [{ id: 'settings', title: '仅设置入口', slot: 'settings' }], navigation: { settings: [{ viewId: 'settings', icon: 'settings' }] } }),
    { ...wrap('disabled', { views: [{ id: 'home', title: '已停用入口', slot: 'page' }], navigation: { main: [{ viewId: 'home', icon: 'grid' }] } }), status: 'disabled' },
  ]
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    const authorization = route.request().headers().authorization || ''
    const payload = authorization.split('.')[1]
    const userId = payload ? Number(JSON.parse(Buffer.from(payload, 'base64url').toString()).sub) : 1
    if (path === '/api/navigation') {
      if (route.request().method() === 'PUT') {
        navigationWrites++
        if (rejectSave) return route.fulfill({ status: 500, json: { error: 'Temporary save failure' } })
        selections.set(userId, route.request().postDataJSON().items)
      }
      return route.fulfill({ json: { items: selections.get(userId) || defaultNavigationSettings().items } })
    }
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: userId, username: 'Ekko', role: 'super_admin' } } })
    if (path === '/api/hermes/profiles') return route.fulfill({ json: { profiles: [{ name: 'default' }] } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: plugins() } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: 'export function mount(root){root.innerHTML="<input aria-label=Draft><p>插件工作区</p>"}' } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'navigation-settings', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__navigation_settings__', route => route.fulfill({ contentType: 'text/html', body: `<meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__navigation_settings__#/studio/plugins/notes/home')
  return { errors, selections, writes: () => navigationWrites, setRegistered: (value: boolean) => { registered = value }, setActive: (value: boolean) => { active = value }, rejectSave: (value: boolean) => { rejectSave = value } }
}

async function openSettings(page: Page) {
  await page.locator('.page-sidebar-account-btn').click()
  await page.getByRole('button', { name: '导航栏设置', exact: true }).click()
  await expect(page.locator('.navigation-settings-modal')).toBeVisible()
  await expect(page.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
}

const selectedRows = (page: Page) => page.locator('.navigation-settings-added > li[data-navigation-id]')
const displayedOrder = (page: Page) => selectedRows(page).evaluateAll(rows => rows.map(row => row.getAttribute('data-navigation-id')))

async function beginDrag(page: Page, id: string) {
  const handle = page.locator(`.navigation-settings-added [data-navigation-id="${id}"] .navigation-settings-grip`)
  await expect(handle).toBeEnabled()
  await handle.scrollIntoViewIfNeeded()
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 8, { steps: 3 })
  await expect(page.locator('.navigation-settings-row--fallback')).toBeVisible()
  return box.x + box.width / 2
}

async function dragBefore(page: Page, id: string, targetId: string) {
  const x = await beginDrag(page, id)
  const target = (await page.locator(`.navigation-settings-added [data-navigation-id="${targetId}"]`).boundingBox())!
  await page.mouse.move(x, target.y + target.height * .35, { steps: 12 })
  await expect.poll(async () => {
    const order = await displayedOrder(page)
    return order.indexOf(id) < order.indexOf(targetId)
  }).toBe(true)
  await page.mouse.up()
}

test('opts in only registered entries, persists order, and preserves the underlying workspace', async ({ page }, testInfo) => {
  const fixture = await setup(page)
  const rail = page.locator('.studio-navigation-rail')
  const frame = page.frameLocator('.plugin-workspace iframe')
  await frame.getByRole('textbox', { name: 'Draft' }).fill('保留的草稿')
  await expect(rail.locator('.studio-navigation-rail__plugin')).toHaveCount(0)
  await expect(rail.getByRole('link', { name: '插件中心', exact: true })).toBeVisible()
  await expect(rail.locator('.studio-navigation-rail__bottom').getByRole('link', { name: '设置', exact: true })).toBeVisible()
  const route = page.url()
  await openSettings(page)
  const modal = page.locator('.navigation-settings-modal'), candidates = modal.locator('.navigation-settings-candidates')
  await expect(modal.getByRole('button', { name: '主题', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '插件中心', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '设置', exact: true })).toHaveCount(0)
  await expect(candidates.locator('li[data-navigation-id]')).toHaveCount(2)
  await expect(candidates).not.toContainText('未注册页面')
  await expect(candidates).not.toContainText('仅设置入口')
  await expect(candidates).not.toContainText('已停用入口')
  await modal.getByRole('button', { name: '添加笔记', exact: true }).click()
  await expect(rail.getByRole('link', { name: '笔记', exact: true })).toBeVisible()
  await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
  const selected = modal.locator('.navigation-settings-added')
  await selected.getByRole('button', { name: '上移笔记', exact: true }).click()
  await expect.poll(() => fixture.selections.get(1)?.at(-2)).toBe('plugin:notes/home')
  await dragBefore(page, 'plugin:notes/home', 'usage')
  await expect.poll(() => fixture.selections.get(1)?.indexOf('plugin:notes/home')).toBe(8)
  await modal.getByRole('button', { name: '移除群聊', exact: true }).click()
  await expect(rail.getByRole('link', { name: '群聊', exact: true })).toHaveCount(0)
  await modal.getByRole('button', { name: '添加群聊', exact: true }).click()
  await expect(rail.getByRole('link', { name: '群聊', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('navigation-settings-light.png') })
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
  expect(page.url()).toBe(route)
  await expect(frame.getByRole('textbox', { name: 'Draft' })).toHaveValue('保留的草稿')
  await page.reload()
  await expect(rail.getByRole('link', { name: '笔记', exact: true })).toBeVisible()
  fixture.setRegistered(false)
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(rail.getByRole('link', { name: '笔记', exact: true })).toHaveCount(0)
  await openSettings(page)
  await expect(modal.locator('.navigation-settings-candidates [data-navigation-id^="plugin:"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  fixture.setRegistered(true)
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(rail.getByRole('link', { name: '笔记', exact: true })).toBeVisible()
  fixture.setActive(false)
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(rail.getByRole('link', { name: '笔记', exact: true })).toHaveCount(0)
  fixture.setActive(true)
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(rail.getByRole('link', { name: '笔记', exact: true })).toBeVisible()
  await page.evaluate(() => (window as any).pluginFixture.account(2, 'admin'))
  await expect(rail.locator('.studio-navigation-rail__plugin')).toHaveCount(0)
  expect(fixture.errors).toEqual([])
})

test('shows the live drop position, saves once on release, and restores a failed drag', async ({ page }, testInfo) => {
  const fixture = await setup(page)
  const initial = ['chat', 'group', 'workflow', 'history', 'studioPlugins']
  fixture.selections.set(1, initial)
  await page.reload()
  await openSettings(page)
  const x = await beginDrag(page, 'history')
  await expect(page.locator('.navigation-settings-added .navigation-settings-row--ghost')).toBeVisible()
  const target = (await selectedRows(page).first().boundingBox())!
  await page.mouse.move(x, target.y + target.height * .35, { steps: 12 })
  await expect.poll(async () => (await displayedOrder(page))[0]).toBe('history')
  expect(fixture.writes()).toBe(0)
  expect(fixture.selections.get(1)).toEqual(initial)
  await page.screenshot({ path: testInfo.outputPath('navigation-drag-placeholder.png') })
  await page.mouse.up()
  const sorted = ['history', 'chat', 'group', 'workflow', 'studioPlugins']
  await expect.poll(() => fixture.selections.get(1)).toEqual(sorted)
  expect(fixture.writes()).toBe(1)
  await expect(page.locator('.navigation-settings-row--fallback')).toHaveCount(0)
  fixture.rejectSave(true)
  await dragBefore(page, 'studioPlugins', 'history')
  await expect(page.getByText('保存失败，已恢复之前的设置。', { exact: true })).toBeVisible()
  await expect.poll(() => displayedOrder(page)).toEqual(sorted)
  expect(fixture.selections.get(1)).toEqual(sorted)
  expect(fixture.errors).toEqual([])
})

test('supports touch handles and scrolls long lists while dragging', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  try {
    const fixture = await setup(page)
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('.studio-mobile-navigation .page-sidebar-account-btn').click()
    await page.getByRole('button', { name: '导航栏设置', exact: true }).click()
    const modal = page.locator('.navigation-settings-modal')
    await expect(modal).toBeVisible()
    await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
    const session = await context.newCDPSession(page)
    const handle = modal.locator('[data-navigation-id="person"] .navigation-settings-grip')
    await expect(handle).toBeEnabled()
    await handle.scrollIntoViewIfNeeded()
    const start = (await handle.boundingBox())!
    const x = start.x + start.width / 2, y = start.y + start.height / 2
    const touch = (type: string, nextX = x, nextY = y) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: nextX, y: nextY, radiusX: 2, radiusY: 2 }] })
    await touch('touchStart')
    // Wait for the library's hold activation, independently of machine speed.
    await expect(modal.locator('[data-navigation-id="person"]')).toHaveClass(/navigation-settings-row--chosen/)
    await touch('touchMove', x, y + 12)
    await expect(page.locator('.navigation-settings-row--fallback')).toBeVisible()
    const editor = modal.locator('.navigation-settings-editor'), edge = (await editor.boundingBox())!
    await touch('touchMove', x + 30, edge.y + edge.height - 12)
    await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(80)
    expect(fixture.writes()).toBe(0)
    const last = modal.locator('.navigation-settings-added [data-navigation-id="apiRelay"]')
    await expect(last).toBeInViewport()
    const destination = (await last.boundingBox())!
    await touch('touchMove', x, destination.y + destination.height * .35)
    await expect.poll(async () => (await displayedOrder(page)).indexOf('person')).toBeGreaterThan(0)
    await page.screenshot({ path: testInfo.outputPath('navigation-touch-drag.png') })
    await touch('touchEnd')
    await expect.poll(fixture.writes).toBe(1)
    await expect.poll(() => fixture.selections.get(1)?.indexOf('person')).toBeGreaterThan(0)
    await expect(page.locator('.navigation-settings-row--fallback')).toHaveCount(0)
    expect(fixture.errors).toEqual([])
  } finally { await context.close() }
})

test('rolls back failed saves and supports dark wallpaper, reset, and narrow layouts', async ({ page }, testInfo) => {
  const fixture = await setup(page)
  await openSettings(page)
  const modal = page.locator('.navigation-settings-modal')
  fixture.rejectSave(true)
  await modal.getByRole('button', { name: '添加笔记', exact: true }).click()
  await expect(page.getByText('保存失败，已恢复之前的设置。', { exact: true })).toBeVisible()
  await expect(page.locator('.studio-navigation-rail__plugin')).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '添加笔记', exact: true })).toBeEnabled()
  fixture.rejectSave(false)
  await modal.getByRole('button', { name: '添加笔记', exact: true }).click()
  await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
  await page.evaluate(async () => {
    await (window as any).pluginFixture.theme(true)
    ;(window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .8 }, regions: { overlay: { backgroundColor: '#243445', opacity: .75, blur: 4, radius: 18 }, card: { opacity: 0 } } } })
    ;(window as any).pluginFixture.wallpaper(true)
  })
  await expect.poll(() => modal.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(36, 52, 69, 0.75)')
  await expect.poll(() => modal.locator('.navigation-settings-added').evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/rgba\(.+, 0\)/)
  await page.screenshot({ path: testInfo.outputPath('navigation-settings-dark-wallpaper.png') })
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: {}, regions: {} } }); (window as any).pluginFixture.wallpaper(false) })
  await expect.poll(() => modal.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(36, 52, 69, 0.75)')
  await page.screenshot({ path: testInfo.outputPath('navigation-settings-dark.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(modal).toBeVisible()
  await modal.getByRole('textbox', { name: '搜索入口或插件名称' }).fill('看板')
  await expect(modal.locator('.navigation-settings-candidates [data-navigation-id]')).toHaveCount(1)
  await modal.getByRole('button', { name: '添加看板', exact: true }).click()
  await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
  await modal.getByRole('button', { name: '上移看板', exact: true }).click()
  await expect.poll(() => fixture.selections.get(1)?.at(-2)).toBe('plugin:notes/board')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const box = await modal.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(391)
  await page.screenshot({ path: testInfo.outputPath('navigation-settings-mobile.png') })
  await modal.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect.poll(() => fixture.selections.get(1)).toEqual(defaultNavigationSettings().items)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.locator('.studio-mobile-navigation .page-sidebar-account-btn').click()
  await page.getByRole('button', { name: '导航栏设置', exact: true }).click()
  await expect(modal).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal).not.toBeVisible()
  expect(fixture.errors).toEqual([])
})

test('keeps other settings in place and recovers from an empty navigation selection', async ({ page }, testInfo) => {
  const fixture = await setup(page)
  fixture.selections.set(1, ['chat', 'group', 'workflow', 'history', 'studioPlugins'])
  await page.reload()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.evaluate(() => (window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: {}, regions: {} } }))
  await openSettings(page)
  const modal = page.locator('.navigation-settings-modal')
  await expect(modal.getByRole('button', { name: '主题', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '设置', exact: true })).toHaveCount(0)
  await expect(modal.getByRole('button', { name: '插件中心', exact: true })).toHaveCount(0)
  await expect.poll(async () => Math.round((await modal.boundingBox())!.width)).toBe(820)
  await modal.getByRole('textbox', { name: '搜索入口或插件名称' }).fill('笔记插件')
  await modal.getByRole('button', { name: '添加笔记', exact: true }).click()
  await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
  await modal.locator('.navigation-settings-editor').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('navigation-settings-focused.png'), animations: 'disabled' })
  for (const name of ['单聊', '群聊', '工作流', '历史', '插件中心', '笔记']) {
    await modal.getByRole('button', { name: '移除' + name, exact: true }).click()
    await expect(modal.locator('.navigation-settings-footer')).toContainText('所有更改已保存')
  }
  await expect(modal.getByText('尚未添加入口，可在下方添加。', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(page.locator('.studio-navigation-rail__nav a')).toHaveCount(0)
  await expect(page.locator('.studio-navigation-rail__bottom').getByRole('link', { name: '设置', exact: true })).toBeVisible()
  await openSettings(page)
  await modal.getByRole('button', { name: '恢复默认', exact: true }).click()
  await expect.poll(() => fixture.selections.get(1)).toEqual(defaultNavigationSettings().items)
  expect(fixture.errors).toEqual([])
})
