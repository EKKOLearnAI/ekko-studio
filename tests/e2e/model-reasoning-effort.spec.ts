import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'
import { selectNewChatAgent, selectNewChatLaunchMode, sendNewChatMessage } from './new-chat-helpers'

for (const [name, provider, model, metadata, max] of [
  ['GLM 5.3 advertised effort levels', 'glm', 'glm-5.3', { reasoning: true, reasoning_efforts: ['low', 'high', 'max'] }, 3],
  ['custom DeepSeek Flash advertised effort levels', 'custom:api.apikey.fun', 'deepseek-flash', { reasoning: true, reasoning_efforts: ['none', 'low', 'high', 'max'] }, 4],
  ['no reasoning support', 'test-provider', 'test-model', { reasoning: false, reasoning_efforts: [] }, 0],
  ['unknown capabilities', 'test-provider', 'test-model', {}, 7],
] as const) {
  test(`chat uses ${name} from the selected model and forwards the chosen effort`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY)
    await mockHermesApi(page, { modelGroups: [{ ...TEST_MODEL_GROUP, provider, models: [model], model_meta: { [model]: metadata } }] })
    await mockChatSocket(page)
    await page.goto('/#/hermes/chat')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await input.fill('Start a session')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run').length || 0)).toBe(1)
    await page.evaluate(() => {
      const state = (window as any).__PW_CHAT_SOCKET__
      const run = state.emitted.find((item: any) => item.event === 'run').payload
      state.latest.__trigger('run.completed', { event: 'run.completed', session_id: run.session_id, run_id: 'first-run', output: 'Ready' })
    })
    await page.locator('.reasoning-effort-button').click()
    const slider = page.getByRole('slider')
    await expect(slider).toHaveAttribute('aria-valuemax', String(max))
    if (max === 0) {
      await expect(slider).toHaveAttribute('aria-disabled', 'true')
    } else {
      await slider.focus()
      for (let step = 0; step < max; step++) await page.keyboard.press('ArrowRight')
      await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /max/i)
    }
    await page.keyboard.press('Escape')
    await expect(page.locator('.reasoning-effort-slider-popover:visible')).toHaveCount(0)
    await input.click()
    await input.fill('Use selected effort')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.filter((item: any) => item.event === 'run').length || 0)).toBe(2)
    const effort = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run')[1].payload.reasoning_effort)
    expect(effort).toBe(max ? 'max' : undefined)
  })
}

const draftGroups = [{
  ...TEST_MODEL_GROUP, models: ['reasoning-model', 'simple-model'],
  model_meta: { 'reasoning-model': { reasoning_efforts: ['low', 'high', 'max'] }, 'simple-model': { reasoning: false } },
}]

async function chooseDraftMax(page: import('@playwright/test').Page) {
  const button = page.locator('.new-chat-page .reasoning-effort-button')
  const initialColor = await button.evaluate(element => getComputedStyle(element).color)
  await button.click()
  const slider = page.getByRole('slider')
  await expect(slider).toHaveAttribute('aria-valuemax', '3')
  await slider.focus()
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
  await expect(button).toHaveAttribute('aria-label', /max/i)
  await expect(button).toHaveCSS('color', initialColor)
  await expect(page.locator('.reasoning-effort-slider-popover:visible')).toHaveCSS('--reasoning-effort-accent-color', '#ef4444')
  await page.keyboard.press('Escape')
  await expect(page.locator('.reasoning-effort-slider-popover:visible')).toHaveCount(0)
  await expect(page.locator('.new-chat-page')).toBeVisible()
}

for (const agent of ['Ekko', 'Hermes', 'Codex']) test(`${agent} new-chat forwards its selected reasoning effort on the first send`, async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { modelGroups: draftGroups })
  await mockChatSocket(page)
  const effortWrites: any[] = []
  await page.route('**/api/studio/sessions/*/reasoning-effort', async route => {
    const body = route.request().postDataJSON()
    effortWrites.push(body)
    await route.fulfill({ json: { ok: true, reasoning_effort: body.reasoningEffort } })
  })
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, agent)
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label',
    agent === 'Hermes' ? /default/i : /none/i)
  await expect(draft.locator('.new-chat-config-bar img, .new-chat-selected-agent')).toHaveCount(0)
  await chooseDraftMax(page)
  await sendNewChatMessage(page, 'Use my draft reasoning effort')
  await expect(draft).toBeHidden()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload)).toMatchObject({
    input: 'Use my draft reasoning effort', ...(agent === 'Codex' ? { managed_agent_protocol: 1 } : { model: 'reasoning-model', reasoning_effort: 'max' }),
  })
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /max/i)
  await expect(page.locator('.reasoning-effort-button')).toBeEnabled()
  expect(api.requests.filter(request => request.pathname.endsWith('/reasoning-effort') && request.method !== 'GET')).toEqual([])
  expect(effortWrites).toEqual([])
  if (agent === 'Codex') {
    expect(JSON.parse(api.requests.find(item => item.pathname === '/api/studio/agent-chats')!.postData!)).toMatchObject({ agentTypeId: 'codex', model: 'reasoning-model', reasoningEffort: 'max' })
    const sid = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.session_id)
    await page.evaluate(sid => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      const base = { session_id: sid, run_id: 'scoped-run', agent_run_id: 'scoped-run', run_marker: 'scoped-run' }
      socket.__trigger('run.started', { ...base, event: 'run.started' })
      socket.__trigger('message.persisted', { ...base, event: 'message.persisted', messages: [{ id: 1, role: 'assistant', content: 'Ready to continue.', run_marker: 'scoped-run', timestamp: 1 }] })
      socket.__trigger('run.completed', { ...base, event: 'run.completed', status: 'completed', queue_remaining: 0 })
    }, sid)
    await page.locator('.reasoning-effort-button').click()
    await page.getByRole('slider').focus()
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /low/i)
    await page.keyboard.press('Escape')
    await expect.poll(() => effortWrites.at(-1)).toEqual({ reasoningEffort: 'low' })
    const input = page.locator('.chat-input-area textarea')
    await input.fill('Continue with the new scoped effort')
    await input.press('Enter')
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').at(-1)?.payload))
      .toMatchObject({ managed_agent_protocol: 1, input: 'Continue with the new scoped effort' })
  }
  expect(api.unexpectedRequests).toEqual([])
})

test('new-chat resets unsupported effort on a model switch and preserves the original MoA visibility rules', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { modelGroups: draftGroups })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Hermes')
  await chooseDraftMax(page)
  const draft = page.locator('.new-chat-page')
  await draft.locator('.input-model-button').click()
  const models = page.locator('.model-cascader:visible')
  await expect(models.locator('.session-model-kind-field')).toHaveCount(0)
  await models.locator('.model-cascader-item').filter({ hasText: 'simple-model' }).click()
  await expect(draft.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /default/i)
  await draft.locator('.reasoning-effort-button').click()
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemax', '0')
  await expect(page.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')
  await draft.locator('textarea').click()
  await sendNewChatMessage(page)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.model)).toBe('simple-model')
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.reasoning_effort)).toBeUndefined()
})

test('new-chat global CLI mode uses native reasoning configuration', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { modelGroups: draftGroups })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Codex')
  await chooseDraftMax(page)
  await selectNewChatLaunchMode(page, 'global')
  await expect(page.locator('.new-chat-page .reasoning-effort-button')).toHaveCount(0)
  await sendNewChatMessage(page)
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload.managed_agent_protocol)).toBe(1)
  expect(JSON.parse(api.requests.find(item => item.pathname === '/api/studio/agent-chats')!.postData!)).toMatchObject({ agentTypeId: 'codex', mode: 'global' })
  expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.reasoning_effort)).toBeUndefined()
})
