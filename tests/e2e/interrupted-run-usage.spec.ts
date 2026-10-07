import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

for (const agent of ['codex', 'claude', 'pi', 'grok', 'cursor', 'opencode', 'dsh', 'hermes', 'ekko-agent']) {
  test(`${agent} keeps stopped and interrupted cards current before and after resume`, async ({ page }) => {
    await authenticate(page, TEST_ACCESS_KEY, 'research')
    const sid = `usage-${agent}`
    const session = { id: sid, profile: 'research', source: agent === 'hermes' ? 'cli' : 'coding_agent', agent,
      agent_mode: 'global', model: 'test-model', provider: agent === 'hermes' ? 'test-provider' : 'global',
      title: 'Interrupted usage', started_at: 100, last_active: 101, message_count: 1,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 }
    await mockHermesApi(page, { sessions: [session] })
    await page.addInitScript(sessionId => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sessionId]: {
        session_id: sessionId, messages: [{ id: 1, role: 'user', content: 'Work in progress', timestamp: 100 }],
        isWorking: true, events: [],
      } }
    }, sid)
    await mockChatSocket(page)
    await page.goto(`/#/hermes/session/${sid}`)
    await expect(page.getByText('Work in progress')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    const empty = { runId: 'first', assistantMessageId: 'reply-1', inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheHitRate: null, costUsd: null, tokensPerSecond: null, isEstimated: false }
    const first = { ...empty, inputTokens: 100, outputTokens: 12, cacheReadTokens: 40, cacheHitRate: 0.4, costUsd: 0.01, tokensPerSecond: 6, speedSource: 'model' }
    const second = { ...first, runId: 'second', assistantMessageId: 'reply-2', outputTokens: 24 }
    await page.evaluate(({ sid, usage }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'first' })
      socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'first', delta: 'Stopped reply' })
      socket.__trigger('abort.completed', { event: 'abort.completed', session_id: sid, run_id: 'first', synced: true, run_usage: usage })
    }, { sid, usage: empty })
    const cards = page.locator('.run-usage-card')
    await expect(cards).toHaveCount(1)
    await expect(page.getByText('Stopped reply', { exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)

    await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Next turn')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.some((item: any) => item.event === 'run'))).toBe(true)
    await page.evaluate(({ sid, usage, coding }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'second' })
      socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'second', delta: 'Interrupted reply' })
      socket.__trigger('run.usage.updated', { event: 'run.usage.updated', session_id: sid, run_id: 'first', run_usage: usage,
        ...(coding ? { inputTokens: 60, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 0 } : {}) })
    }, { sid, usage: first, coding: agent !== 'hermes' && agent !== 'ekko-agent' })
    await expect(cards).toHaveCount(1)
    await expect(cards.first().locator('.run-usage-value').first()).toHaveText('12')
    if (agent !== 'hermes' && agent !== 'ekko-agent') await expect(page.locator('.context-info')).toHaveText('Session usage: 112')
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
    await page.evaluate(({ sid, usage, empty }) => {
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      // Native usage can finish before the interruption event is dispatched.
      socket.__trigger('run.usage.updated', { event: 'run.usage.updated', session_id: sid, run_id: 'second', run_usage: usage })
      socket.__trigger('run.failed', { event: 'run.failed', session_id: sid, run_id: 'second', interrupted: true,
        stop_reason: 'queue_insertion', run_usage: { ...empty, runId: 'second', assistantMessageId: 'reply-2' } })
    }, { sid, usage: second, empty })
    await expect(cards).toHaveCount(2)
    await expect(cards.last().locator('.run-usage-value').first()).toHaveText('24')
    await expect(page.getByText('Interrupted reply', { exact: true })).toHaveCount(1)
    await page.addInitScript(({ sid, first, second }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sid]: { session_id: sid, isWorking: false, events: [], messages: [
        { id: 'reply-1', role: 'assistant', content: 'Stopped reply', timestamp: 100, run_usage: first },
        { id: 'reply-2', role: 'assistant', content: 'Interrupted reply', timestamp: 101, run_usage: second },
      ] } }
    }, { sid, first, second })
    await page.reload()
    await expect(cards).toHaveCount(2)
    await expect(cards.first().locator('.run-usage-value').first()).toHaveText('12')
    await expect(cards.last().locator('.run-usage-value').first()).toHaveText('24')
  })
}
