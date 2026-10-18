import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  test(`download cards follow wallpaper and regional appearance in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness, background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 },
    } })
    await page.route('**/api/studio/versions', route => route.fulfill({ json: {
      schema: 1, mobile: { version: '1.0.0', channels: {
        androidApk: { version: '1.0.0', githubUrl: 'https://downloads.example.test/studio.apk', cloudflareUrl: '', online: true },
        googlePlay: { version: '1.0.1', url: '', online: false },
        apple: { version: '1.1.0', testFlightUrl: '', appStoreUrl: '', online: false },
        harmony: { url: '', online: false },
      } },
    } }))
    const path = '/#/hermes/connections?view=download'
    await page.goto(path)
    const hero = page.locator('.app-download-hero')
    const cards = page.locator('.app-download-hero, .app-platform-card')
    const wallpaperBg = brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)'
    await expect(cards).toHaveCount(4)
    for (const card of await cards.all()) await expect(card).toHaveCSS('background-color', wallpaperBg)
    await expect(hero).toHaveCSS('background-image', 'none')
    await expect(page.locator('.download-tag-qr img')).toHaveCount(1)
    for (const detail of await page.locator('.app-download-meta span, .app-platform-icon').all()) {
      await expect(detail).toHaveCSS('background-color', brightness === 'dark' ? 'rgba(224, 224, 224, 0.04)' : 'rgba(26, 26, 26, 0.04)')
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await hero.scrollIntoViewIfNeeded()
      await expect(page.getByText('APK v1.0.0', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `/tmp/studio-downloads-${brightness}-${width}.png` })
    }
    // QR codes keep an opaque quiet zone for scanning.
    await expect(page.locator('.download-tag-qr')).toHaveCount(1)
    for (const qr of await page.locator('.download-tag-qr').all()) await expect(qr).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await page.goto(path)
    for (const card of await cards.all()) await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')

    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-backgroundColor').fill('#336699')
    await page.getByTestId('theme-card-borderColor').fill('#6688aa')
    for (const [key, value] of [['opacity', '0.25'], ['blur', '12'], ['radius', '16'], ['shadow', '0']]) {
      await page.getByTestId(`theme-card-${key}`).fill(value)
      await page.getByTestId(`theme-card-${key}`).dispatchEvent('change')
    }
    await page.goto(path)
    await page.reload()
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await expect(card).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await expect(card).toHaveCSS('border-radius', '16px')
      await expect(card).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
      await expect(card).toHaveCSS('box-shadow', 'none')
    }
    await expect(page.locator('.app-platform-card--apk .app-platform-action')).toHaveAttribute('href', /^https:\/\//)
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
    await page.goto(path)
    await expect(hero).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await page.goto(path)
    await expect(hero).toHaveCSS('background-color', wallpaperBg)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.goto(path)
    await expect(hero).toHaveCSS('background-image', /radial-gradient.*linear-gradient/)
    expect(api.unexpectedRequests).toEqual([])
  })
}
