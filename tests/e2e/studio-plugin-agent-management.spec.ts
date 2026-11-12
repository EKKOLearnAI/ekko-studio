import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('manages plugin engine deletion, reinstall and supported automatic updates using native Agent controls', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  let installed = true, version = '1.0.0', autoUpdate = false, toggles = 0, removes = 0, checkFailed = true
  const id = 'plugin:managed/worker', external = 'plugin:external/worker'
  const policy = (supported: boolean) => ({ autoUpdate: supported && autoUpdate, autoUpdateSupported: supported, status: checkFailed ? 'failed' : 'current', currentVersion: version, latestVersion: version, checkedAt: '', ...(checkFailed ? { error: 'OMP release lookup returned 403' } : {}) })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), path = decodeURIComponent(new URL(request.url()).pathname)
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/agents/status') return route.fulfill({ json: { agents: ['cursor', 'antigravity', 'zcode'].map(id => ({ id, installed: true, source: 'user-cli', version: '1.0.0' })) } })
    if (path === '/api/coding-agents/update-policies') return route.fulfill({ json: { agents: {} } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [
      { id, name: 'Managed Worker', vendor: 'Fixture', origin: 'plugin', modes: ['scoped'], surfaces: ['chat'], actions: { settings: false, checkUpdate: true, upgrade: true, remove: true, autoUpdate: true }, status: { installed, version } },
      { id: external, name: 'External Worker', vendor: 'Fixture', origin: 'plugin', modes: ['global'], surfaces: ['chat'], actions: { settings: false, checkUpdate: true, upgrade: false, remove: false, autoUpdate: false }, status: { installed: true, version: 'external' } },
    ] } })
    if (path.endsWith('/update-policy')) {
      if (request.method() === 'PUT') {
        expect(path).toBe(`/api/studio/agents/${id}/update-policy`)
        expect(request.postDataJSON()).toEqual({ autoUpdate: true })
        if (++toggles === 1) return route.fulfill({ status: 503, json: { error: 'Preference save failed' } })
        autoUpdate = true
      }
      return route.fulfill({ json: policy(path.includes(id) && installed) })
    }
    if (path.endsWith('/remove')) {
      expect(request.postDataJSON()).toEqual({ expectedVersion: '1.0.0' })
      removes++; installed = false; version = ''; autoUpdate = false
      return route.fulfill({ json: { removed: true } })
    }
    if (path.endsWith('/check-update')) { checkFailed = false; return route.fulfill({ json: { currentVersion: version, latestVersion: '2.0.0', updateAvailable: !installed } }) }
    if (path.endsWith('/upgrade')) {
      expect(request.postDataJSON()).toEqual({ version: '2.0.0', expectedVersion: '' })
      installed = true; version = '2.0.0'
      return route.fulfill({ json: { installedVersion: version } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugin-agents.ts').replace(/^\//, '')
  await page.route('**/__plugin_engine_management__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_engine_management__#/agents')
  const card = page.getByTestId(`agent-card-${id}`), other = page.getByTestId(`agent-card-${external}`)
  const toggle = card.getByRole('switch', { name: '自动更新' })
  await card.scrollIntoViewIfNeeded()
  await expect(toggle).toBeEnabled()
  await expect(other.getByRole('switch', { name: '自动更新' })).toBeDisabled()
  await expect(other.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  await toggle.click()
  await expect(page.getByRole('alert')).toContainText('Preference save failed')
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(toggle).toBeChecked()
  await page.reload()
  await expect(toggle).toBeChecked()
  await expect(card).toContainText('检查更新失败')
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect(card).not.toContainText('检查更新失败')
  await expect(toggle).toBeChecked()
  await card.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect(removes).toBe(0)
  await card.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(card).toContainText('未安装')
  await expect(toggle).toHaveCount(0)
  expect(removes).toBe(1)
  await card.getByRole('button', { name: '一键安装', exact: true }).click()
  await expect(card).toContainText('v2.0.0')
  await expect(toggle).not.toBeChecked()
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('agent-engine-controls-light.png') })
  await page.evaluate(async () => { await (window as any).agentFixture.theme(true) })
  await expect.poll(() => card.getByRole('button', { name: '检查更新', exact: true }).evaluate(button => Number(getComputedStyle(button).color.match(/[\d.]+/)?.[0]))).toBeGreaterThan(150)
  await page.screenshot({ path: testInfo.outputPath('agent-engine-controls-dark.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await card.scrollIntoViewIfNeeded()
  await expect(toggle).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('agent-engine-controls-mobile.png') })
  expect(errors).toEqual([])
})
