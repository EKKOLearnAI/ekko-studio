import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const resumed of [false, true]) {
  test(`Pi cumulative usage updates from terminal events (${resumed ? 'resumed mobile' : 'new desktop'} run)`, async ({ page }) => {
    if (resumed) await page.setViewportSize({ width: 390, height: 844 })
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const sessionId = 'pi-cumulative'
    const api = await mockHermesApi(page, { sessions: [{
      id: sessionId, profile: 'research', source: 'coding_agent', agent: 'pi', agent_mode: 'global',
      model: '', provider: 'global', title: 'Pi cumulative usage', started_at: 100, last_active: 101, message_count: 1,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    }] })
    await page.addInitScript(({ sid, working }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        [sid]: { session_id: sid, messages: [{ id: 1, role: 'user', content: 'Pi session ready', timestamp: 100 }],
          isWorking: working, events: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    }, { sid: sessionId, working: resumed })
    await mockChatSocket(page)
    await page.goto(`/#/hermes/session/${sessionId}`)
    await expect(page.getByText('Pi session ready')).toBeVisible()
    await expect(page.locator('.context-info')).toHaveText('Session usage: 0')

    for (const index of [1, 2]) {
      if (!resumed || index === 2) {
        await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill(`Pi turn ${index}`)
        await page.getByRole('button', { name: 'Send', exact: true }).click()
        await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((item: any) => item.event === 'run').length))
          .toBe(resumed ? 1 : index)
      }
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
      await page.evaluate(({ sid, turn }) => {
        const socket = (window as any).__PW_CHAT_SOCKET__.latest
        const runId = `pi-${turn}`
        socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: runId })
        socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: runId, delta: `Pi answer ${turn}` })
        const event = turn === 1 ? 'run.completed' : 'run.failed'
        // Pi sends these ledger totals before its deferred usage.updated event.
        socket.__trigger(event, { event, session_id: sid, run_id: runId,
          inputTokens: turn * 10, outputTokens: turn * 2, cacheReadTokens: turn * 5, cacheWriteTokens: turn * 3,
          ...(turn === 1 ? { output: 'Pi answer 1' } : { error: 'Pi provider failed after measured usage' }),
        })
      }, { sid: sessionId, turn: index })
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
      await expect(page.locator('.context-info')).toHaveText(`Session usage: ${index * 20}`)
    }
    expect(api.unexpectedRequests).toEqual([])
  })
}
