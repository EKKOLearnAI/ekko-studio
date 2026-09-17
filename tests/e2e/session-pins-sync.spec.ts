import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('uses the session database flag for pins across devices and ignores old browser pins', async ({ page, browser, baseURL }) => {
  const otherContext = await browser.newContext({ baseURL })
  const otherPage = await otherContext.newPage()
  const session = {
    id: 'shared-session', title: 'Shared conversation', profile: 'research',
    source: 'cli', model: 'test-model', provider: 'test-provider',
    started_at: 1800000000, last_active: 1800000100, ended_at: null, message_count: 1,
    is_pinned: false,
  }
  async function prepare(device: Page) {
    await device.addInitScript(() => {
      localStorage.setItem('hermes_session_pins_v1_research', '["shared-session"]')
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        'shared-session': { session_id: 'shared-session', messages: [], isWorking: false },
      }
    })
    await authenticate(device, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(device, { sessions: [session] })
    await mockChatSocket(device)
    await device.route('**/api/studio/sessions/shared-session/pin', async route => {
      session.is_pinned = route.request().postDataJSON().is_pinned
      await route.fulfill({ json: { ok: true, is_pinned: session.is_pinned } })
    })
    await device.goto('/#/hermes/chat')
    await expect(device.locator('.session-item').first()).toBeVisible()
    return api
  }
  const pinnedHeader = (device: Page) => device.locator('.session-group-header').filter({ hasText: 'Pinned' })
  try {
    const api = await prepare(page)
    await expect(pinnedHeader(page)).toHaveCount(0)
    await page.locator('.session-item').first().click({ button: 'right' })
    await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Pin$/ }).click()
    await expect(pinnedHeader(page)).toBeVisible()
    expect(session.is_pinned).toBe(true)

    await prepare(otherPage)
    await expect(pinnedHeader(otherPage)).toBeVisible()
    await otherPage.locator('.session-item').first().click({ button: 'right' })
    await otherPage.locator('.n-dropdown-option:visible').filter({ hasText: /^Unpin$/ }).click()
    await expect(pinnedHeader(otherPage)).toHaveCount(0)
    expect(session.is_pinned).toBe(false)
    await page.reload()
    await expect(pinnedHeader(page)).toHaveCount(0)
    expect(api.unexpectedRequests).toEqual([])
  } finally {
    await otherContext.close()
  }
})
