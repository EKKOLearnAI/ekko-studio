import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('installs a pasted GitHub repository URL without a hash and allows retry after resolution failure', async ({ page }, testInfo) => {
  const source = 'https://github.com/example/notes', pinned = 'github:example/notes#' + 'a'.repeat(40)
  const requests: any[] = []
  let installed = false
  await page.route(url => url.hostname === 'api.ekkostudio.xyz', route => route.fulfill({ json: { ok: true, data: { list: [], total: 0 } } }))
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: installed ? 1 : 0, plugins: installed ? [{
      manifest: { id: 'notes', name: 'GitHub Notes', version: '1.2.3', apiVersion: 1, permissions: [] },
      source: pinned, installedAt: 1, enabled: false, status: 'disabled', config: {}, tools: [], commands: [], actions: [],
    }] : [] } })
    if (path === '/api/studio/plugins/development') return route.fulfill({ json: { projects: [] } })
    if (path === '/api/studio/plugins/install') {
      const body = route.request().postDataJSON(); requests.push(body)
      expect(body).toEqual({ source, revision: 0, trusted: true })
      if (requests.length === 1) return route.fulfill({ status: 422, json: { code: 'PLUGIN_SOURCE_RESOLVE', error: 'Unable to resolve GitHub repository; check network access and try again' } })
      installed = true; return route.fulfill({ json: { ok: true } })
    }
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'github-install', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_github_install__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_github_install__')
  await page.getByRole('button', { name: '安装插件', exact: true }).click()
  const modal = page.locator('.plugin-install-modal'), input = modal.getByRole('textbox'), install = modal.getByRole('button', { name: '安装', exact: true })
  await expect(modal).toContainText('无需填写 hash')
  await input.fill(source)
  await expect(install).toBeDisabled()
  await modal.getByRole('checkbox').check(); await install.click()
  await expect(modal.getByRole('alert')).toContainText('Unable to resolve GitHub repository')
  await expect(input).toHaveValue(source); await expect(install).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('github-source-retry.png'), animations: 'disabled' })
  await install.click()
  await expect(modal).toHaveCount(0)
  const card = page.getByTestId('plugin-card-notes')
  await expect(card).toContainText('GitHub Notes'); await expect(card).toContainText('v1.2.3')
  await expect(card.getByRole('button', { name: '启用', exact: true })).toBeEnabled()
  expect(requests).toHaveLength(2)
  await card.getByRole('button', { name: '详情', exact: true }).click()
  await page.locator('.n-drawer').getByText('开发与维护', { exact: true }).click()
  await expect(page.locator('.n-drawer').getByRole('textbox').first()).toHaveValue(pinned)
  await page.screenshot({ path: testInfo.outputPath('github-source-installed.png'), animations: 'disabled' })
})
