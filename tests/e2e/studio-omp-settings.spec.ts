import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { securityHeaders } from '../../packages/server/src/modules/studio/middleware/security'

test('opens the built-in OMP settings in Studio locale and persists native model configuration', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let saves = 0
  let settings = { executable: '', defaultModel: 'custom/test', models: { providers: { custom: { api: 'openai-completions', apiKey: '••••••••', models: [{ id: 'test' }] } } }, config: {} }
  const require = createRequire(resolve('package.json'))
  const manifest = JSON.parse(await readFile(require.resolve('@ekko-studio/plugin-omp/plugin.json'), 'utf8'))
  manifest.icon = `data:image/png;base64,${(await readFile(require.resolve('@ekko-studio/plugin-omp/icon.png'))).toString('base64')}`
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [{ id: 'plugin:omp/omp', name: 'Oh My Pi', vendor: 'Stencil Labs', icon: manifest.icon, origin: 'plugin', modes: ['scoped', 'global'], actions: { settings: true, checkUpdate: true, upgrade: true }, status: { installed: false } }] } })
    if (path.endsWith('/settings')) return route.fulfill({ json: { name: 'studio.pluginAgentSettings', params: { pluginId: 'omp', viewId: 'skills' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [{ manifest, config: {}, status: 'active', enabled: true, tools: [], commands: [], actions: [] }] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: await readFile(require.resolve('@ekko-studio/plugin-omp/client.mjs'), 'utf8') } })
    if (path.endsWith('/invoke')) {
      const body = route.request().postDataJSON()
      if (body.name === 'list-skills') return route.fulfill({ json: { result: { skills: [] } } })
      if (body.name === 'list-mcp') return route.fulfill({ json: { result: { servers: [] } } })
      if (body.name === 'save-settings') { settings = body.input; saves++ }
      return route.fulfill({ json: { result: body.name === 'get-settings' ? { ...settings, status: { installed: false } } : { ok: true } } })
    }
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'fixture', events: [] } })
    return route.fulfill({ json: {} })
  })
  const headers: Record<string, string> = {}
  await securityHeaders()({ path: '/', query: {}, secure: false, get: () => '', set: (key: string, value: string) => { headers[key] = value } } as any, async () => {})
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugins.ts').replace(/^\//, '')
  await page.route('**/__omp_settings__', route => route.fulfill({ contentType: 'text/html', headers, body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__omp_settings__#/hermes/agentManager')
  const card = page.getByTestId('agent-card-plugin:omp/omp')
  await expect(card).toContainText('未安装')
  const icon = card.locator('img')
  await expect(icon).toHaveAttribute('src', manifest.icon)
  await expect.poll(() => icon.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(256)
  await page.screenshot({ path: testInfo.outputPath('omp-official-logo.png') })
  await card.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL(/studio\/plugin-agent-settings\/omp\/skills/)
  const frame = page.frameLocator('.plugin-workspace iframe')
  const sidebar = page.locator('.plugin-config-sidebar')
  await expect(sidebar.locator('.plugin-config-nav a')).toHaveCount(3)
  await expect(frame.getByRole('heading', { name: 'Skill 管理', exact: true })).toBeVisible()
  await expect(frame.getByText('还没有 Skill，点击“添加 Skill”开始。', { exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: 'MCP 管理', exact: true }).click()
  await expect(frame.getByRole('heading', { name: 'MCP 管理', exact: true })).toBeVisible()
  await expect(frame.getByText('还没有 MCP 服务，点击“添加 MCP 服务”开始。', { exact: true })).toBeVisible()
  await sidebar.getByRole('link', { name: '配置编辑', exact: true }).click()
  await expect(page).toHaveURL(/studio\/plugin-agent-settings\/omp\/settings/)
  await expect(frame.getByRole('heading', { name: '配置编辑', exact: true })).toBeVisible()
  await expect(frame.getByLabel('模型与凭证（JSON）')).toHaveValue(/••••••••/)
  await frame.getByLabel('默认模型', { exact: true }).fill('custom/next-model')
  await frame.getByLabel('OMP 运行设置（JSON）').fill('{"thinkingLevel":"medium"}')
  await frame.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect.poll(() => saves).toBe(1)
  await page.reload()
  await expect(frame.getByLabel('默认模型', { exact: true })).toHaveValue('custom/next-model')
  await expect(frame.getByLabel('OMP 运行设置（JSON）')).toHaveValue(/medium/)
  await frame.getByLabel('模型与凭证（JSON）').fill('{invalid')
  await frame.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(frame.getByRole('status')).toContainText(/JSON|property/i)
  expect(saves).toBe(1)
  await frame.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(frame.getByLabel('模型与凭证（JSON）')).toHaveValue(/••••••••/)
  await page.screenshot({ path: testInfo.outputPath('builtin-omp-settings.png') })
  await page.evaluate(async () => { await (window as any).pluginFixture.theme(true) })
  await expect.poll(() => frame.getByRole('heading', { name: '配置编辑', exact: true }).evaluate(el => Number(getComputedStyle(el).color.match(/[\d.]+/)?.[0]))).toBeGreaterThan(150)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(frame.getByRole('button', { name: '保存配置', exact: true })).toBeVisible()
  expect(await frame.locator('body').evaluate(el => el.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('builtin-omp-settings-dark-mobile.png') })
  expect(errors).toEqual([])
})
