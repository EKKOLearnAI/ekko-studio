import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const cursor = (installed = false) => ({
  id: 'cursor', name: 'Cursor', provider: 'Cursor', command: 'agent', packageName: 'cursor-agent',
  installed, version: installed ? '2026.09.26-dd393fe' : '',
  rawVersion: installed ? '2026.09.26-dd393fe' : '',
  source: installed ? 'user-cli' : 'not-installed', path: installed ? 'agent' : '',
})

test.beforeEach(async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await page.route('**/api/agents/status', route => route.fulfill({ json: {
    revision: 1, updatedAt: '2026-09-27T00:30:00.000Z', agents: [cursor()],
  } }))
})

test('detects an external Cursor install on return without duplicate probes', async ({ page }) => {
  let probes = 0
  let releaseProbe!: () => void
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
  await page.route('**/api/coding-agents', async route => {
    probes += 1
    if (probes === 1) {
      await route.fulfill({ json: { tools: [cursor()] } })
      return
    }
    await probeGate
    await route.fulfill({ json: { tools: [cursor(true)] } })
  })
  await page.route('**/api/coding-agents/cursor/install', route => route.fulfill({ json: {
    success: false, code: 'MANUAL_INSTALL_REQUIRED', tool: cursor(), tools: [cursor()],
  } }))
  await page.goto('/#/studio/agents')
  const card = page.getByTestId('agent-card-cursor')
  await expect(card).toContainText('Not installed')
  await expect.poll(() => probes).toBe(1)

  await page.evaluate(() => { window.open = () => null })
  await card.getByRole('button').last().click()
  await expect(card.getByRole('button').last()).toBeEnabled()
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => probes).toBe(2)
  releaseProbe()
  await expect(card.locator('.agent-version')).toHaveText('v2026.09.26-dd393fe')
  await expect(card).not.toContainText('Not installed')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => probes).toBe(3)
})

test('retries after a failed probe and removes listeners when leaving management', async ({ page }) => {
  let probes = 0
  await page.route('**/api/coding-agents', route => {
    probes += 1
    return probes === 1
      ? route.fulfill({ status: 500, json: { error: 'Probe unavailable' } })
      : route.fulfill({ json: { tools: [cursor()] } })
  })
  await page.goto('/#/studio/agents')
  await expect(page.getByTestId('agent-card-cursor')).toContainText('Not installed')
  await expect(page.locator('.agent-manager-panel .n-alert')).toContainText('Probe unavailable')
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => probes).toBe(2)
  await expect(page.locator('.agent-manager-panel .n-alert')).toHaveCount(0)
  await page.evaluate(() => { window.location.hash = '#/hermes/petdex' })
  await expect(page.locator('.agent-manager-panel')).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  expect(probes).toBe(2)
})

test('detects an installation made before opening management even if focus arrives during loading', async ({ page }) => {
  let releaseSnapshot!: () => void
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
  await page.route('**/api/agents/status', async route => {
    await snapshotGate
    await route.fulfill({ json: { revision: 1, agents: [cursor()] } })
  })
  let probes = 0
  await page.route('**/api/coding-agents', route => {
    probes += 1
    return route.fulfill({ json: { tools: [cursor(true)] } })
  })
  await page.goto('/#/studio/agents')
  // Cards stay mounted under the initial loader while the snapshot is pending.
  await expect(page.getByTestId('agent-card-cursor')).toHaveCount(1)
  await expect(page.locator('.app-main .page-loading-overlay')).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  releaseSnapshot()
  await expect(page.getByTestId('agent-card-cursor').locator('.agent-version')).toHaveText('v2026.09.26-dd393fe')
  await expect(page.getByTestId('agent-card-cursor')).toBeVisible()
  expect(probes).toBe(1)
})
