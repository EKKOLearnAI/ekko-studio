import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const runtime of [
  { version: '24.19.0', kind: 'node' },
  { version: '24.22.1', kind: 'node' },
  { version: '24.19.0', kind: 'electron' },
]) {
  test(`opens the app without a Node version warning for ${runtime.kind} ${runtime.version}`, async ({ page }) => {
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.route('**/health', route => route.fulfill({ json: {
      status: 'ok', node_version: runtime.version, node_runtime: runtime.kind,
    } }))
    await page.goto('/#/hermes/jobs')
    await expect(page.getByRole('heading', { name: 'Scheduled Jobs' })).toBeVisible()
    await expect(page.locator('.node-warning-bar')).toHaveCount(0)
  })
}
