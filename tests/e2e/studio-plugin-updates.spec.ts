import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

async function setup(page: Page, options: { unavailable?: boolean; ordinary?: boolean; differentId?: boolean } = {}) {
  let version = '1.9.0', revision = 1
  const installs: any[] = [], cloudHeaders: Record<string, string>[] = []
  const repository = 'https://github.com/example/notes', commit = 'b'.repeat(40)
  if (options.ordinary) await page.addInitScript(() => localStorage.setItem('plugin_fixture_account', JSON.stringify({ sub: '2', role: 'user' })))
  await page.route(url => url.hostname === 'api.ekkostudio.xyz', async route => {
    cloudHeaders.push(route.request().headers())
    if (options.unavailable) return route.fulfill({ status: 503, json: { ok: false } })
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { ok: true, data: { list: [{
      id: 'a'.repeat(64), repository, manifestId: options.differentId ? 'other' : 'notes', version: '1.10.0', apiVersion: 1,
      sourceCommit: commit, installSource: `github:example/notes#${commit}`,
    }] } } })
  })
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/install')) {
      installs.push(route.request().postDataJSON()); version = '1.10.0'; revision++
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname === '/api/studio/plugins') return route.fulfill({ json: { revision, plugins: [{
      manifest: { id: 'notes', name: 'Notebook', version, apiVersion: 1, repository, server: 'server.mjs', permissions: ['tools'] },
      source: 'github:example/notes#' + 'c'.repeat(40), installedAt: 0, enabled: false, status: 'disabled', config: {}, tools: [], commands: [], actions: [],
    }] } })
    if (url.pathname.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'test', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_updates__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_updates__')
  return { installs, cloudHeaders }
}

test('shows the newer version and upgrades the exact published commit after confirmation', async ({ page }, testInfo) => {
  const { installs, cloudHeaders } = await setup(page)
  const card = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Notebook', exact: true }) })
  await expect(card.getByText('可更新', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugin-update-light.png'), fullPage: true })
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true); (window as any).pluginFixture.wallpaper(true) })
  await page.setViewportSize({ width: 430, height: 900 })
  await expect(card.getByRole('button', { name: '更新到 v1.10.0', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugin-update-dark-narrow.png'), fullPage: true })
  await card.getByRole('button', { name: '更新到 v1.10.0', exact: true }).click()
  await expect(page.getByText(/确认信任此插件并运行其代码/)).toBeVisible()
  expect(installs).toHaveLength(0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await card.getByRole('button', { name: '更新到 v1.10.0', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '更新到 v1.10.0', exact: true }).click()
  await expect(card.getByText('v1.10.0', { exact: true })).toBeVisible()
  await expect(card.getByText('可更新', { exact: true })).toHaveCount(0)
  expect(installs).toEqual([{ source: 'github:example/notes#' + 'b'.repeat(40), pluginId: 'notes', expectedVersion: '1.10.0', revision: 1, trusted: true }])
  for (const headers of cloudHeaders) { expect(headers.authorization).toBeUndefined(); expect(headers.cookie).toBeUndefined(); expect(headers['x-hermes-profile']).toBeUndefined() }
  await page.screenshot({ path: testInfo.outputPath('plugin-updated.png'), fullPage: true })
})
test('retains the installed list when the cloud directory is unavailable', async ({ page }) => {
  await setup(page, { unavailable: true })
  await expect(page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Notebook', exact: true }) })).toBeVisible()
  await expect(page.getByText('暂时无法检查插件更新，已安装插件仍可使用。')).toBeVisible()
})
test('shows availability to ordinary accounts without an upgrade control', async ({ page }) => {
  await setup(page, { ordinary: true })
  await expect(page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Notebook', exact: true }) }).getByText('可更新', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '更新到 v1.10.0' })).toHaveCount(0)
})
test('does not offer an upgrade when the cloud manifest has a different identity', async ({ page }) => {
  await setup(page, { differentId: true })
  await expect(page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Notebook', exact: true }) })).toBeVisible()
  await expect(page.getByRole('button', { name: '更新到 v1.10.0' })).toHaveCount(0)
})
