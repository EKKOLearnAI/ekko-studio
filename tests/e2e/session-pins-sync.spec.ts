import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('synchronizes pins across separate browser devices and survives reload', async ({ page, browser, baseURL }) => {
  const otherContext = await browser.newContext({ baseURL })
  const otherPage = await otherContext.newPage()
  const serverPins = new Set<string>()
  const tombstones = new Set<string>()
  const session = {
    id: 'shared-session', title: 'Shared pinned conversation', profile: 'research',
    source: 'cli', model: 'test-model', provider: 'test-provider',
    started_at: 1800000000, last_active: 1800000100, ended_at: null, message_count: 1,
  }
  async function prepare(device: Page) {
    await device.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        'shared-session': { session_id: 'shared-session', messages: [], isWorking: false },
      }
    })
    await authenticate(device, TEST_ACCESS_KEY, 'research')
    await mockHermesApi(device, { sessions: [session] })
    await mockChatSocket(device)
    await device.route(/\/api\/studio\/session-pins(?:[/?]|$)/, async route => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (request.method() === 'PUT') {
        const id = decodeURIComponent(path.split('/').at(-1)!)
        if (request.postDataJSON().pinned) { serverPins.add(id); tombstones.delete(id) }
        else { serverPins.delete(id); tombstones.add(id) }
      } else if (request.method() === 'POST') {
        for (const id of request.postDataJSON().pinnedIds) {
          if (!tombstones.has(id)) serverPins.add(id)
        }
      }
      await route.fulfill({ json: { pinnedIds: [...serverPins] } })
    })
    await device.goto('/#/hermes/chat')
    await expect(device.locator('.session-item').first()).toBeVisible()
  }
  const pinnedHeader = (device: Page) => device.locator('.session-group-header').filter({ hasText: 'Pinned' })
  try {
    await prepare(page)
    await prepare(otherPage)
    await page.locator('.session-item').first().click({ button: 'right' })
    await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Pin$/ }).click()
    await expect(pinnedHeader(page)).toBeVisible()
    await otherPage.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(pinnedHeader(otherPage)).toBeVisible()
    expect(await otherPage.evaluate(() => localStorage.getItem('hermes_session_pins_v1_research'))).toBeNull()
    await otherPage.reload()
    await expect(pinnedHeader(otherPage)).toBeVisible()
    await otherPage.locator('.session-item').first().click({ button: 'right' })
    await otherPage.locator('.n-dropdown-option:visible').filter({ hasText: /^Unpin$/ }).click()
    await expect(pinnedHeader(otherPage)).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(pinnedHeader(page)).toHaveCount(0)
  } finally {
    await otherContext.close()
  }
})
