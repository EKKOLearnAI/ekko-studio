import { expect, test, type Locator } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function expectMenuUncovered(menu: Locator) {
  await expect(menu).toBeVisible()
  await expect.poll(() => menu.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return [bounds.top + 12, (bounds.top + bounds.bottom) / 2, bounds.bottom - 12].map(y =>
      element.contains(document.elementFromPoint((bounds.left + bounds.right) / 2, y)))
  })).toEqual([true, true, true])
  expect(await menu.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight
  })).toBe(true)
}

for (const viewport of [
  { name: 'desktop light', width: 1280, height: 720, theme: 'light' },
  { name: 'mobile light', width: 320, height: 568, theme: 'light' },
  { name: 'mobile dark', width: 390, height: 844, theme: 'dark' },
  { name: 'short mobile dark', width: 320, height: 360, theme: 'dark' },
]) test(`chat settings menus remain uncovered and selectable on ${viewport.name}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: viewport.width, height: viewport.height })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(theme => {
    localStorage.setItem('hermes_brightness', theme)
    localStorage.setItem('hermes_new_chat_agent_v1', 'dsh')
  }, viewport.theme)
  await mockHermesApi(page, { sessionCategories: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1, name: `Category ${String(index + 1).padStart(2, '0')}`,
  })) })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  if (viewport.width <= 768) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  const field = (name: string) => settings.locator('.new-chat-field').filter({ hasText: new RegExp(`^${name}`) })
  const menu = page.locator('.n-base-select-menu:visible')

  await field('Category').locator('.n-base-selection').click()
  await expect(menu).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('category-menu.png'), animations: 'disabled' })
  await expectMenuUncovered(menu)
  await menu.hover()
  await page.mouse.wheel(0, 180)
  await menu.locator('.n-base-select-option').filter({ hasText: /^Category 06$/ }).click()
  await expect(field('Category')).toContainText('Category 06')
  await expect(menu).toHaveCount(0)

  await field('Protocol').locator('.n-base-selection').click()
  await expectMenuUncovered(menu)
  await page.screenshot({ path: testInfo.outputPath('protocol-menu.png'), animations: 'disabled' })
  await menu.locator('.n-base-select-option').filter({ hasText: /^Anthropic Messages/ }).click()
  await expect(field('Protocol')).toContainText('Anthropic Messages')
  await expect(menu).toHaveCount(0)

  await field('Profiles').locator('.n-base-selection').click()
  await expectMenuUncovered(menu)
  await menu.locator('.n-base-select-option').filter({ hasText: /^default$/ }).click()
  await expect(field('Profiles')).toContainText('default')
  await expect(menu).toHaveCount(0)
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.new-chat-page')).toBeVisible()
})
