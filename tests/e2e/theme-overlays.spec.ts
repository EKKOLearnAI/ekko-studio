import { expect, test } from '@playwright/test'
import sharp from 'sharp'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  for (const mode of ['wallpaper', 'wallpaper-card', 'global', 'regional']) {
    test(`account, profile and preview overlays follow ${mode} theme in ${brightness} mode`, async ({ page }) => {
      await authenticate(page)
      const wallpaper = mode.startsWith('wallpaper')
      const api = await mockHermesApi(page, { theme: {
        brightness,
        ...(wallpaper ? { background: { name: 'solid.png', mime: 'image/png', updatedAt: 1 } } : {}),
        appearance: mode === 'global'
          ? { global: { backgroundColor: '#336699', opacity: 0.3, blur: 12 }, regions: {} }
          : mode === 'regional'
            ? { global: {}, regions: { overlay: { backgroundColor: '#336699', opacity: 0.3, blur: 12 }, input: { backgroundColor: '#6688aa', opacity: 0.2 } } }
            : mode === 'wallpaper-card'
              ? { global: {}, regions: { card: { backgroundColor: '#bb5533', opacity: 1, blur: 0 } } }
              : { global: {}, regions: {} },
      } })
      if (wallpaper) {
        const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#204060' } }).png().toBuffer()
        await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/png', body: image }))
      }
      await page.route('**/api/studio/update/preview', route => route.fulfill({ json: {
        preview_dir: '/tmp/studio-preview', webui_home: '/tmp/studio-preview-home',
        current_tag: 'v0.7.35', has_package: true, installed: true, running: false,
        frontend_url: 'http://localhost:8650', action_log_path: '/tmp/action.log', dev_log_path: '/tmp/dev.log',
        action_log: '', dev_log: '', active_action: null,
      } }))
      await page.route('**/api/studio/update/preview/tags', route => route.fulfill({ json: { tags: [{ name: 'v0.7.35', sha: 'abc123' }, { name: 'v0.7.34', sha: 'def456' }] } }))
      await page.goto('/#/hermes/version-preview')
      await expect(page.locator('.tag-select')).toBeVisible()
      await expect(page.locator('.page-loading-overlay')).toBeHidden()
      const background = wallpaper ? brightness === 'dark' ? 'rgba(26, 26, 26, 0.72)' : 'rgba(255, 255, 255, 0.72)' : 'rgba(51, 102, 153, 0.3)'
      const filter = wallpaper ? 'blur(8px) saturate(1.1)' : 'blur(12px) saturate(1.1)'
      const inputBackground = mode === 'global' ? background : mode === 'regional' ? 'rgba(102, 136, 170, 0.2)' : brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)'
      // Inverted tooltips retain their contrasting palette instead of receiving
      // the light popup fill while keeping white text.
      await page.locator('.studio-navigation-rail').getByRole('link', { name: 'Settings', exact: true }).hover()
      const tooltip = page.locator('.n-tooltip:visible')
      await expect(tooltip).toBeVisible()
      await expect(tooltip).not.toHaveCSS('background-color', background)
      await page.locator('.page-sidebar-account-btn').click()
      const account = page.locator('.sidebar-account-popover')
      await expect(account).toHaveCSS('background-color', background)
      await expect(account).toHaveCSS('backdrop-filter', filter)
      await expect(account).toHaveCSS('opacity', '1')
      for (const selector of ['.profile-display', '.model-trigger', '.n-base-selection']) {
        await expect(account.locator(selector)).toHaveCSS('background-color', inputBackground)
      }
      await page.screenshot({ path: `/tmp/studio-account-overlay-${mode}-${brightness}.png`, animations: 'disabled' })
      await page.getByTestId('profile-selector-select').click()
      const profiles = page.locator('.profile-manager-modal')
      await expect(profiles).toBeVisible()
      await expect(profiles).toHaveCSS('background-color', background)
      await expect(profiles).toHaveCSS('backdrop-filter', filter)
      await expect(profiles.locator('.n-spin-body')).toBeHidden()
      await expect(profiles).toHaveCSS('opacity', '1')
      const itemBackground = mode === 'wallpaper-card' ? 'rgb(187, 85, 51)' : mode === 'global' ? background : brightness === 'dark' ? 'rgba(224, 224, 224, 0.04)' : 'rgba(26, 26, 26, 0.04)'
      for (const item of await profiles.locator('.profile-runtime-item').all()) {
        await expect(item).toHaveCSS('background-color', itemBackground)
      }
      await page.screenshot({ path: `/tmp/studio-profile-overlay-${mode}-${brightness}.png`, animations: 'disabled' })
      await profiles.locator('.n-base-close').click()
      await page.locator('.tag-select').click()
      const dropdown = page.locator('.n-base-select-menu:visible')
      await expect(dropdown).toHaveCSS('background-color', background)
      await expect(dropdown).toHaveCSS('backdrop-filter', filter)
      await expect(dropdown).toHaveCSS('opacity', '1')
      await expect(page.locator('.tag-select .n-base-selection')).toHaveCSS('background-color', inputBackground)
      await expect(page.locator('.tag-select .n-base-selection-label')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await page.screenshot({ path: `/tmp/studio-preview-dropdown-${mode}-${brightness}.png`, animations: 'disabled' })
      await dropdown.getByText('v0.7.34', { exact: true }).click()
      await expect(page.locator('.tag-select')).toContainText('v0.7.34')
      await expect(dropdown).not.toBeVisible()

      // Reset removes overrides; a retained wallpaper keeps only glass defaults.
      await page.goto('/#/hermes/theme')
      await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
      await page.reload()
      await page.locator('.page-sidebar-account-btn').click()
      const preset = brightness === 'dark' ? 'rgb(42, 42, 42)' : 'rgb(255, 255, 255)'
      await expect(account).toHaveCSS('background-color', wallpaper ? background : preset)
      await expect(account).toHaveCSS('backdrop-filter', wallpaper ? filter : 'none')
      await page.getByTestId('profile-selector-select').click()
      await expect(profiles).toHaveCSS('background-color', wallpaper ? background : preset)
      await expect(profiles).toHaveCSS('backdrop-filter', wallpaper ? filter : 'none')
      expect(api.unexpectedRequests.map(({ method, pathname }) => ({ method, pathname }))).toEqual([])
    })
  }
}
