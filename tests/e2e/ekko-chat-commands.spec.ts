import { test, expect } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const source of ['coding_agent', 'builtin_agent']) {
test(`Ekko ${source} sessions expose built-in commands and send the native source`, async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const sessionId = 'ekko-commands'
  const api = await mockHermesApi(page, { sessions: [{
    id: sessionId, profile: 'default', source, agent: 'ekko-agent', agent_mode: 'scoped',
    model: 'gpt-test', provider: 'openai', title: 'Ekko commands', started_at: 100, last_active: 101, message_count: 1,
  }] })
  await page.addInitScript(sid => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: { session_id: sid, messages: [{ id: 1, role: 'user', content: 'Ekko session ready', timestamp: 100 }], isWorking: false, events: [], queueLength: 0 },
    }
  }, sessionId)
  await mockChatSocket(page)
  await page.goto(`/#/hermes/session/${sessionId}`)
  await expect(page.getByText('Ekko session ready')).toBeVisible()
  await expect(page.locator('.fork-bubble-btn')).toHaveCount(0)
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('/')
  await expect(page.locator('.slash-command-name')).toHaveText(['/context', '/compact', '/usage', '/status'])
  await expect(page.locator('.slash-command-dropdown')).toContainText('Run context compression while idle')
  await expect(page.locator('.slash-command-dropdown')).not.toContainText('native CLI')
  await expect(page.locator('.context-info')).not.toContainText('Session usage:')
  await input.fill('/compact')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(1)
  const payload = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((item: any) => item.event === 'run').payload)
  expect(payload).toMatchObject({ input: '/compact', source: 'builtin_agent', agent_id: 'ekko-agent', mode: 'scoped', provider: 'openai' })
  expect(payload).not.toHaveProperty('coding_agent_id')
  await page.evaluate(sid => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('compression.started', { event: 'compression.started', session_id: sid, source: 'command', token_count: 1000 })
    socket.__trigger('compression.completed', { event: 'compression.completed', session_id: sid, compressed: true, contextTokens: 100, source: 'command' })
    socket.__trigger('session.command', { event: 'session.command', session_id: sid, source: 'ekko', command: 'compact', action: 'compact', ok: true, terminal: true, contextTokens: 100, message: 'Ekko compression complete.' })
  }, sessionId)
  await expect(page.getByText('Ekko compression complete.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
}
