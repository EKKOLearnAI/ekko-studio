import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'

const endpoint = 'https://api.ekkostudio.xyz/api/studio/plugins/submissions'
const receipt = { ok: true, data: { submissionId: 'd27d341b-edee-4089-9fb9-e3d5ce07c9e3', pluginId: 'a'.repeat(64), status: 'pending', createTime: 1794400000 } }
async function open(page: Page) {
  // A regular account can submit even though only super administrators manage local installs.
  await page.addInitScript(() => localStorage.setItem('plugin_fixture_account', JSON.stringify({ sub: '2', role: 'admin' })))
  await page.route(url => url.origin !== 'https://api.ekkostudio.xyz' && url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/studio/plugins')) expect(route.request().method()).toBe('GET')
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 2, username: 'Tester', role: 'admin' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 0, plugins: [] } })
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'fixture', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__plugin_submission__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_submission__')
  await expect(page.getByRole('button', { name: '安装插件', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '提交插件', exact: true }).click()
  return page.locator('.plugin-submission-modal')
}
async function fill(page: Page) {
  await page.getByRole('textbox', { name: '仓库地址', exact: true }).fill(' https://github.com/example/notebook ')
  await page.getByRole('textbox', { name: '插件名称', exact: true }).fill(' 工作便签 ')
  await page.getByRole('textbox', { name: '插件描述', exact: true }).fill(' 在 Studio 中保存和管理工作便签 ')
}

test('validates the form and sends one anonymous submission without changing installed plugins', async ({ page }, testInfo) => {
  const calls: unknown[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.context().addCookies([{ name: 'cloud_login', value: 'fixture', url: 'https://api.ekkostudio.xyz' }])
  await page.route(endpoint, async route => {
    const request = route.request()
    expect(request.method()).toBe('POST')
    const headers = await request.allHeaders()
    for (const key of ['authorization', 'cookie', 'x-hermes-profile', 'referer']) expect(headers[key]).toBeUndefined()
    calls.push(request.postDataJSON())
    await held
    await route.fulfill({ status: 201, json: receipt })
  })
  const modal = await open(page), submit = modal.getByRole('button', { name: '提交审核', exact: true })
  await submit.click()
  await expect(modal.getByText('请填写插件名称，最多 160 个字符。')).toBeVisible()
  expect(calls).toHaveLength(0)
  await fill(page)
  await page.getByRole('textbox', { name: '仓库地址', exact: true }).fill('https://user:password@github.com/example/notebook')
  await submit.click()
  await expect(modal.getByText('请输入有效的 HTTP(S) 仓库地址，不含账号密码、查询参数或锚点。')).toBeVisible()
  expect(calls).toHaveLength(0)
  await fill(page)
  await page.screenshot({ path: testInfo.outputPath('submission-light.png'), animations: 'disabled' })
  await submit.click()
  await expect(submit).toBeDisabled()
  await expect(modal.getByRole('textbox', { name: '插件名称', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape'); await expect(modal).toBeVisible()
  await expect.poll(() => calls.length).toBe(1)
  expect(calls).toEqual([{ repository: 'https://github.com/example/notebook', name: '工作便签', description: '在 Studio 中保存和管理工作便签' }])
  release()
  await expect(modal.getByText('已收到插件信息，等待管理员审核。')).toBeVisible()
  await expect(page.locator('.plugin-card')).toHaveCount(0)
  await modal.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '提交插件', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '插件名称', exact: true })).toHaveValue('')
  expect(calls).toHaveLength(1)
})

test('keeps drafts after rate limits and lost responses, with themed narrow dialogs', async ({ page }, testInfo) => {
  let calls = 0
  await page.route(endpoint, async route => {
    calls++
    if (calls === 1) return route.fulfill({ status: 429, json: { ok: false, error: 'rate_limited' } })
    if (calls === 2) return route.abort('failed')
    return route.fulfill({ status: 201, json: receipt })
  })
  const modal = await open(page)
  await fill(page)
  await modal.getByRole('button', { name: '提交审核', exact: true }).click()
  await expect(modal.getByRole('alert')).toHaveText('提交过于频繁，请稍后再试。')
  await expect(page.getByRole('textbox', { name: '插件名称', exact: true })).toHaveValue(' 工作便签 ')
  await page.evaluate(async () => {
    await (window as any).pluginFixture.theme(true)
    ;(window as any).pluginFixture.wallpaper(true)
    ;(window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .65 }, regions: { overlay: { opacity: .8, radius: 20, blur: 8, backgroundColor: '#627a94' } } } })
  })
  await page.screenshot({ path: testInfo.outputPath('submission-dark-wallpaper.png'), animations: 'disabled' })
  await page.evaluate(() => (window as any).pluginFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: .65 }, regions: { overlay: { opacity: 0, radius: 20, blur: 8 } } } }))
  await page.screenshot({ path: testInfo.outputPath('submission-overlay-transparent.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => { (window as any).pluginFixture.appearance({ brightness: 'light', appearance: { global: {}, regions: {} } }); (window as any).pluginFixture.wallpaper(false) })
  await page.screenshot({ path: testInfo.outputPath('submission-mobile-reset.png'), animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await modal.getByRole('button', { name: '提交审核', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('未收到明确的提交结果')
  expect(calls).toBe(2)
  await modal.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '提交插件', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '插件描述', exact: true })).toHaveValue(' 在 Studio 中保存和管理工作便签 ')
  expect(calls).toBe(2)
  await modal.getByRole('button', { name: '提交审核', exact: true }).click()
  await expect(modal.getByText('已收到插件信息，等待管理员审核。')).toBeVisible()
  expect(calls).toBe(3)
})
