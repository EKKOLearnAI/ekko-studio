import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const mode of ['browser', 'local desktop', 'remote desktop'] as const) {
  test(`${mode} handles the default-credential warning`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    if (mode !== 'browser') {
      await page.addInitScript(remoteMode => {
        Object.defineProperty(window, 'hermesDesktop', {
          configurable: true,
          value: {
            isDesktop: true,
            remoteMode,
            platform: 'darwin',
            windowKind: 'main',
            ensureAuth: async () => true,
          },
        })
      }, mode === 'remote desktop')
    }
    const api = await mockHermesApi(page)
    await mockChatSocket(page)
    await page.route('**/api/auth/me', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user: {
        id: 1, username: 'admin', role: 'super_admin', status: 'active',
        created_at: 1, updated_at: 1, last_login_at: 1,
        requiresCredentialChange: true,
      } }),
    }))
    await page.goto('/#/hermes/chat')
    await expect(page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')).toBeVisible()

    const warning = page.getByText('Change the default account credentials', { exact: true })
    if (mode === 'local desktop') {
      await expect(warning).toHaveCount(0)
    } else {
      await expect(warning).toBeVisible()
      await page.getByRole('button', { name: 'Remind me later', exact: true }).click()
      await expect(warning).toHaveCount(0)
      await page.reload()
      await expect(page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')).toBeVisible()
      await expect(warning).toHaveCount(0)
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}
