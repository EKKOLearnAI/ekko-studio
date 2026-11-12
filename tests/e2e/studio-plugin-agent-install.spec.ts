import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('installs an absent plugin engine directly, allows retry, and switches to installed management', async ({ page }, testInfo) => {
  let installed = false, checks = 0, upgrades = 0
  let finishInstall!: () => void
  const installation = new Promise<void>(resolve => { finishInstall = resolve })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    if (path === '/api/auth/me') return route.fulfill({ json: { user: { id: 1, username: 'Tester', role: 'super_admin' } } })
    if (path === '/api/studio/agents') return route.fulfill({ json: { agents: [{ id: 'plugin:omp/omp', name: 'Oh My Pi', vendor: 'Stencil Labs', origin: 'plugin', modes: ['scoped', 'global'], actions: { settings: true, checkUpdate: true, upgrade: true }, status: { installed, version: installed ? '18.19.0' : '' } }] } })
    if (path.endsWith('/check-update')) {
      if (++checks === 1) return route.fulfill({ status: 503, json: { error: 'Release lookup unavailable' } })
      return route.fulfill({ json: { currentVersion: installed ? '18.19.0' : '', latestVersion: '18.19.0', updateAvailable: !installed } })
    }
    if (path.endsWith('/upgrade')) {
      expect(route.request().postDataJSON()).toEqual({ version: '18.19.0', expectedVersion: '' })
      upgrades++; await installation; installed = true
      return route.fulfill({ json: { installedVersion: '18.19.0' } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugin-agents.ts').replace(/^\//, '')
  await page.route('**/__plugin_install__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_install__')
  const card = page.getByTestId('agent-card-plugin:omp/omp')
  await expect(card).toContainText('未安装')
  await expect(card.getByRole('button', { name: '检查更新', exact: true })).toHaveCount(0)
  const install = card.getByRole('button', { name: /一键安装/ })
  await expect(install).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('plugin-agent-install.png') })
  await install.click()
  await expect(page.getByRole('alert')).toContainText('Release lookup unavailable')
  await expect(install).toBeEnabled()
  expect(upgrades).toBe(0)
  await install.click()
  await expect.poll(() => upgrades).toBe(1)
  await expect(install).toBeDisabled()
  await expect(card.getByRole('button', { name: '设置', exact: true })).toBeDisabled()
  finishInstall()
  await expect(card).toContainText('18.19.0')
  await expect(install).toHaveCount(0)
  await expect(card.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled()
  await expect(card.getByRole('button', { name: '设置', exact: true })).toBeEnabled()
  await card.getByRole('button', { name: '检查更新', exact: true }).click()
  await expect.poll(() => checks).toBe(3)
  expect(upgrades).toBe(1)
})
