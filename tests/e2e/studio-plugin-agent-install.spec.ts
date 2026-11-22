import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'

test('opens the manual guide directly from the Agent list and detects installation on return', async ({ page, context }) => {
  const id = 'plugin:trae/trae'
  const guide = 'https://docs.trae.cn/cli_get-started-with-trae-cli-2'
  let installed = false, reads = 0
  const actions: string[] = []
  await context.route(guide, route => route.fulfill({ contentType: 'text/html', body: '<title>CLI guide</title>' }))
  await page.route(url => url.pathname.startsWith('/api/'), route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    if (route.request().method() === 'POST' && path.startsWith('/api/studio/agents/')) actions.push(path)
    if (path === '/api/studio/agents') {
      reads++
      const agent = { id, name: 'TRAE CLI', vendor: 'TRAE', origin: 'plugin', modes: ['global'], actions: {}, installGuideUrl: guide }
      return route.fulfill({ json: { agents: [
        { ...agent, status: { installed, version: installed ? '0.216.0' : '', source: installed ? 'external' : 'not-installed' } },
        { ...agent, id: 'plugin:denied/worker', status: { installed: false, version: '', error: 'Access denied' } },
      ] } })
    }
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/studio-plugin-agents.ts').replace(/^\//, '')
  await page.route('**/__plugin_manual__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__plugin_manual__')
  const card = page.getByTestId(`agent-card-${id}`)
  const link = card.getByRole('link', { name: '安装指引' })
  await expect(card).toContainText('未安装')
  await expect(card.getByRole('alert')).toHaveCount(0)
  await expect(page.getByTestId('agent-card-plugin:denied/worker').getByRole('link')).toHaveCount(0)
  const previousReads = reads
  await card.getByRole('button', { name: '刷新' }).click()
  await expect.poll(() => reads).toBeGreaterThan(previousReads)
  const [tab] = await Promise.all([page.waitForEvent('popup'), link.click()])
  await expect(tab).toHaveURL(guide)
  installed = true
  await tab.close()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(card).toContainText('v0.216.0')
  await expect(link).toHaveCount(0)
  expect(actions).toEqual([])
})

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
