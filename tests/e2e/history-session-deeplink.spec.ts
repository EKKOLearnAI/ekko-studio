import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, TEST_MODEL_GROUP } from './fixtures'

const historySessions = [
  {
    id: 'hist-alpha',
    profile: 'default',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title: 'Alpha History Session',
    preview: 'Alpha preview',
    started_at: 1_790_000_000,
    ended_at: null,
    last_active: 1_790_000_100,
    message_count: 4,
    tool_call_count: 2,
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    workspace: null,
  },
  {
    id: 'hist-beta',
    profile: 'default',
    source: 'cli',
    model: 'test-model',
    provider: 'test-provider',
    title: 'Beta History Session',
    preview: 'Beta preview',
    started_at: 1_790_000_200,
    ended_at: null,
    last_active: 1_790_000_300,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 30,
    output_tokens: 40,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    workspace: null,
  },
  {
    id: 'hist-api-server',
    profile: 'default',
    source: 'api_server',
    model: 'test-model',
    provider: 'test-provider',
    title: 'API Server History Session',
    preview: 'API Server preview',
    started_at: 1_790_000_400,
    ended_at: null,
    last_active: 1_790_000_500,
    message_count: 2,
    tool_call_count: 0,
    input_tokens: 50,
    output_tokens: 60,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: null,
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: '',
    workspace: null,
  },
]

function detailFor(id: string, sessions = historySessions) {
  const session = sessions.find(s => s.id === id)
  if (!session) return null
  const toolMessages = id === 'hist-alpha'
    ? [
        { id: 2, tool_call_id: 'history-tool-1', tool_name: 'read_file', content: '{"path":"README.md"}' },
        { id: 3, tool_call_id: 'history-tool-2', tool_name: 'search', content: '{"matches":2}' },
      ].map(tool => ({
        ...tool,
        session_id: id,
        role: 'tool',
        tool_calls: null,
        run_marker: 'history-run-1',
        timestamp: session.started_at + tool.id - 1,
        token_count: null,
        finish_reason: null,
        reasoning: null,
      }))
    : []
  const messages = [
    {
      id: 1,
      session_id: id,
      role: 'user',
      content: `Question for ${session.title}`,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      run_marker: null,
      timestamp: session.started_at,
      token_count: null,
      finish_reason: null,
      reasoning: null,
    },
    ...toolMessages,
    {
      id: id === 'hist-alpha' ? 4 : 2,
      session_id: id,
      role: 'assistant',
      content: `Answer from ${session.title}`,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      run_marker: id === 'hist-alpha' ? 'history-run-1' : null,
      timestamp: session.started_at + (id === 'hist-alpha' ? 3 : 1),
      token_count: null,
      finish_reason: null,
      reasoning: null,
    },
  ]
  return {
    ...session,
    messages,
  }
}

const defaultGroupRooms = [
    { id: 'room-new', name: 'Newest Group Room', inviteCode: null, canManage: false, lastActiveAt: 1_790_001_000 },
    { id: 'room-old', name: 'Older Group Room', inviteCode: null, canManage: false, lastActiveAt: 1_790_000_000 },
]

async function mockHistoryApi(page: Page, sessions = historySessions, groupRooms = defaultGroupRooms) {
  await page.route('**/*', async (route: Route) => {
    const request = route.request()
    const url = new URL(request.url())
    const { pathname } = url

    if (!(pathname === '/health' || pathname.startsWith('/api/'))) {
      await route.continue()
      return
    }

    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    if (pathname === '/health') return json({ status: 'ok' })
    if (pathname === '/api/auth/status') return json({ hasPasswordLogin: false, username: null })
    if (pathname === '/api/hermes/runtime-versions/jobs' && request.method() === 'GET') return json({ jobs: [] })
    if (pathname === '/api/hermes/available-models') return json({ default: 'test-model', default_provider: 'test-provider', groups: [TEST_MODEL_GROUP], allProviders: [TEST_MODEL_GROUP], model_aliases: {}, model_visibility: {} })
    if (pathname === '/api/hermes/profiles') return json({ profiles: [{ name: 'default', active: true, model: 'test-model', gateway: 'test' }] })
    if (pathname === '/api/studio/group-chat/rooms') {
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 50)
      return json({
        rooms: groupRooms.slice(offset, offset + limit),
        total: groupRooms.length,
        offset,
        limit,
        hasMore: offset + limit < groupRooms.length,
      })
    }
    const groupRoomMatch = pathname.match(/^\/api\/studio\/group-chat\/rooms\/([^/]+)$/)
    if (groupRoomMatch) {
      const roomId = decodeURIComponent(groupRoomMatch[1])
      const room = groupRooms.find(item => item.id === roomId)
      if (!room) return json({ error: 'Room not found' }, 404)
      return json({
        room,
        messages: [
          { id: `${roomId}-message`, roomId, senderId: 'user-1', senderName: 'User', content: `History for ${room.name}`, timestamp: room.lastActiveAt, role: 'user' },
        ],
        agents: [],
        members: [],
        total: 1,
        hasMore: false,
      })
    }
    if (pathname === '/api/studio/sessions/hermes/groups') {
      const limit = Number(url.searchParams.get('limit') || 20)
      const includedIds = new Set(url.searchParams.getAll('include'))
      const bySource = new Map<string, typeof sessions>()
      for (const session of sessions) {
        const group = bySource.get(session.source) || []
        group.push(session)
        bySource.set(session.source, group)
      }
      const groups = [...bySource.entries()].map(([source, group]) => {
        group.sort((a, b) => Number(b.last_active || b.started_at) - Number(a.last_active || a.started_at))
        return { source, sessions: group.slice(0, limit), hasMore: group.length > limit }
      })
      return json({
        groups,
        included: sessions.filter(session => includedIds.has(session.id)),
      })
    }
    if (pathname === '/api/studio/sessions/hermes') {
      const source = url.searchParams.get('source')
      if (!source) return json({ sessions })
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 20)
      const sourceSessions = sessions
        .filter(session => session.source === source)
        .sort((a, b) => Number(b.last_active || b.started_at) - Number(a.last_active || a.started_at))
      return json({
        sessions: sourceSessions.slice(offset, offset + limit),
        hasMore: offset + limit < sourceSessions.length,
        offset,
        limit,
      })
    }

    const detailMatch = pathname.match(/^\/api\/studio\/sessions\/hermes\/([^/]+)$/)
    if (detailMatch) {
      const detail = detailFor(decodeURIComponent(detailMatch[1]), sessions)
      return detail ? json({ session: detail }) : json({ error: 'Session not found' }, 404)
    }

    return json({ error: `Unexpected mocked route: ${request.method()} ${pathname}` }, 404)
  })
}

test.describe('history session deep links', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page)
    await mockHistoryApi(page)
  })

  test('route session id opens selected history session', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-beta')

    await expect(page.getByText('Beta History Session').first()).toBeVisible()
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()
    await expect(page).toHaveURL(/#\/hermes\/history\/session\/hist-beta$/)
  })

  test('restores the task plan independently of tool traces in paginated history', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hermes_show_tool_calls', 'false'))
    await page.route('**/api/studio/sessions/conversations/hist-beta/messages/paginated*', route => {
      const detail = detailFor('hist-beta', historySessions)!
      const taskPlan = {
        session_id: 'hist-beta', run_id: 'history-plan-run', plan_id: 'history-plan-run', revision: 3,
        execution_state: 'ended', created_at: detail.started_at * 1000, updated_at: detail.last_active * 1000,
        plan: [{ id: 'inspect', step: 'Inspect existing implementation', status: 'completed' },
          { id: 'verify', step: 'Verify remaining work', status: 'pending' }],
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        session: detail,
        messages: detail.messages.map(message => ({ ...message, run_marker: message.role === 'user' ? null : taskPlan.run_id })),
        taskPlans: [taskPlan], workspaceRunChanges: [], total: detail.messages.length, offset: 0, limit: 150, hasMore: false,
      }) })
    })
    await page.goto('/#/hermes/history/session/hist-beta')
    const card = page.getByTestId('task-plan-card')
    await expect(card).toContainText('1/2 completed')
    await expect(card).toContainText('Run ended; unfinished steps remain')
    await expect(card.locator('.pending')).toHaveCount(1)
    await page.reload()
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('1/2 completed')
    await card.screenshot({ path: test.info().outputPath('task-plan-history.png'), animations: 'disabled' })
  })

  test('completed tool runs can expand and collapse in history', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-alpha')

    const card = page.locator('.tool-run-card[data-run-id="history-run-1"]')
    const toggle = card.locator('.tool-run-header')
    await expect(card).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(card.locator('.message.tool')).toHaveCount(0)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(card.locator('.message.tool')).toHaveCount(2)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(card.locator('.message.tool')).toHaveCount(0)
  })

  test('API Server sessions are available as a History source', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-api-server')

    await expect(page.getByText('API Server History Session').first()).toBeVisible()
    await expect(page.getByText('Answer from API Server History Session')).toBeVisible()
    await expect(page.getByText('API Server', { exact: true }).first()).toBeVisible()
  })

  test('does not expose Group Chat as a History source', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-alpha')

    await expect(page.locator('.session-group-label', { hasText: 'GROUP' })).toHaveCount(0)
    await expect(page.locator('.group-room-history-item')).toHaveCount(0)
    await expect(page.getByText('Newest Group Room')).toHaveCount(0)
  })

  test('clicking another history session updates URL and reload preserves it', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-alpha')
    await expect(page.getByText('Answer from Alpha History Session')).toBeVisible()

    await page.getByText('Beta History Session').first().click()
    await expect(page).toHaveURL(/#\/hermes\/history\/session\/hist-beta\?profile=default$/)
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()

    await page.reload()
    await expect(page).toHaveURL(/#\/hermes\/history\/session\/hist-beta\?profile=default$/)
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()
  })

  test('unknown route session id falls back to base history route', async ({ page }) => {
    await page.goto('/#/hermes/history/session/missing-session')

    await expect(page).toHaveURL(/#\/hermes\/history$/)
    await expect(page.getByText('API Server History Session').first()).toBeVisible()
  })
})

test.describe('history source pagination', () => {
  const stressSessions = [
    ...historySessions,
    ...Array.from({ length: 53 }, (_, index) => ({
      ...historySessions[0],
      id: `hist-stress-${index + 1}`,
      title: `Stress History Session ${index + 1}`,
      started_at: 1_780_000_000 - index,
      last_active: 1_780_000_100 - index,
    })),
  ]

  test.beforeEach(async ({ page }) => {
    await authenticate(page)
    await mockHistoryApi(page, stressSessions)
  })

  test('loads each source group in pages and removes the control at the end', async ({ page }) => {
    await page.goto('/#/hermes/history/session/hist-beta')

    await expect(page.getByText('Stress History Session 53')).toBeHidden()
    const loadMore = page.getByRole('button', { name: 'Load more sessions' })
    await expect(loadMore).toBeVisible()
    await loadMore.hover()
    await expect(page.getByText('Load more sessions').last()).toBeVisible()

    await loadMore.click()

    await expect(page.getByText('Stress History Session 53')).toBeVisible()
    await expect(loadMore).toHaveCount(0)
  })
})


test('groups database-pinned history separately from its source', async ({ page }) => {
  await authenticate(page)
  await mockHistoryApi(page, historySessions.map(session => ({ ...session, is_pinned: session.id === 'hist-alpha' ? 1 : 0 })))
  await page.goto('/#/hermes/history')
  const pinned = page.locator('.session-group-header').filter({ hasText: 'Pinned' })
  await expect(pinned).toBeVisible()
  await expect(page.locator('.session-item').filter({ hasText: 'Alpha History Session' })).toHaveCount(1)
  await expect(page.locator('.session-item').filter({ hasText: 'Alpha History Session' }).locator('.session-item-pin')).toBeVisible()
})
