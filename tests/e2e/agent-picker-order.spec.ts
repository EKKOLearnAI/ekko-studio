import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const agentLabels = ['Hermes', 'Ekko', 'Claude', 'Codex', 'Pi', 'Grok', 'OpenCode', 'DeepSeek Harness', 'Cursor']

for (const mobile of [false, true]) {
  test(`single-chat Agent order includes Cursor (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.goto('/#/hermes/chat')
    if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const drawer = page.locator('.new-chat-drawer')
    await drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first().locator('.n-base-selection').click()
    await expect(page.locator('.n-base-select-option__content:visible')).toHaveText(agentLabels)
    await page.locator('.n-base-select-option:visible').filter({ hasText: /^Cursor$/ }).click()
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()).toContainText('Cursor')
    await expect(drawer.locator('.new-chat-field').filter({ hasText: 'Global config' })).toHaveCount(0)
  })
}
