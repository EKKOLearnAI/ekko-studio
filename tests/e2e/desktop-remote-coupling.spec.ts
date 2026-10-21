import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function desktop(page: Page, remoteMode: boolean) {
  await page.addInitScript(remoteMode => {
    const calls = { restarts: 0, directoryPicks: 0 }
    ;(window as any).__desktopCoupling = calls
    ;(window as any).hermesDesktop = {
      isDesktop: true, remoteMode, platform: 'win32', windowKind: 'main',
      ensureAuth: async () => !!localStorage.getItem('hermes_api_key'),
      getWindowState: async () => ({ isMaximized: false }),
      restartApp: async () => { calls.restarts++; return true },
      // Also test clients with an older preload that exposed this in remote mode.
      selectRuntimeDirectory: async () => { calls.directoryPicks++; return 'C:/LocalRuntime' },
    }
  }, remoteMode)
}

for (const remoteMode of [false, true]) {
  test(`Runtime restart targets ${remoteMode ? 'the remote server' : 'the local desktop'}`, async ({ page }) => {
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    await desktop(page, remoteMode)
    await page.route('**/api/hermes/runtime-versions/jobs', route => route.fulfill({ json: { jobs: [{
      id: 'runtime-restart-test', kind: 'runtime', version: '0.20.6', status: 'completed',
      source: 'github', stage: 'completed', message: '', error: '', createdAt: '', updatedAt: '',
    }] } }))
    let serverRestarts = 0
    await page.route('**/api/hermes/runtime-versions/restart-webui', route => {
      serverRestarts++
      return route.fulfill({ status: 202, json: { success: true } })
    })
    await page.goto('/#/hermes/jobs')
    await expect(page.getByTestId('runtime-restart-prompt')).toBeVisible()
    await page.getByTestId('runtime-restart-now').click()
    await expect.poll(async () => serverRestarts + await page.evaluate(() => (window as any).__desktopCoupling.restarts)).toBe(1)
    expect(serverRestarts).toBe(remoteMode ? 1 : 0)
    expect(await page.evaluate(() => (window as any).__desktopCoupling.restarts)).toBe(remoteMode ? 0 : 1)
  })
}

test('remote Windows desktop does not run local data migration or submit a local Runtime directory', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  await desktop(page, true)
  await page.route('**/api/agents/status', route => route.fulfill({ json: {
    revision: 1, updatedAt: '', agents: [{ id: 'hermes', installed: true, source: 'managed-runtime', version: '0.20.6', path: '/remote/runtime' }],
  } }))
  let migrations = 0
  let rootChanges = 0
  await page.route('**/api/hermes/data-migrations/windows-appdata', route => {
    migrations++
    return route.fulfill({ json: { supported: true, shouldPrompt: true, sourceDirectory: 'C:/Old', targetDirectory: 'C:/New', decision: null } })
  })
  await page.route('**/api/hermes/runtime-versions/runtime-root', route => {
    rootChanges++
    return route.fulfill({ json: { success: true } })
  })
  await page.goto('/#/studio/agents')
  await page.getByRole('button', { name: 'Manage Runtime', exact: true }).click()
  const drawer = page.locator('.n-drawer').filter({ has: page.locator('.version-management') })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByTestId('select-runtime-directory')).toHaveCount(0)
  await expect(drawer.getByTestId('reset-runtime-directory')).toHaveCount(0)
  expect(migrations).toBe(0)
  expect(rootChanges).toBe(0)
  expect(await page.evaluate(() => (window as any).__desktopCoupling.directoryPicks)).toBe(0)
})

test('locked remote logins show server recovery instructions instead of a local tray reset', async ({ page }) => {
  await mockHermesApi(page)
  await desktop(page, true)
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); localStorage.removeItem('hermes_api_key') })
  await page.route('**/api/auth/login', route => route.fulfill({ status: 429, json: { error: 'Too many login attempts' } }))
  await page.goto('/#/login')
  await page.getByPlaceholder('Username', { exact: true }).fill('remote-admin')
  await page.getByPlaceholder('Password', { exact: true }).fill('invalid')
  await page.locator('form.login-form').getByRole('button').click()
  await expect(page.locator('.login-lock-hint code')).toHaveText([
    'hermes-web-ui clear-login-locks --restart', 'hermes-web-ui reset-default-login',
  ])
  expect(await page.evaluate(() => (window as any).__desktopCoupling.restarts)).toBe(0)
})
