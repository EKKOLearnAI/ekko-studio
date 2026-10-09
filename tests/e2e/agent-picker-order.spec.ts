import { selectNewChatAgent, selectNewChatLaunchMode } from './new-chat-helpers'
import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const agentLabels = ['Ekko', 'Hermes', 'Codex', 'Qwen Code']

for (const mobile of [false, true]) {
  test(`single-chat only lists installed Agents in catalog order (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: 'qwen', installed: true }] } }))
    await page.route('**/api/agents/availability', route => route.fulfill({ json: {
      revision: 1, updatedAt: new Date().toISOString(), agents: [
        { id: 'hermes', installed: true, source: 'user-cli' },
        { id: 'ekko-agent', installed: true, source: 'built-in' },
        { id: 'claude-code', installed: false, source: 'not-installed' },
        { id: 'codex', installed: true, source: 'user-cli' },
        { id: 'qwen', installed: true, source: 'user-cli' },
      ],
    } }))
    await page.goto('/#/hermes/chat')
    if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    const draft = page.locator('.new-chat-page')
    await expect(draft.locator('.agent-card.active')).toContainText('Ekko')
    await expect(draft.locator('.agent-card-name')).toHaveText(agentLabels)
    await selectNewChatAgent(page, 'Qwen Code')
    await expect(draft.locator('.agent-card.active')).toContainText('Qwen Code')
    const launch = draft.getByRole('radiogroup', { name: 'Launch mode', exact: true })
    const model = launch.getByRole('radio', { name: 'Model', exact: true })
    const global = launch.getByRole('radio', { name: 'Global', exact: true })
    await expect(model).toHaveAttribute('aria-checked', 'true')
    await expect(draft.locator('.input-model-button')).toBeVisible()
    await selectNewChatLaunchMode(page, 'global')
    await selectNewChatLaunchMode(page, 'global')
    await expect(draft.locator('.input-model-button')).toBeDisabled()
    await selectNewChatLaunchMode(page, 'scoped')
    await expect(draft.locator('.input-model-button')).toBeVisible()
    await model.focus()
    await page.keyboard.press('ArrowRight')
    await expect(global).toHaveAttribute('aria-checked', 'true')
    await expect(global).toBeFocused()
    await page.keyboard.press('Home')
    await expect(model).toHaveAttribute('aria-checked', 'true')
    await expect(model).toBeFocused()
    await page.keyboard.press('End')
    await expect(global).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
    await expect(draft).toBeVisible()
    await selectNewChatLaunchMode(page, 'scoped')
    await draft.locator('textarea').focus()
    await page.keyboard.press('Escape')
    await page.reload()
    if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect(draft.locator('.agent-card.active')).toContainText('Qwen Code')
    await draft.locator('textarea').fill('Hello')
    await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  })
}

test('a saved unavailable Agent falls back to the first installed option and is restored when available', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => localStorage.setItem('hermes_new_chat_agent_v1', 'codex'))
  await mockHermesApi(page)
  await mockChatSocket(page)
  let codexInstalled = false
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: [
      { id: 'ekko-agent', installed: false, source: 'not-installed' },
      { id: 'hermes', installed: true, source: 'user-cli' },
      { id: 'codex', installed: codexInstalled, source: codexInstalled ? 'user-cli' : 'not-installed' },
    ],
  } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  const agent = draft.locator('.agent-card.active')
  await expect(agent).toContainText('Hermes')
  await draft.locator('textarea').fill('Hello')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => localStorage.getItem('hermes_new_chat_agent_v1'))).toBe('codex')
  await draft.locator('textarea').focus()
  await page.keyboard.press('Escape')
  await expect(draft).toBeHidden()
  codexInstalled = true
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await expect(agent).toContainText('Codex')
})

test('an unknown cached Agent falls back to the first option', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => localStorage.setItem('hermes_new_chat_agent_v1', 'removed-agent'))
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await expect(draft.locator('.agent-card.active')).toContainText('Ekko')
  await draft.locator('textarea').fill('Hello')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})
