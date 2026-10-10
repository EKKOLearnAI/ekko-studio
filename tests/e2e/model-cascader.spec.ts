import { expect, test, type Locator } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY, TEST_MODEL_GROUP } from './fixtures'
import { selectNewChatAgent } from './new-chat-helpers'

const modelGroups = [TEST_MODEL_GROUP, {
  ...TEST_MODEL_GROUP, provider: 'other-provider', label: 'Other Provider', models: ['other-model', 'disabled-model'],
  model_meta: { 'other-model': { alias: 'Fast model', preview: true }, 'disabled-model': { disabled: true } },
}, {
  ...TEST_MODEL_GROUP, provider: 'long-provider', label: 'Long Provider', models: Array.from({ length: 40 }, (_, index) => `long-model-${index}`),
}, {
  ...TEST_MODEL_GROUP, provider: 'moa', label: 'MoA', models: ['review-combination'],
}, ...Array.from({ length: 20 }, (_, index) => ({
  ...TEST_MODEL_GROUP, provider: `provider-${index}`, label: `Provider ${index}`, models: [`model-${index}`],
}))]
const modelAliases = { 'other-provider': { 'other-model': 'Fast model' } }

async function expectCustomFooterAnchored(menu: Locator) {
  const layout = await menu.evaluate(element => {
    const bounds = (selector: string) => element.querySelector(selector)!.getBoundingClientRect()
    const pane = bounds('.model-cascader-model-pane')
    const list = bounds('.model-cascader-models')
    const footer = bounds('.model-cascader-custom')
    const providers = bounds('.model-cascader-providers')
    const input = bounds('.model-cascader-custom .n-input')
    const confirm = bounds('.model-cascader-custom .n-button')
    return {
      leftOffset: footer.left - pane.left, rightOffset: pane.right - footer.right,
      bottomOffset: pane.bottom - footer.bottom, listGap: footer.top - list.bottom,
      providerBottomOffset: providers.bottom - pane.bottom,
      inputFits: input.left >= footer.left && input.right <= footer.right,
      confirmFits: confirm.left >= footer.left && confirm.right <= footer.right,
    }
  })
  for (const offset of [layout.leftOffset, layout.rightOffset, layout.bottomOffset, layout.listGap, layout.providerBottomOffset]) {
    expect(Math.abs(offset)).toBeLessThanOrEqual(1)
  }
  expect(layout.inputFits).toBe(true)
  expect(layout.confirmFits).toBe(true)
}

test('global model switching hides MoA while Hermes single chat retains it', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page, { modelGroups, modelAliases })
  await mockChatSocket(page)
  await page.route('**/api/hermes/config/model', route => route.fulfill({ json: { success: true } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Hermes')
  const menu = page.locator('.model-cascader:visible')
  await page.locator('.new-chat-page .input-model-button').click()
  await expect(menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' })).toBeVisible()
  await menu.getByRole('button', { name: 'Close', exact: true }).click()
  await page.locator('.page-sidebar-account-btn').click()
  await page.locator('.sidebar-account-menu .model-trigger').click()
  await expect(menu).toBeVisible()
  await expect(menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' })).toHaveCount(0)
  await menu.locator('.model-cascader-search input').fill('review-combination')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(0)
  await menu.locator('.model-cascader-search input').fill('')
  await menu.locator('.model-cascader-provider').filter({ hasText: 'Other Provider' }).click()
  const modelUpdate = page.waitForRequest(request => request.url().endsWith('/api/hermes/config/model') && request.method() === 'PUT')
  await menu.getByRole('menuitemradio').filter({ hasText: 'Fast model' }).click()
  expect((await modelUpdate).postDataJSON()).toMatchObject({ default: 'other-model', provider: 'other-provider' })
  await expect(menu).toBeHidden()
  expect(api.unexpectedRequests).toEqual([])
})

for (const [label, identity, expectedMoa] of [
  ['legacy Hermes', { source: 'cli' }, true],
  ['built-in Ekko without agent metadata', { source: 'builtin_agent' }, false],
  ['Codex', { source: 'coding_agent', agent: 'codex', agent_mode: 'scoped' }, false],
] as const) test(`existing ${label} session ${expectedMoa ? 'offers' : 'hides'} MoA models`, async ({ page }) => {
  const session = {
    id: 'model-agent-policy', title: label, profile: 'research', provider: 'test-provider', model: 'test-model',
    started_at: 100, last_active: 101, message_count: 0, ...identity,
  }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__ = { [id]: { session_id: id, messages: [], isWorking: false, messageLoadedCount: 0, messageTotal: 0 } }
  }, session.id)
  const api = await mockHermesApi(page, { sessions: [session], modelGroups })
  await mockChatSocket(page)
  await page.goto(`/#/hermes/session/${session.id}`)
  await page.locator('.input-model-button').click()
  const menu = page.locator('.model-cascader:visible')
  await expect(menu).toBeVisible()
  const moa = menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' })
  await expect(moa).toHaveCount(expectedMoa ? 1 : 0)
  if (expectedMoa) {
    await moa.click()
    await expect(menu.getByRole('menuitemradio').filter({ hasText: 'review-combination' })).toBeVisible()
  }
  expect(api.unexpectedRequests).toEqual([])
})

for (const { mobile, dark } of [{ mobile: false, dark: false }, { mobile: true, dark: false }, { mobile: false, dark: true }]) test(`chooses provider then model in a fixed-height dialog (${mobile ? 'mobile' : dark ? 'dark' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 320, height: 568 } : { width: 1280, height: 900 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(dark => localStorage.setItem('hermes_brightness', dark ? 'dark' : 'light'), dark)
  const api = await mockHermesApi(page, { modelGroups, modelAliases })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Hermes')
  const draft = page.locator('.new-chat-page')
  await draft.locator('textarea').fill('Keep my draft')
  const trigger = draft.locator('.input-model-button')
  await trigger.click()
  const menu = page.locator('.model-cascader:visible')
  const modal = page.locator('.model-cascader-modal:visible')
  const fixedHeight = mobile ? '544px' : '560px'
  await expect(menu).toBeVisible()
  await expect(modal).toHaveAttribute('role', 'dialog')
  await expect(modal).toHaveAttribute('aria-label', 'Set Session Model')
  await expect(modal.locator('.n-card-header')).toHaveCount(0)
  await expect(modal).not.toHaveClass(/n-card--bordered/)
  await expect(menu).toBeFocused()
  await expect(menu.locator('.model-cascader-search input')).not.toBeFocused()
  const rowLayout = await menu.locator('.model-cascader-search').evaluate(row => {
    const input = row.querySelector('.n-input')!.getBoundingClientRect()
    const close = row.querySelector('.model-cascader-close')!.getBoundingClientRect()
    return { centerOffset: Math.abs(input.y + input.height / 2 - close.y - close.height / 2), gap: close.x - input.right }
  })
  expect(rowLayout.centerOffset).toBeLessThanOrEqual(1)
  expect(rowLayout.gap).toBeGreaterThanOrEqual(0)
  await expect(modal).toHaveCSS('height', fixedHeight)
  await expect(menu.locator('.model-cascader-item')).toHaveCount(1)
  await menu.locator('.model-cascader-provider').filter({ hasText: 'Long Provider' }).click()
  for (const column of ['providers', 'models']) {
    expect(await menu.locator(`.model-cascader-${column}`).evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  }
  await expectCustomFooterAnchored(menu)
  await menu.locator('.model-cascader-models').evaluate(element => { element.scrollTop = element.scrollHeight })
  await expectCustomFooterAnchored(menu)
  await expect(modal).toHaveCSS('height', fixedHeight)
  await menu.locator('.model-cascader-search input').fill('no matching model')
  await expect(menu.locator('.model-cascader-empty')).toBeVisible()
  await expect(modal).toHaveCSS('height', fixedHeight)
  await menu.locator('.model-cascader-search input').fill('')
  await menu.locator('.model-cascader-provider').filter({ hasText: 'MoA' }).click()
  await expect(menu.locator('.model-cascader-custom')).toBeHidden()
  await expect(modal).toHaveCSS('height', fixedHeight)
  await menu.locator('.model-cascader-provider').filter({ hasText: 'Other Provider' }).click()
  await expect(trigger).toContainText('test-model')
  await expect(menu.getByRole('menuitemradio').filter({ hasText: 'Fast model' })).toBeVisible()
  await expect(menu.getByRole('menuitemradio').filter({ hasText: 'disabled-model' })).toBeDisabled()
  await menu.locator('.model-cascader-search input').fill('Other Provider')
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2)
  const bounds = await modal.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mobile ? 320 : 1280)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(mobile ? 568 : 900)
  await page.screenshot({ path: `/tmp/studio-model-cascader-${mobile ? 'mobile' : dark ? 'dark' : 'desktop'}.png`, animations: 'disabled' })
  await menu.getByRole('menuitemradio').filter({ hasText: 'Fast model' }).click()
  await expect(menu).toBeHidden()
  await expect(trigger).toContainText('Fast model')
  await expect(draft.locator('textarea')).toHaveValue('Keep my draft')
  expect(api.requests.filter(request => request.pathname.endsWith('/model') && request.method !== 'GET')).toEqual([])
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload))
    .toMatchObject({ provider: 'other-provider', model: 'other-model', input: 'Keep my draft' })
  expect(api.unexpectedRequests).toEqual([])
})

test('supports keyboard traversal, Escape, close and backdrop dismissal without closing the draft', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page, { modelGroups, modelAliases })
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'Hermes')
  const draft = page.locator('.new-chat-page')
  const trigger = draft.locator('.input-model-button')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const menu = page.locator('.model-cascader:visible')
  await expect(menu).toBeFocused()
  await expect(menu.locator('.model-cascader-search input')).not.toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu.locator('.model-cascader-search input')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowRight')
  await expect(menu.getByRole('menuitemradio').filter({ hasText: 'Fast model' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(trigger).toContainText('Fast model')
  await trigger.click()
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(draft).toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(menu).toBeVisible()
  await page.locator('.n-modal-mask:visible').click({ position: { x: 5, y: 5 } })
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(menu).toBeHidden()
  await expect(draft).toBeVisible()
  await expect(trigger).toBeFocused()
})
