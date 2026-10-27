import { expect, test, type Route } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

function sessionSummary(
  id: string,
  title: string,
  lastActive: number,
  categoryId: number | null = 1,
  overrides: Record<string, unknown> = {},
) {
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
    category_id: categoryId,
    ...overrides,
  }
}

test('nests fork sessions and persists the parent collapse state', async ({ page }, testInfo) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript(() => {
    localStorage.setItem('hermes_recent_sessions_collapsed_v1', 'true')
    localStorage.setItem('hermes_chat_collapsed_categories', '[]')
  })
  await mockHermesApi(page, {
    sessionCategories: [{ id: 1, name: 'Work' }],
    sessions: [
      sessionSummary('child-new', 'Forked investigation', 400, 1, {
        parent_session_id: 'root', fork_point_message_id: '12',
      }),
      sessionSummary('child-old', 'Forked alternative', 300, 1, {
        parent_session_id: 'root', fork_point_message_id: '13',
      }),
      sessionSummary('root', 'Root conversation', 200),
      sessionSummary('orphan', 'Orphan fork', 150, null, {
        parent_session_id: 'missing-parent', fork_point_message_id: '14',
      }),
    ],
  })
  await page.route('**/api/studio/sessions/conversations/*/messages/paginated*', (route: Route) => {
    const sessionId = route.request().url().match(/conversations\/([^/]+)\/messages/)?.[1] || ''
    return route.fulfill({
      json: {
        session: sessionSummary(sessionId, sessionId, 400, 1, {
          parent_session_id: sessionId === 'child-new' ? 'root' : null,
          fork_point_message_id: sessionId === 'child-new' ? '12' : null,
        }),
        messages: [{ id: 1, session_id: sessionId, role: 'user', content: 'Fork child input', timestamp: 100 }],
        total: 1,
        offset: 0,
        limit: 150,
        hasMore: false,
      },
    })
  })
  await mockChatSocket(page)
  await page.addInitScript(() => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = Object.fromEntries(
      ['root', 'child-new', 'child-old', 'orphan'].map(sessionId => [
        sessionId,
        { session_id: sessionId, messages: [], isWorking: false, events: [] },
      ]),
    )
  })

  await page.goto('/#/hermes/chat')
  const sidebar = page.locator('.chat-panel > .session-list')
  const parentRow = sidebar.locator('.session-item').filter({ hasText: 'Root conversation' })
  const toggle = parentRow.locator('.session-item-children-toggle')
  const newChild = sidebar.locator('.session-item').filter({ hasText: 'Forked investigation' })
  const oldChild = sidebar.locator('.session-item').filter({ hasText: 'Forked alternative' })

  await expect(parentRow).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(toggle).toHaveText('2')
  await expect(newChild).toHaveClass(/session-item--fork-child/)
  await expect(oldChild).toHaveClass(/session-item--fork-child/)
  await expect(newChild.locator('.session-item-fork-marker')).toBeVisible()
  await expect(sidebar.locator('.session-item').filter({ hasText: 'Orphan fork' })).not.toHaveClass(/session-item--fork-child/)
  await expect(sidebar.locator('.session-group-header').filter({ hasText: 'Work' }).locator('.session-group-count')).toHaveText('3')
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('fork-sidebar-expanded.png') })

  await toggle.click()
  await expect(newChild).toHaveCount(0)
  await expect(oldChild).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_chat_collapsed_fork_sessions'))).toContain('root')

  await page.reload()
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.locator('.session-item').filter({ hasText: 'Forked investigation' })).toHaveCount(0)

  await toggle.press('Enter')
  await expect(newChild).toBeVisible()
  await expect(oldChild).toBeVisible()
  await expect.poll(() => page.evaluate(() => localStorage.getItem('hermes_chat_collapsed_fork_sessions'))).toBe('[]')

  await newChild.click()
  await expect(page).toHaveURL(/\/hermes\/session\/child-new$/)
  await expect(newChild).toHaveClass(/active/)
})
