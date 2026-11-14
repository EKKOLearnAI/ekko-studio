import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { CodingAgentToolStatus, AgentUpdatePolicyState } from '../../packages/client/src/api/coding-agents'

async function setup(page: Page, installed = true) {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const tool = {
    id: 'dsh', installed, version: installed ? '0.2.2-rc.1' : '', source: 'user-cli',
    compatibility: { adapterRevision: 5, pinnedVersion: installed ? '0.2.2-rc.1' : '', previousVersion: installed ? '0.2.1-rc.5' : '', verifiedVersion: installed ? '0.2.2-rc.1' : '' },
  } as CodingAgentToolStatus
  const policy: AgentUpdatePolicyState = { autoUpdate: false, autoUpdateSupported: true, status: 'current', currentVersion: tool.version, latestVersion: tool.version, checkedAt: '' }
  const calls: { path: string; input: Record<string, unknown> }[] = []
  const state: { reject: boolean; gate?: Promise<void> } = { reject: false }
  const tools = () => [tool, ...['opencode', 'cursor', 'antigravity', 'zcode'].map(id => ({ id, installed: true, version: '1.0.0', source: 'user-cli' }))]
  function activate(input: Record<string, unknown>) {
    const previous = tool.version
    const next = input.rollback ? tool.compatibility!.previousVersion : input.version === 'latest' ? '0.2.4-rc.1' : String(input.version || '0.2.4-rc.1')
    tool.installed = true
    tool.version = next
    tool.compatibility = { adapterRevision: 5, verifiedVersion: next, previousVersion: previous, pinnedVersion: input.version === 'latest' ? '' : next }
    Object.assign(policy, { currentVersion: next, latestVersion: next, status: 'current' })
  }
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    const input = request.method() === 'POST' || request.method() === 'PUT' ? request.postDataJSON() || {} : {}
    if (request.method() !== 'GET') calls.push({ path, input })
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/agents/status') return route.fulfill({ json: { revision: 1, agents: [{ id: 'hermes', installed: true, version: '1.0.0', source: 'user-cli' }, ...tools()] } })
    if (path === '/api/coding-agents') return route.fulfill({ json: { tools: tools() } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [] } })
    if (path === '/api/coding-agents/update-policies') return route.fulfill({ json: { agents: { dsh: policy } } })
    if (path === '/api/coding-agents/dsh/update-policy') {
      policy.autoUpdate = input.autoUpdate
      return route.fulfill({ json: { agents: { dsh: policy } } })
    }
    if (path === '/api/studio/agents/dsh/check-update') return route.fulfill({ json: { currentVersion: tool.version, latestVersion: tool.compatibility?.pinnedVersion || tool.version, updateAvailable: false } })
    if (path === '/api/studio/agents/dsh/settings') return route.fulfill({ json: { name: 'codingAgent.config', params: { agentId: 'dsh', section: 'settings' } } })
    if (path === '/api/studio/agents/dsh/upgrade' || path === '/api/coding-agents/dsh/install') {
      await state.gate
      if (state.reject) return route.fulfill({ status: 422, json: { error: 'DSH candidate rejected; previous installation preserved.' } })
      if (path.endsWith('/upgrade')) expect(input.expectedVersion).toBe(tool.version)
      activate(input)
      return route.fulfill({ json: path.endsWith('/upgrade') ? { installedVersion: tool.version } : { success: true, tool, tools: tools(), updateState: policy } })
    }
    if (path === '/api/coding-agents/dsh' && request.method() === 'DELETE') {
      tool.installed = false; tool.version = ''
      tool.compatibility = { adapterRevision: 5, pinnedVersion: '', verifiedVersion: '', previousVersion: '' }
      return route.fulfill({ json: { success: true, tool, tools: tools() } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugin-agents.ts').replace(/^\//, '')
  await page.route('**/__dsh_manager__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__dsh_manager__#/agents')
  const card = page.getByTestId('agent-card-dsh')
  await expect(card.getByTestId('dsh-version-summary')).toBeVisible()
  const open = card.getByTestId('dsh-version-manager-open')
  const drawer = page.getByTestId('dsh-version-manager')
  return { tool, policy, calls, state, errors, card, open, drawer }
}

async function expectEqualCards(page: Page) {
  const sizes = await page.locator('.coding-agent-grid > .agent-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height))
  expect(sizes.length).toBeGreaterThan(10)
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(1)
  return Math.max(...sizes)
}

test('keeps all rows equally compact, opens a keyboard-accessible drawer, and preserves settings navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 1000 })
  const { card, open, drawer, errors } = await setup(page)
  await expect(card).toContainText('已固定')
  await expect(card).toContainText('已验证')
  await expect(card).toContainText('v0.2.2-rc.1')
  await expect(card.getByRole('textbox')).toHaveCount(0)
  expect(await expectEqualCards(page)).toBeLessThan(300)
  await open.focus(); await page.keyboard.press('Enter')
  await expect(drawer).toBeVisible()
  await expect(drawer).toContainText('ACP 适配器 5 · 已测试')
  await expect(drawer).toContainText('当前版本：v0.2.2-rc.1')
  await expect(drawer.getByLabel('精确 npm 版本（如 0.2.2-rc.1）')).toBeEnabled()
  await expect.poll(() => page.locator('.dsh-version-drawer').evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('versions-drawer-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(open).toBeFocused()
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('equal-agent-cards-desktop.png') })
  await card.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page).toHaveURL(/#\/studio\/agents\/dsh\/settings$/)
  expect(errors).toEqual([])
})

test('keeps check-update read-only and preserves pin, latest-unpin, rollback, automatic updates and delete confirmation', async ({ page }) => {
  const { card, open, drawer, calls, errors } = await setup(page)
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(card.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  expect(calls.map(call => call.path)).toEqual(['/api/studio/agents/dsh/check-update'])
  await card.getByRole('switch').click()
  await expect(card.getByRole('switch')).toBeChecked()
  await open.click()
  await drawer.getByRole('textbox').fill('0.2.3-rc.1')
  await drawer.getByRole('button', { name: '安装并固定', exact: true }).click()
  await expect(drawer).toContainText('固定版本：0.2.3-rc.1')
  await expect(card).toContainText('v0.2.3-rc.1')
  await drawer.getByRole('button', { name: '检查并使用最新版', exact: true }).click()
  await expect(drawer).toContainText('固定版本：未固定')
  await expect(card).toContainText('未固定')
  await expect(card).toContainText('v0.2.4-rc.1')
  await drawer.getByRole('button', { name: '恢复 0.2.3-rc.1', exact: true }).click()
  await expect(card).toContainText('v0.2.3-rc.1')
  await expect(card).toContainText('已固定')
  const mutations = calls.filter(call => /upgrade|\/install$/.test(call.path))
  expect(mutations.map(call => call.input)).toEqual([
    { version: '0.2.3-rc.1', expectedVersion: '0.2.2-rc.1' },
    { version: 'latest', expectedVersion: '0.2.3-rc.1' },
    { rollback: true },
  ])
  await page.keyboard.press('Escape')
  await card.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  expect(calls.filter(call => call.path === '/api/coding-agents/dsh')).toHaveLength(0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(card).toContainText('已安装')
  await card.getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(card).toContainText('未安装')
  await expect(card).toContainText('待验证')
  expect(calls.filter(call => call.path === '/api/coding-agents/dsh')).toHaveLength(1)
  expect(errors).toEqual([])
})

test('preserves drafts and synchronizes in-flight and failed operations when the drawer is closed and reopened', async ({ page }, testInfo) => {
  const { card, open, drawer, state, errors } = await setup(page)
  let release!: () => void
  state.gate = new Promise<void>(resolve => { release = resolve })
  state.reject = true
  await open.click()
  await drawer.getByRole('textbox').fill('0.2.3-rc.1')
  await drawer.getByRole('button', { name: '安装并固定', exact: true }).click()
  await expect(drawer.getByRole('status')).toHaveText('安装中')
  await expect(drawer.getByRole('textbox')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(card.getByRole('status')).toHaveText('安装中')
  await expect(card.getByRole('switch')).toBeDisabled()
  await expect(card.getByRole('button', { name: '检查更新', exact: true })).toBeDisabled()
  await open.click()
  await expect(drawer.getByRole('textbox')).toHaveValue('0.2.3-rc.1')
  await expect(drawer.getByRole('status')).toHaveText('安装中')
  release()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(drawer.getByRole('alert')).toContainText('previous installation preserved')
  await expect(card.getByRole('alert')).toContainText('previous installation preserved')
  await expect(card).toContainText('v0.2.2-rc.1')
  await expect(drawer.getByRole('textbox')).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('versions-drawer-failure.png') })
  await page.keyboard.press('Escape')
  await expectEqualCards(page)
  await open.click()
  await expect(drawer.getByRole('alert')).toContainText('previous installation preserved')
  state.reject = false
  await drawer.getByRole('button', { name: '安装并固定', exact: true }).click()
  await expect(drawer).toContainText('固定版本：0.2.3-rc.1')
  await expect(drawer.getByRole('alert')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('supports first installation and no rollback on mobile, with themed overlays and no horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { card, open, drawer, tool, calls, errors } = await setup(page, false)
  await expect(card).toContainText('未安装')
  await expect(card).toContainText('未固定')
  await expect(card).toContainText('待验证')
  await expect(card.getByRole('button', { name: '一键安装', exact: true })).toBeVisible()
  await expectEqualCards(page)
  await open.click()
  await expect(drawer.getByRole('button', { name: '恢复 —', exact: true })).toBeDisabled()
  await expect(drawer).toContainText('没有可恢复的版本')
  await expect(drawer.getByRole('button', { name: '安装并固定', exact: true })).toBeDisabled()
  await drawer.getByRole('button', { name: '检查并使用最新版', exact: true }).click()
  await expect(card).toContainText('v0.2.4-rc.1')
  expect(calls.find(call => call.path.endsWith('/install'))?.input).toEqual({ version: 'latest' })
  expect(tool.compatibility?.pinnedVersion).toBe('')
  const drawerWidth = await page.locator('.dsh-version-drawer').evaluate(el => el.getBoundingClientRect().width)
  expect(drawerWidth).toBe(390)
  await page.screenshot({ path: testInfo.outputPath('versions-mobile-light.png') })
  await page.evaluate(async () => {
    const fixture = (window as any).agentFixture
    await fixture.theme(true)
    fixture.background('/logo.png')
    fixture.appearance({ brightness: 'dark', appearance: { global: { opacity: 0.7 }, regions: { card: { opacity: 0, blur: 4, radius: 12 }, overlay: { opacity: 0.8 } } } })
  })
  await expect(drawer.getByRole('textbox')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('versions-mobile-dark-wallpaper.png') })
  await page.evaluate(async () => {
    const fixture = (window as any).agentFixture
    fixture.background(null); fixture.appearance({ appearance: { global: {}, regions: {} } }); await fixture.theme(false)
  })
  await expect(drawer.getByRole('textbox')).toBeEnabled()
  expect(errors).toEqual([])
})

test('shows background waiting, updating and failure in both views and refreshes the installed version after an automatic update', async ({ page }) => {
  await page.clock.install()
  const { card, open, drawer, tool, policy, errors } = await setup(page)
  policy.status = 'waiting'
  await page.clock.runFor(15001)
  await expect(card.getByRole('status')).toHaveText('等待 Agent 空闲后更新')
  await open.click()
  await expect(drawer.getByRole('status')).toHaveText('等待 Agent 空闲后更新')
  policy.status = 'updating'
  await page.clock.runFor(15001)
  await expect(drawer.getByRole('status')).toHaveText('正在自动更新…')
  await expect(drawer.getByRole('textbox')).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(card.getByRole('status')).toHaveText('正在自动更新…')
  tool.version = '0.2.4-rc.1'
  tool.compatibility!.verifiedVersion = tool.version
  tool.compatibility!.pinnedVersion = ''
  Object.assign(policy, { status: 'current', currentVersion: tool.version })
  await page.clock.runFor(15001)
  await expect(card).toContainText('v0.2.4-rc.1')
  await expect(card).toContainText('未固定')
  policy.status = 'failed'; policy.error = 'Registry unavailable'
  await page.clock.runFor(15001)
  await expect(card.getByTestId('dsh-management-status').getByRole('alert')).toHaveText('Registry unavailable')
  await open.click()
  await expect(drawer.getByRole('alert')).toHaveText('Registry unavailable')
  await expect(drawer.getByRole('textbox')).toBeEnabled()
  expect(errors).toEqual([])
})
