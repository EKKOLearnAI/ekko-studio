import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

for (const brightness of ['light', 'dark']) {
  test(`borders follow regional opacity without fading focus or selection in ${brightness} mode`, async ({ page }) => {
    await authenticate(page)
    const api = await mockHermesApi(page, { theme: {
      brightness, accentColor: '#ff8833',
      appearance: {
        global: { opacity: 0.3, borderColor: '#6688aa' },
        regions: { card: { opacity: 0.65 }, input: { opacity: 0 }, overlay: { opacity: 0.45 } },
      },
    } })
    await page.goto('/#/hermes/theme')
    const library = page.getByTestId('theme-library')
    const divider = page.locator('.theme-setting').first()
    const create = page.getByTestId('theme-create')
    const selection = page.getByTestId('theme-preset-theme-0')
    await expect(library).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.65)')
    await expect(divider).toHaveCSS('border-top-color', /rgba\(.+, 0\.65\)/)
    await expect(create.locator('.n-button__border')).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.65)')
    await expect(selection).toHaveCSS('border-top-color', 'rgb(255, 136, 51)')
    await expect(page.locator('.font-size-input .n-input__border')).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0)')

    await create.click()
    const dialog = page.locator('.theme-name-dialog')
    const name = page.getByTestId('theme-name')
    await expect(dialog).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.45)')
    await expect(name.locator('.n-input__border')).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0)')
    await name.locator('input').focus()
    await expect(name.locator('.n-input__state-border')).toHaveCSS('border-top-color', 'rgb(255, 136, 51)')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByTestId('theme-scope').selectOption('card')
    const opacity = page.getByTestId('theme-card-opacity')
    // input previews immediately, including internal divider/button borders.
    await opacity.fill('0.1')
    await expect(library).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.1)')
    await expect(create.locator('.n-button__border')).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.1)')
    await opacity.dispatchEvent('change')
    await page.getByTestId('theme-scope').selectOption('global')
    await expect(divider).toHaveCSS('border-top-color', /rgba\(.+, 0\.1\)/)
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
    await expect(library).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.3)')
    await page.reload()
    await expect(library).toHaveCSS('border-top-color', 'rgba(102, 136, 170, 0.3)')
    await page.getByTestId('theme-scope').selectOption('global')
    await page.getByRole('button', { name: 'Reset Background opacity', exact: true }).click()
    await expect(library).toHaveCSS('border-top-color', 'rgb(102, 136, 170)')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await expect(library).toHaveCSS('border-top-color', brightness === 'dark' ? 'rgb(58, 58, 58)' : 'rgb(224, 224, 224)')
    expect(api.unexpectedRequests.map(({ method, pathname }) => ({ method, pathname }))).toEqual([])
  })
}
