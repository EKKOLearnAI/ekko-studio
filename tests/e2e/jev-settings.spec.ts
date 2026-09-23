import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import en from '../../packages/client/src/i18n/locales/en'
import zh from '../../packages/client/src/i18n/locales/zh'

const memoryDefaults = { ekkoMemoryKindRoutingEnabled: false, ekkoMemoryRerankEnabled: false, ekkoMemoryWriteReviewEnabled: false,
  ekkoMemoryCandidateLimit: 20, ekkoMemoryMinConfidence: 0.8, ekkoMemoryTimeoutMs: 3000 }

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
        await route.fulfill({ json: { ...memoryDefaults, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10000, hasApiKey: true, ekkoMemoryEnabled: false } })
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
    await expect(panel.getByRole('switch', { name: messages.jev.ekkoMemoryEnabled, exact: true })).not.toBeChecked()
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

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
test(`configures JEV memory per Profile at ${viewport.width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize(viewport)
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const api = await mockHermesApi(page, { initialProfileName: 'default' })
  const defaults = { ...memoryDefaults, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10000, hasApiKey: false, ekkoMemoryEnabled: false }
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
      const { apiKey, ...values } = body
      settings[profile] = { ...values, hasApiKey: !!apiKey || settings[profile].hasApiKey }
    }
    if (method === 'DELETE') settings[profile] = { ...defaults }
    await route.fulfill({ json: settings[profile] })
  })

  await page.goto('/#/hermes/models?tab=jev&modelProfile=research')
  await expect(page.locator('.n-tabs-tab--active')).toHaveText('JEV')
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-latest')
  const memorySwitch = page.getByRole('switch', { name: en.jev.ekkoMemoryEnabled, exact: true })
  await expect(memorySwitch).not.toBeChecked()
  await memorySwitch.click()
  for (const label of [en.jev.memoryKindRouting, en.jev.memoryRerank, en.jev.memoryWriteReview]) {
    const control = page.getByRole('switch', { name: label, exact: true })
    await expect(control).not.toBeChecked()
    await control.click()
  }
  await page.locator('summary').filter({ hasText: en.jev.memoryAdvanced }).click()
  await page.getByLabel(en.jev.memoryCandidateLimit, { exact: true }).fill('7')
  await page.getByLabel(en.jev.memoryMinConfidence, { exact: true }).fill('0.9')
  await page.getByLabel(en.jev.memoryTimeout, { exact: true }).fill('1200')
  await page.getByLabel('JEV API Key', { exact: true }).fill('new-research-key')
  await page.getByLabel('JEV Model', { exact: true }).fill('jev-research')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByLabel('JEV API Key', { exact: true })).toHaveValue('')
  expect(requests.find(r => r.method === 'PUT')).toMatchObject({ profile: 'research', body: { apiKey: 'new-research-key', model: 'jev-research', ekkoMemoryEnabled: true, ekkoMemoryKindRoutingEnabled: true, ekkoMemoryRerankEnabled: true, ekkoMemoryWriteReviewEnabled: true, ekkoMemoryCandidateLimit: 7, ekkoMemoryMinConfidence: 0.9, ekkoMemoryTimeoutMs: 1200 } })
  await expect(memorySwitch).toBeChecked()
  await expect(page.locator('.jev-settings')).toContainText(en.jev.memoryReady)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('jev-memory-settings.png'), fullPage: true })

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => requests.filter(r => r.method === 'PUT').length).toBe(2)
  expect(requests.filter(r => r.method === 'PUT')[1].body).not.toHaveProperty('apiKey')
  await page.getByRole('button', { name: 'Test saved configuration', exact: true }).click()
  await expect(page.getByTestId('jev-test-result')).toContainText('jev-research')

  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^default$/ }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-default')
  await expect(memorySwitch).not.toBeChecked()
  await expect(page.getByTestId('jev-test-result')).toHaveCount(0)
  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^research$/ }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-research')
  await expect(memorySwitch).toBeChecked()
  for (const label of [en.jev.memoryKindRouting, en.jev.memoryRerank, en.jev.memoryWriteReview]) {
    await expect(page.getByRole('switch', { name: label, exact: true })).toBeChecked()
  }
  await page.locator('summary').filter({ hasText: en.jev.memoryAdvanced }).click()
  await expect(page.getByLabel(en.jev.memoryCandidateLimit, { exact: true })).toHaveValue('7')
  await expect(page.getByLabel(en.jev.memoryMinConfidence, { exact: true })).toHaveValue('0.9')
  await expect(page.getByLabel(en.jev.memoryTimeout, { exact: true })).toHaveValue('1200')
  await memorySwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => settings.research.ekkoMemoryEnabled).toBe(false)
  await page.reload()
  await expect(memorySwitch).not.toBeChecked()
  expect(settings.research.ekkoMemoryWriteReviewEnabled).toBe(true)
  expect(settings.research.ekkoMemoryCandidateLimit).toBe(7)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-latest')
  await expect(memorySwitch).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Test saved configuration', exact: true })).toBeDisabled()
  expect(settings.default.model).toBe('jev-default')
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  expect(api.requests.filter(r => r.pathname.includes('/profiles/') && r.method !== 'GET')).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})
}
