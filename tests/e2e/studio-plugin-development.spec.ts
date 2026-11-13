import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')

test('shows development projects as regular cards, enables them and unlinks while retaining installed plugins', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let revision = 0, watching = false, installed = false, enabled = false, linked = true, starts = 0, unlinks = 0, error = '', content = 'first build'
  const directory = '/projects/independent-notes'
  const manifest = { id: 'notes', name: 'Dev Notes', description: 'Notes for the project', version: '0.1.0', apiVersion: 1, client: 'client.mjs', permissions: ['ui'], configSchema: { type: 'object', properties: { prefix: { type: 'string', title: 'Prefix' } } }, views: [{ id: 'home', title: 'Dev Notes', slot: 'page' }] }
  const plugin = () => ({ manifest, source: directory, installedAt: revision, enabled, status: enabled ? 'active' : 'disabled', developmentDirectory: installed && linked ? directory : undefined, config: { prefix: 'saved prefix' }, tools: [], commands: [], actions: [] })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url())
    const body = request.postData() ? request.postDataJSON() : {}
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (url.pathname === '/api/studio/plugins/development') return route.fulfill({ json: { projects: linked ? [{ id: 'notes', manifest, directory, watching, status: error ? 'error' : watching ? 'watching' : 'registered', error }] : [] } })
    if (url.pathname === '/api/studio/plugins/notes/development') {
      if (request.method() === 'DELETE') {
        expect(url.searchParams.get('revision')).toBe(String(revision)); unlinks++; linked = watching = false; revision++
      } else {
        expect(body).toEqual({ revision, trusted: true }); starts++; installed = watching = enabled = true; error = ''; revision++
      }
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/client')) return route.fulfill({ json: { source: `export function mount(root) { root.textContent = ${JSON.stringify(content)} }` } })
    if (url.pathname.endsWith('/events')) return route.fulfill({ json: { cursor: revision, generation: 'dev-host', events: Number(url.searchParams.get('cursor')) < revision ? [{ id: String(revision), type: 'plugin.changed', pluginId: 'notes', timestamp: Date.now(), identity: { userId: 1, profile: 'default' }, data: null }] : [] } })
    if (url.pathname === '/api/studio/plugins/notes' && request.method() === 'PATCH') {
      expect(body).toEqual({ revision, enabled: !enabled }); enabled = watching = !enabled; revision++
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/studio/plugins') return route.fulfill({ json: { revision, plugins: installed ? [plugin()] : [] } })
    return route.fulfill({ json: {} })
  })
  await page.route('**/__plugin_development__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_development__')
  await expect(page.getByTestId('plugin-card-notes')).toHaveCount(0)
  await page.getByRole('tab', { name: /开发插件/ }).click()
  const card = page.getByTestId('plugin-card-notes')
  await expect(card.getByRole('button', { name: 'Dev Notes', exact: true })).toBeVisible()
  await expect(card).toContainText('v0.1.0')
  await expect(page.locator('.development-panel')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /开始调试|停止调试|重新构建/ })).toHaveCount(0)
  await card.getByRole('button', { name: '启用', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '取消' }).click()
  expect(starts).toBe(0)
  await card.getByRole('button', { name: '启用', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '启用', exact: true }).click()
  await expect(card.getByText('运行中', { exact: true })).toBeVisible()
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await card.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.frameLocator('iframe').locator('#root')).toHaveText('first build')
  content = 'rebuilt without page refresh'; revision++
  await expect(page.frameLocator('iframe').locator('#root')).toHaveText(content, { timeout: 10_000 })
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins'))
  await card.getByRole('button', { name: '详情', exact: true }).click()
  const drawer = page.locator('.n-drawer')
  error = 'Build failed; previous version remains active'
  await expect(drawer.getByText(error, { exact: true })).toBeVisible()
  await drawer.locator('.n-tabs-tab').getByText('开发与维护', { exact: true }).click()
  await expect(drawer.getByText(directory, { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('development-light.png'), animations: 'disabled' })
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.screenshot({ path: testInfo.outputPath('development-dark.png'), animations: 'disabled' })
  await expect(drawer.getByRole('button', { name: /开始调试|停止调试|重新构建/ })).toHaveCount(0)
  await drawer.getByRole('button', { name: '重载', exact: true }).click()
  await expect.poll(() => starts).toBe(2)
  await drawer.getByRole('button', { name: '禁用', exact: true }).click()
  await expect.poll(() => enabled).toBe(false)
  await drawer.getByRole('button', { name: '启用', exact: true }).click()
  await expect.poll(() => starts).toBe(3)
  await expect(drawer.getByRole('button', { name: '禁用', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: '解除开发链接', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('源码、已安装副本和插件数据会保留')
  await page.locator('.n-dialog').getByRole('button', { name: '取消' }).click()
  expect(unlinks).toBe(0)
  await drawer.getByRole('button', { name: '解除开发链接', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(() => unlinks).toBe(1)
  await expect(card).toBeVisible()
  await expect(card.getByText('开发', { exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '解除开发链接', exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '打开', exact: true })).toBeEnabled()
  await card.getByRole('button', { name: '详情', exact: true }).click()
  await drawer.locator('.n-tabs-tab').getByText('配置', { exact: true }).click()
  await expect(drawer.getByRole('textbox', { name: 'Prefix', exact: true })).toHaveValue('saved prefix')
  expect(errors).toEqual([])
})

test('removes a linked-only card after unlink, preserving it on failure', async ({ page }, testInfo) => {
  let linked = true, attempts = 0
  const shipped = { manifest: { id: 'shipped', name: 'Released Plugin', version: '2.0.0', apiVersion: 1, permissions: [] }, source: '/installed/shipped', enabled: false, status: 'disabled', config: {}, tools: [], commands: [], actions: [] }
  const project = { id: 'local', directory: '/projects/local', watching: false, status: 'registered', manifest: { id: 'local', name: 'Local Plugin', version: '1.2.0', apiVersion: 1, permissions: [] } }
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request(), url = new URL(request.url())
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (url.pathname === '/api/studio/plugins/development') return route.fulfill({ json: { projects: linked ? [project] : [] } })
    if (url.pathname === '/api/studio/plugins/local/development' && request.method() === 'DELETE') {
      if (++attempts === 1) return route.fulfill({ status: 409, json: { error: 'Registration changed; retry' } })
      linked = false; return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [shipped] } })
    return route.fulfill({ json: {} })
  })
  await page.route('**/__plugin_unlink__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_unlink__')
  await expect(page.getByTestId('plugin-card-local')).toHaveCount(0)
  await page.getByRole('tab', { name: /开发插件/ }).click()
  const card = page.getByTestId('plugin-card-local')
  await expect(card).toContainText('Local Plugin')
  await page.screenshot({ path: testInfo.outputPath('development-card.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByRole('button', { name: '解除开发链接' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('development-card-mobile.png'), animations: 'disabled' })
  const remove = async () => {
    await card.getByRole('button', { name: '解除开发链接' }).click()
    await page.locator('.n-dialog').getByRole('button', { name: '确定', exact: true }).click()
  }
  await remove()
  await expect(page.getByRole('alert')).toContainText('Registration changed; retry')
  await expect(card).toBeVisible()
  await remove()
  await expect(card).toHaveCount(0)
  expect(attempts).toBe(2)
})
