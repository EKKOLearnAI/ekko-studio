import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

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
