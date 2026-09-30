import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const [path, selector] of [
  ['/hermes/chat', '.chat-view'],
  ['/hermes/group-chat', '.group-chat-view'],
  ['/hermes/history', '.history-panel'],
  ['/hermes/workflow', '.workflow-view'],
]) {
  test(`${path} shares the initial profile request and skips runtime probes`, async ({ page }) => {
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.route('**/api/studio/sessions/hermes/groups*', route => route.fulfill({ json: { groups: [], included: [] } }))
    let profileRequests = 0
    let runtimeRequests = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/hermes/profiles', async route => {
      profileRequests++
      await pending
      await route.fallback()
    })
    page.on('request', request => {
      if (/\/api\/hermes\/profiles\/.*runtime-status/.test(request.url())) runtimeRequests++
    })

    try {
      await page.goto(`/#${path}`)
      await expect(page.locator(`${selector} > .page-loading-overlay`)).toBeVisible()
      await expect.poll(() => profileRequests).toBe(1)
    } finally {
      release()
    }
    await expect(page.locator(selector)).toHaveAttribute('aria-busy', 'false')
    expect(profileRequests).toBe(1)
    expect(runtimeRequests).toBe(0)
  })
}
