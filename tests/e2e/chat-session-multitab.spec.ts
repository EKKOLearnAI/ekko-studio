import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

type SessionSeed = {
  id: string
  title: string
  lastActive: number
}

function sessionSummary({ id, title, lastActive }: SessionSeed) {
  return {
    id,
    profile: 'research',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title,
    preview: title,
    started_at: lastActive - 10,
    ended_at: null,
    last_active: lastActive,
    message_count: 1,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'estimated',
  }
}

function resumePayload(sessionId: string, content: string) {
  return {
    session_id: sessionId,
    messages: [
      {
        id: 1,
        session_id: sessionId,
        role: 'user',
        content,
        timestamp: Date.now() / 1000,
        tool_call_id: null,
        tool_calls: null,
        tool_name: null,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      },
    ],
    isWorking: false,
    events: [],
  }
}

const sessions = [
  sessionSummary({ id: 'session-a', title: 'Alpha chat', lastActive: 100 }),
  sessionSummary({ id: 'session-b', title: 'Beta chat', lastActive: 200 }),
]

const resumes = {
  'session-a': resumePayload('session-a', 'Alpha route content'),
  'session-b': resumePayload('session-b', 'Beta route content'),
}

async function setupChatPage(page: Page) {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((payload) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = payload
    window.localStorage.setItem('hermes_active_session_research', 'session-b')
  }, resumes)
  const api = await mockHermesApi(page, { sessions })
  await mockChatSocket(page)
  return api
}

async function sendChatMessage(page: Page, message: string) {
  const input = page.getByPlaceholder(inputPlaceholder)
  await expect(input).toBeVisible()
  await input.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
}

async function waitForRun(page: Page, index = 0) {
  const handle = await page.waitForFunction((runIndex) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    const run = runs[runIndex]
    return run ? run.payload : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

test('route session id wins over shared active-session localStorage', async ({ page }) => {
  const api = await setupChatPage(page)
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const bubble = document.querySelector('.message.user .message-bubble')
      if (!bubble) return
      ;(window as any).__PW_INITIAL_CHAT_BUBBLE_TEXT__ = bubble.textContent?.trim()
      observer.disconnect()
    })
    observer.observe(document, { childList: true, subtree: true })
  })

  await page.goto('/#/hermes/session/session-a')

  await expect(page.getByText('Alpha route content')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__PW_INITIAL_CHAT_BUBBLE_TEXT__)).toBe('Alpha route content')
  await expect(page.getByText('Beta route content')).toHaveCount(0)
  await expect(page).toHaveURL(/#\/hermes\/session\/session-a$/)
  expect(api.unexpectedRequests).toEqual([])
})

test('two tabs can show different sessions and keep them after reload', async ({ context }) => {
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  const apiA = await setupChatPage(pageA)
  const apiB = await setupChatPage(pageB)

  await pageA.goto('/#/hermes/session/session-a')
  await pageB.goto('/#/hermes/session/session-b')

  await expect(pageA.getByText('Alpha route content')).toBeVisible()
  await expect(pageB.getByText('Beta route content')).toBeVisible()

  await pageA.reload()
  await pageB.reload()

  await expect(pageA.getByText('Alpha route content')).toBeVisible()
  await expect(pageB.getByText('Beta route content')).toBeVisible()
  await expect(pageA).toHaveURL(/#\/hermes\/session\/session-a$/)
  await expect(pageB).toHaveURL(/#\/hermes\/session\/session-b$/)
  expect(apiA.unexpectedRequests).toEqual([])
  expect(apiB.unexpectedRequests).toEqual([])
})

test('parallel tabs send runs and render progress only for their own session', async ({ context }) => {
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  const apiA = await setupChatPage(pageA)
  const apiB = await setupChatPage(pageB)

  await pageA.goto('/#/hermes/session/session-a')
  await pageB.goto('/#/hermes/session/session-b')
  await expect(pageA.getByText('Alpha route content')).toBeVisible()
  await expect(pageB.getByText('Beta route content')).toBeVisible()

  await sendChatMessage(pageA, 'Question for Alpha')
  await sendChatMessage(pageB, 'Question for Beta')

  const runA = await waitForRun(pageA)
  const runB = await waitForRun(pageB)
  expect(runA.session_id).toBe('session-a')
  expect(runB.session_id).toBe('session-b')

  await pageA.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-a' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-a', delta: 'Alpha progress' })
  }, runA.session_id)
  await pageB.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-b' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-b', delta: 'Beta progress' })
  }, runB.session_id)

  await expect(pageA.getByText('Alpha progress')).toBeVisible()
  await expect(pageA.getByText('Beta progress')).toHaveCount(0)
  await expect(pageB.getByText('Beta progress')).toBeVisible()
  await expect(pageB.getByText('Alpha progress')).toHaveCount(0)
  expect(apiA.unexpectedRequests).toEqual([])
  expect(apiB.unexpectedRequests).toEqual([])
})
