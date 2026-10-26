import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'
import { selectNewChatAgent, selectNewChatLaunchMode, sendNewChatMessage } from './new-chat-helpers'

for (const mobile of [false, true]) test(`OpenCode global errors show the provider message and survive reload (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sessions: Record<string, unknown>[] = []
  const api = await mockHermesApi(page, { sessions })
  await mockChatSocket(page)
  await page.route('**/api/agents/availability', route => route.fulfill({ json: { revision: 1, agents: [
    { id: 'ekko-agent', installed: true, source: 'built-in' },
    { id: 'opencode', installed: true, source: 'user-cli' },
  ] } }))
  await page.route('**/api/coding-agents', route => route.fulfill({ json: { tools: [{ id: 'opencode', installed: true }] } }))
  const model = 'opencode/ling-3.0-flash-fin-free'
  await page.route('**/api/coding-agents/models?*', route => route.fulfill({ json: { agents: [{
    agentId: 'opencode', name: 'OpenCode', status: 'ready', source: 'cli', scope: 'configured',
    models: [{ id: model, name: model }], checkedAt: '2026-10-11T00:00:00.000Z', cached: false,
  }] } }))
  await page.goto('/#/hermes/chat')
  if (mobile) await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New Chat', exact: true }).click()
  await selectNewChatAgent(page, 'OpenCode')
  await selectNewChatLaunchMode(page, 'global')
  await page.locator('.new-chat-page .input-model-button').click()
  await page.locator('.model-cascader:visible').getByRole('menuitemradio', { name: model, exact: true }).click()
  await sendNewChatMessage(page, 'OpenCode global test')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.find((item: any) => item.event === 'run')?.payload))
    .toMatchObject({ coding_agent_id: 'opencode', mode: 'global', model })
  const sessionId = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload.session_id)
  const message = 'Upstream request failed: Model is unavailable.'
  // The server's native-error normalization is covered by opencode-run.test.ts.
  await page.evaluate(({ sid, error }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'opencode-failed' })
    socket.__trigger('run.failed', { event: 'run.failed', session_id: sid, run_id: 'opencode-failed', error })
  }, { sid: sessionId, error: message })
  await expect(page.getByText(`Error: ${message}`, { exact: true })).toBeVisible()
  await expect(page.getByText('[object Object]', { exact: true })).toHaveCount(0)
  sessions.push({ id: sessionId, profile: 'research', source: 'coding_agent', agent: 'opencode', agent_mode: 'global',
    model, provider: 'global', title: 'OpenCode global test', started_at: 100, last_active: 101, message_count: 2 })
  await page.addInitScript(({ sid, error }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: {
      session_id: sid, isWorking: false, events: [], messages: [
        { id: 1, role: 'user', content: 'OpenCode global test', timestamp: 100 },
        { id: 2, role: 'assistant', content: error, finish_reason: 'error', timestamp: 101 },
      ],
    } }
  }, { sid: sessionId, error: message })
  await page.reload()
  await page.goto(`/#/hermes/session/${sessionId}`)
  await expect(page.getByText(message, { exact: true })).toBeVisible()
  await expect(page.getByText('[object Object]', { exact: true })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
