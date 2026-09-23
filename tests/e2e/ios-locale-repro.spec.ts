import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const CJK = /[\u4e00-\u9fff]/

test.describe('mobile locale switching on page-sidebar screens', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    locale: 'zh-CN',
  })

  test('chat home screen exposes a working language switch on mobile', async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'default')
    await mockChatSocket(page)
    await mockHermesApi(page)

    // Fresh visitor with a Chinese browser: the home screen resolves to zh.
    await page.goto('/#/hermes/chat')
    await page.waitForSelector('.chat-view', { timeout: 15_000 })
    await expect(page.getByRole('textbox')).toBeVisible()

    const zhVisible = await visibleChineseText(page)
    expect(zhVisible.length, `expected Chinese UI strings before switching, got: ${JSON.stringify(zhVisible)}`).toBeGreaterThan(0)

    // The page sidebar starts collapsed on mobile; open it via the hamburger.
    await page.locator('.hamburger-btn').click()
    const languageSwitch = page.locator('.page-sidebar-bottom .language-switch')
    await expect(languageSwitch).toBeVisible()

    await languageSwitch.click()
    const option = page.locator('.n-base-select-option').filter({ hasText: /^English$/ })
    await expect(option).toBeVisible()
    await option.click()

    // After switching, the same screen must no longer show Chinese UI chrome.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect
      .poll(async () => (await visibleChineseText(page)).length, { timeout: 10_000 })
      .toBe(0)
  })

  test('shared group chat invite gate exposes a working language switch', async ({ page }) => {
    // Guest landing on a share link sees the invite card; the language switch
    // must be available there because the app sidebar never renders.
    await page.route('**/api/hermes/group-chat/rooms/join/ROOM1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ room: { id: 'room-shared', name: 'Shared Room' } }),
      })
    })
    await page.goto('/#/share/group-chat/ROOM1')

    await expect(page.locator('.invite-card')).toBeVisible()
    const languageSwitch = page.locator('.invite-card .invite-language-switch')
    await expect(languageSwitch).toBeVisible()

    const zhVisible = await visibleChineseText(page)
    expect(zhVisible.length, `expected Chinese UI strings before switching, got: ${JSON.stringify(zhVisible)}`).toBeGreaterThan(0)

    await languageSwitch.click()
    const option = page.locator('.n-base-select-option').filter({ hasText: /^English$/ })
    await expect(option).toBeVisible()
    await option.click()

    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect
      .poll(async () => (await visibleChineseText(page)).length, { timeout: 10_000 })
      .toBe(0)
  })
})

async function visibleChineseText(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const seen = new Set<string>()
    let node: Node | null
    const cjk = /[\u4e00-\u9fff]/
    while ((node = walker.nextNode())) {
      const parent = (node as Text).parentElement
      if (!parent) continue
      if (parent.closest('script, style')) continue
      const style = window.getComputedStyle(parent)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const rect = parent.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      const text = (node.textContent || '').trim()
      if (text && cjk.test(text)) seen.add(text)
    }
    return [...seen]
  })
}
