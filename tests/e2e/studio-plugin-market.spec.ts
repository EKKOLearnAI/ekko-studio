import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

function published(index: number, extra: Record<string, unknown> = {}) {
  return { id: index.toString(16).padStart(64, '0'), name: `Published ${index}`, description: 'Available from the plugin marketplace',
    repository: `https://github.com/example/plugin-${index}`, manifestId: `plugin-${index}`, version: '1.0.0', apiVersion: 1,
    author: { name: `Publisher ${index}` }, repositoryStars: 1234,
    permissions: ['tools'], sourceCommit: 'b'.repeat(40), installSource: `github:example/plugin-${index}#${'b'.repeat(40)}`, ...extra }
}
async function setup(page: Page, options: { ordinary?: boolean; unavailable?: boolean; countUnavailable?: boolean; entries?: any[] } = {}) {
  const local = { manifest: { id: 'plugin-1', name: 'Installed commands', description: 'Disabled, but still a chat-command plugin', version: '2.0.0', apiVersion: 1,
    repository: 'https://github.com/example/plugin-1', author: { name: 'Local Maintainer' }, permissions: ['commands', 'tools'] }, source: 'github:example/plugin-1#' + 'c'.repeat(40), installedAt: 0,
    enabled: false, status: 'disabled', config: {}, tools: [], commands: [], actions: [] }
  const state = { plugins: [local], revision: 1, unavailable: Boolean(options.unavailable), countUnavailable: Boolean(options.countUnavailable), entries: options.entries || [published(1), published(2, { name: 'Agent extension', permissions: ['agents', 'ui'] })] }
  const installs: any[] = [], marketRequests: URL[] = [], countRequests: URL[] = [], cloudHeaders: Record<string, string>[] = []
  if (options.ordinary) await page.addInitScript(() => localStorage.setItem('plugin_fixture_account', JSON.stringify({ sub: '2', role: 'user' })))
  await page.context().addCookies([{ name: 'cloud_cookie', value: 'private', url: 'https://api.ekkostudio.xyz' }])
  await page.route(url => url.hostname === 'api.ekkostudio.xyz', async route => {
    const url = new URL(route.request().url()); cloudHeaders.push(await route.request().allHeaders())
    if (url.pathname === '/api/studio/plugins/count') {
      countRequests.push(url)
      return state.unavailable || state.countUnavailable ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { ok: true, data: { total: state.entries.length } } })
    }
    if (url.searchParams.has('repository')) return state.unavailable ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { ok: true, data: { list: state.entries.filter(entry => entry.repository === url.searchParams.get('repository')) } } })
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
      state.plugins.push({ ...local, manifest: { ...local.manifest, id: entry.manifestId, name: entry.name, repository: entry.repository, version: entry.version, permissions: entry.permissions }, source: input.source })
      state.revision++
      return route.fulfill({ json: { ok: true } })
    }
    if (route.request().method() === 'PATCH' && path.startsWith('/api/studio/plugins/') && route.request().postDataJSON().action === 'uninstall') {
      state.plugins = state.plugins.filter(plugin => plugin.manifest.id !== path.split('/').at(-1))
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
  return { state, installs, marketRequests, countRequests, cloudHeaders }
}

test('defaults to installed plugins, filters the full market and installs an exact release after confirmation', async ({ page }, testInfo) => {
  const entries = [...Array.from({ length: 100 }, (_, i) => published(i + 1)), published(101, { name: 'Last-page Agent', permissions: ['agents', 'ui'] })]
  const { installs, marketRequests, countRequests, cloudHeaders } = await setup(page, { entries })
  await expect(page.getByRole('tab').nth(0)).toContainText('已安装')
  await expect(page.getByRole('tab').nth(1)).toHaveText('全部 101')
  await expect(page.getByRole('tab', { name: /已安装/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('plugin-card-plugin-1')).toBeVisible()
  expect(marketRequests).toHaveLength(0)
  expect(countRequests).toHaveLength(1)
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
  await expect(card.locator('.status')).toHaveText('未安装')
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
  await expect(card.locator('.status')).toHaveText('已禁用')
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  expect(installs).toEqual([{ source: `github:example/plugin-101#${'b'.repeat(40)}`, pluginId: 'plugin-101', expectedVersion: '1.0.0', revision: 1, trusted: true }])
  await page.getByRole('tab', { name: /^已安装/ }).click()
  await expect(page.getByTestId('plugin-card-plugin-101')).toBeVisible()
  for (const headers of cloudHeaders) for (const key of ['authorization', 'cookie', 'x-hermes-profile', 'referer']) expect(headers[key]).toBeUndefined()
})

test('shows zero on entry and refreshes the count without opening All or loading market entries', async ({ page }) => {
  const { state, marketRequests, countRequests } = await setup(page, { entries: [] })
  const all = page.getByRole('tab', { name: /^全部/ })
  await expect(all).toHaveText('全部 0')
  state.entries = [published(1), published(2)]
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(all).toHaveText('全部 2')
  expect(countRequests).toHaveLength(2)
  expect(marketRequests).toHaveLength(0)
  await expect(page.getByRole('tab', { name: /^已安装/ })).toHaveAttribute('aria-selected', 'true')
})

test('can browse All when the count endpoint is unavailable and recovers its count from the list', async ({ page }) => {
  const { countRequests, marketRequests } = await setup(page, { countUnavailable: true })
  await expect.poll(() => countRequests.length).toBe(1)
  const all = page.getByRole('tab', { name: /^全部/ })
  await expect(all).toHaveText('全部')
  await expect(page.getByTestId('plugin-card-plugin-1')).toBeVisible()
  expect(marketRequests).toHaveLength(0)
  await all.click()
  await expect(page.getByTestId('market-plugin-plugin-2')).toBeVisible()
  await expect(all).toHaveText('全部 2')
})

test('shows and filters live installation statuses in All without confusing another repository', async ({ page }, testInfo) => {
  const { state } = await setup(page, { entries: [1, 2, 3, 4, 5].map(index => published(index)) })
  for (const [index, status] of [[2, 'active'], [3, 'failed'], [5, 'active']] as const) {
    const repository = index === 5 ? 'https://github.com/another/plugin-5' : `https://github.com/example/plugin-${index}`
    state.plugins.push({ ...state.plugins[0], status, enabled: true,
      manifest: { ...state.plugins[0].manifest, id: `plugin-${index}`, name: `Installed ${index}`, repository, permissions: ['tools'] },
      source: 'git+' + repository + '#' + 'c'.repeat(40) })
  }
  state.revision++
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('tab', { name: /^全部/ }).click()
  const card = (index: number) => page.getByTestId(`market-plugin-plugin-${index}`)
  const filter = page.locator('.state-filter')
  async function selectStatus(label: string) {
    await filter.click()
    await page.locator('.n-base-select-option').getByText(label, { exact: true }).click()
  }
  for (const [index, status] of [[1, '已禁用'], [2, '运行中'], [3, '失败'], [4, '未安装'], [5, '已安装其他来源']] as const) {
    await expect(card(index).locator('.status')).toHaveText(status)
  }
  await card(1).getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.getByRole('dialog').locator('.detail-identity .status')).toHaveText('已禁用')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('market-statuses.png'), fullPage: true, animations: 'disabled' })

  await selectStatus('已安装')
  await expect(page.locator('.plugin-card')).toHaveCount(3)
  await expect(card(5)).toHaveCount(0)
  await selectStatus('未安装')
  await expect(page.locator('.plugin-card')).toHaveCount(2)
  await expect(card(4)).toBeVisible()
  await expect(card(5).getByRole('button', { name: '已安装其他来源' })).toBeDisabled()
  await page.getByRole('tab', { name: /^已安装/ }).click()
  await expect(filter).toContainText('全部状态')
  await expect(page.locator('.plugin-card')).toHaveCount(4)
  await page.getByRole('tab', { name: /^全部/ }).click()

  await selectStatus('失败')
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await expect(card(3)).toBeVisible()
  await selectStatus('运行中')
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await expect(card(2)).toBeVisible()
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('Published 3')
  await expect(page.getByText('没有匹配的插件')).toBeVisible()
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('')
  await page.getByRole('button', { name: /^聊天命令/ }).click()
  await expect(page.getByText('没有匹配的插件')).toBeVisible()
  await page.getByRole('button', { name: /^所有类型/ }).click()
  await selectStatus('已禁用')
  await expect(card(1)).toBeVisible()
  await page.getByRole('tab', { name: /^已安装/ }).click()
  await expect(filter).toContainText('已禁用')
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await page.getByRole('tab', { name: /^全部/ }).click()
  state.plugins[0].status = 'active'; state.plugins[0].enabled = true; state.revision++
  await page.evaluate(() => (window as any).pluginFixture.changed())
  await expect(card(1)).toHaveCount(0)
  await selectStatus('运行中')
  await expect(card(1).locator('.status')).toHaveText('运行中')
  await expect(page.locator('.plugin-card')).toHaveCount(2)
  await card(1).getByRole('button', { name: '卸载', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  await expect(card(1)).toHaveCount(0)
  await selectStatus('未安装')
  await expect(card(1).locator('.status')).toHaveText('未安装')
  await expect(card(1).getByRole('button', { name: '安装', exact: true })).toBeEnabled()
})

test('rechecks local identity after confirmation instead of replacing a newly installed plugin', async ({ page }) => {
  const { state, installs } = await setup(page)
  await page.getByRole('tab', { name: /^全部/ }).click()
  await page.getByTestId('market-plugin-plugin-2').getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.locator('.n-dialog')).toBeVisible()
  state.plugins.push({ ...state.plugins[0], manifest: { ...state.plugins[0].manifest, id: 'plugin-2', repository: 'https://github.com/another/source' } })
  state.revision++
  await page.locator('.n-dialog').getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.locator('.n-dialog').getByRole('alert').getByText('插件状态已改变，请刷新后重试。')).toBeVisible()
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

test('shows authors, GitHub stars and links, installed/published versions and upgrades in both lists', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await setup(page, { entries: [published(1, { version: '3.0.0', repositoryStars: 12345 }), published(2, { repositoryStars: 0 }), published(3, { author: null, repositoryStars: null })] })
  const installed = page.getByTestId('plugin-card-plugin-1')
  await expect(installed.getByText('Local Maintainer', { exact: true })).toBeVisible()
  await expect(installed.locator('.repository-stars')).toHaveText('12,345')
  await expect(installed.getByRole('link', { name: '仓库 · GitHub' })).toHaveAttribute('href', 'https://github.com/example/plugin-1')
  await expect(installed.getByRole('link', { name: '仓库 · GitHub' })).toHaveAttribute('target', '_blank')
  await expect(installed.locator('.versions')).toContainText('已安装版本v2.0.0已发布v3.0.0')
  await expect(installed.getByText('可更新', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('installed-card-metadata.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('tab', { name: /^全部/ }).click()
  const market = page.getByTestId('market-plugin-plugin-1')
  await expect(market.getByText('Publisher 1', { exact: true })).toBeVisible()
  await expect(market.locator('.repository-stars')).toHaveText('12,345')
  await expect(market.locator('.versions')).toContainText('已安装版本v2.0.0已发布v3.0.0')
  await expect(market.getByText('可更新', { exact: true })).toBeVisible()
  await expect(market.getByRole('button', { name: '更新到 v3.0.0' })).toBeVisible()
  await expect(page.getByTestId('market-plugin-plugin-2').locator('.repository-stars')).toHaveText('0')
  await expect(page.getByTestId('market-plugin-plugin-3').locator('.repository-stars')).toHaveText('—')
  await expect(page.getByTestId('market-plugin-plugin-3').getByText('未提供', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('market-card-metadata-light.png'), fullPage: true, animations: 'disabled' })
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true); (window as any).pluginFixture.wallpaper(true) })
  await page.setViewportSize({ width: 390, height: 900 })
  await market.scrollIntoViewIfNeeded()
  await expect(market.getByRole('link', { name: '仓库 · GitHub' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('market-card-metadata-mobile.png'), fullPage: true, animations: 'disabled' })
})

test('distinguishes no upgrade from a failed check and preserves the last known star count', async ({ page }) => {
  const { state } = await setup(page, { entries: [published(1, { version: '2.0.0', repositoryStars: 42 })] })
  const card = page.getByTestId('plugin-card-plugin-1')
  await expect(card.getByText('无可用升级', { exact: true })).toBeVisible()
  await expect(card.locator('.repository-stars')).toHaveText('42')
  state.unavailable = true
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(card.getByText('暂无法确认更新', { exact: true })).toBeVisible()
  await expect(card.getByText('无可用升级', { exact: true })).toHaveCount(0)
  await expect(card.locator('.repository-stars')).toHaveText('42')
})

test('opens developer resources and submission from the compact catalog across themes and narrow layouts', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 960 })
  await setup(page, { entries: [
    published(1, { name: 'File Search', description: '查找工作区文件，让 Agent 随时获取项目上下文。', version: '3.0.0', author: { name: 'Studio Community' }, permissions: ['tools'] }),
    published(2, { name: 'Terminal Agent', description: '在 Studio 中运行终端 Agent，管理模型、工具和任务。', author: { name: 'Ekko Studio' }, permissions: ['agents', 'ui'] }),
    published(3, { name: 'Project Board', description: '把项目任务带入工作区，与团队一起查看进展。', author: { name: 'Community Labs' }, permissions: ['ui', 'commands'], repositoryStars: 42 }),
  ] })
  const banner = page.getByRole('complementary', { name: '开发你的插件' })
  await expect(banner).toBeVisible()
  await page.evaluate(() => {
    const fixture = (window as any).pluginFixture
    fixture.copiedCommand = ''; fixture.copyFails = false
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
      if (fixture.copyFails) throw new Error('Clipboard unavailable')
      fixture.copiedCommand = text
    } } })
    document.execCommand = () => false
  })
  const guide = page.locator('.plugin-development-guide')
  await banner.getByRole('button', { name: '创建空白项目', exact: true }).click()
  await expect(guide).toBeVisible()
  await expect(guide.locator('code')).toHaveText('ekko-studio plugins create my-plugin ./my-plugin')
  await expect(guide).toContainText('并自动关联到 Studio')
  await expect(guide).toContainText('最小设置页示例')
  await expect(guide).toContainText('开发插件')
  await guide.getByRole('button', { name: '复制', exact: true }).click()
  await expect(guide.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).pluginFixture.copiedCommand)).toBe('ekko-studio plugins create my-plugin ./my-plugin')
  await page.screenshot({ path: testInfo.outputPath('create-guide-light.png'), animations: 'disabled' })
  await guide.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(guide).toHaveCount(0)
  await banner.getByRole('button', { name: '关联已有项目', exact: true }).click()
  await expect(guide.locator('code')).toHaveText('ekko-studio plugins link "/absolute/path/my-plugin"')
  await expect(guide).toContainText('plugin.json')
  await expect(guide).toContainText('HERMES_WEB_UI_HOME')
  await guide.getByRole('button', { name: '复制', exact: true }).click()
  expect(await page.evaluate(() => (window as any).pluginFixture.copiedCommand)).toBe('ekko-studio plugins link "/absolute/path/my-plugin"')
  await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0)
  const docsUrl = 'https://github.com/EKKOLearnAI/ekko-studio/blob/main/docs/plugins.md'
  await expect(banner.getByRole('link', { name: '开发文档' })).toHaveAttribute('href', docsUrl)
  await expect(banner.getByRole('link', { name: '插件模板' })).toHaveAttribute('href', 'https://github.com/EKKOLearnAI/ekko-studio/tree/main/packages/plugin-sdk/template')
  await page.context().route(docsUrl, route => route.fulfill({ contentType: 'text/html', body: '<h1>Plugin development documentation</h1>' }))
  const popup = page.waitForEvent('popup')
  await banner.getByRole('link', { name: '开发文档' }).click()
  const docs = await popup
  await expect(docs).toHaveURL(docsUrl); await docs.close()
  await page.locator('.catalog-actions').getByRole('button', { name: '提交插件', exact: true }).click()
  await expect(page.locator('.plugin-submission-modal').getByRole('textbox', { name: '仓库地址', exact: true })).toBeVisible()
  await page.locator('.plugin-submission-modal').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.plugin-submission-modal')).toHaveCount(0)
  await page.getByRole('tab', { name: /^全部/ }).click()
  const card = page.getByTestId('market-plugin-plugin-1')
  await expect(card.getByRole('button', { name: '更新到 v3.0.0' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('catalog-light.png'), animations: 'disabled' })
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true); (window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: {}, regions: {} } }) })
  await page.screenshot({ path: testInfo.outputPath('catalog-dark.png'), animations: 'disabled' })
  await banner.getByRole('button', { name: '创建空白项目', exact: true }).click()
  await expect(guide).toBeInViewport({ ratio: .95 })
  await expect(guide).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('create-guide-dark.png'), animations: 'disabled' })
  await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0)
  await page.evaluate(() => {
    const fixture = (window as any).pluginFixture
    fixture.wallpaper(true)
    fixture.appearance({ brightness: 'light', appearance: { global: { opacity: .65 }, regions: { card: { opacity: .4, radius: 16, blur: 4, backgroundColor: '#627a94' } } } })
  })
  await page.screenshot({ path: testInfo.outputPath('catalog-light-wallpaper.png'), animations: 'disabled' })
  await banner.getByRole('button', { name: '关联已有项目', exact: true }).click()
  await expect(guide).toHaveCSS('opacity', '1')
  await page.screenshot({ path: testInfo.outputPath('link-guide-wallpaper.png'), animations: 'disabled' })
  await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0)
  await page.evaluate(async () => {
    const fixture = (window as any).pluginFixture
    await fixture.theme(true)
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .65 }, regions: { card: { opacity: 0, radius: 16, blur: 4 }, overlay: { opacity: .8, radius: 16, blur: 8 } } } })
  })
  await expect(card).toHaveCSS('border-radius', '16px')
  await expect(card).toHaveCSS('background-color', /rgba\(.*?, 0\)/)
  await card.getByRole('button', { name: '详情', exact: true }).focus()
  await expect(card.getByRole('button', { name: '详情', exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('catalog-dark-transparent.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.screenshot({ path: testInfo.outputPath('catalog-mobile-dark.png'), animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await banner.getByRole('button', { name: '关联已有项目', exact: true }).click()
  await expect(guide).toBeInViewport({ ratio: .95 })
  await page.evaluate(() => { (window as any).pluginFixture.copyFails = true })
  await guide.getByRole('button', { name: '复制', exact: true }).click()
  await expect(guide.getByRole('alert')).toContainText('复制失败')
  await page.screenshot({ path: testInfo.outputPath('link-guide-mobile-copy-error.png'), animations: 'disabled' })
  await page.evaluate(() => { (window as any).pluginFixture.copyFails = false })
  await guide.getByRole('button', { name: '复制', exact: true }).click()
  await expect(guide.getByRole('alert')).toHaveCount(0)
  await expect(guide.getByRole('button', { name: '已复制', exact: true })).toBeVisible()
  await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0)
  await page.locator('.catalog-actions').getByRole('button', { name: '提交插件', exact: true }).click()
  await expect(page.locator('.plugin-submission-modal')).toBeInViewport({ ratio: .95 })
  await page.keyboard.press('Escape'); await expect(page.locator('.plugin-submission-modal')).toHaveCount(0)
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } }); (window as any).pluginFixture.wallpaper(false) })
  await page.screenshot({ path: testInfo.outputPath('catalog-mobile-reset.png'), animations: 'disabled' })
  await banner.getByRole('button', { name: '创建空白项目', exact: true }).click()
  await expect(guide).toBeInViewport({ ratio: .95 })
  await expect(guide.getByRole('button', { name: '复制', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('create-guide-mobile-reset.png'), animations: 'disabled' })
  await page.keyboard.press('Escape'); await expect(guide).toHaveCount(0)
  await page.getByRole('button', { name: '安装插件', exact: true }).click()
  await expect(page.locator('.plugin-install-modal').getByRole('textbox')).toBeVisible()
})
