import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

/**
 * Session outline Q&A index behavior:
 *  - Q = first non-empty cleaned line of the user message
 *  - A = first prose line of the answer run (markdown headings and tool rows are skipped)
 *  - load-all refetches the full session and the outline grows to cover it
 *  - clicking an entry scrolls to that message
 */
const sessionId = 'session-outline-qa-1'

const baseSession = {
  id: sessionId,
  title: 'Outline QA Review',
  source: 'cli',
  model: 'test-model',
  provider: 'test-provider',
  profile: 'research',
  workspace: '/tmp/outline-qa-review',
  started_at: 1_800_000_000,
  ended_at: null,
  last_active: 1_800_000_100,
  message_count: 3,
}

function hermesMessage(id: number, role: 'user' | 'assistant', content: string, toolCalls: unknown = null) {
  return {
    id,
    session_id: sessionId,
    role,
    content,
    tool_call_id: null,
    tool_calls: toolCalls,
    tool_name: null,
    timestamp: 1_800_000_000 + id,
    token_count: null,
    finish_reason: null,
    reasoning: null,
  }
}

// Healthy store shape: the tool-calling assistant row carries tool_calls with empty
// content (mapHermesMessages turns it into a tool row, so it must not produce an A item).
const initialMessages = [
  hermesMessage(1, 'user', '你知道 Dify 吗'),
  hermesMessage(
    2, 'assistant', '',
    [{ id: 'call_a1', function: { name: 'read_file', arguments: '{}' } }],
  ),
  // Leading markdown heading must be skipped by the A summary.
  hermesMessage(3, 'assistant', '## 结论\n\nDify 是一个开源的 LLM 应用开发平台，适合快速搭建知识库问答。'),
]

// Older turn the initial (paginated) resume did not carry — only visible after load-all.
const fullMessages = [
  hermesMessage(0, 'user', '帮我看看知识库'),
  ...initialMessages,
]

test('outline shows Q&A pairs, skips headings and tool rows, and load-all extends it', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((sid) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid,
        isWorking: false,
        events: [],
        messageLoadedCount: 3,
        messageTotal: 3,
        messages: [
          {
            id: 1,
            session_id: sid,
            role: 'user',
            content: '你知道 Dify 吗',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1_800_000_001,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 2,
            session_id: sid,
            role: 'assistant',
            content: '',
            tool_call_id: null,
            tool_calls: [{ id: 'call_a1', function: { name: 'read_file', arguments: '{}' } }],
            tool_name: null,
            timestamp: 1_800_000_002,
            token_count: null,
            finish_reason: 'tool_calls',
            reasoning: null,
          },
          {
            id: 3,
            session_id: sid,
            role: 'assistant',
            content: '## 结论\n\nDify 是一个开源的 LLM 应用开发平台，适合快速搭建知识库问答。',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1_800_000_003,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ],
      },
    }
  }, sessionId)
  await mockChatSocket(page)
  await mockHermesApi(page, { sessions: [baseSession] })

  // Load-all endpoint: return the full session.
  await page.route(`**/api/studio/sessions/hermes/${sessionId}*`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        session: {
          id: sessionId,
          title: baseSession.title,
          source: baseSession.source,
          profile: 'research',
          messages: fullMessages,
          taskPlans: [],
        },
      }),
    })
  })

  await page.goto('/#/hermes/chat')
  await expect(page.locator('.message')).toHaveCount(3)

  const headerActions = page.locator('.header-actions')
  await headerActions.getByRole('button', { name: 'Session actions' }).click()
  const option = page.locator('.n-dropdown-option:visible').filter({ hasText: 'Conversation Outline' })
  await expect(option).toBeVisible()
  await option.click()
  await expect(page.locator('.outline-panel')).toBeVisible()

  // Q&A pair: heading "## 结论" must not appear, tool row must not produce an A.
  const qItem = page.locator('.outline-item.user-item')
  await expect(qItem).toHaveCount(1)
  await expect(qItem.locator('.q-text')).toHaveText('你知道 Dify 吗')

  const aItem = page.locator('.outline-item.answer-item')
  await expect(aItem).toHaveCount(1)
  await expect(aItem.locator('.q-text')).toHaveText(
    'Dify 是一个开源的 LLM 应用开发平台，适合快速搭建知识库问答。',
  )
  await expect(page.locator('.outline-panel', { hasText: '## 结论' })).toHaveCount(0)
  await expect(page.locator('.outline-panel', { hasText: 'read_file' })).toHaveCount(0)

  // Clicking Q scrolls to the matching user message.
  await qItem.click()
  await expect
    .poll(async () => page.evaluate(() => {
      const el = document.getElementById('message-1')
      if (!el) return 'missing'
      const r = el.getBoundingClientRect()
      return r.top >= -20 && r.bottom <= window.innerHeight + 20 ? 'in-viewport' : 'outside'
    }))
    .toBe('in-viewport')

  // Load-all: the outline grows with the older turn the resume page did not carry.
  const loadAllButton = page.locator('.outline-panel .load-all-btn')
  await expect(loadAllButton).toBeVisible()
  await loadAllButton.click()
  await expect(qItem).toHaveCount(2)
  const texts = await page.locator('.outline-item.user-item .q-text').allTextContents()
  expect(texts).toContain('帮我看看知识库')
  // Answer count unchanged: the older turn added a user row only.
  await expect(aItem).toHaveCount(1)
})
