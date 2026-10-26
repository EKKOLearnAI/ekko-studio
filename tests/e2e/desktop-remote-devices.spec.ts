import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function setup(page: Page, options: { remote?: boolean; empty?: boolean; loadFail?: boolean; delay?: number } = {}, theme: Parameters<typeof mockHermesApi>[1] = {}) {
  await authenticate(page)
  await mockHermesApi(page, theme)
  await mockChatSocket(page)
  await page.addInitScript(options => {
    const initial = { devices: options.empty ? [] : [
      { id: 'home', name: 'Home computer', serverUrl: 'http://192.168.1.20:6060' },
      { id: 'office', name: 'Office', serverUrl: 'https://studio.example.com' },
    ], activeDeviceId: options.remote ? 'home' : null, activeServerUrl: options.remote ? 'http://192.168.1.20:6060' : null }
    const data = { state: JSON.parse(sessionStorage.getItem('remote-devices-fixture') || 'null') || initial,
      loadFail: options.loadFail || false, failSwitch: false, failSave: false, switches: [] as Array<string | null>, delay: options.delay || 0 }
    ;(window as any).__remoteDevices = data
    const persist = () => {
      sessionStorage.setItem('remote-devices-fixture', JSON.stringify(data.state))
      return structuredClone(data.state)
    }
    ;(window as any).hermesDesktop = {
      isDesktop: true, remoteMode: options.remote || false, platform: 'darwin', windowKind: 'main',
      getWindowState: async () => ({ isMaximized: false }), ensureAuth: async () => true,
      remoteDevices: {
        list: async () => {
          if (data.delay) await new Promise(resolve => setTimeout(resolve, data.delay))
          if (data.loadFail) throw new Error('REMOTE_DEVICE_LOAD_FAILED')
          return structuredClone(data.state)
        },
        add: async (input: { name: string; serverUrl: string }) => {
          if (data.failSave) throw new Error('REMOTE_DEVICE_SAVE_FAILED')
          if (!/^https?:\/\//.test(input.serverUrl)) throw new Error('REMOTE_DEVICE_INVALID_URL')
          if (new URL(input.serverUrl).pathname !== '/') throw new Error('REMOTE_DEVICE_UNSUPPORTED_PATH')
          if (data.state.devices.some((device: any) => device.serverUrl === input.serverUrl)) throw new Error('REMOTE_DEVICE_DUPLICATE')
          data.state.devices.push({ id: 'new-device', ...input })
          return persist()
        },
        remove: async (id: string) => {
          if (data.failSave) throw new Error('REMOTE_DEVICE_SAVE_FAILED')
          data.state.devices = data.state.devices.filter((device: any) => device.id !== id)
          return persist()
        },
        switchTo: async (id: string | null) => {
          data.switches.push(id)
          if (data.delay) await new Promise(resolve => setTimeout(resolve, data.delay))
          if (data.failSwitch) throw new Error('REMOTE_DEVICE_UNREACHABLE')
        },
      },
    }
  }, options)
}

const remoteRoute = '/#/hermes/connections?tab=remote'

test('adds and deletes saved remote devices with validation, confirmation and reload persistence', async ({ page }) => {
  await setup(page, { empty: true })
  await page.goto(remoteRoute)
  await expect(page.getByText('No remote devices saved yet')).toBeVisible()
  await page.getByRole('button', { name: 'Add remote device', exact: true }).click()
  const modal = page.locator('.remote-device-modal')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('Enter a device name')
  await modal.getByLabel('Device name', { exact: true }).fill('My NAS')
  await modal.getByLabel('Studio server address').fill('not-an-address')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('valid HTTP or HTTPS')
  await modal.getByLabel('Studio server address').fill('https://studio.example.com/studio')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('Subpath deployments are not supported')
  await modal.getByLabel('Studio server address').fill('http://192.168.1.30:6060')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal).not.toBeVisible()
  const card = page.getByTestId('remote-device-new-device')
  await expect(card).toContainText('My NAS')
  await page.reload()
  await expect(card).toBeVisible()
  await expect(page.getByTestId('remote-device-local')).toContainText('Current device')
  await card.getByRole('button', { name: 'Delete device My NAS' }).click()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: 'Delete device My NAS' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.getByText('No remote devices saved yet')).toBeVisible()
})

test('handles duplicate addresses and disk failures without dropping the form or device', async ({ page }) => {
  await setup(page)
  await page.goto(remoteRoute)
  await page.getByRole('button', { name: 'Add remote device', exact: true }).click()
  const modal = page.locator('.remote-device-modal')
  await modal.getByLabel('Device name', { exact: true }).fill('Duplicate')
  await modal.getByLabel('Studio server address').fill('http://192.168.1.20:6060')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('already saved')
  await page.evaluate(() => { (window as any).__remoteDevices.failSave = true })
  await modal.getByLabel('Studio server address').fill('http://other:6060')
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(modal.getByRole('alert')).toContainText('Please try again')
  await expect(modal.getByLabel('Device name', { exact: true })).toHaveValue('Duplicate')
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByTestId('remote-device-office').getByRole('button', { name: 'Delete device Office' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click()
  await expect(page.getByTestId('remote-devices-panel').getByRole('alert')).toContainText('Please try again')
  await expect(page.getByTestId('remote-device-office')).toBeVisible()
})

test('confirms switching, preserves the device on connection failure and disables actions during restart', async ({ page }) => {
  await setup(page)
  await page.goto(remoteRoute)
  const home = page.getByTestId('remote-device-home')
  await home.getByRole('button', { name: 'Switch to device' }).click()
  await expect(page.getByText('Switch to Home computer?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__remoteDevices.switches)).toEqual([])
  await page.evaluate(() => { (window as any).__remoteDevices.failSwitch = true })
  await home.getByRole('button', { name: 'Switch to device' }).click()
  await page.getByRole('button', { name: 'Switch and restart' }).click()
  await expect(page.getByRole('alert')).toContainText('Your current connection is unchanged')
  await expect(page.getByTestId('remote-device-local')).toContainText('Current device')
  await page.evaluate(() => { (window as any).__remoteDevices.failSwitch = false })
  await home.getByRole('button', { name: 'Switch to device' }).click()
  await page.getByRole('button', { name: 'Switch and restart' }).click()
  await expect(page.getByText('Checking the connection and restarting Studio…')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add remote device' })).toBeDisabled()
  await expect(home.getByRole('button', { name: 'Switch to device' })).toBeDisabled()
  expect(await page.evaluate(() => (window as any).__remoteDevices.switches)).toEqual(['home', 'home'])
})

test('manages the same list in remote mode and offers switching back to the local device', async ({ page }) => {
  await setup(page, { remote: true })
  await page.goto(remoteRoute)
  const home = page.getByTestId('remote-device-home')
  await expect(home).toContainText('Current device')
  await expect(home.getByRole('button', { name: 'Delete device Home computer' })).toBeDisabled()
  await page.getByTestId('remote-device-local').getByRole('button', { name: 'Switch to device' }).click()
  await page.getByRole('button', { name: 'Switch and restart' }).click()
  expect(await page.evaluate(() => (window as any).__remoteDevices.switches)).toEqual([null])
})

test('shows a recoverable load failure and disables actions while loading', async ({ page }) => {
  await setup(page, { loadFail: true, delay: 300 })
  await page.goto(remoteRoute)
  await expect(page.getByRole('button', { name: 'Add remote device' })).toBeDisabled()
  await expect(page.getByRole('alert')).toContainText('Please try again')
  await page.evaluate(() => { (window as any).__remoteDevices.loadFail = false })
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByTestId('remote-device-home')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('hides remote device management in a web browser', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto(remoteRoute)
  await expect(page.getByRole('heading', { name: 'App', exact: true })).toBeVisible()
  await expect(page.getByText('Remote devices', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('remote-devices-panel')).toHaveCount(0)
})

for (const brightness of ['light', 'dark'] as const) {
  for (const wallpaper of [false, true]) {
    test(`remote devices support ${brightness}${wallpaper ? ' wallpaper' : ''} and narrow layouts`, async ({ page }) => {
      await setup(page, {}, { theme: { brightness, ...(wallpaper ? {
        background: { name: 'devices.svg', mime: 'image/svg+xml', updatedAt: 1 },
        appearance: { global: { opacity: 0.4 }, regions: { card: { opacity: 0, backgroundColor: '#7192b3', radius: 14, blur: 8 } } },
      } : {}) } })
      if (wallpaper) await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000"><path fill="#849aaa" d="M0 0h1200v1000H0z"/></svg>' }))
      await page.goto(remoteRoute)
      const card = page.getByTestId('remote-device-home')
      await expect(card).toBeVisible()
      if (wallpaper) {
        await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0)')
        await expect(card).toHaveCSS('border-radius', '14px')
      }
      await page.screenshot({ animations: 'disabled', path: `/tmp/studio-remote-devices-${brightness}${wallpaper ? '-wallpaper' : ''}.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(card).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.getByRole('button', { name: 'Add remote device', exact: true }).click()
      await expect(page.getByLabel('Device name', { exact: true })).toBeVisible()
      await page.screenshot({ animations: 'disabled', path: `/tmp/studio-remote-devices-${brightness}${wallpaper ? '-wallpaper' : ''}-narrow-dialog.png` })
    })
  }
}

test('remote device cards follow regional opacity, inheritance reset and wallpaper removal', async ({ page }) => {
  await setup(page, {}, { theme: {
    brightness: 'light', background: { name: 'devices.svg', mime: 'image/svg+xml', updatedAt: 1 },
    appearance: { global: { opacity: 0.4, radius: 10 }, regions: { card: { opacity: 0.65, backgroundColor: '#7192b3', radius: 14, blur: 8 } } },
  } })
  await page.route('**/api/theme/background?*', route => route.request().method() === 'GET'
    ? route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path fill="#849aaa" d="M0 0h10v10H0z"/></svg>' })
    : route.fallback())
  await page.goto(remoteRoute)
  const card = page.getByTestId('remote-device-home')
  await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0.65)')
  await expect(card).toHaveCSS('border-radius', '14px')
  await expect(card).toHaveCSS('backdrop-filter', 'blur(8px) saturate(1.1)')
  await page.goto('/#/hermes/theme')
  await page.getByTestId('theme-scope').selectOption('card')
  await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
  await page.getByRole('button', { name: 'Reset Corner radius', exact: true }).click()
  await page.goto(remoteRoute)
  await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0.4)')
  await expect(card).toHaveCSS('border-radius', '10px')
  await page.goto('/#/hermes/theme')
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.locator('.background-name')).toHaveCount(0)
  await page.goto(remoteRoute)
  await expect(page.locator('.app-shell')).not.toHaveClass(/app-shell--custom-background/)
  await expect(card).toHaveCSS('background-color', 'rgba(113, 146, 179, 0.4)')
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await page.reload()
  await expect(page.getByRole('button', { name: '添加远程设备', exact: true })).toBeVisible()
  await page.screenshot({ animations: 'disabled', path: '/tmp/studio-remote-devices-zh.png' })
})

test('keeps App, Little Box and remote devices available without the retired Devices tab', async ({ page }) => {
  await setup(page)
  const retiredRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/devices')) retiredRequests.push(request.url())
  })
  await page.route('**/api/mcu-devices', route => route.fulfill({ json: { devices: [] } }))
  await page.goto('/#/hermes/connections?tab=devices')
  const tabs = page.locator('.connections-panel > .n-tabs > .n-tabs-nav .n-tabs-tab')
  await expect(tabs).toHaveText(['App', 'Little Box', 'Remote devices'])
  await expect(tabs.filter({ hasText: /^App$/ })).toHaveClass(/n-tabs-tab--active/)
  await tabs.filter({ hasText: /^Little Box$/ }).click()
  await expect(page.locator('.mcu-devices-panel')).toBeVisible()
  await tabs.filter({ hasText: /^Remote devices$/ }).click()
  await expect(page.getByTestId('remote-device-local')).toBeVisible()
  expect(retiredRequests).toEqual([])
  await page.screenshot({ path: '/tmp/studio-device-connections-without-lan-devices.png' })
})
