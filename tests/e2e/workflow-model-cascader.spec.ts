import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

const modelGroups = [{
  ...TEST_MODEL_GROUP, provider: 'moa', label: 'MoA', models: ['review-combination'],
}, TEST_MODEL_GROUP, {
  ...TEST_MODEL_GROUP, provider: 'other-provider', label: 'Other Provider',
  models: ['other-model', 'disabled-model'], api_mode: 'anthropic_messages',
  model_meta: { 'disabled-model': { disabled: true } },
}]

function workflow(provider = 'test-provider', model = 'test-model') {
  return {
    id: 'wf-model', name: 'Workflow model selection', profile: 'research', workspace: null,
    nodes: [{ id: 'agent', type: 'agent', position: { x: 80, y: 80 }, data: {
      title: 'Agent', agent: 'hermes', agentMode: 'scoped', provider, model,
      apiMode: 'chat_completions', input: 'Review', skills: [], images: [], approvalRequired: false,
    } }], edges: [], viewport: { x: 80, y: 80, zoom: .75 }, created_at: 1, updated_at: 1,
  }
}

test('workflow uses the shared dialog and saves aliases, protocol and custom model IDs', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, {
    modelGroups, modelAliases: { 'other-provider': { 'other-model': 'Fast model' } },
    workflows: [workflow()], workflowRuns: [],
  })
  await page.goto('/#/hermes/workflow')
  const node = page.locator('.vue-flow__node[data-id="agent"]')
  const trigger = node.locator('.model-trigger')
  await trigger.click()
  const dialog = page.locator('.model-cascader-modal:visible')
  const menu = dialog.locator('.model-cascader')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('height', '560px')
  await expect(dialog.locator('.n-card-header')).toHaveCount(0)
  await expect(menu).toBeFocused()
  await expect(menu.locator('.model-cascader-search input')).not.toBeFocused()
  await expect(menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' })).toHaveCount(0)
  await menu.locator('.model-cascader-provider').filter({ hasText: 'Other Provider' }).click()
  await expect(menu.getByRole('menuitemradio').filter({ hasText: 'disabled-model' })).toBeDisabled()
  await menu.getByRole('menuitemradio').filter({ hasText: 'Fast model' }).click()
  await expect(dialog).toBeHidden()
  await expect(trigger).toContainText('Fast model')
  const saves = () => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-model')
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => saves().length).toBe(1)
  expect(JSON.parse(saves()[0].postData || '{}').nodes[0].data).toMatchObject({
    agent: 'hermes', provider: 'other-provider', model: 'other-model', apiMode: 'anthropic_messages',
  })

  await trigger.click()
  await menu.locator('.model-cascader-custom input').fill('manual-workflow-model')
  await menu.locator('.model-cascader-custom input').press('Enter')
  await expect(dialog).toBeHidden()
  await expect(trigger).toContainText('manual-workflow-model')
  await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => saves().length).toBe(2)
  const saved = JSON.parse(saves()[1].postData || '{}')
  expect(saved.nodes[0].data).toMatchObject({ provider: 'other-provider', model: 'manual-workflow-model', apiMode: 'anthropic_messages' })
  await page.route('**/api/studio/workflows', route => route.fulfill({ json: { workflows: [{ ...workflow(), ...saved }] } }))
  await page.reload()
  await expect(trigger).toContainText('manual-workflow-model')
  await trigger.click()
  await expect(menu.getByRole('menuitemradio').filter({ hasText: 'manual-workflow-model' })).toHaveAttribute('aria-checked', 'true')
  expect(api.requests.filter(request => request.pathname === '/api/hermes/config/model' && request.method !== 'GET')).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

for (const [agent, label] of [['ekko-agent', 'Ekko'], ['codex', 'Codex']]) {
  test(`workflow excludes MoA for Hermes and ${label} and repairs old selections`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page, { modelGroups, workflows: [workflow('moa', 'review-combination')], workflowRuns: [] })
    await page.goto('/#/hermes/workflow')
    const node = page.locator('.vue-flow__node[data-id="agent"]')
    const trigger = node.locator('.model-trigger')
    await expect(trigger).toContainText('test-model')
    await trigger.click()
    const menu = page.locator('.model-cascader:visible')
    await expect(menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' })).toHaveCount(0)
    await expect(menu.getByRole('menuitemradio').filter({ hasText: 'review-combination' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeFocused()
    await node.locator('.n-select').first().click()
    await page.locator('.n-base-select-option__content:visible').getByText(label, { exact: true }).click()
    await expect(trigger).toContainText('test-model')
    await trigger.click()
    await expect(menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' })).toHaveCount(0)
    await expect(menu.locator('.model-cascader-provider').filter({ hasText: 'Test Provider' })).toBeVisible()
    await menu.getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('.header-actions').getByRole('button', { name: 'Save', exact: true }).click()
    const saves = () => api.requests.filter(request => request.method === 'PATCH' && request.pathname === '/api/studio/workflows/wf-model')
    await expect.poll(() => saves().length).toBe(1)
    expect(JSON.parse(saves()[0].postData || '{}').nodes[0].data).toMatchObject({ agent, agentMode: 'scoped', provider: 'test-provider', model: 'test-model' })
    expect(api.unexpectedRequests).toEqual([])
  })
}
