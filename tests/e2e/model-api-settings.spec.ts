import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const secret = `sk-ekko-${'A'.repeat(43)}`
async function mockModelApi(page: Page) {
  let keys: any[] = []
  let state: 'ready' | 'empty' | 'error' = 'ready'
  const writes: { method: string; profile: string | undefined; body: any }[] = []
  await page.route('**/api/studio/models/api-keys**', async route => {
    const request = route.request()
    if (request.method() === 'POST') {
      writes.push({ method: 'POST', profile: request.headers()['x-hermes-profile'], body: request.postDataJSON() })
      const key = { id: `key-${keys.length}`, name: request.postDataJSON().name, preview: 'sk-ekko-…AAAA', createdAt: Date.now(), lastUsedAt: null }
      keys.unshift(key)
      return route.fulfill({ status: 201, json: { key, apiKey: secret } })
    }
    if (request.method() === 'DELETE') {
      writes.push({ method: 'DELETE', profile: request.headers()['x-hermes-profile'], body: null })
      keys = keys.filter(key => !request.url().endsWith(`/${key.id}`))
      return route.fulfill({ json: { success: true } })
    }
    return route.fulfill({ json: { keys } })
  })
  await page.route('**/api/ekko-studio/models/v1/models', route => state === 'error'
    ? route.fulfill({ status: 502, json: { error: { message: 'Catalog unavailable' } } })
    : route.fulfill({ json: { object: 'list', data: state === 'empty' ? [] : [
      { id: 'glm/glm-5.3', owned_by: 'glm', api_mode: 'chat_completions', responses_supported: true },
      { id: 'deepseek/deepseek-reasoner', owned_by: 'deepseek', api_mode: 'chat_completions', responses_supported: true },
      { id: 'bedrock/claude', owned_by: 'bedrock', api_mode: 'bedrock_converse', responses_supported: false },
    ] } }))
  return { writes, setState: (next: typeof state) => { state = next } }
}

for (const width of [390, 1280]) {
  test(`creates, copies and revokes an account key without Profile selection at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page)
    const api = await mockModelApi(page)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => { (window as any).copiedText = value } } })
    })
    await page.goto('/#/hermes/models?tab=api&modelProfile=research')
    const panel = page.getByTestId('model-api-panel')
    await expect(panel).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('models-profile-select')).toHaveCount(0)
    await expect(page.getByLabel('Base URL', { exact: true })).toHaveValue(/\/api\/ekko-studio\/models\/v1$/)
    await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Create key', exact: true })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Key name', exact: true }).fill('My coding client')
    await page.getByRole('button', { name: 'Create key', exact: true }).click()
    const modal = page.getByRole('dialog')
    await expect(modal.getByText('Copy and save this key now. The full key will not be shown again.')).toBeVisible()
    await expect(modal.locator('input[type="password"]')).toHaveValue(secret)
    await modal.getByRole('button', { name: 'Copy', exact: true }).click()
    expect(await page.evaluate(() => (window as any).copiedText)).toBe(secret)
    await modal.getByRole('button', { name: 'I saved the key', exact: true }).click()
    await expect(modal).toHaveCount(0)
    expect(api.writes[0]).toEqual({ method: 'POST', profile: '', body: { name: 'My coding client' } })
    expect(await page.evaluate(value => JSON.stringify(localStorage).includes(value), secret)).toBe(false)
    await expect(page.locator('.key-list')).toContainText('My coding client')
    await page.screenshot({ path: info.outputPath(`model-api-${width}.png`), fullPage: true, animations: 'disabled' })

    await page.reload()
    await expect(panel).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.key-list')).toContainText('sk-ekko-…AAAA')
    await page.locator('.n-tabs-tab').filter({ hasText: /^General Models$/ }).click()
    await page.getByTestId('models-profile-select').click()
    await page.locator('.n-base-select-option').filter({ hasText: /^default$/ }).click()
    await expect(page).toHaveURL(/modelProfile=default/)
    await page.locator('.n-tabs-tab').filter({ hasText: /^Model API$/ }).click()
    await expect(page.getByTestId('models-profile-select')).toHaveCount(0)
    await expect(page.locator('.key-list')).toContainText('My coding client')
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    await page.locator('.n-popconfirm__action').getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(page.getByText('No API keys yet', { exact: true })).toBeVisible()
    expect(api.writes.at(-1)?.method).toBe('DELETE')
    expect(api.writes.at(-1)?.profile).toBe('')

    await page.getByLabel('Select a model', { exact: true }).click()
    await expect(page.locator('.n-base-select-option--disabled')).toContainText('bedrock/claude')
    await page.locator('.n-base-select-option').filter({ hasText: /^deepseek\/deepseek-reasoner$/ }).click()
    await expect(page.locator('.request-example')).toContainText('model="deepseek/deepseek-reasoner"')
    await expect(page.locator('.request-example')).not.toContainText(secret)
    await page.locator('.request-example').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`model-api-example-${width}.png`), fullPage: true, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const usageRequest = page.waitForRequest(request => request.url().includes('/api/studio/usage/stats?'))
    await page.getByRole('button', { name: 'View external usage', exact: true }).click()
    expect(new URL((await usageRequest).url()).searchParams.get('origin')).toBe('external')
    await expect(page.locator('[data-usage-origin="external"]')).toHaveAttribute('aria-pressed', 'true')
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  })
}

test('recovers from a failed catalog load and renders the empty model state', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  const api = await mockModelApi(page)
  api.setState('error')
  await page.goto('/#/hermes/models?tab=api')
  await expect(page.getByRole('alert').filter({ hasText: 'Catalog unavailable' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Key name', exact: true }).fill('Still manageable')
  await expect(page.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled()
  api.setState('empty')
  await page.getByTestId('model-api-panel').getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Configure a provider and models in the General tab first.', { exact: true })).toBeVisible()
  await expect(page.locator('.request-example')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Create key', exact: true })).toBeEnabled()
})

for (const brightness of ['light', 'dark']) {
  test(`model API cards inherit theme surfaces in ${brightness} mode`, async ({ page }, info) => {
    await authenticate(page)
    await mockHermesApi(page, { theme: {
      brightness,
      background: { name: 'wall.png', mime: 'image/png', updatedAt: 1 },
      appearance: { global: { opacity: 0.4 }, regions: { card: { backgroundColor: '#6286a8', opacity: 0, blur: 12, radius: 18, borderColor: '#abcdea' } } },
    } })
    await mockModelApi(page)
    await page.goto('/#/hermes/models?tab=api')
    const card = page.locator('.api-card').first()
    await expect(card).toHaveCSS('background-color', 'rgba(98, 134, 168, 0)')
    await expect(card).toHaveCSS('border-radius', '18px')
    await expect(card).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    await expect(card).toHaveCSS('opacity', '1')
    await expect(page.getByLabel('Base URL', { exact: true })).toBeVisible()
    await page.screenshot({ path: info.outputPath(`model-api-${brightness}-wallpaper.png`), fullPage: true, animations: 'disabled' })
    // Reload with preset inheritance restored and wallpaper removed.
    await page.route('**/api/theme', route => route.fulfill({ json: { fontSize: 14, brightness, background: null, appearance: { global: {}, regions: {} } } }))
    await page.reload()
    await expect(card).not.toHaveCSS('background-color', 'rgba(98, 134, 168, 0)')
    await expect(page.locator('.models-view')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByTestId('model-api-panel')).toHaveAttribute('aria-busy', 'false')
    await expect(card).toBeVisible()
    await page.screenshot({ path: info.outputPath(`model-api-${brightness}-preset.png`), fullPage: true, animations: 'disabled' })
  })
}
