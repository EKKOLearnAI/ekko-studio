import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`keeps the header clear of drawers and masks in ${brightness} mode with wallpaper ${wallpaper}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await authenticate(page)
      await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'solid.png', mime: 'image/png', updatedAt: 1 } } : {}),
      } })
      if (wallpaper) {
        const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
        await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: image }))
      }
      await page.goto('/#/hermes/workflow')
      const header = page.locator('.studio-page-header')
      const headerAction = header.locator('.header-workspace-button')
      await page.getByRole('button', { name: 'New Workflow', exact: true }).click()
      const drawer = page.locator('.n-drawer:visible')
      const mask = page.locator('.n-drawer-mask:visible')
      await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeVisible()
      const background = brightness === 'dark' ? '26, 26, 26' : '255, 255, 255'
      await expect(drawer).toHaveCSS('background-color', wallpaper ? `rgba(${background}, 0.72)` : `rgb(${background})`)
      await expect(drawer).toHaveCSS('border-radius', '0px')
      await expect(drawer.locator('.n-drawer-content')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const headerBox = (await header.boundingBox())!
      const headerBottom = headerBox.y + headerBox.height
      for (const surface of [drawer, mask]) {
        await expect.poll(async () => {
          const box = (await surface.boundingBox())!
          return { top: box.y, bottom: box.y + box.height }
        }).toEqual({ top: headerBottom, bottom: 900 })
      }
      // A header action above the panel must remain the actual pointer target.
      await expect.poll(() => headerAction.evaluate(element => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
      await page.mouse.move(500, 400)
      await page.screenshot({ path: testInfo.outputPath('drawer-below-header.png'), animations: 'disabled' })
      await page.mouse.click(500, 100)
      await expect(drawer).toBeHidden()
      await expect(mask).toBeHidden()
    })
  }
}

test('updates an open drawer when the shared header appears or disappears', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await authenticate(page)
  await mockHermesApi(page)
  await page.goto('/#/hermes/workflow')
  await page.getByRole('button', { name: 'New Workflow', exact: true }).click()
  const drawer = page.locator('.n-drawer:visible')
  const mask = page.locator('.n-drawer-mask:visible')
  await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeVisible()
  for (const [width, top] of [[900, 40], [390, 0], [1440, 40]]) {
    await page.setViewportSize({ width, height: 800 })
    for (const surface of [drawer, mask]) {
      await expect.poll(async () => {
        const box = (await surface.boundingBox())!
        return { top: box.y, bottom: box.y + box.height }
      }).toEqual({ top, bottom: 800 })
    }
  }
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
})

for (const brightness of ['light', 'dark']) {
  test(`drawer follows global and overlay colors while keeping square corners in ${brightness} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await authenticate(page)
    await mockHermesApi(page, { theme: { brightness, appearance: {
      global: { backgroundColor: '#223344', opacity: 0.5, radius: 24 }, regions: {},
    } } })
    const drawer = page.locator('.n-drawer:visible')
    const openDrawer = async (background: string, filter = 'none') => {
      await page.goto('/#/hermes/workflow')
      await page.getByRole('button', { name: 'New Workflow', exact: true }).click()
      await expect(drawer).toHaveCSS('background-color', background)
      await expect(drawer).toHaveCSS('backdrop-filter', filter)
      await expect(drawer).toHaveCSS('border-radius', '0px')
      await expect(drawer.locator('.n-drawer-content')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await page.keyboard.press('Escape')
      await expect(drawer).toBeHidden()
    }
    await openDrawer('rgba(34, 51, 68, 0.5)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('overlay')
    await page.getByTestId('theme-overlay-backgroundColor').fill('#336699')
    await page.getByTestId('theme-overlay-radius').fill('18')
    await page.getByTestId('theme-overlay-radius').dispatchEvent('change')
    await page.getByTestId('theme-overlay-blur').fill('12')
    await page.getByTestId('theme-overlay-blur').dispatchEvent('change')
    for (const opacity of [0.6, 0]) {
      await page.getByTestId('theme-scope').selectOption('overlay')
      await page.getByTestId('theme-overlay-opacity').fill(String(opacity))
      await page.getByTestId('theme-overlay-opacity').dispatchEvent('change')
      await openDrawer(`rgba(51, 102, 153, ${opacity})`, 'blur(12px) saturate(1.1)')
      await page.goto('/#/hermes/theme')
    }
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await openDrawer(brightness === 'dark' ? 'rgb(26, 26, 26)' : 'rgb(255, 255, 255)')
  })
}
