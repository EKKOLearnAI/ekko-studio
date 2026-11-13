import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { securityHeaders } from '../../packages/server/src/modules/studio/middleware/security'

test('manages a plugin Agent, updates dynamic choices, and edits its own isolated settings page', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let version = '1.0.0', prefix = 'Echo'
  const plugin = { manifest: { id: 'custom-agent', name: 'Custom Agent Example', version: '1.0.0', apiVersion: 1, client: 'client.mjs', permissions: ['agents', 'ui'], views: [{ id: 'settings', title: 'Settings', slot: 'settings' }] }, config: {}, status: 'active', enabled: true, tools: [], commands: [], actions: [] }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [{ id: 'plugin:custom-agent/assistant', name: 'Custom Agent', vendor: 'Example Team', origin: 'plugin', modes: ['scoped', 'global'], surfaces: ['chat', 'group-chat', 'workflow'], actions: { settings: true, checkUpdate: true, upgrade: true }, status: { installed: true, version } }] } })
    if (path.endsWith('/check-update')) return route.fulfill({ json: { currentVersion: version, latestVersion: '2.0.0', updateAvailable: true } })
    if (path.endsWith('/upgrade')) { expect(route.request().postDataJSON()).toEqual({ version: '2.0.0', expectedVersion: '1.0.0' }); version = '2.0.0'; return route.fulfill({ json: { installedVersion: version } }) }
    if (path.startsWith('/api/studio/agents/') && path.endsWith('/settings')) return route.fulfill({ json: { name: 'studio.pluginSettings', params: { pluginId: 'custom-agent', viewId: 'settings' } } })
    if (path === '/api/studio/plugins') return route.fulfill({ json: { revision: 1, plugins: [plugin] } })
    if (path.endsWith('/client')) return route.fulfill({ json: { source: await import('node:fs/promises').then(fs => fs.readFile(resolve('tests/fixtures/plugins/custom-agent/client.mjs'), 'utf8')) } })
    if (path.endsWith('/invoke')) { const body = route.request().postDataJSON(); if (body.name === 'save-settings') prefix = body.input.prefix; return route.fulfill({ json: { result: body.name === 'get-settings' ? { prefix } : { ok: true } } }) }
    if (path.endsWith('/events')) return route.fulfill({ json: { cursor: 0, generation: 'fixture', events: [] } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugin-agents.ts').replace(/^\//, '')
  const headers: Record<string, string> = {}
  await securityHeaders()({ path: '/', query: {}, secure: false, get: () => '', set: (key: string, value: string) => { headers[key] = value } } as any, async () => {})
  await page.route('**/__plugin_agents__', route => route.fulfill({ contentType: 'text/html', headers, body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_agents__')
  const card = page.getByTestId('agent-card-plugin:custom-agent/assistant')
  await expect(card).toContainText('Example Team')
  await expect(page.getByLabel('Agent picker').locator('option[value="plugin:custom-agent/assistant"]')).toHaveText('Custom Agent')
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await card.getByRole('button', { name: /2\.0\.0/ }).click()
  await expect(card).toContainText('2.0.0')
  await expect(card.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(page.locator('.n-message')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('plugin-agent-manager-light.png') })
  await page.evaluate(async () => { await (window as any).agentFixture.theme(true); (window as any).agentFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: 0.7 }, regions: { card: { opacity: 0, blur: 4, radius: 12 } } } }) })
  await expect.poll(() => card.getByRole('button', { name: '设置', exact: true }).evaluate(button => Number(getComputedStyle(button).color.match(/[\d.]+/)?.[0]))).toBeGreaterThan(150)
  await page.screenshot({ path: testInfo.outputPath('plugin-agent-manager-dark.png') })
  await card.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL(/studio\/plugin-settings\/custom-agent\/settings/)
  const frame = page.frameLocator('.plugin-workspace iframe')
  await frame.getByLabel('Local echo prefix').fill('Custom prefix')
  await frame.getByRole('button', { name: 'Save settings' }).click()
  await expect.poll(() => prefix).toBe('Custom prefix')
  await page.reload()
  await expect(page.frameLocator('.plugin-workspace iframe').getByLabel('Local echo prefix')).toHaveValue('Custom prefix')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.frameLocator('.plugin-workspace iframe').getByRole('button', { name: 'Save settings' })).toBeVisible()
  expect(errors).toEqual([])
})
