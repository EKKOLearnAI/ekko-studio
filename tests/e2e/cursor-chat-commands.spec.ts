import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const mobile of [false, true]) {
  test(`Cursor chat keeps per-session usage through refresh and switching (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const sessionId = 'cursor-commands'
    const current = {
      id: sessionId, profile: 'research', source: 'coding_agent', agent: 'cursor', agent_mode: 'global',
      model: '', provider: '', title: 'Cursor commands', started_at: 100, last_active: 101, message_count: 1,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    }
    const other = { ...current, id: 'cursor-other', title: 'Other Cursor session', input_tokens: 5000, output_tokens: 1000, cache_read_tokens: 2000 }
    const api = await mockHermesApi(page, { sessions: [current, other] })
    await page.addInitScript(sid => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [sid]: {
          session_id: sid, messages: [{ id: 1, role: 'user', content: 'Cursor session ready', timestamp: 100 }],
          isWorking: false, events: [],
        },
        'cursor-other': {
          session_id: 'cursor-other', messages: [{ id: 2, role: 'user', content: 'Other session ready', timestamp: 100 }],
          isWorking: false, events: [], inputTokens: 5000, outputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 0,
        },
      }
    }, sessionId)
    await mockChatSocket(page)
    await page.goto(`/#/hermes/session/${sessionId}`)
    await expect(page.getByText('Cursor session ready')).toBeVisible()
    await expect(page.locator('.context-info')).toHaveText('Session usage: 0')

    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await input.fill('/')
    await expect(page.locator('.slash-command-name')).toHaveText(['/usage', '/status'])
    await input.fill('/con')
    await expect(page.locator('.slash-command-dropdown')).toHaveCount(0)

    const results = [
      { command: 'context', available: false, messageKey: 'nativeContextUnknown',
        message: 'Context: unknown. Current native context usage and its limit are not available.',
        contextTokens: null, contextWindow: null, contextPercent: null },
      { command: 'usage', available: false, messageKey: 'nativeUsageUnknown',
        message: 'Usage: unknown. No native token usage has been reported for this session.',
        inputTokens: null, outputTokens: null, totalTokens: null },
      { command: 'usage', available: true, messageKey: 'nativeUsage',
        message: 'Usage: input 24003, output 474, cache read 20736, cache write 0, total 45213 tokens.',
        inputTokens: 24003, outputTokens: 474, cacheReadTokens: 20736, cacheWriteTokens: 0, totalTokens: 45213 },
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
    await expect(page.locator('.context-info')).toHaveText('Session usage: 45.2k')

    // The server summary must carry the ledger totals on the next list refresh.
    Object.assign(current, { input_tokens: 24003, output_tokens: 474, cache_read_tokens: 20736 })
    const refreshed = page.waitForResponse(response => response.url().includes('/api/studio/sessions') && response.request().method() === 'GET')
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await refreshed
    await expect(page.locator('.context-info')).toHaveText('Session usage: 45.2k')

    await page.evaluate(() => { window.location.hash = '/hermes/session/cursor-other' })
    await expect(page.getByText('Other session ready')).toBeVisible()
    await expect(page.locator('.context-info')).toHaveText('Session usage: 8.0k')
    await page.evaluate(sid => { window.location.hash = `/hermes/session/${sid}` }, sessionId)
    await expect(page.getByText('Cursor session ready')).toBeVisible()
    await expect(page.locator('.context-info')).toHaveText('Session usage: 45.2k')
    await page.reload()
    await expect(page.getByText('Cursor session ready')).toBeVisible()
    await expect(page.locator('.context-info')).toHaveText('Session usage: 45.2k')
    expect(api.unexpectedRequests).toEqual([])
  })
}
