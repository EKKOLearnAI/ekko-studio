import { selectNewChatAgent, selectNewChatLaunchMode } from './new-chat-helpers'
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
  await page.route('**/api/agents/availability', route => route.fulfill({ json: {
    revision: 1, updatedAt: new Date().toISOString(), agents: [
      { id: 'ekko-agent', installed: true, source: 'built-in' },
      { id: 'antigravity', installed: true, source: 'user-cli' },
    ],
  } }))
  await page.goto('/#/hermes/chat')
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await selectNewChatAgent(page, 'Antigravity')
  await expect(draft.locator('.agent-card.active')).toContainText('Antigravity')
  await expect(draft.getByRole('radiogroup', { name: 'Launch mode', exact: true }).getByRole('radio', { name: 'Model', exact: true })).toHaveAttribute('aria-checked', 'true')
  await selectNewChatLaunchMode(page, 'global')
  await expect(draft.locator('.input-model-button')).toBeEnabled()
  await expect(draft.locator('.input-model-button')).toHaveText('Agent default model')
})

for (const mode of ['global', 'scoped']) {
  test(`search resumes unloaded Antigravity history with the correct agent (${mode})`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const api = await mockHermesApi(page, { sessions: [] })
    await mockChatSocket(page)
    const session = {
      id: `agy-search-${mode}`, profile: 'research', source: 'coding_agent',
      agent: 'antigravity', agent_mode: mode, agent_native_session_id: 'native-agy',
      provider: mode === 'global' ? 'global' : 'test-provider', model: 'test-model',
      title: 'Antigravity search history', started_at: 100, last_active: 101,
      ended_at: null, message_count: 1, input_tokens: 0, output_tokens: 0,
    }
    await page.addInitScript(sid => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [sid]: { session_id: sid, messages: [{ id: 1, role: 'assistant', content: 'Previous agy answer', timestamp: 101 }],
          isWorking: false, events: [] },
      }
    }, session.id)
    await page.route('**/api/hermes/write-gate/pending', route => route.fulfill({ json: { pending: [] } }))
    await page.route('**/api/studio/search/sessions?**', route => route.fulfill({ json: {
      results: [{ ...session, matched_message_id: null, snippet: 'Previous agy answer', rank: 1 }],
    } }))
    await page.route('**/api/studio/sessions/conversations/*/messages/paginated?**', route => route.fulfill({ json: {
      session, messages: [{ id: 1, session_id: session.id, role: 'assistant', content: 'Previous agy answer', timestamp: 101 }],
      total: 1, offset: 0, limit: 150, hasMore: false,
    } }))
    await page.goto('/#/hermes/skills')
    await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible()
    await page.keyboard.press('Control+k')
    await page.locator('.session-search-modal input').fill('Antigravity')
    await page.locator('.session-search-modal .result-item').filter({ hasText: session.title }).click()
    await expect(page).toHaveURL(new RegExp(`/hermes/session/${session.id}$`))
    await expect(page.getByText('Previous agy answer', { exact: true })).toBeVisible()
    await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Continue this conversation')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted
      .filter((item: any) => item.event === 'run').at(-1)?.payload)).toMatchObject({
      session_id: session.id, coding_agent_id: 'antigravity', mode,
    })
    expect(api.unexpectedRequests).toEqual([])
  })
}
