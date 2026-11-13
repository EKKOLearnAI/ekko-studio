import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const repository = 'https://github.com/example/notes', directory = '/projects/notes'
const releaseSource = 'github:example/notes#' + 'b'.repeat(40)
async function setup(page: Page, options: { development?: boolean; packaged?: boolean; failed?: boolean; version?: string; empty?: boolean } = {}) {
  const manifest = { id: 'notes', name: 'Lifecycle Notes', description: 'Plugin lifecycle fixture', apiVersion: 1, version: options.version || '0.1.6', repository, permissions: ['tools'] }
  const original = { manifest, source: options.packaged ? releaseSource : directory, installedAt: 1, enabled: true,
    status: options.failed ? 'failed' : 'active', developmentDirectory: options.development ? directory : undefined,
    config: { prefix: 'saved setting' }, tools: [], commands: [], actions: [] }
  const state = { revision: 1, installed: options.empty ? undefined : structuredClone(original) as typeof original | undefined, linked: !!options.development,
    published: '0.1.4', failInstall: false, failUninstall: false, starts: 0, unlinks: 0,
    installGate: undefined as Promise<void> | undefined, developmentGate: undefined as Promise<void> | undefined }
  const installs: any[] = [], patches: any[] = []
  await page.route(url => url.hostname === 'api.ekkostudio.xyz', route => route.fulfill({ json: { ok: true, data: {
    list: [{ id: 'a'.repeat(64), name: manifest.name, description: manifest.description, repository, manifestId: 'notes',
      apiVersion: 1, version: state.published, sourceCommit: 'b'.repeat(40), installSource: releaseSource, permissions: ['tools'], repositoryStars: 42 }],
    total: 1, page: 1, pageSize: 100,
  } } }))
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url()), body = request.postData() ? request.postDataJSON() : {}
    if (url.pathname === '/api/studio/plugins') return route.fulfill({ json: { revision: state.revision, plugins: state.installed ? [state.installed] : [] } })
    if (url.pathname === '/api/studio/plugins/development') return route.fulfill({ json: { projects: state.linked ? [{ id: 'notes', directory, manifest,
      status: state.installed?.developmentDirectory ? 'watching' : 'registered', watching: !!state.installed?.developmentDirectory }] : [] } })
    if (url.pathname === '/api/studio/plugins/notes/development') {
      if (request.method() === 'DELETE') {
        expect(url.searchParams.get('revision')).toBe(String(state.revision)); state.linked = false; state.unlinks++
        if (state.installed) state.installed.developmentDirectory = undefined
      } else {
        expect(body).toEqual({ revision: state.revision, trusted: true }); state.starts++
        await state.developmentGate
        state.installed = { ...structuredClone(original), developmentDirectory: directory, installedAt: state.revision + 1 }
      }
      state.revision++; return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/studio/plugins/install') {
      installs.push(body)
      expect(body).toEqual(body.source === releaseSource
        ? { source: releaseSource, pluginId: 'notes', expectedVersion: state.published, revision: state.revision, trusted: true }
        : { source: directory, revision: state.revision, trusted: true })
      await state.installGate
      if (state.failInstall) return route.fulfill({ status: 422, json: { error: 'Release activation failed' } })
      state.installed = { ...original, manifest: { ...manifest, version: state.published }, source: body.source,
        developmentDirectory: undefined, enabled: state.installed?.enabled || false, status: state.installed?.enabled ? 'active' : 'disabled', installedAt: ++state.revision }
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/studio/plugins/notes' && request.method() === 'PATCH') {
      patches.push(body); expect(body.revision).toBe(state.revision)
      if (body.action === 'uninstall') {
        if (state.failUninstall) return route.fulfill({ status: 409, json: { error: 'Dependent plugin is running' } })
        state.installed = undefined
      } else { state.installed!.enabled = body.enabled; state.installed!.status = body.enabled ? 'active' : 'disabled' }
      state.revision++; return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'lifecycle', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_lifecycle__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_lifecycle__')
  return { state, installs, patches }
}
const all = (page: Page) => page.getByRole('tab', { name: /^全部/ }).click()
const confirm = (page: Page, name: string) => page.locator('.n-dialog').getByRole('button', { name, exact: true }).click()

test('switches a retained newer local copy to the marketplace, then uninstalls, reinstalls and upgrades', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  const { state, installs } = await setup(page)
  const local = page.getByTestId('plugin-card-notes'), market = page.getByTestId('market-plugin-notes')
  await expect(local.getByText('本地版本', { exact: true })).toBeVisible()
  await expect(local.getByRole('button', { name: '安装市场版 v0.1.4', exact: true })).toBeVisible()
  await all(page)
  await expect(market.getByText('已安装', { exact: true })).toHaveCount(0)
  await expect(market.locator('.versions')).toContainText('已安装版本v0.1.6已发布v0.1.4')
  await expect(market.getByText('本地版本高于市场版本', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('retained-local-copy.png'), fullPage: true, animations: 'disabled' })
  await market.getByRole('button', { name: '安装市场版 v0.1.4', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('目标版本可能更旧')
  await confirm(page, '取消'); expect(installs).toHaveLength(0)
  state.failInstall = true
  await market.getByRole('button', { name: '安装市场版 v0.1.4', exact: true }).click()
  await confirm(page, '安装市场版 v0.1.4')
  await expect(page.getByRole('alert')).toContainText('Release activation failed')
  expect(state.installed?.source).toBe(directory)
  state.failInstall = false
  await confirm(page, '安装市场版 v0.1.4')
  await expect(market.getByText('已安装', { exact: true })).toBeVisible()
  await expect(market.locator('.version')).toHaveText('v0.1.4')
  expect(state.installed).toMatchObject({ enabled: true, config: { prefix: 'saved setting' } })
  await market.getByRole('button', { name: '卸载', exact: true }).click(); await confirm(page, '确定')
  await expect(market.getByRole('button', { name: '安装', exact: true })).toBeEnabled()
  await expect(market.getByText('已安装', { exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: /^已安装/ }).click(); await expect(local).toHaveCount(0)
  await all(page); await market.getByRole('button', { name: '安装', exact: true }).click(); await confirm(page, '安装')
  await expect(market.getByText('已安装', { exact: true })).toBeVisible()
  state.published = '0.1.7'
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await market.getByRole('button', { name: '更新到 v0.1.7', exact: true }).click(); await confirm(page, '更新到 v0.1.7')
  await expect(market.locator('.version')).toHaveText('v0.1.7')
  await expect(market.getByRole('button', { name: '更新到 v0.1.7' })).toHaveCount(0)
})

test('uninstalls development copies independently of linking and keeps released enable actions independent of registered projects', async ({ page }, testInfo) => {
  const { state } = await setup(page, { development: true })
  const local = page.getByTestId('plugin-card-notes'), market = page.getByTestId('market-plugin-notes')
  await local.getByRole('button', { name: '卸载', exact: true }).click(); await confirm(page, '确定')
  await expect(local).toHaveCount(0); expect(state.unlinks).toBe(0)
  await all(page); await market.getByRole('button', { name: '安装', exact: true }).click(); await confirm(page, '安装')
  await page.getByRole('tab', { name: /^已安装/ }).click()
  await expect(local.locator('.version')).toHaveText('v0.1.4')
  await expect(local.getByText('开发', { exact: true })).toHaveCount(0)
  await local.getByRole('button', { name: '启用', exact: true }).click()
  await expect(local.getByText('运行中', { exact: true })).toBeVisible(); expect(state.starts).toBe(0)
  await page.getByRole('tab', { name: /开发插件/ }).click()
  await expect(local.locator('.version')).toHaveText('v0.1.6')
  await expect(local.getByRole('button', { name: '卸载', exact: true })).toHaveCount(0)
  await local.getByRole('button', { name: '启用', exact: true }).click(); await confirm(page, '启用')
  await expect.poll(() => state.starts).toBe(1)
  await local.getByRole('button', { name: '解除开发链接', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('已安装副本和插件数据会保留'); await confirm(page, '确定')
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  await expect(local.getByText('本地版本', { exact: true })).toBeVisible()
  await expect(local.getByRole('button', { name: '安装市场版 v0.1.4', exact: true })).toBeVisible()
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true); (window as any).pluginFixture.wallpaper(true) })
  await page.setViewportSize({ width: 390, height: 900 })
  await local.getByRole('button', { name: '卸载', exact: true }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('local-copy-actions-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('rechecks the exact installation before confirmed upgrades and uninstalls', async ({ page }) => {
  const { state, installs, patches } = await setup(page, { packaged: true, version: '0.1.3' })
  const local = page.getByTestId('plugin-card-notes')
  await local.getByRole('button', { name: '更新到 v0.1.4', exact: true }).click()
  state.installed!.manifest = { ...state.installed!.manifest, version: '0.1.7' }; state.revision++
  await confirm(page, '更新到 v0.1.4')
  await expect(page.getByRole('alert')).toContainText('插件状态已改变')
  expect(installs).toHaveLength(0); await confirm(page, '取消')
  await expect(local.getByText('本地版本高于市场版本', { exact: true })).toBeVisible()
  await local.getByRole('button', { name: '卸载', exact: true }).click()
  state.installed!.installedAt++; state.revision++
  await confirm(page, '确定')
  await expect(page.getByRole('alert')).toContainText('插件状态已改变')
  expect(patches).toHaveLength(0); await expect(local).toBeVisible()
})

test('retains installed state after failed uninstall and offers same-version repair for failed packages', async ({ page }) => {
  const { state } = await setup(page, { packaged: true, version: '0.1.4', failed: true })
  const local = page.getByTestId('plugin-card-notes')
  await local.getByRole('button', { name: '重新安装 v0.1.4', exact: true }).click(); await confirm(page, '重新安装 v0.1.4')
  await expect(local.getByText('运行中', { exact: true })).toBeVisible()
  state.failUninstall = true
  await local.getByRole('button', { name: '卸载', exact: true }).click(); await confirm(page, '确定')
  await expect(page.getByRole('alert')).toContainText('Dependent plugin is running')
  await expect(local).toBeVisible(); expect(state.installed).toBeDefined()
})

function heldRequest() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('uses a primary confirmation and shows pending installation until failure or success, without duplicate submits or dismissal', async ({ page }, testInfo) => {
  const { state, installs } = await setup(page, { empty: true })
  const first = heldRequest(); state.installGate = first.promise; state.failInstall = true
  await all(page)
  const market = page.getByTestId('market-plugin-notes'), dialog = page.locator('.n-dialog')
  await market.getByRole('button', { name: '安装', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '安装', exact: true })).toHaveClass(/n-button--primary-type/)
  await expect(dialog.locator('.n-dialog__icon')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('install-confirm-light.png'), animations: 'disabled' })
  await confirm(page, '安装')
  const waiting = dialog.getByRole('button', { name: /正在安装…$/ })
  await expect(waiting).toBeDisabled()
  await expect(waiting.locator('.n-base-loading')).toBeVisible()
  await expect(dialog.getByRole('status')).toContainText('安装可能需要一些时间，请稍候。')
  await expect(dialog.getByRole('status').locator('.n-spin')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeDisabled()
  await expect(dialog.locator('.n-base-close')).toHaveCount(0)
  await waiting.evaluate(button => (button as HTMLButtonElement).click())
  await page.keyboard.press('Escape'); await page.mouse.click(5, 5)
  await expect(dialog).toBeVisible(); await expect.poll(() => installs.length).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('install-pending-light.png'), animations: 'disabled' })
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true); (window as any).pluginFixture.wallpaper(true) })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(dialog).toBeInViewport({ ratio: .95 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('install-pending-dark-mobile.png'), animations: 'disabled' })
  first.release()
  await expect(dialog.getByRole('alert')).toContainText('Release activation failed')
  await expect(dialog.getByRole('button', { name: '安装', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('status')).toHaveCount(0)
  expect(state.installed).toBeUndefined()
  await page.screenshot({ path: testInfo.outputPath('install-error-mobile.png'), animations: 'disabled' })
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } }); (window as any).pluginFixture.wallpaper(false) })
  state.failInstall = false
  const retry = heldRequest(); state.installGate = retry.promise
  await confirm(page, '安装')
  await expect(waiting).toBeDisabled(); await expect(dialog.getByRole('alert')).toHaveCount(0)
  retry.release()
  await expect(dialog).toHaveCount(0)
  await expect(market.getByText('已安装', { exact: true })).toBeVisible()
  expect(installs).toHaveLength(2)
})

test('keeps manual source installation visible with locked inputs until its request completes', async ({ page }) => {
  const { state, installs } = await setup(page, { empty: true })
  const held = heldRequest(); state.installGate = held.promise
  await page.getByRole('button', { name: '安装插件', exact: true }).click()
  const modal = page.locator('.plugin-install-modal')
  await modal.getByRole('textbox').fill(directory); await modal.getByRole('checkbox').check()
  await modal.getByRole('button', { name: '安装', exact: true }).click()
  await expect(modal.getByRole('button', { name: /正在安装…$/ })).toBeDisabled()
  await expect(modal.getByRole('status')).toBeVisible()
  await expect(modal.getByRole('textbox')).toBeDisabled(); await expect(modal.getByRole('checkbox')).toBeDisabled()
  await page.keyboard.press('Escape'); await page.mouse.click(5, 5)
  await expect(modal).toBeVisible(); await expect.poll(() => installs.length).toBe(1)
  held.release()
  await expect(modal).toHaveCount(0)
  await expect(page.getByTestId('plugin-card-notes')).toBeVisible()
})

test('shows build/install feedback for both trusted and first-time development activation', async ({ page }) => {
  const { state } = await setup(page, { empty: true, development: true })
  const held = heldRequest(); state.developmentGate = held.promise
  await page.getByRole('tab', { name: /开发插件/ }).click()
  const card = page.getByTestId('plugin-card-notes'), dialog = page.locator('.n-dialog')
  await card.getByRole('button', { name: '启用', exact: true }).click(); await confirm(page, '启用')
  await expect(dialog.getByRole('button', { name: /正在安装…$/ })).toBeDisabled()
  await expect(dialog.getByRole('status')).toBeVisible(); await expect.poll(() => state.starts).toBe(1)
  held.release(); await expect(dialog).toHaveCount(0)
  await card.getByRole('button', { name: '详情', exact: true }).click()
  const drawer = page.locator('.n-drawer')
  await drawer.getByRole('button', { name: '禁用', exact: true }).click()
  const again = heldRequest(); state.developmentGate = again.promise
  await drawer.getByRole('button', { name: '启用', exact: true }).click()
  await expect(drawer.getByRole('status')).toBeVisible(); await expect(dialog).toHaveCount(0)
  again.release(); await expect(drawer.getByRole('status')).toHaveCount(0)
  await expect(drawer.getByRole('button', { name: '禁用', exact: true })).toBeVisible()
})
