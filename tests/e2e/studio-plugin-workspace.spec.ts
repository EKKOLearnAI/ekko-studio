import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('direct plugin pages stay available across accounts and Profiles while public navigation stays hidden', async ({ page }, testInfo) => {
  let active = true, installed = true
  let releaseSlowProfile: (() => void) | undefined
  const slowProfile = new Promise<void>(resolve => { releaseSlowProfile = resolve })
  const clients: string[] = []
  let change = 0
  const makePlugin = (id: string, name: string, enabled: boolean, views: object[], capabilities = ['ui']) => ({
    manifest: { id, name, description: name + ' description', apiVersion: 1, version: '1.0.0', client: 'client.mjs', capabilities, views },
    enabled, status: enabled ? 'active' : 'disabled', source: '/tmp/' + id, config: {}, tools: [], commands: [], actions: [],
  })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url()), profile = url.searchParams.get('profile') || 'default'
    if (url.pathname === '/api/auth/me') {
      const account = await page.evaluate(() => JSON.parse(localStorage.getItem('plugin_fixture_account') || '{"sub":"1","role":"super_admin"}'))
      return route.fulfill({ json: { user: { id: Number(account.sub), username: 'Tester', role: account.role } } })
    }
    if (url.pathname.endsWith('/events')) return route.fulfill({ json: { cursor: change, generation: 'global', events: Number(url.searchParams.get('cursor')) < change ? [{ id: String(change), type: 'plugin.changed', pluginId: 'alpha', timestamp: Date.now(), identity: { userId: 1, profile: 'default' }, data: null }] : [] } })
    if (url.pathname.endsWith('/client')) {
      clients.push(profile)
      if (profile === 'slow') await slowProfile
      return route.fulfill({ json: { source: 'export function mount(root,ctx){root.textContent=ctx.identity.userId+"/"+ctx.identity.profile+":"+ctx.view;}' } })
    }
    if (url.pathname === '/api/studio/plugins') {
      expect(url.searchParams.has('profile')).toBe(false)
      expect(route.request().headers()['x-hermes-profile'] || '').toBe('')
      const pages = [{ id: 'home', title: '主页', slot: 'page' }, { id: 'report', title: '报告', slot: 'page' }, { id: 'settings', title: '设置', slot: 'settings' }]
      const plugins = [
        ...(installed ? [makePlugin('alpha', 'Alpha 工作台', active, pages)] : []),
        makePlugin('beta', 'Beta 已禁用', false, [{ id: 'home', title: 'Beta', slot: 'page' }]),
        makePlugin('automation', '自动化助手', true, [], ['automation']),
      ]
      return route.fulfill({ json: { revision: 1, plugins } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_workspace__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_workspace__')
  await expect(page.locator('.plugin-card')).toHaveCount(3)
  await expect(page.locator('iframe')).toHaveCount(0)
  expect(clients).toHaveLength(0)
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('没有结果')
  await expect(page.getByText('没有匹配的插件')).toBeVisible()
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('Beta')
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await page.getByRole('textbox', { name: '搜索插件名称、描述…' }).fill('')
  await page.getByRole('button', { name: '自动化 1', exact: true }).click()
  await expect(page.locator('.plugin-card')).toHaveCount(1)
  await expect(page.locator('.plugin-card')).toContainText('自动化助手')
  await page.getByRole('button', { name: '全部 3', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('center-light.png') })
  await page.getByRole('button', { name: 'Alpha 工作台', exact: true }).click()
  await page.locator('.n-tabs-tab').getByText('配置', { exact: true }).click()
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.getByRole('link', { name: '设置 ↗', exact: true }).click()
  await expect(page.frameLocator('iframe').locator('#root')).toHaveText('1/default:settings')
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/alpha/report'))
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('#root')).toHaveText('1/default:report')
  await page.reload()
  await expect(frame.locator('#root')).toHaveText('1/default:report')
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  await expect(page.locator('iframe')).toHaveCount(1)
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/alpha/home'))
  await expect(frame.locator('#root')).toHaveText('1/default:home')
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/alpha/missing'))
  await expect(page.getByText('此页面不可用，请检查插件状态或页面地址。')).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/alpha'))
  await expect(frame.locator('#root')).toHaveText('1/default:home')
  active = false; change++
  await expect(page.getByText('此插件已禁用，请在插件中心启用。')).toBeVisible()
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  active = true; change++
  await expect(frame.locator('#root')).toHaveText('1/default:home')
  await page.evaluate(() => (window as any).pluginFixture.profile('slow'))
  await expect(frame.locator('#root')).toBeEmpty()
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  await page.evaluate(() => (window as any).pluginFixture.profile('other'))
  await expect(page.locator('.studio-navigation-rail__plugins a')).toHaveCount(0)
  await expect(frame.locator('#root')).toHaveText('1/other:home')
  releaseSlowProfile!()
  await expect(frame.locator('#root')).toHaveText('1/other:home')
  expect(clients).toContain('slow')
  await page.evaluate(() => (window as any).pluginFixture.account(2, 'admin'))
  await expect(frame.locator('#root')).toHaveText('2/other:home')
  await page.getByRole('button', { name: '管理插件' }).click()
  await expect(page.locator('.plugin-card')).toHaveCount(3)
  await expect(page.getByText('全局插件 · 所有账号与 Profile 可用')).toBeVisible()
  await expect(page.getByRole('button', { name: '安装插件', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).pluginFixture.navigate('/studio/plugins/alpha/home'))
  await expect(frame.locator('#root')).toHaveText('2/other:home')
  installed = false; change++
  await expect(page.getByText('此页面不可用，请检查插件状态或页面地址。')).toBeVisible()
  await page.getByRole('button', { name: '返回插件中心' }).click()
  await expect(page.locator('.plugin-card')).toHaveCount(2)
  await page.evaluate(() => (window as any).pluginFixture.theme(true))
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('textbox', { name: '搜索插件名称、描述…' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('center-dark-mobile.png'), animations: 'disabled' })
  for (const scene of ['light-wallpaper', 'dark-transparent', 'reset']) {
    await page.evaluate(scene => {
      const fixture = (window as any).pluginFixture
      fixture.appearance({ brightness: scene === 'dark-transparent' ? 'dark' : 'light', appearance: scene === 'reset'
        ? { global: {}, regions: {} }
        : { global: { opacity: .65 }, regions: { card: { opacity: scene === 'dark-transparent' ? 0 : .4, radius: 20, blur: 4, backgroundColor: '#627a94' }, overlay: { opacity: .8, radius: 16, blur: 8 } } } })
      fixture.wallpaper(scene !== 'reset')
    }, scene)
    await page.getByRole('button', { name: 'Beta 已禁用', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('使用入口')
    await expect(page.getByRole('dialog')).toBeInViewport({ ratio: .95 })
    await page.screenshot({ path: testInfo.outputPath('details-' + scene + '.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: '搜索插件名称、描述…' })).toBeVisible()
  }
})
