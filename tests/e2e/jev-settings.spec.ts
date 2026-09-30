import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import en from '../../packages/client/src/i18n/locales/en'
import zh from '../../packages/client/src/i18n/locales/zh'

const collaborationDefaults = {
  groupSummaryReviewEnabled: false, groupSummaryReviewMinConfidence: .8, groupSummaryRevisionEnabled: false, groupSummaryReviewTimeoutMs: 3000,
  workflowQualityEnabled: false, workflowQualityMinConfidence: .8, workflowQualityTimeoutMs: 5000,
  groupMessageRoutingEnabled: false, groupHandoffReviewEnabled: true, groupLoopDetectionEnabled: true,
  groupMessageRoutingMinConfidence: .9, groupMessageRoutingMode: 'suggest', groupMessageRoutingTimeoutMs: 1500,
}

const browserDefaults = { browserMatchEnabled: false, browserMatchCandidateLimit: 20, browserMatchMinConfidence: 0.8,
  browserMatchTimeoutMs: 3000, browserVerifyEnabled: false, browserVerifyMinConfidence: 0.8, browserVerifyTimeoutMs: 3000 }
const browserOptions = { browserMatchEnabled: true, browserMatchCandidateLimit: 12, browserMatchMinConfidence: 0.9,
  browserMatchTimeoutMs: 1100, browserVerifyEnabled: true, browserVerifyMinConfidence: 0.95, browserVerifyTimeoutMs: 1400 }
const memoryDefaults = { ...collaborationDefaults, ...browserDefaults, ekkoSkillsEnabled: false, ekkoSkillsCandidateLimit: 20, ekkoSkillsMinConfidence: 0.8, ekkoSkillsTimeoutMs: 3000, ekkoMemoryKindRoutingEnabled: true, ekkoMemoryRelevanceFilterEnabled: true, ekkoMemoryRerankEnabled: true, ekkoMemoryWriteReviewEnabled: true,
  ekkoMemoryCandidateLimit: 20, ekkoMemoryRecallMinConfidence: 0.5, ekkoMemoryFilterMinConfidence: 0.8, ekkoMemoryMinConfidence: 0.8, ekkoMemoryTimeoutMs: 3000 }

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
test(`configures JEV memory, skills and browser per Profile at ${viewport.width}px`, async ({ page }, testInfo) => {
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
  const skillsSwitch = page.getByRole('switch', { name: en.jev.ekkoSkillsEnabled, exact: true })
  await expect(skillsSwitch).not.toBeChecked()
  await skillsSwitch.click()
  await page.getByLabel(en.jev.skillsCandidateLimit, { exact: true }).fill('12')
  await page.getByLabel(en.jev.skillsMinConfidence, { exact: true }).fill('0.9')
  await page.getByLabel(en.jev.skillsTimeout, { exact: true }).fill('1500')
  await expect(page.locator('.jev-settings')).toContainText(en.common.notConfigured)
  for (const label of [en.jev.memoryKindRouting, en.jev.memoryRelevanceFilter, en.jev.memoryRerank, en.jev.memoryWriteReview]) {
    const control = page.getByRole('switch', { name: label, exact: true })
    await expect(control).toBeChecked()
  }
  await page.locator('summary').filter({ hasText: en.jev.memoryAdvanced }).click()
  await page.getByLabel(en.jev.memoryCandidateLimit, { exact: true }).fill('7')
  await expect(page.getByLabel(en.jev.memoryRecallMinConfidence, { exact: true })).toHaveValue('0.5')
  await page.getByLabel(en.jev.memoryRecallMinConfidence, { exact: true }).fill('0.65')
  await expect(page.getByLabel(en.jev.memoryFilterMinConfidence, { exact: true })).toHaveValue('0.8')
  await page.getByLabel(en.jev.memoryFilterMinConfidence, { exact: true }).fill('0.85')
  await page.getByLabel(en.jev.memoryMinConfidence, { exact: true }).fill('0.9')
  await page.getByLabel(en.jev.memoryTimeout, { exact: true }).fill('1200')
  const matchSwitch = page.getByRole('switch', { name: en.jev.browserMatchEnabled, exact: true })
  const verifySwitch = page.getByRole('switch', { name: en.jev.browserVerifyEnabled, exact: true })
  await expect(matchSwitch).not.toBeChecked()
  await expect(verifySwitch).not.toBeChecked()
  await matchSwitch.click()
  await verifySwitch.click()
  for (const key of ['browserMatchCandidateLimit', 'browserMatchMinConfidence', 'browserMatchTimeoutMs', 'browserVerifyMinConfidence', 'browserVerifyTimeoutMs'] as const) {
    await page.getByLabel(en.jev[key], { exact: true }).fill(String(browserOptions[key]))
  }
  await page.getByLabel('JEV API Key', { exact: true }).fill('new-research-key')
  await page.getByLabel('JEV Model', { exact: true }).fill('jev-research')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByLabel('JEV API Key', { exact: true })).toHaveValue('')
  expect(requests.find(r => r.method === 'PUT')).toMatchObject({ profile: 'research', body: { ...browserOptions, ekkoSkillsEnabled: true, ekkoSkillsCandidateLimit: 12, ekkoSkillsMinConfidence: 0.9, ekkoSkillsTimeoutMs: 1500, apiKey: 'new-research-key', model: 'jev-research', ekkoMemoryEnabled: true, ekkoMemoryKindRoutingEnabled: true, ekkoMemoryRelevanceFilterEnabled: true, ekkoMemoryRerankEnabled: true, ekkoMemoryWriteReviewEnabled: true, ekkoMemoryCandidateLimit: 7, ekkoMemoryRecallMinConfidence: 0.65, ekkoMemoryFilterMinConfidence: 0.85, ekkoMemoryMinConfidence: 0.9, ekkoMemoryTimeoutMs: 1200 } })
  await expect(memorySwitch).toBeChecked()
  await expect(skillsSwitch).toBeChecked()
  await expect(page.locator('.jev-settings')).toContainText(en.jev.skillsReady)
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
  await expect(skillsSwitch).not.toBeChecked()
  await expect(matchSwitch).not.toBeChecked()
  await expect(verifySwitch).not.toBeChecked()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-default')
  await expect(memorySwitch).not.toBeChecked()
  await expect(page.getByTestId('jev-test-result')).toHaveCount(0)
  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^research$/ }).click()
  await expect(skillsSwitch).toBeChecked()
  await expect(matchSwitch).toBeChecked()
  await expect(verifySwitch).toBeChecked()
  for (const key of ['browserMatchCandidateLimit', 'browserMatchMinConfidence', 'browserMatchTimeoutMs', 'browserVerifyMinConfidence', 'browserVerifyTimeoutMs'] as const) {
    await expect(page.getByLabel(en.jev[key], { exact: true })).toHaveValue(String(browserOptions[key]))
  }
  await expect(page.getByLabel(en.jev.skillsCandidateLimit, { exact: true })).toHaveValue('12')
  await expect(page.getByLabel(en.jev.skillsMinConfidence, { exact: true })).toHaveValue('0.9')
  await expect(page.getByLabel(en.jev.skillsTimeout, { exact: true })).toHaveValue('1500')
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-research')
  await expect(memorySwitch).toBeChecked()
  for (const label of [en.jev.memoryKindRouting, en.jev.memoryRelevanceFilter, en.jev.memoryRerank, en.jev.memoryWriteReview]) {
    await expect(page.getByRole('switch', { name: label, exact: true })).toBeChecked()
  }
  await page.locator('summary').filter({ hasText: en.jev.memoryAdvanced }).click()
  await expect(page.getByLabel(en.jev.memoryCandidateLimit, { exact: true })).toHaveValue('7')
  await expect(page.getByLabel(en.jev.memoryRecallMinConfidence, { exact: true })).toHaveValue('0.65')
  await expect(page.getByLabel(en.jev.memoryFilterMinConfidence, { exact: true })).toHaveValue('0.85')
  await expect(page.getByLabel(en.jev.memoryMinConfidence, { exact: true })).toHaveValue('0.9')
  await expect(page.getByLabel(en.jev.memoryTimeout, { exact: true })).toHaveValue('1200')
  await page.getByRole('switch', { name: en.jev.memoryRelevanceFilter, exact: true }).click()
  await memorySwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => settings.research.ekkoMemoryEnabled).toBe(false)
  await skillsSwitch.click()
  await matchSwitch.click()
  await verifySwitch.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => settings.research.ekkoSkillsEnabled).toBe(false)
  await page.reload()
  await expect(matchSwitch).not.toBeChecked()
  await expect(verifySwitch).not.toBeChecked()
  expect(settings.research.browserMatchCandidateLimit).toBe(12)
  expect(settings.research.browserVerifyMinConfidence).toBe(0.95)
  await expect(memorySwitch).not.toBeChecked()
  await expect(skillsSwitch).not.toBeChecked()
  expect(settings.research.ekkoSkillsCandidateLimit).toBe(12)
  expect(settings.research.ekkoMemoryRelevanceFilterEnabled).toBe(false)
  expect(settings.research.ekkoMemoryWriteReviewEnabled).toBe(true)
  expect(settings.research.ekkoMemoryCandidateLimit).toBe(7)
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.getByLabel('JEV Model', { exact: true })).toHaveValue('jev-latest')
  await expect(memorySwitch).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Test saved configuration', exact: true })).toBeDisabled()
  expect(settings.research.ekkoSkillsEnabled).toBe(false)
  expect(settings.research).toMatchObject(browserDefaults)
  expect(settings.research.ekkoSkillsCandidateLimit).toBe(20)
  expect(settings.default.model).toBe('jev-default')
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  expect(api.requests.filter(r => r.pathname.includes('/profiles/') && r.method !== 'GET')).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})
}

for (const [locale, messages] of [['en', en], ['zh', zh]] as const) {
for (const width of [1280, 390]) {
  test(`saves group and workflow JEV settings per Profile in ${locale} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await authenticate(page, TEST_ACCESS_KEY, 'default')
    await page.addInitScript(value => localStorage.setItem('hermes_locale', value), locale)
    await mockHermesApi(page, { initialProfileName: 'default' })
    const defaults = { ...memoryDefaults, baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', timeoutMs: 10000, hasApiKey: false, ekkoMemoryEnabled: false }
    const settings: Record<string, typeof defaults> = { default: { ...defaults }, research: { ...defaults } }
    const saves: Array<{ profile: string; body: any }> = []
    await page.route('**/api/studio/jev/settings', async route => {
      const profile = route.request().headers()['x-hermes-profile']
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        saves.push({ profile, body })
        settings[profile] = { ...settings[profile], ...body }
      }
      await route.fulfill({ json: settings[profile] })
    })
    await page.goto('/#/hermes/models?tab=jev&modelProfile=research')
    const switches = ['groupSummaryReviewEnabled', 'groupSummaryRevisionEnabled', 'workflowQualityEnabled',
      'groupMessageRoutingEnabled', 'groupHandoffReviewEnabled', 'groupLoopDetectionEnabled'] as const
    const numbers = [
      ['groupSummaryReviewMinConfidence', 'groupSummaryReviewMinConfidence', .9],
      ['groupSummaryReviewTimeoutMs', 'groupSummaryReviewTimeout', 1200],
      ['workflowQualityMinConfidence', 'workflowQualityMinConfidence', .95],
      ['workflowQualityTimeoutMs', 'workflowQualityTimeout', 1400],
      ['groupMessageRoutingMinConfidence', 'groupMessageRoutingMinConfidence', .85],
      ['groupMessageRoutingTimeoutMs', 'groupMessageRoutingTimeout', 1600],
    ] as const
    const expected = { ...collaborationDefaults, groupMessageRoutingMode: 'auto' }
    for (const key of switches) {
      const control = page.getByRole('switch', { name: messages.jev[key], exact: true })
      await expect(control).toBeChecked({ checked: collaborationDefaults[key] })
      await control.click()
      expected[key] = !collaborationDefaults[key]
    }
    for (const [key, label, value] of numbers) {
      await page.getByLabel(messages.jev[label], { exact: true }).fill(String(value))
      expected[key] = value
    }
    await page.getByTestId('jev-routing-mode').click()
    await page.locator('.n-base-select-option').filter({ hasText: messages.jev.groupRoutingAuto }).click()
    await page.getByRole('button', { name: messages.common.save, exact: true }).click()
    await expect.poll(() => saves.length).toBe(1)
    expect(saves[0]).toMatchObject({ profile: 'research', body: expected })
    await page.reload()
    for (const key of switches) await expect(page.getByRole('switch', { name: messages.jev[key], exact: true })).toBeChecked({ checked: expected[key] })
    for (const [key, label] of numbers) await expect(page.getByLabel(messages.jev[label], { exact: true })).toHaveValue(String(expected[key]))
    await expect(page.getByTestId('jev-routing-mode')).toContainText(messages.jev.groupRoutingAuto)
    await page.getByTestId('models-profile-select').click()
    await page.locator('.n-base-select-option').filter({ hasText: /^default$/ }).click()
    for (const key of switches) await expect(page.getByRole('switch', { name: messages.jev[key], exact: true })).toBeChecked({ checked: collaborationDefaults[key] })
    for (const [key, label] of numbers) await expect(page.getByLabel(messages.jev[label], { exact: true })).toHaveValue(String(collaborationDefaults[key]))
    await expect(page.getByTestId('jev-routing-mode')).toContainText(messages.jev.groupRoutingSuggest)
    await page.getByTestId('models-profile-select').click()
    await page.locator('.n-base-select-option').filter({ hasText: /^research$/ }).click()
    for (const key of ['groupSummaryReviewEnabled', 'groupSummaryRevisionEnabled', 'workflowQualityEnabled', 'groupMessageRoutingEnabled'] as const) {
      const control = page.getByRole('switch', { name: messages.jev[key], exact: true })
      await expect(control).toBeChecked()
      await control.click()
      expected[key] = false
    }
    await page.getByRole('button', { name: messages.common.save, exact: true }).click()
    await expect.poll(() => saves.length).toBe(2)
    expect(saves[1]).toMatchObject({ profile: 'research', body: expected })
    await page.reload()
    for (const key of switches) await expect(page.getByRole('switch', { name: messages.jev[key], exact: true })).not.toBeChecked()
    for (const [key, label] of numbers) await expect(page.getByLabel(messages.jev[label], { exact: true })).toHaveValue(String(expected[key]))
    expect(settings.default).toMatchObject(collaborationDefaults)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
}
