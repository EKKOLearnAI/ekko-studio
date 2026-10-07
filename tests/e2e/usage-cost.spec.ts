import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('shows unknown, partial and free costs and saves explicit model pricing', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  let coverage = { reported: 0, estimated: 0, unknown: 1 }
  let cost = 0
  const date = new Date().toISOString().slice(0, 10)
  await page.route('**/api/studio/usage/stats?*', route => route.fulfill({ json: {
    total_input_tokens: 10, total_output_tokens: 2, total_cache_read_tokens: 0, total_cache_write_tokens: 0, total_reasoning_tokens: 0,
    total_sessions: 1, total_cost: cost, cost_coverage: coverage, model_usage: [], agent_usage: [],
    daily_usage: [{ date, input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, sessions: 1, errors: 0, cost, cost_coverage: coverage }],
  } }))
  let saved: any
  await page.route('**/api/studio/usage/pricing', async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON()
    await route.fulfill({ json: saved || { rates: [] } })
  })
  await page.goto('/#/hermes/usage')
  const card = page.locator('.stat-card').filter({ hasText: 'Cost (USD)' })
  await expect(card.getByText('Not recorded', { exact: true })).toBeVisible()
  await expect(page.locator('tbody').getByText('Not recorded')).toBeVisible()
  coverage = { reported: 1, estimated: 0, unknown: 1 }; cost = 0.25
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(card.getByText('$0.25', { exact: true })).toBeVisible()
  await expect(card.getByText('Partial cost; some usage is unpriced')).toBeVisible()
  coverage = { reported: 1, estimated: 0, unknown: 0 }; cost = 0
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(card.getByText('$0.00', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Model pricing', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Model ID', exact: true }).fill('unlisted-model')
  await dialog.getByRole('textbox', { name: 'Model ID', exact: true }).press('Enter')
  await dialog.getByRole('textbox', { name: 'Input', exact: true }).fill('2')
  await dialog.getByRole('textbox', { name: 'Output', exact: true }).fill('8')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(saved).toEqual({ rates: [{ provider: 'global', model: 'unlisted-model', input: 2, output: 8 }] })
})

for (const width of [1280, 390]) {
  test(`selects configured providers and their models for pricing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const groups = [
      { provider: 'custom:relay', label: 'My Relay', models: ['added-model', 'shared-model'], available_models: ['added-model', 'shared-model', 'hidden-model'], base_url: '', api_key: '' },
      { provider: 'custom:other', label: 'Other Relay', models: ['other-model'], base_url: '', api_key: '' },
    ]
    await mockHermesApi(page, { initialProfileName: 'research', modelGroups: groups })
    await page.route('**/api/studio/usage/stats?*', route => route.fulfill({ json: {
      total_input_tokens: 0, total_output_tokens: 0, total_sessions: 0, total_cost: 0,
      model_usage: [], agent_usage: [], daily_usage: [],
    } }))
    let saved: any
    await page.route('**/api/studio/usage/pricing', async route => {
      if (route.request().method() === 'PUT') saved = route.request().postDataJSON()
      await route.fulfill({ json: saved || { rates: [] } })
    })
    await page.goto('/#/hermes/usage')
    const catalogRequest = page.waitForRequest(request => request.url().includes('/api/hermes/available-models?profile=research'))
    await page.getByRole('button', { name: 'Model pricing', exact: true }).click()
    await catalogRequest
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    const provider = dialog.locator('.n-select').nth(0)
    const model = dialog.locator('.n-select').nth(1)
    await provider.click()
    await page.locator('.n-base-select-option').filter({ hasText: /^My Relay$/ }).click()
    await model.click()
    await expect(page.locator('.n-base-select-option').filter({ hasText: /^other-model$/ })).toHaveCount(0)
    await page.locator('.n-base-select-option').filter({ hasText: /^added-model$/ }).click()
    await provider.click()
    await page.locator('.n-base-select-option').filter({ hasText: /^Other Relay$/ }).click()
    await expect(dialog.getByText('added-model', { exact: true })).toHaveCount(0)
    await model.click()
    await page.locator('.n-base-select-option').filter({ hasText: /^other-model$/ }).click()
    await dialog.getByRole('textbox', { name: 'Input', exact: true }).fill('2')
    await dialog.getByRole('textbox', { name: 'Output', exact: true }).fill('8')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(saved).toEqual({ rates: [{ provider: 'custom:other', model: 'other-model', input: 2, output: 8 }] })
    await page.getByRole('button', { name: 'Model pricing', exact: true }).click()
    await expect(dialog.getByText('Other Relay', { exact: true })).toBeVisible()
    await expect(dialog.getByText('other-model', { exact: true })).toBeVisible()
  })
}

test('shows translated pricing help and catalog errors in Chinese', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await mockHermesApi(page)
  await page.route('**/api/studio/usage/stats?*', route => route.fulfill({ json: {
    total_input_tokens: 0, total_output_tokens: 0, total_sessions: 0, total_cost: 0,
    model_usage: [], agent_usage: [], daily_usage: [],
  } }))
  await page.route('**/api/studio/usage/pricing', route => route.fulfill({ json: { rates: [] } }))
  await page.goto('/#/hermes/usage')
  await page.getByRole('button', { name: '模型单价', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.pricing-help')).toContainText('可选择已配置的供应商及其模型，也可输入 ID 后按回车。')
  await expect(dialog.getByText('无法加载已配置的供应商和模型，仍可手动输入 ID。', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  // Fail only after startup has loaded providers, so the unrelated setup prompt stays closed.
  await page.route('**/api/hermes/available-models?*', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.getByRole('button', { name: '模型单价', exact: true }).click()
  await expect(dialog.locator('.pricing-help')).toContainText('可选择已配置的供应商及其模型，也可输入 ID 后按回车。')
  await expect(dialog.getByText('无法加载已配置的供应商和模型，仍可手动输入 ID。', { exact: true })).toBeVisible()
  await expect(dialog).not.toContainText('usage.pricing.')
})
