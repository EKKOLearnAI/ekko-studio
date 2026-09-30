import { expect, test, type Page } from '@playwright/test'
import type { DesktopUpdateState } from '../../packages/client/src/utils/desktop-bridge'
import { authenticate, mockHermesApi } from './fixtures'

interface UpdateHarness {
  actions: string[]
  push: (patch: Partial<DesktopUpdateState>) => DesktopUpdateState
}
type UpdateWindow = Window & { __PW_UPDATE__: UpdateHarness }

async function installUpdater(page: Page) {
  await page.addInitScript(() => {
    const saved = localStorage.getItem('pw-desktop-update')
    let state: DesktopUpdateState = saved ? JSON.parse(saved) : {
      revision: 0, status: 'idle', version: '', percent: null,
      transferred: 0, total: 0, bytesPerSecond: 0,
    }
    const listeners = new Set<(state: DesktopUpdateState) => void>()
    const harness: UpdateHarness = {
      actions: [],
      push(patch) {
        state = { ...state, ...patch, revision: state.revision + 1 }
        localStorage.setItem('pw-desktop-update', JSON.stringify(state))
        listeners.forEach(listener => listener({ ...state }))
        return { ...state }
      },
    }
    ;(window as unknown as UpdateWindow).__PW_UPDATE__ = harness
    Object.defineProperty(window, 'hermesDesktop', { value: {
      isDesktop: true,
      platform: 'darwin',
      updater: {
        getState: async () => ({ ...state }),
        cancel: async () => {
          harness.actions.push('cancel')
          return harness.push({ status: 'cancelling', bytesPerSecond: 0 })
        },
        download: async () => {
          harness.actions.push('download')
          return harness.push({ status: 'downloading', percent: null, bytesPerSecond: 0 })
        },
        install: async () => {
          harness.actions.push('install')
          return harness.push({ status: 'installing' })
        },
        onStateChange: (listener: (state: DesktopUpdateState) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    } })
  })
}

async function push(page: Page, patch: Partial<DesktopUpdateState>) {
  await page.evaluate(value => (window as unknown as UpdateWindow).__PW_UPDATE__.push(value), patch)
}

test('does not show a desktop update preview on the web', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')
  await expect(page.locator('.page-sidebar-nav')).toBeVisible()
  await expect(page.locator('.desktop-update-tab')).toHaveCount(0)
})

test('shows update progress above new chat, with cancellation, retry and installation', async ({ page }, testInfo) => {
  await installUpdater(page)
  await authenticate(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/chat')
  await expect(page.locator('.page-sidebar-nav')).toBeVisible()
  const tab = page.locator('.desktop-update-tab')
  await expect(tab).toHaveCount(0)

  await push(page, { status: 'downloading', version: '0.7.25' })
  await expect(tab).toContainText('Downloading update')
  await expect(tab.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  await push(page, { percent: 42.7, transferred: 427, total: 1000, bytesPerSecond: 3355443 })
  await expect(tab).toContainText('42%')
  await expect(tab).toContainText('3.2 MB/s')
  await expect(tab).toContainText('v0.7.25')
  const tabBox = await tab.boundingBox()
  const navBox = await page.locator('.page-sidebar-tabs').boundingBox()
  expect(tabBox!.y + tabBox!.height).toBeLessThanOrEqual(navBox!.y)
  await page.locator('.page-sidebar-nav').screenshot({ path: testInfo.outputPath('update-progress.png') })

  await tab.getByRole('button', { name: 'Stop download', exact: true }).click()
  await expect(tab).toContainText('Stopping download')
  await expect(tab.getByRole('button')).toHaveCount(0)
  await push(page, { status: 'cancelled' })
  await expect(tab).toContainText('Download stopped')
  await expect(tab.getByRole('progressbar')).toHaveCount(0)
  await tab.getByRole('button', { name: 'Download again', exact: true }).click()
  await expect(tab).toContainText('Downloading update')

  await push(page, { status: 'error', bytesPerSecond: 0 })
  await expect(tab).toContainText('Download failed')
  await tab.getByRole('button', { name: 'Download again', exact: true }).click()
  await push(page, { percent: 100 })
  await expect(tab).toContainText('Preparing update')
  await push(page, { status: 'preparing' })
  await expect(tab.getByRole('button')).toHaveCount(0)
  await page.reload()
  await expect(tab).toContainText('Preparing update')
  await expect(tab.getByRole('button')).toHaveCount(0)
  await push(page, { status: 'downloaded' })
  await expect(tab).toContainText('Update ready')
  await expect.poll(() => page.evaluate(() => (window as unknown as UpdateWindow).__PW_UPDATE__.actions))
    .toEqual([])

  await page.reload()
  await expect(tab).toContainText('Update ready')
  await tab.getByRole('button', { name: 'Restart to update', exact: true }).click()
  await expect(tab).toContainText('Restarting to update')
  expect(await page.evaluate(() => (window as unknown as UpdateWindow).__PW_UPDATE__.actions)).toEqual(['install'])
})
