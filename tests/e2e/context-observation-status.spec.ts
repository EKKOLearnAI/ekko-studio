import { test, expect, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const sessionId = 'context-observation'

function observation(model = 'gpt-test', observedAt = Date.now()) {
  return {
    contextManager: 'bili', contextFallback: false, contextSource: 'usage', contextManagerStatus: 'active',
    contextTokens: 1200, contextWindow: 32000, contextModel: model, contextObservedAt: observedAt, contextGeneration: 'g2',
  }
}

async function openSession(page: Page, context = observation()) {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const api = await mockHermesApi(page, { sessions: [{
    id: sessionId, profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_mode: 'scoped',
    model: 'gpt-test', provider: 'openai', title: 'Context observation', started_at: 100, last_active: 101, message_count: 1,
  }] })
  await page.addInitScript(({ sid, snapshot }) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid, messages: [{ id: 1, role: 'user', content: 'Context session ready', timestamp: 100 }],
        isWorking: true, events: [], queueLength: 0, inputTokens: 900000, outputTokens: 100000,
        cacheReadTokens: 700000, ...snapshot,
      },
    }
  }, { sid: sessionId, snapshot: context })
  await mockChatSocket(page)
  const sessionsLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/studio/sessions' && response.ok())
  await page.goto(`/#/hermes/session/${sessionId}`)
  await sessionsLoaded
  await expect(page.getByText('Context session ready')).toBeVisible({ timeout: 15000 })
  return api
}

async function emit(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(({ event, payload, sid }) => {
    ;(window as any).__PW_CHAT_SOCKET__.latest.__trigger(event, { event, session_id: sid, ...payload })
  }, { event, payload, sid: sessionId })
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`context manager fallback and recovery via socket at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const api = await openSession(page)
    await expect(page.locator('.context-info')).toContainText('1.2k / 32.0k')
    await emit(page, 'context.manager', { selectedManager: 'bili', manager: 'native', fallback: true })
    await expect(page.locator('.context-status')).toHaveText('Built-in fallback')
    await expect(page.locator('.context-info')).toHaveText('Unavailable')
    await expect(page.locator('.context-bar')).toHaveCount(0)
    await expect(page.locator('.context-status')).toHaveAttribute('title', /No observation/)
    await page.screenshot({ path: testInfo.outputPath('fallback.png'), fullPage: true })
    const boxes = await page.locator('.context-info, .context-status').evaluateAll(elements => elements.map(el => {
      const box = el.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
    }))
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(viewport.width)
    }
    expect(boxes[0].right <= boxes[1].left || boxes[0].bottom <= boxes[1].top).toBe(true)
    await emit(page, 'usage.updated', { contextManager: 'native', contextFallback: true, contextSource: 'unavailable', contextManagerStatus: 'unavailable' })
    await expect(page.locator('.context-status')).toHaveText('Built-in fallback')
    await emit(page, 'context.manager', { selectedManager: 'bili', manager: 'bili', fallback: false })
    await emit(page, 'usage.updated', { ...observation(), contextGeneration: 'g3' })
    await expect(page.locator('.context-status')).toHaveText('Billion Context · Active')
    await expect(page.locator('.context-info')).toContainText('1.2k / 32.0k')
    await expect(page.locator('.context-status')).toHaveAttribute('title', /Observed usage/)
    expect(api.unexpectedRequests).toEqual([])
  })
}

test('model changes reject late old-model observations and accept the new model', async ({ page }, testInfo) => {
  const api = await openSession(page)
  await expect(page.locator('.context-info')).toContainText('1.2k / 32.0k')
  await emit(page, 'session.settings.updated', { model: 'new-model' })
  await expect(page.locator('.context-info')).toHaveText('Unavailable')
  await expect(page.locator('.context-bar')).toHaveCount(0)
  await emit(page, 'usage.updated', { ...observation(), inputTokens: 1800000 })
  await expect(page.locator('.context-info')).toHaveText('Unavailable')
  await emit(page, 'usage.updated', { ...observation('new-model'), contextGeneration: 'g3' })
  await expect(page.locator('.context-info')).toContainText('1.2k / 32.0k')
  await expect(page.locator('.context-status')).toHaveAttribute('title', /new-model/)
  await page.screenshot({ path: testInfo.outputPath('new-model.png'), fullPage: true })
  expect(api.unexpectedRequests).toEqual([])
})

test('visible context expires without another socket event', async ({ page }, testInfo) => {
  const now = Date.now()
  await page.clock.install({ time: new Date(now) })
  const api = await openSession(page, observation('gpt-test', now - 850000))
  await expect(page.locator('.context-info')).toContainText('1.2k / 32.0k')
  await page.clock.runFor(60000)
  await expect(page.locator('.context-info')).toHaveText('Unknown')
  await expect(page.locator('.context-status')).toHaveText('Billion Context · Unavailable')
  await expect(page.locator('.context-limit-observed')).toHaveCount(0)
  await expect(page.locator('.context-bar')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('expired.png'), fullPage: true })
  expect(api.unexpectedRequests).toEqual([])
})