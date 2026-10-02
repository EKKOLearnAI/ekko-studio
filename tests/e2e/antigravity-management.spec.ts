import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, mockChatSocket, TEST_ACCESS_KEY } from './fixtures'

test('Antigravity native settings are editable and unmanaged installation is explicit', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  let settings = '{"toolPermission":"request-review"}'
  await page.route('**/api/coding-agents/antigravity/config-files/*', async route => {
    const key = new URL(route.request().url()).pathname.split('/').at(-1)!
    if (route.request().method() === 'PUT' && key === 'settings') settings = route.request().postDataJSON().content
    await route.fulfill({ json: { key, content: key === 'settings' ? settings : '# User rules', path: key === 'settings' ? '~/.gemini/antigravity-cli/settings.json' : '~/.gemini/config/AGENTS.md', exists: true, language: key === 'settings' ? 'json' : 'markdown' } })
  })
  await page.goto('/#/studio/agents')
  const card = page.getByTestId('agent-card-antigravity')
  await expect(card).toContainText('Antigravity')
  await expect(card).toContainText('Install guide')
  await expect(card.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
  await page.getByTestId('agent-settings-antigravity').click()
  await expect(page).toHaveURL(/\/studio\/agents\/antigravity\/settings/)
  const editor = page.locator('.settings-editor-panel').filter({ has: page.locator('textarea[placeholder="~/.gemini/antigravity-cli/settings.json"]') })
  await editor.locator('textarea').fill('{"toolPermission":"strict"}')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => settings).toBe('{"toolPermission":"strict"}')
})

test('Antigravity picker offers scoped provider selection and global config', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const drawer = page.locator('.new-chat-drawer')
  await drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first().locator('.n-base-selection').click()
  await page.locator('.n-base-select-option:visible').filter({ hasText: /^Antigravity$/ }).click()
  await expect(drawer.locator('.new-chat-field').filter({ hasText: /^Agent/ }).first()).toContainText('Antigravity')
  await expect(drawer.locator('.new-chat-field').filter({ hasText: 'Global config' })).toHaveCount(1)
})
