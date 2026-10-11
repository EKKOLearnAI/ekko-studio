import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import { selectNewChatAgent, selectNewChatLaunchMode, sendNewChatMessage } from './new-chat-helpers'

const catalog = { agentId: 'codex', name: 'Codex', status: 'ready', source: 'app-server', scope: 'available',
  models: [
    { id: 'native-a', name: 'Native A', isDefault: true, reasoningEfforts: ['low', 'high'] },
    { id: 'native-b', name: 'Native B', reasoningEfforts: ['low', 'high'] },
    { id: 'native-simple', name: 'Native Simple', reasoningEfforts: [] },
    { id: 'native-hidden', name: 'Hidden Model', hidden: true },
  ], checkedAt: '2026-10-11T00:00:00.000Z', cached: false }

async function openGlobalDraft(page: Page, mobile = false) {
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Codex')
  await selectNewChatLaunchMode(page, 'global')
}

async function selectNativeModel(page: Page, label: string) {
  await page.locator('.new-chat-page .input-model-button').click()
  const models = page.locator('.model-cascader:visible')
  await models.getByRole('menuitemradio', { name: label, exact: true }).click()
  await expect(models).toBeHidden()
}

for (const mobile of [false, true]) for (const native of [
  { agent: 'antigravity', name: 'Antigravity', family: 'Gemini 3.1 Pro', base: 'gemini-3.1-pro', levels: ['low', 'high'], alias: false },
  { agent: 'cursor', name: 'Cursor', family: 'Codex 5.3 Fast', base: 'gpt-5.3-codex-fast', levels: ['low', 'high', 'xhigh'], alias: true },
]) test(`${native.name} groups native effort variants and continues with the selected ID (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  const variantId = (effort: string) => native.agent === 'cursor' ? `gpt-5.3-codex-${effort}-fast` : `${native.base}-${effort}`
  const models = [
    ...(native.alias ? [{ id: 'auto', name: 'Auto', isDefault: true },
      { id: native.base, name: native.family, modelFamily: native.base, modelFamilyName: native.family, reasoningEfforts: native.levels }] : []),
    ...[...native.levels].reverse().map(effort => ({ id: variantId(effort), name: `${native.family} (${effort})`,
      modelFamily: native.base, modelFamilyName: native.family, reasoningEffort: effort, reasoningEfforts: native.levels })),
    ...(native.agent === 'cursor' ? [{ id: 'gpt-5.3-codex-low', name: 'Codex 5.3 Low', modelFamily: 'gpt-5.3-codex', modelFamilyName: 'Codex 5.3', reasoningEffort: 'low', reasoningEfforts: ['low'] }] : []),
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', modelFamily: 'gpt-oss-120b', modelFamilyName: 'GPT-OSS 120B', reasoningEffort: 'medium', reasoningEfforts: ['medium'] },
  ]
  await page.route('**/api/agents/availability', route => route.fulfill({ json: { revision: 1, agents: [
    { id: 'hermes', installed: true, source: 'user-cli' }, { id: 'ekko-agent', installed: true, source: 'built-in' },
    { id: native.agent, installed: true, source: 'user-cli' },
  ] } }))
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: native.agent, installed: true }] } }))
  await page.route('**/api/coding-agents/models?*', route => route.fulfill({ json: { agents: [{ ...catalog,
    agentId: native.agent, name: native.name, source: 'cli', models }] } }))
  const writes: any[] = []
  await page.route('**/api/studio/sessions/*/reasoning-effort', async route => {
    const body = route.request().postDataJSON()
    writes.push(body)
    await route.fulfill({ json: { ok: true, model: body.model, reasoning_effort: body.reasoningEffort } })
  })
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, native.name)
  if (native.agent !== 'cursor') await selectNewChatLaunchMode(page, 'global')
  const draft = page.locator('.new-chat-page')
  await draft.locator('.input-model-button').click()
  const picker = page.locator('.model-cascader:visible')
  await expect(picker.getByRole('menuitemradio', { name: native.family, exact: true })).toHaveCount(1)
  await expect(picker).not.toContainText(`${native.family} (high)`)
  if (native.agent === 'cursor') await expect(picker.getByRole('menuitemradio', { name: 'Codex 5.3', exact: true })).toBeVisible()
  await picker.getByRole('menuitemradio', { name: native.family, exact: true }).click()
  await draft.locator('.reasoning-effort-button').click()
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemax', String(native.levels.length - (native.alias ? 0 : 1)))
  await page.getByRole('slider').focus()
  for (let i = 0; i < native.levels.length; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  const lastEffort = native.levels.at(-1)!
  const lastLabel = lastEffort === 'xhigh' ? 'Extra high' : 'High'
  await expect(draft.locator('.reasoning-effort-label')).toHaveText(lastLabel)
  await page.reload()
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(draft.locator('.input-model-button')).toContainText(native.family)
  await expect(draft.locator('.reasoning-effort-label')).toHaveText(lastLabel)
  await draft.locator('.input-model-button').click()
  await expect(picker.getByRole('menuitemradio', { name: native.family, exact: true })).toHaveAttribute('aria-checked', 'true')
  await picker.getByRole('menuitemradio', { name: native.family, exact: true }).click()
  await sendNewChatMessage(page, 'Start with the chosen native variant')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload))
    .toMatchObject({ model: variantId(lastEffort), reasoning_effort: lastEffort })
  const sid = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.session_id)
  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'native-run' })
    socket.__trigger('session.workspace.updated', { event: 'session.workspace.updated', session_id: sid, workspace: '/tmp/native-workspace' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, delta: 'Ready to continue.' })
    socket.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'native-run' })
  }, sid)
  await expect(page.locator('.input-model-button')).toContainText(native.family)
  await expect(page.locator('.reasoning-effort-label')).toHaveText(lastLabel)
  await expect(page.locator('.reasoning-effort-button')).toBeDisabled()
  await expect(page.getByRole('slider')).toHaveCount(0)
  await page.locator('.reasoning-effort-button').dispatchEvent('click')
  await expect(page.getByRole('slider')).toHaveCount(0)
  expect(writes).toEqual([])
  await page.locator('.chat-input-area textarea').fill('Continue with the original effort')
  await page.locator('.chat-input-area textarea').press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload))
    .toMatchObject({ model: variantId(lastEffort), reasoning_effort: lastEffort, input: 'Continue with the original effort' })
  expect(api.unexpectedRequests).toEqual([])
})

for (const native of [
  { agent: 'grok', name: 'Grok', model: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'], label: 'Extra high' },
  { agent: 'grok', name: 'Grok', model: 'grok-4.5', efforts: ['low', 'medium', 'high'], label: 'High' },
  { agent: 'zcode', name: 'ZCode', model: 'glm-5.3', efforts: ['low', 'high', 'max'], label: 'Max' },
  { agent: 'zcode', name: 'ZCode', model: 'glm-5-turbo', efforts: ['disabled', 'enabled'], label: 'On' },
]) test(`${native.name} ${native.model} uses its native effort choices when starting a chat`, async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, agents: [
      { id: 'hermes', installed: true, source: 'user-cli' },
      { id: 'ekko-agent', installed: true, source: 'built-in' },
      { id: native.agent, installed: true, source: 'user-cli' },
    ],
  } }))
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: native.agent, installed: true }] } }))
  await page.route('**/api/coding-agents/models?*', route => route.fulfill({ json: { agents: [{
    ...catalog, agentId: native.agent, name: native.name, source: 'cli',
    models: [
      ...(native.agent === 'zcode' ? [{ id: native.model, name: native.model, provider: 'another-route', reasoningEfforts: ['disabled'] }] : []),
      { id: native.model, name: native.model, provider: 'current-route', isDefault: true, reasoningEfforts: native.efforts },
    ],
  }] } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, native.name)
  await selectNewChatLaunchMode(page, 'global')
  await selectNativeModel(page, native.model)
  const draft = page.locator('.new-chat-page')
  await draft.locator('.reasoning-effort-button').click()
  const slider = page.getByRole('slider')
  await expect(slider).toHaveAttribute('aria-valuemax', String(native.efforts.length))
  await slider.focus()
  for (let i = 0; i < native.efforts.length; i++) await page.keyboard.press('ArrowRight')
  await expect(draft.locator('.reasoning-effort-label')).toHaveText(native.label)
  await page.keyboard.press('Escape')
  await sendNewChatMessage(page, 'Use the native reasoning level')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    coding_agent_id: native.agent, mode: 'global', model: native.model, reasoning_effort: native.efforts.at(-1),
  })
  await expect(page.locator('.reasoning-effort-button .reasoning-effort-label')).toHaveText(native.label)
  await expect(page.locator('.reasoning-effort-button')).toBeDisabled()
  expect(api.unexpectedRequests).toEqual([])
})

for (const mobile of [false, true]) test(`global draft selects native model and effort (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { customModels: { 'native:codex': ['unrelated-custom'] } })
  await mockChatSocket(page)
  await page.route('**/api/coding-agents/models?*', route => route.fulfill({ json: { agents: [catalog] } }))
  await openGlobalDraft(page, mobile)
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('.input-model-button')).toBeEnabled()
  await draft.locator('.input-model-button').click()
  const models = page.locator('.model-cascader:visible')
  await expect(models).toContainText('Agent default model')
  await expect(models).toContainText('Native B')
  await expect(models).not.toContainText('Test Provider')
  await expect(models).not.toContainText('Hidden Model')
  await expect(models).not.toContainText('unrelated-custom')
  await models.getByRole('menuitemradio', { name: 'Native B', exact: true }).click()
  await expect(models).toBeHidden()
  await expect(draft.locator('.input-model-button')).toContainText('Native B')
  await draft.locator('.reasoning-effort-button').click()
  const slider = page.getByRole('slider')
  await expect(slider).toHaveAttribute('aria-valuemax', '2')
  await slider.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `/tmp/studio-global-models-${mobile ? 'mobile' : 'desktop'}.png`, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await sendNewChatMessage(page, 'Use native model and effort')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    coding_agent_id: 'codex', mode: 'global', model: 'native-b', reasoning_effort: 'high', input: 'Use native model and effort',
  })
  const payload = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload)
  for (const key of ['provider', 'baseUrl', 'apiKey', 'apiMode']) expect(payload[key]).toBeUndefined()
  await expect(page.locator('.input-model-button')).toContainText('native-b')
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await expect(page.locator('.reasoning-effort-button .reasoning-effort-label')).toBeVisible()
  await expect(page.locator('.reasoning-effort-button .reasoning-effort-label')).toHaveText('High')
  expect(api.unexpectedRequests).toEqual([])
})

test('cached native models stay usable while refresh is slow and survive page reload', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)
  let requests = 0
  let finishRefresh: (() => void) | undefined
  await page.route('**/api/coding-agents/models?*', async route => {
    requests++
    if (requests > 1) await new Promise<void>(resolve => { finishRefresh = resolve })
    await route.fulfill({ json: { agents: [catalog] } })
  })
  try {
    await openGlobalDraft(page)
    await selectNativeModel(page, 'Native B')
    const draft = page.locator('.new-chat-page')
    await draft.locator('.reasoning-effort-button').click()
    await page.getByRole('slider').focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Escape')
    await page.reload()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect.poll(() => requests).toBe(2)
    await expect(draft.locator('.input-model-button')).toContainText('Native B')
    await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
    await draft.locator('.input-model-button').click()
    const models = page.locator('.model-cascader:visible')
    await expect(models).toContainText('Native B')
    await expect(models.locator('.n-base-loading')).toHaveCount(1)
    await expect(models.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled()
    await models.getByRole('menuitemradio', { name: 'Native B', exact: true }).click()
    await sendNewChatMessage(page, 'Send while models refresh')
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.reasoning_effort)).toBe('high')
    await expect(page.locator('.reasoning-effort-button .reasoning-effort-label')).toHaveText('High')
    expect(requests).toBe(2)
    finishRefresh?.()
    await expect(page.locator('.reasoning-effort-button')).toBeDisabled()
    expect(api.unexpectedRequests).toEqual([])
  } finally { finishRefresh?.() }
})

test('failed background discovery preserves the cached catalog and selected effort', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  let requests = 0
  await page.route('**/api/coding-agents/models?*', route => route.fulfill(++requests === 1
    ? { json: { agents: [catalog] } } : { json: { agents: [{ ...catalog, status: 'timeout', models: [] }] } }))
  await openGlobalDraft(page)
  await selectNativeModel(page, 'Native B')
  await page.locator('.new-chat-page .reasoning-effort-button').click()
  await page.getByRole('slider').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await selectNewChatLaunchMode(page, 'scoped')
  await selectNewChatLaunchMode(page, 'global')
  await page.locator('.new-chat-page .input-model-button').click()
  const models = page.locator('.model-cascader:visible')
  await expect(models).toContainText('Refresh failed. Showing cached models.')
  await expect(models).toContainText('Native B')
  await models.getByRole('menuitemradio', { name: 'Native B', exact: true }).click()
  await expect(page.locator('.new-chat-page .reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
})

test('restored global conversation shows and sends its saved effort when discovery is unavailable', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sessionId = 'saved-global-effort'
  await mockHermesApi(page, { sessions: [{
    id: sessionId, profile: 'research', source: 'coding_agent', agent: 'codex', agent_mode: 'global',
    model: 'native-b', provider: '', title: 'Saved native effort', reasoning_effort: 'high',
    started_at: 100, last_active: 101, message_count: 1,
  }] })
  await page.addInitScript(sid => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: {
      session_id: sid, messages: [{ id: 1, role: 'user', content: 'Previous message', timestamp: 100 }], isWorking: false, events: [],
    } }
  }, sessionId)
  await mockChatSocket(page)
  await page.route('**/api/coding-agents/models?*', route => route.fulfill({ status: 404, json: { error: 'Unavailable' } }))
  await page.goto(`/#/hermes/session/${sessionId}`)
  await expect(page.getByText('Previous message', { exact: true })).toBeVisible()
  const effort = page.locator('.reasoning-effort-button')
  await expect(effort).toHaveAttribute('aria-label', /high/i)
  await expect(effort.locator('.reasoning-effort-label')).toHaveText('High')
  await expect(effort).toBeDisabled()
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Keep the saved effort')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.reasoning_effort)).toBe('high')
})

test('slow first discovery shows one loading indicator and does not block native defaults', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  let finish!: () => void
  await page.route('**/api/coding-agents/models?*', async route => {
    await new Promise<void>(resolve => { finish = resolve })
    await route.fulfill({ json: { agents: [catalog] } })
  })
  try {
    await openGlobalDraft(page)
    const draft = page.locator('.new-chat-page')
    await draft.locator('.input-model-button').click()
    const models = page.locator('.model-cascader:visible')
    await expect(models).toContainText('Loading...')
    await expect(models.locator('.n-base-loading')).toHaveCount(1)
    await models.getByRole('menuitemradio', { name: 'Agent default model', exact: true }).click()
    await sendNewChatMessage(page, 'Use native defaults without waiting')
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.mode)).toBe('global')
    finish()
  } finally { finish?.() }
})

test('global native choices survive reopening and remain separate from scoped choices', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/coding-agents/models?*', route => route.fulfill({ json: { agents: [catalog] } }))
  await openGlobalDraft(page)
  await selectNativeModel(page, 'Native B')
  const draft = page.locator('.new-chat-page')
  await draft.locator('.reasoning-effort-button').click()
  await page.getByRole('slider').focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Escape')
  await selectNativeModel(page, 'Native B')
  await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await selectNewChatLaunchMode(page, 'scoped')
  await expect(draft.locator('.input-model-button')).toContainText('test-model')
  await selectNewChatLaunchMode(page, 'global')
  await expect(draft.locator('.input-model-button')).toContainText('Native B')
  await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await draft.locator('textarea').focus()
  await page.keyboard.press('Escape')
  await expect(draft).toBeHidden()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(draft.locator('.input-model-button')).toContainText('Native B')
  await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await selectNativeModel(page, 'Native Simple')
  await expect(draft.locator('.reasoning-effort-button')).toHaveCount(0)
  await sendNewChatMessage(page)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.model)).toBe('native-simple')
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.reasoning_effort)).toBeUndefined()
})

test('unavailable native catalogs allow agent defaults and refreshing the model list', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.route('**/api/coding-agents/models?*', route => route.fulfill(new URL(route.request().url()).searchParams.get('refresh') === 'true'
    ? { json: { agents: [catalog] } } : { status: 404, json: { error: 'Unavailable' } }))
  await openGlobalDraft(page)
  const draft = page.locator('.new-chat-page')
  await draft.locator('.input-model-button').click()
  const models = page.locator('.model-cascader:visible')
  await expect(models).toContainText('Models could not be loaded')
  await models.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(models).toContainText('Native B')
  await models.getByRole('menuitemradio', { name: 'Agent default model', exact: true }).click()
  await sendNewChatMessage(page)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.mode)).toBe('global')
  const payload = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload)
  expect(payload.model).toBeUndefined()
  expect(payload.reasoning_effort).toBeUndefined()
})
