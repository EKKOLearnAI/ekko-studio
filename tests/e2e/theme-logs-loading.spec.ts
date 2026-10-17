import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi } from './fixtures'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

for (const brightness of ['light', 'dark']) {
  for (const mode of ['wallpaper', 'global', 'input']) {
    test(`log filters keep ${mode} backgrounds while loading in ${brightness} mode`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 820 })
      await authenticate(page)
      const wallpaper = mode === 'wallpaper'
      const surface = { backgroundColor: '#336699', opacity: 0.25 }
      const api = await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'solid.png', mime: 'image/png', updatedAt: 1 } } : {}),
        appearance: { global: mode === 'global' ? surface : {}, regions: mode === 'input' ? { input: surface } : {} },
      } })
      if (wallpaper) {
        const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
        await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: image }))
      }
      const fileGate = gate()
      const entryGate = gate()
      const queries: URLSearchParams[] = []
      await page.route('**/api/studio/logs', async route => {
        await fileGate.promise
        await route.fulfill({ json: { files: [{ name: 'webui', size: '1 KB', modified: '2026-09-30T00:00:00Z' }] } })
      })
      await page.route('**/api/studio/logs/webui?**', async route => {
        queries.push(new URL(route.request().url()).searchParams)
        await entryGate.promise
        await route.fulfill({ json: { entries: [] } })
      })
      // Navigate with the theme already applied, isolating the disabled loading
      // state from initial theme fetching or wallpaper decoding.
      await page.goto('/#/hermes/theme')
      await expect(page.getByTestId('theme-scope')).toBeVisible()
      if (wallpaper) await expect(page.locator('html')).toHaveClass(/theme-has-custom-background/)
      await page.goto('/#/hermes/logs')
      const controls = page.locator('.logs-page-header .n-base-selection')
      const background = wallpaper ? brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)' : 'rgba(51, 102, 153, 0.25)'
      await expect(controls).toHaveCount(3)
      const expectSurfaces = async (disabled: boolean) => {
        for (const control of await controls.all()) {
          await expect(control).toBeVisible()
          if (disabled) {
            await expect(control).toHaveClass(/n-base-selection--disabled/)
            await expect(control).toHaveCSS('cursor', 'not-allowed')
          } else await expect(control).not.toHaveClass(/n-base-selection--disabled/)
          await expect(control).toHaveCSS('background-color', background)
          await expect(control.locator('.n-base-selection-label')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        }
      }
      try {
        await expectSurfaces(true)
        fileGate.release()
        await expect.poll(() => queries.length).toBe(1)
        await expectSurfaces(true)
        entryGate.release()
        await expect(page.locator('.logs-view')).toHaveAttribute('aria-busy', 'false')
        await expectSurfaces(false)
        await page.locator('.logs-level-select').click()
        await page.locator('.n-base-select-option').filter({ hasText: /^ERROR$/ }).click()
        await expect.poll(() => queries.some(query => query.get('level') === 'ERROR')).toBe(true)
        await expectSurfaces(false)
        expect(api.unexpectedRequests.map(({ method, pathname }) => ({ method, pathname }))).toEqual([])
      } finally {
        fileGate.release()
        entryGate.release()
      }
    })
  }
}
