import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  test(`view selectors and switches follow wallpaper and input opacity in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness, accentColor: '#e16666', background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 },
    } })
    const connections = ['Phone', 'Other phone'].map((name, index) => ({
      id: index + 1, device_code: `device-${index}`, device_name: name, device_brand: '', device_model: '',
      connection_type: 'lan', user_id: index + 1, cloud_user_id: 0, username: 'playwright',
      token_expires_at: 4102444800, last_connected_at: 1780000000, created_at: 1780000000, updated_at: 1780000000,
      active: true, online: true, push_enabled: true, can_manage_push: index === 0,
    }))
    await page.route('**/api/app-connections', route => route.fulfill({ json: { connections, access_failure: null } }))
    await page.route('**/api/studio/app-connections/1/push', async route => {
      connections[0].push_enabled = route.request().postDataJSON().push_enabled
      await route.fulfill({ json: { success: true, push_enabled: connections[0].push_enabled } })
    })
    await page.goto('/#/hermes/connections?view=download')
    const view = page.locator('.panel-actions > .view-switch')
    const source = page.locator('.download-source-switch')
    const wallpaperBg = brightness === 'dark' ? 'rgba(42, 42, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)'
    for (const group of [view, source]) {
      await expect(group).toHaveCSS('background-color', wallpaperBg)
      await expect(group.locator('[aria-selected="true"]')).toHaveCSS('background-color', 'rgba(225, 102, 102, 0.16)')
    }
    await source.getByRole('tab', { name: 'GitHub', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(source.getByRole('tab', { name: 'GitHub', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(source.getByRole('tab', { name: 'GitHub', exact: true })).toHaveCSS('outline-style', 'solid')
    await view.screenshot({ path: `/tmp/studio-view-switch-${brightness}.png` })
    await view.getByRole('button', { name: 'List', exact: true }).click()

    const toggle = page.getByRole('switch', { name: 'Push notifications for Phone', exact: true })
    const disabled = page.getByRole('switch', { name: 'Push notifications for Other phone', exact: true })
    const rail = toggle.locator('.n-switch__rail')
    await expect(toggle).toBeChecked()
    await expect(rail).toHaveCSS('background-color', 'rgba(225, 102, 102, 0.72)')
    await expect(disabled).toBeDisabled()
    const onPosition = await toggle.locator('.n-switch__button').evaluate(el => getComputedStyle(el).left)
    await toggle.focus()
    await expect(rail).not.toHaveCSS('box-shadow', 'none')
    await page.keyboard.press('Space')
    await expect(toggle).not.toBeChecked()
    const neutral = brightness === 'dark' ? '64, 64, 64' : '228, 228, 228'
    await expect(rail).toHaveCSS('background-color', `rgba(${neutral}, 0.72)`)
    await expect(toggle.locator('.n-switch__button')).not.toHaveCSS('left', onPosition)
    await expect(toggle.locator('.n-switch__button')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await toggle.screenshot({ path: `/tmp/studio-toggle-${brightness}.png` })

    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-opacity').fill('0.25')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await page.getByTestId('theme-scope').selectOption('input')
    await page.getByTestId('theme-input-backgroundColor').fill('#336699')
    await page.getByTestId('theme-input-backgroundColor').dispatchEvent('change')
    await page.getByTestId('theme-input-opacity').fill('0.4')
    const saved = page.waitForResponse(response => response.url().endsWith('/api/theme') && response.request().method() === 'PUT'
      && response.request().postDataJSON().appearance?.regions?.input?.opacity === 0.4)
    await page.getByTestId('theme-input-opacity').dispatchEvent('change')
    await saved
    await page.goto('/#/hermes/connections?view=download')
    await expect(view).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.4)')
    await expect(source).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.4)')
    await view.getByRole('button', { name: 'List', exact: true }).click()
    await toggle.click()
    await expect(toggle).toBeChecked()
    await expect(rail).toHaveCSS('background-color', 'rgba(225, 102, 102, 0.4)')
    await page.reload()
    await expect(rail).toHaveCSS('background-color', 'rgba(225, 102, 102, 0.4)')

    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('input')
    await page.getByTestId('theme-input-opacity').fill('0')
    await page.getByTestId('theme-input-opacity').dispatchEvent('change')
    await page.goto('/#/hermes/connections?view=list')
    await expect(rail).toHaveCSS('background-color', 'rgba(225, 102, 102, 0)')
    await expect(toggle.locator('.n-switch__button')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await toggle.focus()
    await expect(rail).not.toHaveCSS('box-shadow', 'none')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('input')
    await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
    await page.goto('/#/hermes/connections?view=list')
    await expect(view).toHaveCSS('background-color', 'rgba(51, 102, 153, 0.25)')
    await expect(rail).toHaveCSS('background-color', 'rgba(225, 102, 102, 0.25)')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await page.goto('/#/hermes/connections?view=download')
    await expect(view).toHaveCSS('background-color', wallpaperBg)
    await expect(source).toHaveCSS('background-color', wallpaperBg)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.goto('/#/hermes/connections?view=list')
    await expect(rail).toHaveCSS('background-color', brightness === 'dark' ? 'rgb(224, 224, 224)' : 'rgb(51, 51, 51)')
    expect(api.unexpectedRequests).toEqual([])
  })
}
