import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { PersonAgentPreset } from '../../packages/client/src/api/person'
import type { ProviderApiMode } from '../../packages/client/src/api/studio/provider-api-mode'

async function openSettings(page: Page, metadata: { api_mode?: ProviderApiMode; api_mode_by_model?: Record<string, ProviderApiMode | null> }, initial: PersonAgentPreset[] = []) {
  await page.addInitScript(agents => { (window as any).initialProtocolAgents = agents }, initial)
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/agent-models')) return route.fulfill({ json: { profiles: ['work'], groups: [{
      profile: 'work', provider: 'custom:relay', label: 'Relay', models: ['model-a', 'model-b'], ...metadata,
      model_meta: { 'model-a': { reasoning_efforts: ['low', 'high'] }, 'model-b': { reasoning_efforts: ['low', 'high'] } },
    }] } })
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { native_allowed: false, agents: [{ runtime: 'ekko', installed: true }] } })
    if (path.endsWith('/settings')) return route.fulfill({ json: { agents: route.request().postDataJSON().agents } })
    return route.fulfill({ json: {} })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-agent-protocol.ts').replace(/^\//, '')
  await page.route('**/__person_agent_protocol__', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__person_agent_protocol__')
  if (initial.length) await page.getByRole('button', { name: '编辑', exact: true }).click()
  else {
    await page.getByRole('button', { name: /^添加\s*(?:Agent|智能体)$/ }).click()
    await page.getByRole('button', { name: 'Ekko', exact: true }).click()
    await page.getByRole('textbox', { name: 'Agent 名称', exact: true }).fill('Executor')
    await page.locator('.field-wide textarea').fill('Complete the task')
  }
}

async function choose(page: Page, model: string) {
  await page.locator('.model-trigger').click()
  await page.getByRole('menuitemradio', { name: model, exact: true }).click()
}

async function save(page: Page) {
  const submitted = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname.endsWith('/person/settings'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const payload = (await submitted).postDataJSON()
  await expect(page.locator('.agent-card')).toHaveCount(1)
  return payload.agents[0] as PersonAgentPreset
}

for (const input of [
  { name: 'supplier protocol', metadata: { api_mode: 'codex_responses' as const }, expected: 'codex_responses' },
  { name: 'per-model protocol ahead of supplier default', metadata: { api_mode: 'chat_completions' as const, api_mode_by_model: { 'model-a': 'anthropic_messages' as const } }, expected: 'anthropic_messages' },
]) test(`inherits ${input.name} and submits it without a protocol dialog`, async ({ page }) => {
  await openSettings(page, input.metadata)
  await choose(page, 'model-a')
  await expect(page.getByRole('dialog', { name: '协议', exact: true })).toBeHidden()
  await expect(page.locator('.model-trigger')).toContainText('model-a')
  expect(await save(page)).toMatchObject({ selection: { provider: 'custom:relay', model: 'model-a', apiMode: input.expected } })
})

const existing: PersonAgentPreset = {
  id: 'saved', name: 'Saved executor', description: 'Existing purpose',
  selection: { runtime: 'ekko', mode: 'scoped', profile: 'work', provider: 'custom:relay', model: 'model-a', apiMode: 'anthropic_messages', reasoningEffort: 'high' },
}

test('reselecting a saved model preserves its explicit protocol, reasoning and other settings', async ({ page }) => {
  await openSettings(page, { api_mode: 'codex_responses' }, [existing])
  await choose(page, 'model-a')
  await expect(page.getByRole('dialog', { name: '协议', exact: true })).toBeHidden()
  expect(await save(page)).toEqual(existing)
})

test('changing models inherits the new protocol without carrying the old override or reasoning', async ({ page }) => {
  await openSettings(page, { api_mode: 'codex_responses' }, [existing])
  await choose(page, 'model-b')
  await expect(page.getByRole('dialog', { name: '协议', exact: true })).toBeHidden()
  expect(await save(page)).toMatchObject({ name: existing.name, description: existing.description,
    selection: { provider: 'custom:relay', model: 'model-b', apiMode: 'codex_responses', reasoningEffort: 'low' } })
})

test('unknown protocol still asks, cancellation leaves the model unset and confirmation submits the manual choice', async ({ page }) => {
  await openSettings(page, {})
  await choose(page, 'model-a')
  const dialog = page.getByRole('dialog', { name: '协议', exact: true })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
  await page.getByRole('menuitemradio', { name: 'model-a', exact: true }).click()
  await expect(dialog).toBeVisible()
  await dialog.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'Anthropic Messages' }).click()
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  expect(await save(page)).toMatchObject({ selection: { model: 'model-a', apiMode: 'anthropic_messages' } })
})
