import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('keeps Runtime management readable at the shared desktop and mobile drawer widths', async ({ page }, testInfo) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/agents/status', route => route.fulfill({ json: {
    revision: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    agents: [{ id: 'hermes', installed: true, source: 'managed-runtime', version: '0.21.0', path: '/runtime/hermes' }],
  } }))
  const directory = '/Users/studio/Library/Application Support/Ekko Studio/runtimes/hermes/0.21.0/linux-x64'
  await page.route('**/api/hermes/runtime-versions', route => route.fulfill({ json: {
    active: null,
    platform: 'linux-x64',
    activeVersionPath: directory,
    remoteManifestUrl: '',
    remoteError: '',
    hermes: {
      source: 'managed-runtime', activeVersion: '0.21.0', agentVersion: '0.21.0', activeDirectory: directory,
      storageDirectory: directory, defaultStorageDirectory: directory, pendingStorageDirectory: '',
      migrationError: '', activationError: '', cliInstallations: [],
      installed: [{ version: '0.21.0', platform: 'linux-x64', directory, active: true }],
      remoteVersions: ['0.21.0', '0.21.1'],
    },
    webui: { currentVersion: '0.7.0', activeVersion: '0.7.0', activeDirectory: '', installed: [], remoteVersions: [] },
  } }))
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/#/studio/agents')
  await page.getByRole('button', { name: 'Manage Runtime', exact: true }).click()
  const drawer = page.locator('.n-drawer').filter({ has: page.locator('.version-management') })
  await expect(drawer.getByText('0.21.1', { exact: true })).toBeVisible()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(drawer).toHaveCSS('width', `${width > 768 ? 520 : width}px`)
    await expect.poll(() => drawer.locator('.n-drawer-body-content-wrapper').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(drawer.getByRole('button', { name: 'Refresh', exact: true })).toBeInViewport()
    await drawer.screenshot({ path: testInfo.outputPath(`runtime-drawer-${width}.png`), animations: 'disabled' })
  }
  await drawer.locator('.n-drawer-header__close').click()
  await expect(drawer).toBeHidden()
})

test('shows disabled Cursor updates without stale failures and preserves supported update controls', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.route('**/api/agents/status', route => route.fulfill({ json: {
    revision: 1,
    updatedAt: '2026-09-27T00:00:00.000Z',
    agents: ['cursor', 'codex'].map(id => ({
      id, installed: true, source: 'user-cli', version: '1.2.3', path: `/usr/local/bin/${id}`,
    })),
  } }))
  const agents = {
    cursor: {
      autoUpdate: false, autoUpdateSupported: false, status: 'failed',
      currentVersion: '1.2.3', latestVersion: '', checkedAt: '2026-09-27T00:00:00.000Z',
      error: 'Cursor CLI updates are not managed by Studio',
    },
    codex: {
      autoUpdate: false, autoUpdateSupported: true, status: 'failed',
      currentVersion: '1.2.3', latestVersion: '', checkedAt: '2026-09-27T00:00:00.000Z',
      error: 'Registry connection timed out',
    },
  }
  await page.route('**/api/coding-agents/update-policies', route => route.fulfill({ json: { agents } }))
  const updates: string[] = []
  await page.route('**/api/coding-agents/*/update-policy', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2)!
    updates.push(id)
    expect(id).toBe('codex')
    agents.codex.autoUpdate = route.request().postDataJSON().autoUpdate
    await route.fulfill({ json: { agents } })
  })

  await page.goto('/#/studio/agents')
  const cursor = page.getByTestId('agent-card-cursor')
  const cursorSwitch = cursor.getByRole('switch')
  await expect(cursor.locator('.agent-update-policy')).toContainText('Automatic updates')
  await expect(cursor.locator('.agent-update-error')).toHaveCount(0)
  await expect(cursorSwitch).toHaveClass(/n-switch--disabled/)
  await cursorSwitch.click({ force: true })
  await expect(cursorSwitch).toHaveAttribute('aria-checked', 'false')
  expect(updates).toEqual([])

  const codex = page.getByTestId('agent-card-codex')
  await expect(codex.locator('.agent-update-error')).toHaveText('Failed to check for update')
  await codex.getByRole('switch').click()
  await expect(codex.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  expect(updates).toEqual(['codex'])
  await expect(cursorSwitch).toHaveClass(/n-switch--disabled/)
  await expect(cursor.locator('.agent-update-error')).toHaveCount(0)
})
