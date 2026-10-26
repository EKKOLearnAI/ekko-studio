import { test, expect } from '@playwright/test'
import { DEFAULT_EKKO_CONFIG } from '../../packages/ekko-agent/src/config'
import { authenticate, mockHermesApi, mockChatSocket, TEST_ACCESS_KEY } from './fixtures'

test('Ekko desktop controls persist through the settings API and page reload', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  await mockHermesApi(page)
  await mockChatSocket(page)
  let config = structuredClone(DEFAULT_EKKO_CONFIG)
  const saves: unknown[] = []
  await page.route('**/api/ekko/config', async route => {
    if (route.request().method() === 'PUT') {
      config = route.request().postDataJSON().config
      saves.push(config.tools.computerUse)
    }
    await route.fulfill({ json: { ok: true, schemaVersion: 15, configPath: '/fixture/ekko.json', config, providers: [] } })
  })
  await page.goto('/#/ekko/settings?tab=tools')
  const toggle = page.getByTestId('computer-use-enabled')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect.poll(() => config.tools.computerUse.enabled).toBe(false)
  const timeout = page.getByTestId('computer-use-timeout').locator('input')
  await timeout.fill('20000')
  await timeout.blur()
  await expect.poll(() => config.tools.computerUse.timeoutMs).toBe(20000)
  await page.reload()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect(timeout).toHaveValue('20000')
  expect(saves.length).toBeGreaterThanOrEqual(2)
})
