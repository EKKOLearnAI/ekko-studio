import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

async function selectProfile(page: Page, name: string) {
  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: new RegExp(`^${name}$`) }).click()
  await expect(page.getByTestId('models-profile-select')).toContainText(name)
  await expect(page.locator('.models-profile-loading')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
}

test('switches the model catalog and scopes provider additions, edits and deletion to the selected Profile', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const freeGroup = { provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', api_key: '', builtin: true, models: ['free-test-model'], catalog_status: 'ready' }
  const api = await mockHermesApi(page, { modelGroups: [TEST_MODEL_GROUP, freeGroup] })
  await page.route('**/api/hermes/available-models?*', async route => {
    const profile = new URL(route.request().url()).searchParams.get('profile')
    const groups = [{ ...TEST_MODEL_GROUP, label: `${profile} Provider`, builtin: false, provider_source: 'providers', provider_key: 'test-provider' }, freeGroup]
    await route.fulfill({ json: { groups, allProviders: groups, default: 'test-model', default_provider: 'test-provider' } })
  })
  let addedProfile = ''
  await page.route('**/api/hermes/config/providers', async route => {
    addedProfile = route.request().headers()['x-hermes-profile']
    await route.fulfill({ json: { success: true } })
  })
  let deletedProfile = ''
  await page.route('**/api/hermes/config/providers/test-provider?*', async route => {
    deletedProfile = route.request().headers()['x-hermes-profile']
    await route.fulfill({ json: { success: true } })
  })
  await page.goto('/#/hermes/models')
  await expect(page.getByRole('heading', { name: 'default Provider', exact: true })).toBeVisible()
  await selectProfile(page, 'research')
  await expect(page.getByRole('heading', { name: 'default Provider', exact: true })).toHaveCount(0)
  const researchCard = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'research Provider', exact: true }) })
  await expect(researchCard).toBeVisible()

  await page.getByRole('button', { name: 'Add Provider', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.locator('.n-base-selection').first().click()
  await page.locator('.n-base-select-option').filter({ hasText: 'OpenCode Free' }).click()
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(form).toHaveCount(0)
  expect(addedProfile).toBe('research')

  await researchCard.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByLabel('Display name').fill('Updated research provider')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const edits = api.requests.filter(request => request.method === 'PATCH' && request.pathname.endsWith('/test-provider/editor'))
  expect(edits).toHaveLength(1)
  expect(edits[0].headers['x-hermes-profile']).toBe('research')
  expect(JSON.parse(edits[0].postData || '{}').label).toBe('Updated research provider')
  await researchCard.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect.poll(() => deletedProfile).toBe('research')
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  await expect(page).toHaveURL(/#\/hermes\/models$/)
})

test('reloads auxiliary settings and saves only the selected Profile', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  const configs: Record<string, Record<string, unknown>> = {
    default: { vision: { provider: 'test-provider', model: 'default-vision' } },
    research: { vision: { provider: 'test-provider', model: 'research-vision' } },
  }
  const writes: string[] = []
  await page.route('**/api/hermes/config/auxiliary-models', async route => {
    const profile = route.request().headers()['x-hermes-profile'] || 'default'
    if (route.request().method() === 'PUT') {
      writes.push(profile)
      configs[profile] = route.request().postDataJSON().auxiliary
    }
    await route.fulfill({ json: { success: true, tasks: [{ key: 'vision', label: 'Vision' }], auxiliary: configs[profile] } })
  })
  await page.goto('/#/hermes/models?tab=auxiliary')
  await expect(page.locator('.task-config').filter({ hasText: 'default-vision' })).toBeVisible()
  await selectProfile(page, 'research')
  await expect(page.locator('.task-config').filter({ hasText: 'research-vision' })).toBeVisible()
  await expect(page.locator('.task-config').filter({ hasText: 'default-vision' })).toHaveCount(0)
  await page.locator('.auxiliary-row').filter({ hasText: 'research-vision' }).getByRole('button', { name: 'Clear', exact: true }).click()
  await expect.poll(() => writes).toEqual(['research'])
  expect(configs.default).toEqual({ vision: { provider: 'test-provider', model: 'default-vision' } })
  expect(configs.research).toEqual({ vision: { provider: 'auto' } })
  await expect(page).toHaveURL(/tab=auxiliary/)
})

test('keeps the ensemble tab selected and edits the newly selected Profile on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)
  const preset = {
    enabled: true, reference_models: [{ provider: 'test-provider', model: 'test-model' }],
    aggregator: { provider: 'test-provider', model: 'test-model' },
    reference_temperature: 0.6, aggregator_temperature: 0.4, max_tokens: 4096,
  }
  const configs: Record<string, any> = Object.fromEntries(['default', 'research'].map(profile => [profile, {
    ...preset, default_preset: `${profile}-ensemble`, presets: { [`${profile}-ensemble`]: preset },
  }]))
  const writes: string[] = []
  await page.route('**/api/hermes/config/moa', async route => {
    const profile = route.request().headers()['x-hermes-profile'] || 'default'
    if (route.request().method() === 'PUT') {
      writes.push(profile)
      configs[profile] = route.request().postDataJSON().moa
      await route.fulfill({ json: { success: true, moa: configs[profile] } })
    } else {
      await route.fulfill({ json: configs[profile] })
    }
  })
  await page.goto('/#/hermes/models?tab=combination')
  await expect(page.locator('.preset-name')).toContainText('default-ensemble')
  await selectProfile(page, 'research')
  await expect(page.locator('.preset-name')).toContainText('research-ensemble')
  await page.locator('.combination-row').filter({ hasText: 'research-ensemble' }).getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByPlaceholder('e.g. review').fill('research-updated')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(writes).toEqual(['research'])
  expect(Object.keys(configs.default.presets)).toEqual(['default-ensemble'])
  expect(Object.keys(configs.research.presets)).toEqual(['research-updated'])
  await expect(page.locator('.preset-name')).toContainText('research-updated')
  await expect(page).toHaveURL(/tab=combination/)
  expect(await page.locator('.models-view > .page-header').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

for (const kind of ['stt', 'tts'] as const) {
  test(`filters ${kind.toUpperCase()} configurations and removes only the selected Profile's provider`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page)
    const writes: string[] = []
    await page.route('**/api/studio/stt/settings', route => route.fulfill({ json: { providers: [], activeProvider: 'browser' } }))
    await page.route(`**/api/studio/${kind}/settings**`, async route => {
      const profile = route.request().headers()['x-hermes-profile'] || 'default'
      if (route.request().method() === 'DELETE') {
        writes.push(profile)
        await route.fulfill({ json: { success: true } })
      } else {
        await route.fulfill({ json: {
          activeProvider: 'openai',
          providers: [{ provider: 'openai', settings: { model: `${profile}-${kind}`, voice: 'alloy' }, secrets: { apiKey: '[stored]' }, updatedAt: 1 }],
        } })
      }
    })
    await page.goto(`/#/hermes/models?tab=${kind}`)
    await expect(page.locator('.voice-api-card').filter({ hasText: `default-${kind}` })).toBeVisible()
    await selectProfile(page, 'research')
    const card = page.locator('.voice-api-card').filter({ hasText: `research-${kind}` })
    await expect(card).toBeVisible()
    await expect(page.locator('.voice-api-card').filter({ hasText: `default-${kind}` })).toHaveCount(0)
    await card.getByRole('button', { name: /More actions/ }).click()
    await page.locator('.n-dropdown-option').filter({ hasText: 'Remove' }).click()
    await expect.poll(() => writes).toEqual(['research'])
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  })
}
