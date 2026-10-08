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
    const drawer = page.locator('.new-chat-drawer')
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()).toContainText('Ekko')
    await drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first().locator('.n-base-selection').click()
    await expect(page.locator('.n-base-select-option__content:visible')).toHaveText(agentLabels)
    await page.locator('.n-base-select-option:visible').filter({ hasText: /^Qwen Code$/ }).click()
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()).toContainText('Qwen Code')
    await expect(drawer.locator('.new-chat-field').filter({ hasText: 'Global config' })).toHaveCount(1)
    await expect(drawer.getByRole('radio', { name: 'Provider and model', exact: true })).toBeChecked()
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Models/ })).toBeVisible()
    await drawer.locator('.n-radio-button').filter({ hasText: 'Global config' }).click()
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Models/ })).toHaveCount(0)
    await drawer.locator('.n-radio-button').filter({ hasText: 'Provider and model' }).click()
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Models/ })).toBeVisible()
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.reload()
    if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()
    await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()).toContainText('Qwen Code')
    await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
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
  const drawer = page.locator('.new-chat-drawer')
  const agent = drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()
  await expect(agent).toContainText('Hermes')
  await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => localStorage.getItem('hermes_new_chat_agent_v1'))).toBe('codex')
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(drawer).toBeHidden()
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
  const drawer = page.locator('.new-chat-drawer')
  await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()).toContainText('Ekko')
  await expect(drawer.getByRole('button', { name: 'Create', exact: true })).toBeEnabled()
})
