import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_EKKO_CONFIG } from '../../packages/ekko-agent/src/config'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function mockDesktop(page: Page, options: { platform?: string; remoteMode?: boolean; missingBridge?: boolean; delay?: number } = {}) {
  await page.addInitScript(options => {
    const state = { accessibility: 'denied', screenRecording: 'not-determined', checks: 0, requests: [] as string[], fail: false, openFail: false, delay: options.delay || 0 }
    ;(window as any).__permissions = state
    ;(window as any).hermesDesktop = {
      isDesktop: true, platform: options.platform || 'darwin', remoteMode: options.remoteMode || false,
      windowKind: 'main', getWindowState: async () => ({ isMaximized: false }),
      ...(options.missingBridge ? {} : { computerUsePermissions: {
        getStatus: async () => {
          state.checks++
          if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay))
          if (state.fail) throw new Error('read failed')
          return { supported: true, accessibility: state.accessibility, screenRecording: state.screenRecording }
        },
        request: async (key: string) => {
          state.requests.push(key)
          if (state.openFail) throw new Error('open failed')
        },
      } }),
    }
  }, options)
}

async function setup(page: Page, theme: Parameters<typeof mockHermesApi>[1] = {}) {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, theme)
  let config = structuredClone(DEFAULT_EKKO_CONFIG)
  await page.route('**/api/ekko/config', async route => {
    if (route.request().method() === 'PUT') config = route.request().postDataJSON().config
    await route.fulfill({ json: { ok: true, schemaVersion: 15, configPath: '/fixture/ekko.json', config, providers: [] } })
  })
}

test('quietly checks permissions, requests only on click and refreshes on return', async ({ page }) => {
  await mockDesktop(page)
  await setup(page)
  await page.goto('/#/ekko/settings?tab=tools')
  const card = page.getByTestId('computer-use-permissions')
  await expect(card.getByRole('status')).toHaveText(['Required', 'Required'])
  expect(await page.evaluate(() => (window as any).__permissions.requests)).toEqual([])
  await card.getByRole('button', { name: 'Authorize · Accessibility' }).click()
  expect(await page.evaluate(() => (window as any).__permissions.requests)).toEqual(['accessibility'])
  await expect(page.getByTestId('permission-accessibility').getByRole('status')).toHaveText('Required')
  await page.evaluate(() => {
    ;(window as any).__permissions.accessibility = 'granted'
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByTestId('permission-accessibility').getByRole('status')).toHaveText('Enabled')
  await card.getByRole('button', { name: 'Authorize · Screen Recording' }).click()
  await page.evaluate(() => {
    ;(window as any).__permissions.screenRecording = 'granted'
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(card.getByText('Both system permissions are enabled.')).toBeVisible()
  await expect(card.getByRole('button', { name: /Authorize/ })).toHaveCount(0)
  await card.screenshot({ path: '/tmp/ekko-permissions-granted.png' })
  expect(await page.evaluate(() => (window as any).__permissions.requests)).toEqual(['accessibility', 'screenRecording'])
})

test('clears stale granted status on failure and recovers with a manual check', async ({ page }) => {
  await mockDesktop(page)
  await setup(page)
  await page.goto('/#/ekko/settings?tab=tools')
  const card = page.getByTestId('computer-use-permissions')
  await expect(card.getByRole('status')).toHaveText(['Required', 'Required'])
  await page.evaluate(() => { Object.assign((window as any).__permissions, { accessibility: 'granted', screenRecording: 'granted' }) })
  await page.getByTestId('permissions-refresh').click()
  await expect(card.getByText('Both system permissions are enabled.')).toBeVisible()
  await page.evaluate(() => { (window as any).__permissions.fail = true })
  await page.getByTestId('permissions-refresh').click()
  await expect(card.getByRole('alert')).toHaveText('Could not read permissions. Try checking again.')
  await expect(card.getByRole('status')).toHaveText(['Unknown', 'Unknown'])
  await card.screenshot({ path: '/tmp/ekko-permissions-error.png' })
  await page.evaluate(() => { Object.assign((window as any).__permissions, { fail: false, accessibility: 'denied', screenRecording: 'restricted', openFail: true }) })
  await page.getByTestId('permissions-refresh').click()
  await expect(card.getByRole('alert')).toHaveCount(0)
  await expect(card.getByRole('status')).toHaveText(['Required', 'Restricted'])
  await card.getByRole('button', { name: 'Authorize · Accessibility' }).click()
  await expect(card.getByRole('alert')).toContainText('Open System Settings')
})

test('checks only while the enabled Computer Use guide is visible', async ({ page }) => {
  await mockDesktop(page)
  await setup(page)
  await page.goto('/#/ekko/settings')
  await expect(page.locator('.n-tabs')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__permissions.checks)).toBe(0)
  await page.goto('/#/ekko/settings?tab=tools')
  await expect(page.getByTestId('computer-use-permissions')).toBeVisible()
  await page.getByTestId('computer-use-enabled').click()
  await expect(page.getByTestId('computer-use-permissions')).toHaveCount(0)
  const before = await page.evaluate(() => (window as any).__permissions.checks)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  expect(await page.evaluate(() => (window as any).__permissions.checks)).toBe(before)
  await page.getByTestId('computer-use-enabled').click()
  await expect(page.getByTestId('computer-use-permissions')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__permissions.checks)).toBeGreaterThan(before)
})

for (const [name, options] of Object.entries({ Windows: { platform: 'win32' }, Linux: { platform: 'linux' }, remote: { remoteMode: true }, olderDesktop: { missingBridge: true } })) {
  test(`does not show or query local macOS grants on ${name}`, async ({ page }) => {
    await mockDesktop(page, options)
    await setup(page)
    await page.goto('/#/ekko/settings?tab=tools')
    await expect(page.getByTestId('computer-use-enabled')).toBeVisible()
    await expect(page.getByTestId('computer-use-permissions')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__permissions.checks)).toBe(0)
  })
}

test('shows a disabled loading state without authorizing', async ({ page }) => {
  await mockDesktop(page, { delay: 1500 })
  await setup(page)
  await page.goto('/#/ekko/settings?tab=tools')
  const card = page.getByTestId('computer-use-permissions')
  await expect(card.getByRole('status')).toHaveText(['Checking…', 'Checking…'])
  await expect(card.getByRole('button', { name: 'Authorize · Accessibility' })).toBeDisabled()
  await card.screenshot({ path: '/tmp/ekko-permissions-loading.png' })
  await expect(card.getByRole('status')).toHaveText(['Required', 'Required'])
  expect(await page.evaluate(() => (window as any).__permissions.requests)).toEqual([])
})

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`permission guide fits ${brightness} with wallpaper ${wallpaper}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 1050 })
      await mockDesktop(page)
      await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
      await setup(page, { theme: {
        brightness,
        ...(wallpaper ? {
          background: { name: 'permission-test.svg', mime: 'image/svg+xml', updatedAt: 1 },
          appearance: { global: { opacity: 0.4 }, regions: { card: { opacity: 0, backgroundColor: '#7192b3', radius: 14, blur: 8 } } },
        } : {}),
      } })
      if (wallpaper) await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000"><defs><linearGradient id="a"><stop stop-color="#749db4"/><stop offset="1" stop-color="#7d7799"/></linearGradient></defs><path fill="url(#a)" d="M0 0h1200v1000H0z"/></svg>' }))
      await page.goto('/#/ekko/settings?tab=tools')
      const card = page.getByTestId('computer-use-permissions')
      await expect(card.getByRole('status')).toHaveText(['待授权', '待授权'])
      await card.scrollIntoViewIfNeeded()
      if (wallpaper) {
        await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0)')
        await expect(card).toHaveCSS('border-radius', '14px')
      }
      await card.screenshot({ path: `/tmp/ekko-permissions-${brightness}${wallpaper ? '-wallpaper' : ''}.png` })
      if (!wallpaper) await page.screenshot({ path: `/tmp/ekko-permissions-${brightness}-page.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      await card.scrollIntoViewIfNeeded()
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await card.getByRole('button', { name: '前往授权 · 辅助功能' }).click()
      expect(await page.evaluate(() => (window as any).__permissions.requests)).toEqual(['accessibility'])
      await card.screenshot({ path: `/tmp/ekko-permissions-${brightness}${wallpaper ? '-wallpaper' : ''}-narrow.png` })
    })
  }
}

test('permission card follows regional overrides, inheritance reset and wallpaper removal', async ({ page }) => {
  await mockDesktop(page)
  await setup(page, { theme: {
    brightness: 'light', background: { name: 'test.svg', mime: 'image/svg+xml', updatedAt: 1 },
    appearance: { global: { opacity: 0.4, radius: 10 }, regions: { card: { opacity: 0.65, backgroundColor: '#7192b3', radius: 14, blur: 8 } } },
  } })
  await page.route('**/api/theme/background?*', route => route.request().method() === 'GET'
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill="#849aaa" d="M0 0h10v10H0z"/></svg>' })
    : route.fallback())
  await page.goto('/#/ekko/settings?tab=tools')
  const card = page.getByTestId('computer-use-permissions')
  await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0.65)')
  await expect(card).toHaveCSS('border-radius', '14px')
  await expect(card).toHaveCSS('backdrop-filter', 'blur(8px) saturate(1.1)')
  await page.goto('/#/hermes/theme')
  await page.getByTestId('theme-scope').selectOption('card')
  await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
  await page.getByRole('button', { name: 'Reset Corner radius', exact: true }).click()
  await page.goto('/#/ekko/settings?tab=tools')
  await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0.4)')
  await expect(card).toHaveCSS('border-radius', '10px')
  await page.goto('/#/hermes/theme')
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.locator('.background-name')).toHaveCount(0)
  await page.goto('/#/ekko/settings?tab=tools')
  await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--custom-background/)
  await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0.4)')
  await card.getByRole('button', { name: 'Authorize · Accessibility' }).click()
  expect(await page.evaluate(() => (window as any).__permissions.requests)).toEqual(['accessibility'])
})
