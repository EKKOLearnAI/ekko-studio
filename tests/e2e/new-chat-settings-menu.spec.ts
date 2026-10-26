import { expect, test, type Locator } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

async function expectMenuUncovered(menu: Locator) {
  await expect(menu).toBeVisible()
  await expect.poll(() => menu.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return [bounds.top + 12, (bounds.top + bounds.bottom) / 2, bounds.bottom - 12].map(y =>
      element.contains(document.elementFromPoint((bounds.left + bounds.right) / 2, y)))
  })).toEqual([true, true, true])
  await expect.poll(() => menu.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return { left: bounds.left >= 0, top: bounds.top >= 0, right: bounds.right <= innerWidth, bottom: bounds.bottom <= innerHeight }
  })).toEqual({ left: true, top: true, right: true, bottom: true })
}

async function expectWideCategory(category: Locator, viewportWidth: number) {
  await expect.poll(() => category.evaluate(element => {
    const bounds = element.closest('.n-popover')!.getBoundingClientRect()
    return { width: Math.round(bounds.width), left: bounds.left >= 15, right: bounds.right <= innerWidth - 15 }
  })).toEqual({ width: Math.min(320, viewportWidth - 32), left: true, right: true })
}

for (const viewport of [
  { name: 'desktop light', width: 1280, height: 720, theme: 'light' },
  { name: 'desktop dark', width: 1280, height: 900, theme: 'dark' },
  { name: 'mobile light', width: 320, height: 568, theme: 'light' },
  { name: 'mobile dark', width: 390, height: 844, theme: 'dark' },
  { name: 'wide mobile light', width: 440, height: 956, theme: 'light' },
  { name: 'wide mobile dark', width: 440, height: 956, theme: 'dark' },
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
  const settings = page.getByRole('dialog', { name: 'Chat settings', exact: true })
  const field = (name: string) => settings.locator('.new-chat-field').filter({ hasText: new RegExp(`^${name}`) })
  const menu = page.locator('.n-base-select-menu:visible')

  const categoryButton = page.locator('.new-chat-config-actions').getByRole('button', { name: 'Category', exact: true })
  const settingsButton = page.locator('.new-chat-config-actions').getByRole('button', { name: 'Chat settings', exact: true })
  expect(await categoryButton.evaluate((element) => element.previousElementSibling?.getAttribute('aria-label'))).toBe('Chat settings')
  await categoryButton.click()
  const category = page.getByRole('dialog', { name: 'Category', exact: true })
  if (viewport.width <= 768) await expectWideCategory(category, viewport.width)
  await category.locator('.n-base-selection').click()
  await expect(menu).toBeVisible()
  await expectMenuUncovered(menu)
  expect(await page.evaluate(() => ({ scrollX, overflow: document.documentElement.scrollWidth > innerWidth }))).toEqual({ scrollX: 0, overflow: false })
  await page.screenshot({ path: testInfo.outputPath('category-menu.png'), animations: 'disabled' })
  await menu.hover()
  await page.mouse.wheel(0, 180)
  await menu.locator('.n-base-select-option').filter({ hasText: /^Category 06$/ }).click()
  await expect(category).toContainText('Category 06')
  await expect(categoryButton).toHaveAttribute('title', 'Category: Category 06')
  await expect(menu).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(category).toBeHidden()
  await expect(page.locator('.new-chat-page')).toBeVisible()
  await expect(categoryButton).toHaveAttribute('aria-expanded', 'false')
  await expect(categoryButton).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('category-toolbar.png'), animations: 'disabled' })
  await settingsButton.click()
  await expect(settings.locator('.new-chat-field').filter({ hasText: /^Category/ })).toHaveCount(0)
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

for (const width of [320, 390, 440]) test(`Hermes category menu fits a ${width}px viewport without shifting the page`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => localStorage.setItem('hermes_new_chat_agent_v1', 'hermes'))
  await mockHermesApi(page, { sessionCategories: [{ id: 1, name: 'Work' }] })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await page.locator('.new-chat-config-actions').getByRole('button', { name: 'Category', exact: true }).click()
  const category = page.getByRole('dialog', { name: 'Category', exact: true })
  await expectWideCategory(category, width)
  const categoryButton = page.locator('.new-chat-config-actions').getByRole('button', { name: 'Category', exact: true })
  await categoryButton.click()
  await expect(category).toBeHidden()
  await categoryButton.click()
  await expectWideCategory(category, width)
  if (width === 440) {
    for (const resizedWidth of [320, 390, 440]) {
      await page.setViewportSize({ width: resizedWidth, height: 844 })
      await expectWideCategory(category, resizedWidth)
    }
  }
  await category.getByRole('textbox', { name: 'Category', exact: true }).click()
  const menu = page.locator('.n-base-select-menu:visible')
  await expectMenuUncovered(menu)
  expect(await page.evaluate(() => ({ scrollX, overflow: document.documentElement.scrollWidth > innerWidth }))).toEqual({ scrollX: 0, overflow: false })
  await menu.locator('.n-base-select-option').filter({ hasText: /^Work$/ }).click()
  await expect(category).toContainText('Work')
  await page.locator('.new-chat-intro').click()
  await expect(category).toBeHidden()
  await expect(page.locator('.new-chat-page')).toBeVisible()
  await categoryButton.click()
  await expectWideCategory(category, width)
  await category.getByRole('textbox', { name: 'Category', exact: true }).click()
  await menu.locator('.n-base-select-option').filter({ hasText: /^Uncategorized$/ }).click()
  await expect(page.locator('.new-chat-config-actions').getByRole('button', { name: 'Category', exact: true })).toHaveAttribute('title', 'Category: Uncategorized')
  await page.keyboard.press('Escape')
  await expect(category).toBeHidden()
  await expect(page.locator('.new-chat-page')).toBeVisible()
})
