import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

function published(index: number, extra: Record<string, unknown> = {}) {
  return { id: index.toString(16).padStart(64, '0'), name: `Published ${index}`, description: 'Available from the plugin marketplace',
    repository: `https://github.com/example/plugin-${index}`, manifestId: `plugin-${index}`, version: '1.0.0', apiVersion: 1,
    author: { name: `Publisher ${index}` }, repositoryStars: 1234, permissions: ['tools'],
    sourceCommit: 'b'.repeat(40), installSource: `github:example/plugin-${index}#${'b'.repeat(40)}`, ...extra }
}

function installed(enabled: boolean) {
  return { manifest: { id: 'plugin-1', name: 'Installed commands', description: 'Installed plugin used by the risk notice fixture', version: '1.0.0', apiVersion: 1,
    repository: 'https://github.com/example/plugin-1', author: { name: 'Local Maintainer' }, permissions: ['commands', 'tools'] },
    source: 'github:example/plugin-1#' + 'c'.repeat(40), installedAt: 0, enabled, status: enabled ? 'active' : 'disabled', config: {}, tools: [], commands: [], actions: [] }
}

async function setup(page: Page, options: { localEnabled?: boolean; localVersion?: string; entries?: any[] } = {}) {
  const local = installed(Boolean(options.localEnabled))
  if (options.localVersion) local.manifest.version = options.localVersion
  const state = { plugins: [local], revision: 1, entries: options.entries || [published(1, { version: '2.0.0' }), published(2)] }
  await page.route(url => url.hostname === 'api.ekkostudio.xyz', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/studio/plugins/count') return route.fulfill({ json: { ok: true, data: { total: state.entries.length } } })
    if (url.searchParams.has('repository')) return route.fulfill({ json: { ok: true, data: { list: state.entries.filter(entry => entry.repository === url.searchParams.get('repository')) } } })
    const current = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('pageSize'))
    return route.fulfill({ json: { ok: true, data: { list: state.entries.slice((current - 1) * size, current * size), total: state.entries.length, page: current, pageSize: size } } })
  })
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: state.revision, plugins: state.plugins } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'risk', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_risk__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_risk__')
  return state
}

test('installed view, enable confirmation and permission details', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await setup(page)
  await expect(page.getByTestId('plugin-card-plugin-1')).toBeVisible()
  await expect(page.getByText('第三方插件由开发者自行发布')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('01-installed-risk-banner.png'), fullPage: true, animations: 'disabled' })

  await page.getByTestId('plugin-card-plugin-1').getByRole('button', { name: '启用', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('启用 Installed commands')
  await expect(page.locator('.n-dialog')).toContainText('Local Maintainer')
  await expect(page.locator('.n-dialog')).toContainText('Studio 进程权限')
  await page.screenshot({ path: testInfo.outputPath('02-enable-confirm.png'), fullPage: false, animations: 'disabled' })
  await page.locator('.n-dialog').getByRole('button', { name: '取消', exact: true }).click()

  await page.getByTestId('plugin-card-plugin-1').getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('不是 Ekko Studio 官方产品')
  await expect(page.getByRole('dialog')).toContainText('声明权限')
  await expect(page.getByRole('dialog')).toContainText('不是安全沙箱')
  await page.screenshot({ path: testInfo.outputPath('03-detail-permission-boundary.png'), fullPage: false, animations: 'disabled' })
})

test('install modal and market install confirmation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await setup(page)
  await page.getByRole('button', { name: '安装插件', exact: true }).click()
  await expect(page.locator('.n-modal')).toContainText('新安装的第三方插件默认禁用')
  await page.screenshot({ path: testInfo.outputPath('04-install-modal-risk-note.png'), fullPage: false, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal')).toHaveCount(0)

  await page.getByRole('tab', { name: /^全部/ }).click()
  await expect(page.getByText('以下插件由第三方开发者发布；上架不代表官方认证或安全保证。')).toBeVisible()
  await expect(page.getByTestId('market-plugin-plugin-1')).toBeVisible()
  await page.waitForTimeout(150)
  await page.screenshot({ path: testInfo.outputPath('05-market-risk-notice.png'), fullPage: true, animations: 'disabled' })

  await page.getByTestId('market-plugin-plugin-2').getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.locator('.n-dialog')).toBeVisible()
  await expect(page.locator('.n-dialog')).toContainText('Publisher 2')
  await expect(page.locator('.n-dialog')).toContainText('github.com/example/plugin-2')
  await expect(page.locator('.n-dialog')).toContainText('不是 Ekko Studio 官方产品')
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('06-market-install-confirm.png'), fullPage: false, animations: 'disabled' })
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('08-market-narrow.png'), fullPage: true, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('enabled plugin upgrade warns that the new version runs immediately', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await setup(page, { localEnabled: true, localVersion: '1.0.0' })
  await page.getByRole('tab', { name: /^全部/ }).click()
  const card = page.getByTestId('market-plugin-plugin-1')
  await expect(card).toContainText('更新到 v2.0.0')
  await card.getByRole('button', { name: '更新到 v2.0.0', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('该插件当前已启用，更新完成后会立即运行新版本代码')
  await page.screenshot({ path: testInfo.outputPath('07-enabled-update-confirm.png'), fullPage: false, animations: 'disabled' })
})
