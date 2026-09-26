import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('language menu stays usable after switching to an RTL locale', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)

  await page.goto('/#/hermes/theme')

  await page.locator('.page-sidebar-account-btn').click()

  const languageSwitch = page.locator('.language-switch')
  const languageMenu = page.locator('.n-base-select-menu')
  const option = (label: string) =>
    page.locator('.n-base-select-option').filter({ hasText: new RegExp(`^${label}$`) })

  await languageSwitch.click()
  await option('العربية').click()
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')

  await languageSwitch.click()
  await expect(languageMenu).toBeVisible()
  await expect(languageMenu).toBeInViewport()
  await option('English').click()

  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await expect(languageSwitch).toContainText('English')
})
