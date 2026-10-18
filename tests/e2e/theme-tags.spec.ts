import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`default tags follow ${wallpaper ? 'wallpaper' : 'custom'} surfaces in ${brightness} mode`, async ({ page }) => {
      await authenticate(page)
      const api = await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 } } : {
          textColor: '#e4e8f8', appearance: { global: { backgroundColor: '#182438', opacity: 0.15 }, regions: {} },
        }),
      } })
      await page.route('**/api/studio/update/preview', route => route.fulfill({ json: {
        preview_dir: '/tmp/preview', webui_home: '/tmp/preview-home', current_tag: 'v0.7.35',
        has_package: true, installed: true, running: false, frontend_url: 'http://localhost:8650',
        action_log: '', dev_log: '', active_action: null,
      } }))
      await page.route('**/api/studio/update/preview/tags', route => route.fulfill({ json: { tags: [{ name: 'v0.7.35', sha: 'abc123' }] } }))
      await page.goto('/#/studio/agents')
      const card = page.getByTestId('agent-card-claude-code')
      const provider = card.locator('.n-tag').filter({ hasText: /^Anthropic$/ })
      const installed = card.locator('.n-tag').filter({ hasText: /^Installed$/ })
      const background = wallpaper
        ? brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)'
        : 'rgba(24, 36, 56, 0.15)'
      await expect(provider).toHaveCSS('background-color', background)
      await expect(installed).toBeVisible()
      const semanticBackground = await installed.evaluate(el => getComputedStyle(el).backgroundColor)
      expect(semanticBackground).not.toBe(background)
      await provider.scrollIntoViewIfNeeded()
      await card.screenshot({ path: `/tmp/studio-theme-tag-${brightness}-${wallpaper ? 'wallpaper' : 'custom'}.png` })

      // Bordered tags use a different Naive UI token from the provider badge.
      await page.goto('/#/hermes/version-preview')
      const stopped = page.locator('.status-table .n-tag').filter({ hasText: /^Not running$/ })
      await expect(stopped).toHaveCSS('background-color', background)
      await expect(stopped.locator('.n-tag__border')).toBeVisible()

      await page.goto('/#/hermes/theme')
      await page.getByTestId('theme-scope').selectOption('card')
      const color = page.getByTestId('theme-card-backgroundColor')
      await color.fill('#336699')
      await color.dispatchEvent('change')
      const opacity = page.getByTestId('theme-card-opacity')
      await opacity.fill('0')
      const saved = page.waitForResponse(response => response.url().endsWith('/api/theme') && response.request().method() === 'PUT'
        && response.request().postDataJSON().appearance?.regions?.card?.opacity === 0)
      await opacity.dispatchEvent('change')
      await saved
      await page.goto('/#/studio/agents')
      await expect(provider).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
      await expect(installed).toHaveCSS('background-color', semanticBackground)
      await page.reload()
      await expect(provider).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')

      await page.goto('/#/hermes/theme')
      await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
      await page.goto('/#/studio/agents')
      await expect(provider).toHaveCSS('background-color', wallpaper ? background : brightness === 'dark' ? 'rgb(51, 51, 51)' : 'rgb(238, 238, 238)')
      expect(api.unexpectedRequests).toEqual([])
    })
  }
}
