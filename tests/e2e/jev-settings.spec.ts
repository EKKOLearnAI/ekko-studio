import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import en from '../../packages/client/src/i18n/locales/en'
import zh from '../../packages/client/src/i18n/locales/zh'

for (const [locale, messages] of [['en', en], ['zh', zh]] as const) {
  test(`localizes JEV fields, failures and connection feedback in ${locale}`, async ({ page }, testInfo) => {
    await authenticate(page, TEST_ACCESS_KEY, 'default')
    await page.addInitScript(value => localStorage.setItem('hermes_locale', value), locale)
    await mockHermesApi(page, { initialProfileName: 'default' })
    let loadFailed = true
    let testFailure: 'auth_failed' | 'timeout' | 'network' | null = 'auth_failed'
    await page.route('**/api/studio/jev/settings', async route => {
      if (loadFailed) {
        await route.fulfill({ status: 500, json: { error: 'Internal storage failure', code: 'jev_settings_failed' } })
      } else if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 400, json: { error: 'Invalid JEV model', code: 'jev_invalid_request' } })
      } else {
        await route.fulfill({ json: { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10000, hasApiKey: true } })
      }
    })
    await page.route('**/api/studio/jev/test', async route => {
      if (testFailure === 'network') { await route.abort(); return }
      if (testFailure) {
        await route.fulfill({ status: testFailure === 'timeout' ? 504 : 502, json: { error: 'Upstream English diagnostic', code: `jev_${testFailure}` } })
      } else {
        await route.fulfill({ json: { model: 'jev-test', durationMs: 2500, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } } })
      }
    })
    await page.goto('/#/hermes/models?tab=jev&modelProfile=default')
    const panel = page.locator('.jev-settings')
    await expect(panel).toContainText(messages.jev.errors.settings_failed)
    await expect(panel).not.toContainText('Internal storage failure')
    loadFailed = false
    await panel.getByRole('button', { name: messages.common.retry, exact: true }).click()
    await expect(panel.getByLabel(`JEV ${messages.jev.baseUrl}`, { exact: true })).toHaveValue('https://api.typesafe.ai')
    await expect(panel.getByLabel(`JEV ${messages.jev.apiKey}`, { exact: true })).toHaveAttribute('placeholder', messages.jev.keyHint)
    await expect(panel.getByLabel(`JEV ${messages.jev.timeout}`, { exact: true })).toHaveValue('10000')
    await panel.getByRole('button', { name: messages.common.save, exact: true }).click()
    await expect(panel).toContainText(messages.jev.errors.invalid_request)
    const testButton = panel.getByRole('button', { name: messages.jev.testSaved, exact: true })
    await testButton.click()
    await expect(panel).toContainText(messages.jev.errors.auth_failed)
    await expect(panel).not.toContainText('Upstream English diagnostic')
    testFailure = 'timeout'
    await testButton.click()
    await expect(panel).toContainText(messages.jev.errors.timeout)
    testFailure = 'network'
    await testButton.click()
    await expect(panel).toContainText(messages.jev.errors.unavailable)
    testFailure = null
    await testButton.click()
    await expect(page.getByTestId('jev-test-result')).toHaveText(messages.jev.testSuccess.replace('{model}', 'jev-test').replace('{duration}', '2,500'))
    await expect(panel.locator('pre')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('jev-i18n.png') })
  })
}

test('configures and tests JEV per page Profile without switching the global Profile', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const api = await mockHermesApi(page, { initialProfileName: 'default' })
  const defaults = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10000, hasApiKey: false }
  const settings: Record<string, typeof defaults> = {
    default: { ...defaults, model: 'jev-default', hasApiKey: true }, research: { ...defaults },
  }
  const requests: Array<{ method: string; profile: string; body: any }> = []
  await page.route('**/api/studio/jev/**', async route => {
    const request = route.request()
    const profile = request.headers()['x-hermes-profile']
    const method = request.method()
    const body = request.postData() ? request.postDataJSON() : undefined
    requests.push({ method, profile, body })
    if (request.url().endsWith('/test')) {
      await route.fulfill({ json: { model: settings[profile].model, durationMs: 8, answers: { working: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } } })
      return
    }
    if (method === 'PUT') {
      settings[profile] = { baseUrl: body.baseUrl, model: body.model, timeoutMs: body.timeoutMs, hasApiKey: !!body.apiKey || settings[profile].hasApiKey }
    }
    if (method === 'DELETE') settings[profile] = { ...defaults }
    await route.fulfill({ json: settings[profile] })
  })

  await page.goto('/#/hermes/models?tab=jev&modelProfile=research')
  await expect(page.locator('.n-tabs-tab--active')).toHaveText('JEV')
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-latest')
  await page.getByLabel('JEV API Key', { exact: true }).fill('new-research-key')
  await page.getByLabel('JEV Model', { exact: true }).fill('jev-research')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByLabel('JEV API Key', { exact: true })).toHaveValue('')
  expect(requests.find(r => r.method === 'PUT')).toMatchObject({ profile: 'research', body: { apiKey: 'new-research-key', model: 'jev-research' } })

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => requests.filter(r => r.method === 'PUT').length).toBe(2)
  expect(requests.filter(r => r.method === 'PUT')[1].body).not.toHaveProperty('apiKey')
  await page.getByRole('button', { name: 'Test saved configuration', exact: true }).click()
  await expect(page.getByTestId('jev-test-result')).toContainText('jev-research')

  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^default$/ }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-default')
  await expect(page.getByTestId('jev-test-result')).toHaveCount(0)
  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^research$/ }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-research')
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-latest')
  await expect(page.getByRole('button', { name: 'Test saved configuration', exact: true })).toBeDisabled()
  expect(settings.default.model).toBe('jev-default')
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  expect(api.requests.filter(r => r.pathname.includes('/profiles/') && r.method !== 'GET')).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})
