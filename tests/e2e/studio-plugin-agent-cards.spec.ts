import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('appends plugin Agents to the shared manager grid without description text', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const plugin = (id: string, installed: boolean) => ({
    id: `plugin:example/${id}`, name: `Example ${id}`, vendor: 'Example Team', origin: 'plugin',
    icon: '/coding-agents/pi.svg', description: 'Plugin description must not appear on the Agent card',
    modes: ['scoped', 'global'], surfaces: ['chat', 'group-chat', 'workflow'],
    actions: { settings: true, checkUpdate: true, upgrade: true }, status: { installed, version: installed ? '1.0.0' : '' },
  })
  const plugins = [plugin('installed', true), plugin('absent', false)]
  const native = ['hermes', 'codex', 'cursor', 'antigravity', 'zcode'].map(id => ({
    id, installed: true, version: '1.0.0', source: 'user-cli', path: `/fixture/${id}`,
  }))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [plugins[0], { id: 'codex', origin: 'builtin' }, plugins[1]] } })
    if (path === '/api/agents/status') return route.fulfill({ json: { revision: 1, agents: [...native, ...plugins.map(agent => ({ ...agent, ...agent.status, source: 'plugin' }))] } })
    if (path === '/api/coding-agents/update-policies') return route.fulfill({ json: { agents: {} } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugin-agents.ts').replace(/^\//, '')
  await page.route('**/__plugin_cards__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_cards__#/agents')
  const installed = page.getByTestId(`agent-card-${plugins[0].id}`)
  const absent = page.getByTestId(`agent-card-${plugins[1].id}`)
  await expect(installed).toBeVisible()
  await expect(installed.locator('.agent-name-row')).toContainText('已安装')
  await expect(installed.locator('.agent-version')).toHaveText('v1.0.0')
  await expect(absent.locator('.agent-name-row')).toContainText('未安装')
  await expect(absent.getByRole('button', { name: '一键安装', exact: true })).toBeVisible()
  await expect(installed).not.toContainText(plugins[0].description)
  await expect(absent).not.toContainText(plugins[1].description)
  const ids = await page.locator('.coding-agent-grid > [data-testid]').evaluateAll(cards => cards.map(card => card.getAttribute('data-testid')))
  expect(ids.slice(0, 2)).toEqual(['agent-card-ekko', 'agent-card-hermes'])
  expect(ids.slice(-3)).toEqual(['agent-card-zcode', ...plugins.map(agent => `agent-card-${agent.id}`)])
  expect(ids.filter(id => id === 'agent-card-codex')).toHaveLength(1)
  const codex = page.getByTestId('agent-card-codex')
  await expect(codex).toBeVisible()
  const appearance = (card: Element) => {
    const style = getComputedStyle(card), logo = card.querySelector('img')!.getBoundingClientRect()
    return { padding: style.padding, radius: style.borderRadius, logo: [logo.width, logo.height], font: getComputedStyle(card.querySelector('h3')!).fontSize }
  }
  expect(await installed.evaluate(appearance)).toEqual(await codex.evaluate(appearance))
  await installed.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('agent-cards-light.png') })
  await page.evaluate(async () => { await (window as any).agentFixture.theme(true) })
  await expect.poll(() => installed.getByRole('button', { name: '设置', exact: true }).evaluate(button => Number(getComputedStyle(button).color.match(/[\d.]+/)?.[0]))).toBeGreaterThan(150)
  await page.screenshot({ path: testInfo.outputPath('agent-cards-dark.png') })
  await page.evaluate(() => {
    (window as any).agentFixture.background('/logo.png');
    (window as any).agentFixture.appearance({ brightness: 'dark', appearance: { global: { opacity: 0.7 }, regions: { card: { opacity: 0, blur: 4, radius: 12 } } } })
  })
  await expect.poll(() => installed.evaluate(card => getComputedStyle(card).backgroundColor)).toMatch(/rgba\(.*0\)/)
  await page.screenshot({ path: testInfo.outputPath('agent-cards-transparent.png') })
  await page.evaluate(async () => {
    (window as any).agentFixture.background(null);
    (window as any).agentFixture.appearance({ appearance: { global: {}, regions: {} } });
    await (window as any).agentFixture.theme(false)
  })
  await expect.poll(() => installed.evaluate(card => getComputedStyle(card).backgroundColor)).not.toMatch(/rgba\(.*0\)/)
  await page.setViewportSize({ width: 390, height: 844 })
  await absent.scrollIntoViewIfNeeded()
  await expect(absent.getByRole('button', { name: '一键安装', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('agent-cards-mobile.png') })
  expect(errors).toEqual([])
})
