import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'

test('shows OpenCode Free loading without blocking other providers, then updates in the background', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const freeGroup = { provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', api_key: '', builtin: true, models: [] as string[], catalog_status: 'loading' }
  const api = await mockHermesApi(page, { modelGroups: [TEST_MODEL_GROUP, freeGroup] })
  await page.goto('/#/hermes/models')
  const freeCard = page.locator('.provider-card').filter({ has: page.getByRole('heading', { name: 'OpenCode Free', exact: true }) })
  await expect(freeCard.getByText('Loading free models in the background…')).toBeVisible()
  await expect(page.locator('.provider-card').filter({ hasText: 'test-provider' }).getByText('test-model', { exact: true }).first()).toBeVisible()
  await expect(freeCard.getByRole('button', { name: 'Set default provider' })).toBeDisabled()
  freeGroup.models = ['mimo-v2.5-free']
  freeGroup.catalog_status = 'ready'
  await expect(freeCard.getByText('mimo-v2.5-free', { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(freeCard.getByText('Loading free models in the background…')).toHaveCount(0)
  expect(api.requests.filter(request => request.method === 'PUT' && request.pathname === '/api/hermes/config/model')).toHaveLength(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('adds OpenCode Free without a key and preserves the native provider ID', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const freeGroup = { provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', api_key: '', builtin: true, models: ['mimo-v2.5-free'], catalog_status: 'ready' }
  await mockHermesApi(page, { modelGroups: [TEST_MODEL_GROUP, freeGroup] })
  let saved: Record<string, unknown> | undefined
  await page.route('**/api/hermes/config/providers', async route => {
    saved = route.request().postDataJSON()
    await route.fulfill({ json: { success: true } })
  })
  await page.goto('/#/hermes/models?addProvider=1')
  const form = page.getByRole('dialog')
  await form.locator('.n-base-selection').first().click()
  await page.locator('.n-base-select-option').filter({ hasText: 'OpenCode Free' }).click()
  await expect(form.locator('input[type="password"]')).toHaveCount(0)
  await expect(form.getByText('No account or API key required. Free models may be rate limited.')).toBeVisible()
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(form).toHaveCount(0)
  expect(saved).toMatchObject({ providerKey: 'opencode-free', api_key: '', model: 'mimo-v2.5-free' })
})

test('opens the provider form when model settings are entered from setup guidance', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  await mockHermesApi(page)

  await page.goto('/#/hermes/models?addProvider=1')

  await expect(page.getByText('Provider Type')).toBeVisible()
  const apiKeyInput = page.locator('input[type="password"]')
  await expect(apiKeyInput).toHaveAttribute('autocomplete', 'new-password')
  await expect(apiKeyInput).toHaveAttribute('name', 'new-provider-api-key')
  await expect(apiKeyInput).toHaveAttribute('data-1p-ignore', 'true')
  await expect(page).toHaveURL(/#\/hermes\/models\?modelProfile=default$/)
})

test('fetches custom provider models through the backend proxy', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const api = await mockHermesApi(page)

  const thirdPartyRequests: string[] = []
  page.on('request', (request) => {
    const url = request.url()
    if (url.startsWith('https://provider.example.test')) {
      thirdPartyRequests.push(url)
    }
  })

  await page.goto('/#/hermes/models')

  await page.getByRole('button', { name: 'Add Provider' }).click()
  await page.getByRole('button', { name: 'Custom' }).click()
  await page.getByPlaceholder('e.g. https://api.example.com/v1').fill('https://provider.example.test/v1')
  await page.getByPlaceholder('sk-...').fill('test-provider-key')
  await page.getByRole('button', { name: 'Fetch' }).click()

  await expect(page.getByText('Found 2 models')).toBeVisible()
  await expect(page.getByText('proxy-model-a')).toBeVisible()

  const proxyRequest = api.requests.find((request) => request.pathname === '/api/hermes/provider-models')
  expect(proxyRequest).toBeTruthy()
  expect(proxyRequest?.method).toBe('POST')
  expect(proxyRequest?.headers.authorization).toBe(`Bearer ${TEST_ACCESS_KEY}`)
  expect(JSON.parse(proxyRequest?.postData || '{}')).toMatchObject({
    base_url: 'https://provider.example.test/v1',
    api_key: 'test-provider-key',
  })
  expect(thirdPartyRequests).toEqual([])
  expect(api.unexpectedRequests).toEqual([])
})

test('edits a provider without rendering its existing credential', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { initialProfileName: 'research' })

  await page.goto('/#/hermes/models')
  await page.getByRole('button', { name: 'Edit' }).click()

  const editor = page.getByRole('dialog')
  await expect(editor.getByText('Internal provider ID', { exact: true })).toBeVisible()
  await expect(editor.getByText('test-provider', { exact: true })).toBeVisible()
  await expect(editor.getByText('Configured', { exact: true })).toBeVisible()
  await expect(editor.getByText('list-response-credential')).toHaveCount(0)
  await expect(editor.locator('input[type="password"]')).toHaveValue('')
  await expect(editor.locator('input[type="password"]')).toHaveAttribute('autocomplete', 'new-password')
  await expect(editor.locator('input[type="password"]')).toHaveAttribute('name', 'provider-api-key-replacement')

  await editor.getByLabel('Display name').fill('Edited Provider')
  await editor.getByLabel('Base URL').fill('https://edited.example/v1')
  await editor.locator('input[type="password"]').fill('replacement-provider-credential')

  const patchRequestPromise = page.waitForRequest(request => {
    const url = new URL(request.url())
    return request.method() === 'PATCH' && url.pathname === '/api/hermes/config/providers/test-provider/editor'
  })
  await editor.getByRole('button', { name: 'Save' }).click()
  const patchRequest = await patchRequestPromise
  await expect(editor).toHaveCount(0)

  expect(patchRequest.headers()['if-match']).toBe('"provider-revision-1"')
  expect(JSON.parse(patchRequest.postData() || '{}')).toMatchObject({
    label: 'Edited Provider',
    base_url: 'https://edited.example/v1',
    preferred_model: 'test-model',
    credential_action: 'replace',
    api_key: 'replacement-provider-credential',
  })
  const testRequest = api.requests.find(request => (
    request.pathname === '/api/hermes/config/providers/test-provider/editor/test'
  ))
  expect(testRequest?.method).toBe('POST')
  expect(testRequest?.headers['x-hermes-profile']).toBe('research')
  expect(api.unexpectedRequests).toEqual([])
})


for (const agent of ['Hermes', 'Ekko', 'Claude', 'Codex', 'Pi', 'Grok', 'OpenCode', 'DeepSeek Harness']) {
  test(`creates an OpenCode Free ${agent} chat without asking for a key`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page, { modelGroups: [{ provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', api_key: '', builtin: true, models: ['mimo-v2.5-free'], catalog_status: 'ready' }] })
    await mockChatSocket(page)
    await page.route('**/api/coding-agents', route => route.fulfill({ json: {
      tools: ['claude-code', 'codex', 'pi', 'grok', 'opencode', 'dsh'].map(id => ({ id, name: id, installed: true })),
    } }))
    await page.goto('/#/hermes/chat')
    await page.getByRole('button', { name: 'New Chat' }).click()
    const form = page.locator('.new-chat-drawer')
    if (agent !== 'Hermes') {
      await form.locator('.new-chat-field').filter({ hasText: /^Agent/ }).locator('.n-base-selection').click()
      await page.locator('.n-base-select-option:visible').filter({ hasText: new RegExp(`^${agent}$`) }).click()
    }
    await expect(form.locator('input[type="password"]')).toHaveCount(0)
    await expect(form.getByText('No account or API key required. Free models may be rate limited.')).toBeVisible()
    await expect(form.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
    await form.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page).toHaveURL(/#\/hermes\/session\//)
  })
}

test('updates a pending free catalog inside the new chat drawer', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const freeGroup = { provider: 'opencode-free', label: 'OpenCode Free', base_url: 'https://opencode.ai/zen/v1', api_key: '', models: [] as string[], catalog_status: 'loading' }
  await mockHermesApi(page, { modelGroups: [freeGroup] })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat' }).click()
  const create = page.locator('.new-chat-drawer').getByRole('button', { name: 'Create', exact: true })
  await expect(create).toBeDisabled()
  freeGroup.models = ['mimo-v2.5-free']
  freeGroup.catalog_status = 'ready'
  await expect(create).toBeEnabled({ timeout: 10_000 })
})

for (const mode of ['scoped', 'global']) test(`DSH ${mode} chat selects its model and displays deltas before completion`, async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY)
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: 'dsh', name: 'DeepSeek Harness', installed: true }] } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat' }).click()
  const form = page.locator('.new-chat-drawer')
  await form.locator('.new-chat-field').filter({ hasText: /^Agent/ }).locator('.n-base-selection').click()
  await page.getByText('DeepSeek Harness', { exact: true }).last().click()
  if (mode === 'global') await form.getByText('Global config', { exact: true }).click()
  await form.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page).toHaveURL(/#\/hermes\/session\//)
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('DSH integration check')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run').length || 0)).toBe(1)
  const payload = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload)
  expect(payload).toMatchObject({ coding_agent_id: 'dsh', mode })
  if (mode === 'scoped') expect(payload).toMatchObject({ provider: 'test-provider', model: 'test-model' })
  await expect(page.locator('img[src="/coding-agents/deepseek.svg"]').first()).toBeVisible()
  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'dsh-stream' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'dsh-stream', delta: 'DSH first chunk' })
  }, payload.session_id)
  await expect(page.getByText('DSH first chunk', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'dsh-stream', delta: ' and second chunk' })
  }, payload.session_id)
  await expect(page.getByText('DSH first chunk and second chunk', { exact: true })).toBeVisible()
  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'dsh-stream', output: 'DSH first chunk and second chunk' })
  }, payload.session_id)
  await expect(page.getByText('DSH first chunk and second chunk', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
