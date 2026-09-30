import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi } from './fixtures'

test('gateway auto-start defaults to off and preserves explicit opt-in after reload', async ({ page }) => {
  await authenticate(page)
  const api = await mockHermesApi(page)
  let gatewayAutoStart: { enabled?: boolean } = {}
  const saved: unknown[] = []
  await page.route(/\/api\/hermes\/config(?:\?.*)?$/, async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON()
      saved.push(body)
      gatewayAutoStart = { ...gatewayAutoStart, ...body.values }
      await route.fulfill({ json: { success: true, gatewayAutoStart } })
    } else {
      await route.fulfill({ json: { gatewayAutoStart } })
    }
  })

  await page.goto('/#/hermes/config/settings')
  const toggle = page.locator('.gateway-auto-start-settings').getByRole('switch').first()
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect.poll(() => saved).toEqual([{ section: 'gatewayAutoStart', values: { enabled: true }, restart: false }])
  await expect(toggle).toBeChecked()

  await page.reload()
  await expect(toggle).toBeChecked()
  expect(api.unexpectedRequests).toEqual([])
})
