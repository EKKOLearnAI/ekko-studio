import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  test(`pet cards follow wallpaper and regional appearance in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness, background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 },
    } })
    await page.route('**/api/studio/petdex/manifest*', route => route.fulfill({ json: {
      generatedAt: '2026-07-28T00:00:00.000Z', total: 2,
      pets: ['Cat', 'Dog'].map(kind => ({
        slug: kind.toLowerCase(), displayName: `Theme ${kind}`, kind, submittedBy: 'Theme tester',
        spritesheetUrl: '/logo.png', previewUrl: '/logo.png', petJsonUrl: '', zipUrl: '',
      })),
    } }))
    const path = '/#/hermes/petdex'
    await page.goto(path)
    const cards = page.locator('.petdex-view .summary-card, .pet-card')
    const pet = page.locator('.pet-card').first()
    const wallpaperBg = brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)'
    await expect(cards).toHaveCount(6)
    for (const card of await cards.all()) await expect(card).toHaveCSS('background-color', wallpaperBg)
    await expect(page.locator('.pet-preview').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('.pet-preview').first()).toHaveCSS('background-image', /linear-gradient/)
    await expect(page.locator('.pet-frame').first()).toHaveCSS('background-image', /logo\.png/)
    const search = page.getByPlaceholder('Search by name, slug, author, or kind')
    await search.fill('cat')
    await expect(page.locator('.pet-card')).toHaveCount(1)
    await expect(pet).toContainText('Theme Cat')
    await search.fill('')
    await page.locator('.filter-row .n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: 'Dog (1)' }).click()
    await expect(page.locator('.pet-card')).toHaveCount(1)
    await expect(pet).toContainText('Theme Dog')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-linkColor').fill('#ddbb77')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await page.goto(path)
    await expect(cards).toHaveCount(6)
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
    await expect(cards).toHaveCount(6)
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
      await expect(card).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
      await expect(card).toHaveCSS('border-radius', '16px')
      await expect(card).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.25)')
      await expect(card).toHaveCSS('box-shadow', 'none')
    }
    await expect(page.locator('.petdex-view')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('.app-main--card')).toHaveCSS('backdrop-filter', 'none')
    await expect(pet.getByRole('button', { name: 'Adopt', exact: true })).toBeEnabled()
    await expect(pet.getByRole('link', { name: 'Spritesheet', exact: true })).toHaveAttribute('href', '/logo.png')
    await expect(pet.getByRole('link', { name: 'Spritesheet', exact: true })).toHaveCSS('color', 'rgb(221, 187, 119)')
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 })
      await pet.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: `/tmp/studio-petdex-${brightness}-${width}.png`, animations: 'disabled' })
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.goto(path)
    // The page wrapper must not obscure the content layer without a wallpaper either.
    await expect(page.locator('.petdex-view')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(pet).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
    await page.goto(path)
    await expect(pet).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await page.goto(path)
    await expect(cards).toHaveCount(6)
    for (const card of await cards.all()) {
      await expect(card).toHaveCSS('background-color', brightness === 'dark' ? 'rgb(37, 37, 37)' : 'rgb(240, 240, 240)')
      await expect(card).toHaveCSS('backdrop-filter', 'none')
      await expect(card).toHaveCSS('border-radius', '8px')
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}
