import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('saves per-device push preferences and preserves the value when saving fails', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  const connections = ['iPhone', 'Android', 'Other phone'].map((name, index) => ({
    id: index + 1, device_code: `device-${index}`, device_name: name,
    device_brand: '', device_model: '', connection_type: 'lan',
    user_id: index === 2 ? 2 : 1, cloud_user_id: 0, username: 'playwright',
    token_expires_at: 4102444800, last_connected_at: 1780000000,
    created_at: 1780000000, updated_at: 1780000000,
    active: true, online: true, push_enabled: true, can_manage_push: index !== 2,
  }))
  let failSave = false
  const changes: unknown[] = []
  await page.route('**/api/app-connections', route => route.fulfill({
    json: { connections, access_failure: null },
  }))
  await page.route('**/api/studio/app-connections/*/push', async route => {
    expect(route.request().method()).toBe('PATCH')
    const body = route.request().postDataJSON()
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-2))
    changes.push({ id, ...body })
    if (failSave) {
      await route.fulfill({ status: 500, json: { error: 'Could not save preference' } })
      return
    }
    connections.find(row => row.id === id)!.push_enabled = body.push_enabled
    await route.fulfill({ json: { success: true, push_enabled: body.push_enabled } })
  })
  await page.goto('/#/hermes/connections?view=list')
  const iphone = page.getByRole('switch', { name: 'Push notifications for iPhone', exact: true })
  const android = page.getByRole('switch', { name: 'Push notifications for Android', exact: true })
  await expect(iphone).toBeChecked()
  await expect(android).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Push notifications for Other phone', exact: true })).toBeDisabled()
  await iphone.click()
  await expect(iphone).not.toBeChecked()
  await expect(android).toBeChecked()
  await page.reload()
  await expect(iphone).not.toBeChecked()
  await expect(android).toBeChecked()
  failSave = true
  await iphone.click()
  await expect(page.getByText(/Could not save preference/)).toBeVisible()
  await expect(iphone).not.toBeChecked()
  failSave = false
  await iphone.click()
  await expect(iphone).toBeChecked()
  expect(changes).toEqual([
    { id: 1, push_enabled: false }, { id: 1, push_enabled: true }, { id: 1, push_enabled: true },
  ])
})
