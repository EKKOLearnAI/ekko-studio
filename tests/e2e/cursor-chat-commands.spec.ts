import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

test('Cursor chat renders unknown context and native usage including caches', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const sessionId = 'cursor-commands'
  const api = await mockHermesApi(page, { sessions: [{
    id: sessionId, profile: 'research', source: 'coding_agent', agent: 'cursor', agent_mode: 'global',
    model: '', provider: '', title: 'Cursor commands', started_at: 100, last_active: 101, message_count: 1,
  }] })
  await page.addInitScript(sid => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: {
      session_id: sid, messages: [{ id: 1, role: 'user', content: 'Cursor session ready', timestamp: 100 }],
      isWorking: false, events: [],
    } }
  }, sessionId)
  await mockChatSocket(page)
  await page.goto(`/#/hermes/session/${sessionId}`)
  await expect(page.getByText('Cursor session ready')).toBeVisible()

  const results = [
    { command: 'context', available: false, messageKey: 'nativeContextUnknown',
      message: 'Context: unknown. Current native context usage and its limit are not available.',
      contextTokens: null, contextWindow: null, contextPercent: null },
    { command: 'usage', available: false, messageKey: 'nativeUsageUnknown',
      message: 'Usage: unknown. No native token usage has been reported for this session.',
      inputTokens: null, outputTokens: null, totalTokens: null },
    { command: 'usage', available: true, messageKey: 'nativeUsage',
      message: 'Usage: input 123, output 45, cache read 67, cache write 8, total 243 tokens.',
      inputTokens: 123, outputTokens: 45, cacheReadTokens: 67, cacheWriteTokens: 8, totalTokens: 243 },
  ]
  for (const [index, result] of results.entries()) {
    await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill(`/${result.command}`)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length)).toBe(index + 1)
    await page.evaluate(({ sid, payload }) => {
      ;(window as any).__PW_CHAT_SOCKET__.latest.__trigger('session.command', {
        event: 'session.command', session_id: sid, action: payload.command, terminal: true, ok: true, ...payload,
        // The client should render the localized data, not this fallback text.
        message: 'Server fallback text',
      })
    }, { sid: sessionId, payload: result })
    await expect(page.getByText(result.message, { exact: true })).toBeVisible()
  }
  await expect(page.getByText('Server fallback text', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/0 \/ 256000/)).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})
