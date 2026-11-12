import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

function published(index: number, extra: Record<string, unknown> = {}) {
  return { id: index.toString(16).padStart(64, '0'), name: `Published ${index}`, description: 'Available from the plugin marketplace',
    repository: `https://github.com/example/plugin-${index}`, manifestId: `plugin-${index}`, version: '1.0.0', apiVersion: 1,
    capabilities: ['tools'], sourceCommit: 'b'.repeat(40), installSource: `github:example/plugin-${index}#${'b'.repeat(40)}`, ...extra }
}
async function setup(page: Page, options: { ordinary?: boolean; unavailable?: boolean; entries?: any[] } = {}) {
  const local = { manifest: { id: 'plugin-1', name: 'Installed commands', description: 'Disabled, but still a chat-command plugin', version: '2.0.0', apiVersion: 1,
    repository: 'https://github.com/example/plugin-1', capabilities: ['commands', 'tools'] }, source: '/local/plugin', installedAt: 0,
    enabled: false, status: 'disabled', config: {}, tools: [], commands: [], actions: [] }
  const state = { plugins: [local], revision: 1, unavailable: Boolean(options.unavailable), entries: options.entries || [published(1), published(2, { name: 'Agent extension', capabilities: ['agents', 'ui'] })] }
  const installs: any[] = [], marketRequests: URL[] = [], cloudHeaders: Record<string, string>[] = []
  if (options.ordinary) await page.addInitScript(() => localStorage.setItem('plugin_fixture_account', JSON.stringify({ sub: '2', role: 'user' })))
  await page.context().addCookies([{ name: 'cloud_cookie', value: 'private', url: 'https://api.ekkostudio.xyz' }])
  await page.route(url => url.hostname === 'api.ekkostudio.xyz', async route => {
    const url = new URL(route.request().url()); cloudHeaders.push(await route.request().allHeaders())
    if (url.searchParams.has('repository')) return route.fulfill({ json: { ok: true, data: { list: [] } } })
    marketRequests.push(url)
    if (state.unavailable) return route.fulfill({ status: 503, json: {} })
    const current = Number(url.searchParams.get('page')), size = Number(url.searchParams.get('pageSize'))
    return route.fulfill({ json: { ok: true, data: { list: state.entries.slice((current - 1) * size, current * size), total: state.entries.length, page: current, pageSize: size } } })
  })
  await page.route(url => url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/studio/plugins/install') {
      const input = route.request().postDataJSON(); installs.push(input)
      const entry = state.entries.find(value => value.manifestId === input.pluginId)!
      state.plugins.push({ ...local, manifest: { ...local.manifest, id: entry.manifestId, name: entry.name, repository: entry.repository, version: entry.version, capabilities: entry.capabilities }, source: input.source })
      state.revision++
      return route.fulfill({ json: { ok: true } })
    }
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: state.revision, plugins: state.plugins } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'market', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_market__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_market__')
  return { state, installs, marketRequests, cloudHeaders }
}

test('defaults to installed plugins, filters the full market and installs an exact release after confirmation', async ({ page }, testInfo) => {
  const entries = [...Array.from({ length: 100 }, (_, i) => published(i + 1)), published(101, { name: 'Last-page Agent', capabilities: ['agents', 'ui'] })]
  const { installs, marketRequests, cloudHeaders } = await setup(page, { entries })
  await expect(page.getByRole('tab').nth(0)).toContainText('已安装')
  await expect(page.getByRole('tab').nth(1)).toHaveText('全部')
  await expect(page.getByRole('tab', { name: /已安装/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('plugin-card-plugin-1')).toBeVisible()
  expect(marketRequests).toHaveLength(0)
  await page.getByRole('button', { name: /^聊天命令/ }).click()
  await expect(page.getByTestId('plugin-card-plugin-1')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('installed-default.png'), fullPage: true })
  await page.getByRole('button', { name: /^所有类型/ }).click()
  await page.getByRole('tab', { name: /^已安装/ }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: /^全部/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('market-plugin-plugin-1').getByText('已安装', { exact: true })).toBeVisible()
  await expect(page.getByTestId('market-plugin-plugin-1').getByRole('button', { name: /更新到/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^Agent/ }).click()
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  const card = page.getByTestId('market-plugin-plugin-101')
  await expect(card).toContainText('Last-page Agent')
  expect(marketRequests.map(url => url.searchParams.get('page'))).toEqual(['1', '2'])
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('not-a-plugin')
  await expect(page.getByText('没有匹配的插件')).toBeVisible()
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('Last-page')
  await page.screenshot({ path: testInfo.outputPath('market-light.png'), fullPage: true, animations: 'disabled' })
  await card.getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.locator('.n-dialog')).toContainText('github.com/example/plugin-101')
  await page.locator('.n-dialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  expect(installs).toHaveLength(0)
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.screenshot({ path: testInfo.outputPath('market-dark.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(() => (window as any).pluginFixture.wallpaper(true))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('market-dark-mobile.png'), fullPage: true, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await card.getByRole('button', { name: '安装', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '安装', exact: true }).click()
  await expect(card.getByText('已安装', { exact: true })).toBeVisible()
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  expect(installs).toEqual([{ source: `github:example/plugin-101#${'b'.repeat(40)}`, pluginId: 'plugin-101', expectedVersion: '1.0.0', revision: 1, trusted: true }])
  await page.getByRole('tab', { name: /^已安装/ }).click()
  await expect(page.getByTestId('plugin-card-plugin-101')).toBeVisible()
  for (const headers of cloudHeaders) for (const key of ['authorization', 'cookie', 'x-hermes-profile', 'referer']) expect(headers[key]).toBeUndefined()
})

test('rechecks local identity after confirmation instead of replacing a newly installed plugin', async ({ page }) => {
  const { state, installs } = await setup(page)
  await page.getByRole('tab', { name: /^全部/ }).click()
  await page.getByTestId('market-plugin-plugin-2').getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.locator('.n-dialog')).toBeVisible()
  state.plugins.push({ ...state.plugins[0], manifest: { ...state.plugins[0].manifest, id: 'plugin-2', repository: 'https://github.com/another/source' } })
  state.revision++
  await page.locator('.n-dialog').getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.locator('.n-message').getByText('插件状态已改变，请刷新后重试。')).toBeVisible()
  expect(installs).toHaveLength(0)
})

test('keeps installed plugins usable during a market failure and supports retry and an empty directory', async ({ page }) => {
  const { state } = await setup(page, { unavailable: true })
  await page.getByRole('tab', { name: /^全部/ }).click()
  await expect(page.getByText('暂时无法加载插件市场，已安装插件仍可使用。')).toBeVisible()
  await page.getByRole('tab', { name: /^已安装/ }).click()
  await expect(page.getByTestId('plugin-card-plugin-1')).toBeVisible()
  state.unavailable = false; state.entries = []
  await page.getByRole('tab', { name: /^全部/ }).click()
  await expect(page.getByText('暂无已上架插件')).toBeVisible()
  state.entries = [published(2)]
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByTestId('market-plugin-plugin-2')).toBeVisible()
})

test('does not replace a different repository with the same ID or install an unverifiable release', async ({ page }) => {
  const { installs } = await setup(page, { entries: [published(1, { repository: 'https://github.com/other/plugin', installSource: `github:other/plugin#${'b'.repeat(40)}` }), published(2, { installSource: '/tmp/untrusted' })] })
  await page.getByRole('tab', { name: /^全部/ }).click()
  await expect(page.getByRole('button', { name: '已安装其他来源', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '暂不可安装', exact: true })).toBeDisabled()
  expect(installs).toHaveLength(0)
})

test('lets ordinary users browse and see installed state without install controls', async ({ page }) => {
  await setup(page, { ordinary: true })
  await page.getByRole('tab', { name: /^全部/ }).click()
  await expect(page.getByTestId('market-plugin-plugin-1').getByText('已安装', { exact: true })).toBeVisible()
  await expect(page.getByTestId('market-plugin-plugin-2')).toBeVisible()
  await expect(page.getByRole('button', { name: '安装', exact: true })).toHaveCount(0)
  await page.getByTestId('market-plugin-plugin-2').getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Agent extension')
  await expect(page.getByRole('dialog').getByRole('button', { name: '安装', exact: true })).toHaveCount(0)
})
