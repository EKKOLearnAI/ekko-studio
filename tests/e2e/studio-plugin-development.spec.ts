import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('discovers independent projects, activates debugging and refreshes the open plugin after rebuilds', async ({ page }, testInfo) => {
  let revision = 0, watching = false, installed = false, starts = 0, error = '', content = 'first build'
  const directory = '/projects/independent-notes'
  const plugin = () => ({ manifest: { id: 'notes', name: 'Dev Notes', version: '0.1.0', apiVersion: 1, client: 'client.mjs', capabilities: ['ui'], views: [{ id: 'home', title: 'Dev Notes', slot: 'page' }] }, source: directory,
    installedAt: revision, enabled: true, status: 'active', developmentDirectory: watching ? directory : undefined, config: {}, tools: [], commands: [], actions: [] })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url())
    const body = request.postData() ? request.postDataJSON() : {}
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (url.pathname === '/api/studio/plugins/development') return route.fulfill({ json: { directory: '/studio/plugins/development', projects: [{ id: 'notes', directory, watching, status: error ? 'error' : watching ? 'watching' : 'registered', error }] } })
    if (url.pathname === '/api/studio/plugins/notes/development') {
      expect(body).toEqual({ revision, trusted: true }); starts++; installed = watching = true; revision++
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/client')) return route.fulfill({ json: { source: `export function mount(root) { root.textContent = ${JSON.stringify(content)} }` } })
    if (url.pathname.endsWith('/events')) return route.fulfill({ json: { cursor: revision, generation: 'dev-host', events: Number(url.searchParams.get('cursor')) < revision ? [{ id: String(revision), type: 'plugin.changed', pluginId: 'notes', timestamp: Date.now(), identity: { userId: 1, profile: 'default' }, data: null }] : [] } })
    if (url.pathname === '/api/studio/plugins/notes' && request.method() === 'PATCH') {
      expect(body).toEqual({ revision, action: 'stop-development' }); watching = false; revision++
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/studio/plugins') return route.fulfill({ json: { revision, plugins: installed ? [plugin()] : [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_development__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_development__')
  await page.getByText('开发插件 (1)', { exact: true }).click()
  const panel = page.locator('.development-panel')
  await expect(panel.getByText(directory, { exact: true })).toBeVisible()
  await expect(page.locator('.plugin-card')).toHaveCount(0)
  await panel.getByRole('button', { name: '开始调试' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
  expect(starts).toBe(0)
  await panel.getByRole('button', { name: '开始调试' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '开始调试' }).click()
  await expect(panel.getByText('监听中', { exact: true })).toBeVisible()
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await expect(page.frameLocator('iframe').locator('#root')).toHaveText('first build')
  content = 'rebuilt without page refresh'; revision++
  await expect(page.frameLocator('iframe').locator('#root')).toHaveText(content, { timeout: 10_000 })
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins'))
  await page.getByText('开发插件 (1)', { exact: true }).click()
  error = 'Build failed; previous version remains active'
  await expect(panel.getByText(error, { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('development-light.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.screenshot({ path: testInfo.outputPath('development-dark.png'), fullPage: true, animations: 'disabled' })
  await panel.getByRole('button', { name: '停止调试' }).click()
  await expect.poll(() => watching).toBe(false)
  await expect(panel.getByRole('button', { name: '开始调试' })).toBeVisible()
  await expect(page.locator('.plugin-card')).toHaveCount(1)
})
