import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

function provider(id: string, count: number, total = count) {
  const available_models = Array.from({ length: total }, (_, index) => `${id}-model-${index}`)
  return { ...TEST_MODEL_GROUP, provider: id, label: id, models: available_models.slice(0, count), available_models }
}

async function setup(page: Page, groups: ReturnType<typeof provider>[], aliases: Record<string, Record<string, string>> = {}) {
  await authenticate(page, TEST_ACCESS_KEY)
  const api = await mockHermesApi(page, { modelGroups: groups, modelAliases: aliases })
  const visibility: Record<string, { mode: string; models: string[] }> = {}
  const writes: any[] = []
  let defaultModel = groups[0]?.models[0] || ''
  let defaultProvider = groups[0]?.provider || ''
  await page.route('**/api/hermes/provider-models/cache/refresh', route => route.fulfill({ json: { success: true } }))
  await page.route('**/api/hermes/config/model', async route => {
    const body = route.request().postDataJSON()
    defaultModel = body.default
    defaultProvider = body.provider
    await route.fulfill({ json: { success: true } })
  })
  await page.route('**/api/hermes/model-alias', route => route.fulfill({ json: { success: true } }))
  await page.route('**/api/hermes/model-visibility', async route => {
    const body = route.request().postDataJSON()
    writes.push(body)
    visibility[body.provider] = { mode: body.mode, models: body.models }
    await route.fulfill({ json: { success: true, model_visibility: visibility } })
  })
  await page.route('**/api/hermes/available-models*', async route => {
    const current = groups.map(({ available_models, ...group }) => ({
      ...group,
      model_count: available_models.length,
      models: visibility[group.provider]?.mode === 'include' ? visibility[group.provider].models
        : visibility[group.provider]?.mode === 'all' ? available_models : group.models,
    }))
    await route.fulfill({ json: {
      groups: current, allProviders: groups.map(({ available_models, ...group }) => ({ ...group, models: [], model_count: available_models.length })), default: defaultModel,
      default_provider: defaultProvider, model_visibility: visibility,
      model_aliases: aliases,
    } })
  })
  await page.route('**/api/hermes/provider-models?*', async route => {
    const providerId = new URL(route.request().url()).searchParams.get('provider')
    const group = groups.find(group => group.provider === providerId)
    if (!group) { await route.fulfill({ status: 404, json: { error: 'Provider not found' } }); return }
    await route.fulfill({ json: {
      provider: providerId, models: group.available_models,
      visible_models: visibility[group.provider]?.mode === 'include' ? visibility[group.provider].models
        : visibility[group.provider]?.mode === 'all' ? group.available_models : group.models,
      model_aliases: aliases[group.provider] || {},
    } })
  })
  return { api, writes }
}

for (const mobile of [false, true]) {
  test(`visibility search preserves selections across filters and saves (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    const aliases = { OpenRouter: { 'OpenRouter-model-100': 'Research Claude', 'OpenRouter-model-463': '实验室助手' } }
    const { api, writes } = await setup(page, [provider('OpenRouter', 2, 464)], aliases)
    await page.goto('/#/hermes/models')
    await page.getByRole('button', { name: 'Manage visible models', exact: true }).click()
    const editor = page.getByRole('dialog')
    const search = editor.getByRole('textbox', { name: 'Search models...' })
    await search.fill('  research CLAUDE  ')
    await expect(editor.getByRole('checkbox')).toHaveCount(1)
    await expect(editor).toContainText('OpenRouter-model-100')
    await editor.getByRole('checkbox').check()
    await expect(editor).toContainText('3 of 464 models selected')
    await page.screenshot({ path: test.info().outputPath('visibility-search.png'), animations: 'disabled' })

    await search.fill('MODEL-463')
    await expect(editor.getByRole('checkbox')).toHaveCount(1)
    await expect(editor).toContainText('实验室助手')
    await editor.getByRole('checkbox').check()
    await search.fill('no-such-model')
    await expect(editor.getByRole('status')).toHaveText('No results')
    await expect(editor.getByRole('checkbox')).toHaveCount(0)
    await expect(editor).toContainText('4 of 464 models selected')

    await search.fill('')
    await expect(editor.getByRole('checkbox')).toHaveCount(464)
    await expect(editor.getByRole('checkbox', { name: 'OpenRouter-model-0', exact: true })).toBeChecked()
    await editor.getByRole('checkbox', { name: 'OpenRouter-model-1', exact: true }).uncheck()
    await search.fill('实验室')
    await expect(editor.getByRole('checkbox')).toHaveCount(1)
    await expect(editor.getByRole('checkbox')).toBeChecked()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(writes).toEqual([{ provider: 'OpenRouter', mode: 'include', models: ['OpenRouter-model-0', 'OpenRouter-model-100', 'OpenRouter-model-463'] }])

    await page.reload()
    await page.getByRole('button', { name: 'Manage visible models', exact: true }).click()
    await expect(search).toHaveValue('')
    await expect(editor.getByRole('checkbox', { name: 'OpenRouter-model-0', exact: true })).toBeChecked()
    await expect(editor.getByRole('checkbox', { name: 'OpenRouter-model-1', exact: true })).not.toBeChecked()
    await search.fill('Research Claude')
    await expect(editor.getByRole('checkbox')).toBeChecked()

    // Bulk actions still apply to the complete catalog, as they do in the App.
    await editor.getByRole('button', { name: 'Show all models', exact: true }).click()
    await expect(editor).toContainText('464 of 464 models selected')
    await editor.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await search.fill('OpenRouter-model-0')
    await expect(editor.getByRole('checkbox')).not.toBeChecked()
    await editor.getByRole('checkbox').check()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(writes[1]).toEqual({ provider: 'OpenRouter', mode: 'include', models: ['OpenRouter-model-0'] })
    expect(api.unexpectedRequests).toEqual([])
  })
}

test('loads a full Provider catalog only on demand and blocks saves until a failed read is retried', async ({ page }) => {
  const { writes } = await setup(page, [provider('Gateway', 1, 3000)])
  let catalogReads = 0
  await page.route('**/api/hermes/provider-models?*', async route => {
    catalogReads++
    if (catalogReads === 1) await route.fulfill({ status: 502, json: { error: 'Catalog unavailable' } })
    else await route.fallback()
  })
  await page.goto('/#/hermes/models')
  await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible()
  expect(catalogReads).toBe(0)
  await page.getByRole('button', { name: 'Manage visible models', exact: true }).click()
  const editor = page.getByRole('dialog')
  await expect(editor.getByRole('alert')).toContainText('Catalog unavailable')
  await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  expect(writes).toEqual([])
  await editor.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(editor.getByRole('checkbox')).toHaveCount(3000)
  await editor.getByRole('checkbox', { name: 'Gateway-model-2999', exact: true }).check()
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  expect(writes).toEqual([{ provider: 'Gateway', mode: 'include', models: ['Gateway-model-0', 'Gateway-model-2999'] }])
  expect(catalogReads).toBe(2)
})

for (const mobile of [false, true]) {
  test(`large catalogs open the visibility editor and persist the selection (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    const { api, writes } = await setup(page, [provider('Gateway A', 101), provider('Gateway B', 150), provider('Boundary', 100), provider('Filtered', 2, 3000)])
    await page.goto('/#/hermes/models')
    const notice = page.getByTestId('large-model-catalog-notice')
    await expect(notice).toBeVisible()
    await expect(notice.locator('li')).toHaveCount(2)
    await expect(notice).toContainText('Gateway A: 101 visible models')
    await expect(notice).toContainText('Gateway B: 150 visible models')
    await expect(notice).toContainText('may slow down page loading')
    await page.screenshot({ path: test.info().outputPath('catalog-notice.png'), animations: 'disabled' })
    await notice.locator('li').filter({ hasText: 'Gateway A:' }).getByRole('button', { name: 'Manage visible models' }).click()

    const editor = page.getByRole('dialog').filter({ hasText: 'Manage visible models for Gateway A' })
    await expect(editor).toBeVisible()
    await editor.getByRole('button', { name: 'Clear selection', exact: true }).click()
    await editor.getByRole('checkbox', { name: 'Gateway A-model-100', exact: true }).check()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    expect(writes).toEqual([{ provider: 'Gateway A', mode: 'include', models: ['Gateway A-model-100'] }])
    await expect(notice).toBeVisible()
    await expect(notice.locator('li')).toHaveCount(1)
    await expect(notice).toContainText('Gateway B: 150 visible models')

    await page.reload()
    await expect(notice).toBeVisible()
    await expect(notice.locator('li')).toHaveCount(1)
    await expect(notice).toContainText('Gateway B: 150 visible models')
    await page.getByRole('button', { name: 'Later', exact: true }).click()
    const card = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'Gateway A', exact: true }) })
    await card.getByRole('button', { name: 'Manage visible models', exact: true }).click()
    await expect(editor.getByRole('checkbox', { name: 'Gateway A-model-100', exact: true })).toBeChecked()
    await expect(editor.getByRole('checkbox', { name: 'Gateway A-model-0', exact: true })).not.toBeChecked()
    expect(api.unexpectedRequests).toEqual([])
  })
}

test('100 visible models and a filtered large catalog do not prompt', async ({ page }) => {
  await setup(page, [provider('Boundary', 100), provider('Filtered', 2, 3000)])
  await page.goto('/#/hermes/models')
  await expect(page.getByRole('heading', { name: 'Boundary', exact: true })).toBeVisible()
  await expect(page.getByTestId('large-model-catalog-notice')).toHaveCount(0)
})

test('refreshing and returning to the page both recheck a dismissed reminder', async ({ page }) => {
  await setup(page, [provider('Gateway', 101)])
  await page.goto('/#/hermes/models')
  const notice = page.getByTestId('large-model-catalog-notice')
  await expect(notice).toBeVisible()
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh model cache', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Gateway', exact: true })).toBeVisible()
  await expect(notice).toBeVisible()
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.goto('/#/hermes/history')
  await expect(page.locator('.models-view')).toHaveCount(0)
  await page.goto('/#/hermes/models')
  await expect(notice).toBeVisible()
})

test('a failed Profile catalog request does not warn about the previous Profile', async ({ page }) => {
  await setup(page, [provider('Gateway', 101)])
  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.route('**/api/hermes/available-models?profile=research', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.getByTestId('models-profile-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^research$/ }).click()
  await expect(page.getByTestId('models-profile-select')).toContainText('research')
  await expect(page.getByTestId('models-profile-select')).not.toHaveClass(/n-select--disabled/)
  await expect(page.getByTestId('large-model-catalog-notice')).toHaveCount(0)
})

for (const locale of [
  { id: 'zh', title: '可见模型较多', manage: '管理可见模型', count: '已选择 101 / 101 个模型', clear: '取消全选' },
  { id: 'tr', title: 'Çok fazla görünür model', manage: 'Görünür modelleri yönet', count: '101 modelden 101 tanesi seçildi', clear: 'Seçimi temizle' },
  { id: 'ar', title: 'نماذج ظاهرة كثيرة', manage: 'إدارة النماذج الظاهرة', count: 'تم اختيار 101 من أصل 101 نموذجًا', clear: 'مسح التحديد' },
]) {
  test(`the common warning dialog and visibility editor are localized in ${locale.id}`, async ({ page }) => {
    await setup(page, [provider('OpenRouter', 101)])
    await page.addInitScript(id => localStorage.setItem('hermes_locale', id), locale.id)
    await page.goto('/#/hermes/models')
    const notice = page.getByTestId('large-model-catalog-notice')
    await expect(notice).toBeVisible()
    await expect(page.locator('.n-dialog')).toContainText(locale.title)
    await expect(notice).not.toContainText('models.')
    await page.screenshot({ path: test.info().outputPath(`notice-${locale.id}.png`), animations: 'disabled' })
    await notice.getByRole('button', { name: locale.manage, exact: true }).click()
    const editor = page.getByRole('dialog')
    await expect(editor).toContainText(locale.count)
    await expect(editor.getByRole('button', { name: locale.clear, exact: true })).toBeVisible()
    await expect(editor).not.toContainText('models.')
  })
}

test('showing all models rechecks a previously filtered provider after saving', async ({ page }) => {
  await setup(page, [provider('Filtered', 2, 150)])
  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Manage visible models', exact: true }).click()
  const editor = page.getByRole('dialog')
  await editor.getByRole('button', { name: 'Show all models', exact: true }).click()
  await expect(page.getByTestId('large-model-catalog-notice')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByTestId('large-model-catalog-notice')).toContainText('Filtered: 150 visible models')
  await expect(page.getByRole('dialog')).toHaveCount(1)
})

test('adding a provider checks the refreshed catalog after the add form closes', async ({ page }) => {
  const groups = [provider('Existing', 101)]
  await setup(page, groups)
  await page.route('**/api/hermes/config/providers', async route => {
    groups.push(provider('Added', 464))
    await route.fulfill({ json: { success: true } })
  })
  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.getByRole('button', { name: 'Add Provider', exact: true }).click()
  const form = page.getByRole('dialog')
  await form.getByRole('button', { name: 'Custom', exact: true }).click()
  await form.getByPlaceholder('e.g. https://api.example.com/v1').fill('https://provider.example.test/v1')
  await form.getByPlaceholder('sk-...').fill('fixture-key')
  await form.getByRole('button', { name: 'Fetch', exact: true }).click()
  await expect(form).toContainText('proxy-model-a')
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  const notice = page.getByTestId('large-model-catalog-notice')
  await expect(notice).toContainText('Added: 464 visible models')
  await expect(notice.locator('li')).toHaveCount(2)
  await expect(page.getByRole('dialog')).toHaveCount(1)
})

test('editing a provider rechecks after the editor closes', async ({ page }) => {
  await setup(page, [provider('test-provider', 101)])
  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.locator('.provider-editor-modal')
  await editor.getByLabel('Display name').fill('Edited Provider')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByTestId('large-model-catalog-notice')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(1)
})

test('default-model and alias changes recheck, while a failed alias save does not', async ({ page }) => {
  await setup(page, [provider('Gateway', 101)])
  await page.goto('/#/hermes/models')
  const notice = page.getByTestId('large-model-catalog-notice')
  const later = page.getByRole('button', { name: 'Later', exact: true })
  await later.click()
  await page.locator('.default-model-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: /^Gateway-model-1$/ }).click()
  await expect(notice).toBeVisible()
  await later.click()
  await page.locator('.model-tag-button').first().click()
  const editor = page.getByRole('dialog')
  await editor.getByPlaceholder('Leave empty to use original model ID').fill('My model')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(notice).toBeVisible()
  await later.click()
  await page.route('**/api/hermes/model-alias', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }))
  await page.locator('.model-tag-button').first().click()
  await editor.getByPlaceholder('Leave empty to use original model ID').fill('Unsaved name')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('API Error 503: Unavailable', { exact: true })).toBeVisible()
  await expect(notice).toHaveCount(0)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(notice).toHaveCount(0)
})

for (const operation of ['refresh', 'restore'] as const) {
  test(`${operation} provider models checks the resulting catalog`, async ({ page }) => {
    const groups = [{ ...provider('Gateway', 2), model_refreshable: true, model_restore_available: true }]
    await setup(page, groups)
    await page.route(`**/api/hermes/config/providers/Gateway/models/${operation}`, async route => {
      const previous = groups[0].models
      Object.assign(groups[0], provider('Gateway', 150))
      await route.fulfill({ json: { success: true, applied: true, models: groups[0].models, previous_models: previous, unavailable_models: [], restore_available: true, requires_confirmation: false, diff: { added: [], removed: [], unchanged: [] } } })
    })
    await page.goto('/#/hermes/models')
    await page.getByRole('button', { name: operation === 'refresh' ? 'Refresh models' : 'Restore previous models', exact: true }).click()
    await expect(page.getByTestId('large-model-catalog-notice')).toContainText('Gateway: 150 visible models')
  })
}

test('removing a provider only warns about remaining oversized providers', async ({ page }) => {
  const groups = [provider('custom:removed', 101), provider('Remaining', 150)]
  await setup(page, groups)
  let removed = false
  let finishReload!: () => void
  const pendingReload = new Promise<void>(resolve => { finishReload = resolve })
  await page.route('**/api/hermes/available-models', async route => {
    if (removed) await pendingReload
    await route.fallback()
  })
  await page.route('**/api/hermes/config/providers/custom%3Aremoved*', async route => {
    removed = true
    groups.shift()
    await route.fulfill({ json: { success: true } })
  })
  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Later', exact: true }).click()
  const card = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'custom:removed', exact: true }) })
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  const notice = page.getByTestId('large-model-catalog-notice')
  try {
    await expect(card).toHaveCount(0)
    await expect(notice).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(1)
  } finally {
    finishReload()
  }
  await expect(notice).toBeVisible()
  await expect(notice.locator('li')).toHaveCount(1)
  await expect(notice).toContainText('Remaining: 150 visible models')
})
