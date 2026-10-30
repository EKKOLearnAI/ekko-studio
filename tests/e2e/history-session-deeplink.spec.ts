import { expect, test, type Page, type Route } from '@playwright/test'
import { authenticate, mockChatSocket, TEST_MODEL_GROUP } from './fixtures'

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
        const source = url.searchParams.get('agent_groups') === '1'
          && ['ekko', 'ekko-agent', 'ekko_agent'].includes((session as { agent?: string }).agent || '')
          && ['coding_agent', 'cli', 'api_server'].includes(session.source) ? 'builtin_agent' : session.source
        const group = bySource.get(source) || []
        group.push(session)
        bySource.set(source, group)
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
        .filter(session => {
          const builtin = url.searchParams.get('agent_groups') === '1'
            && ['ekko', 'ekko-agent', 'ekko_agent'].includes((session as { agent?: string }).agent || '')
            && ['coding_agent', 'cli', 'api_server'].includes(session.source)
          return (builtin ? 'builtin_agent' : session.source) === source
        })
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
  await mockChatSocket(page)
}

test.describe('history session deep links', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page)
    await mockHistoryApi(page)
  })

  test('covers the whole page until list and legacy detail are ready, ignoring stale switches', async ({ page }) => {
    let releaseList!: () => void
    let releaseDetail!: () => void
    let releaseOld!: () => void
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    const detailGate = new Promise<void>(resolve => { releaseDetail = resolve })
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve })
    let detailRequested = false
    let oldRequested = false
    await page.route('**/api/studio/sessions/hermes/groups?**', async route => { await listGate; await route.fallback() })
    await page.route(/\/api\/studio\/sessions\/hermes\/hist-beta(?:\?.*)?$/, async route => {
      detailRequested = true
      await detailGate
      await route.fallback()
    })
    await page.route(/\/api\/studio\/sessions\/hermes\/hist-alpha(?:\?.*)?$/, async route => {
      oldRequested = true
      await oldGate
      await route.fallback()
    })
    await page.goto('/#/hermes/history/session/hist-beta')
    const overlay = page.locator('.history-panel > .page-loading-overlay')
    await expect(overlay.locator('.studio-loading-logo')).toBeVisible()
    await expect(page.locator('.history-panel > .page-loading-content')).toHaveAttribute('inert', '')
    releaseList()
    await expect.poll(() => detailRequested).toBe(true)
    await expect(overlay).toBeVisible()
    expect(await overlay.boundingBox()).toEqual(await page.locator('.history-panel').boundingBox())
    await expect.poll(() => overlay.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    await expect(overlay.locator('.studio-loading-logo')).toHaveCSS('height', '72px')
    await overlay.locator('img').evaluate((image: HTMLImageElement) => image.decode())
    await page.screenshot({ path: '/tmp/studio-history-page-loading.png', animations: 'disabled' })
    releaseDetail()
    await expect(overlay).toHaveCount(0)
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()

    await page.evaluate(() => { location.hash = '#/hermes/history/session/hist-alpha' })
    await expect.poll(() => oldRequested).toBe(true)
    await expect(overlay).toHaveCount(0)
    await expect(page.locator('.history-panel > .page-loading-content')).not.toHaveAttribute('inert', '')
    await page.evaluate(() => { location.hash = '#/hermes/history/session/hist-beta' })
    await expect(overlay).toHaveCount(0)
    const oldResponse = page.waitForResponse(response => /\/sessions\/hermes\/hist-alpha(?:\?|$)/.test(response.url()))
    releaseOld()
    await oldResponse
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
    await expect(page.getByText('Answer from Beta History Session')).toBeVisible()
    await expect(page.getByText('Answer from Alpha History Session')).toHaveCount(0)
  })

  test('releases full-page loading when history detail fails', async ({ page }) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    await page.route(/\/api\/studio\/sessions\/hermes\/hist-beta(?:\?.*)?$/, async route => {
      await gate
      await route.fulfill({ status: 503, json: { error: 'History unavailable' } })
    })
    await page.goto('/#/hermes/history/session/hist-beta')
    const overlay = page.locator('.history-panel > .page-loading-overlay')
    await expect(overlay).toBeVisible()
    release()
    await expect(overlay).toHaveCount(0)
    await expect(page.locator('.history-panel')).toHaveAttribute('aria-busy', 'false')
    await expect(page.getByText('Session not found', { exact: true })).toBeVisible()
    await page.getByText('Alpha History Session', { exact: true }).click()
    await expect(page.getByText('Answer from Alpha History Session')).toBeVisible()
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

test('legacy Ekko history has a builtin group, native identity and independent pagination', async ({ page }) => {
  await authenticate(page)
  const native = Array.from({ length: 55 }, (_, i) => ({
    ...historySessions[0], id: `hist-ekko-${i}`, source: i % 2 ? 'cli' : 'coding_agent',
    agent: ['ekko-agent', 'ekko', 'ekko_agent'][i % 3], agent_mode: 'scoped',
    title: `Native Ekko History ${i}`, last_active: 1_790_010_000 - i,
  }))
  const coding = Array.from({ length: 55 }, (_, i) => ({
    ...historySessions[0], id: `hist-codex-${i}`, source: 'coding_agent', agent: 'codex',
    title: `External Codex History ${i}`, last_active: 1_790_020_000 - i,
  }))
  await mockHistoryApi(page, [...native, ...coding])
  await page.goto('/#/hermes/history/session/hist-ekko-0')
  await expect(page.getByText('Answer from Native Ekko History 0')).toBeVisible()
  await expect(page.locator('.source-badge')).toHaveText('Built-in Agent')
  const builtinHeader = page.locator('.session-group-header').filter({ hasText: 'Built-in Agent' })
  const codingHeader = page.locator('.session-group-header').filter({ hasText: 'Coding Agent' })
  await expect(builtinHeader).toBeVisible()
  await expect(codingHeader).toBeVisible()
  await expect(page.getByText('Native Ekko History 54', { exact: true })).toHaveCount(0)
  const requested = page.waitForRequest(request => {
    const url = new URL(request.url())
    return url.pathname === '/api/studio/sessions/hermes' && url.searchParams.get('source') === 'builtin_agent'
  })
  await builtinHeader.getByRole('button', { name: 'Load more sessions' }).click()
  const url = new URL((await requested).url())
  expect(url.searchParams.get('offset')).toBe('50')
  expect(url.searchParams.get('agent_groups')).toBe('1')
  await expect(page.getByText('Native Ekko History 54', { exact: true })).toBeVisible()
  await expect(builtinHeader.getByRole('button', { name: 'Load more sessions' })).toHaveCount(0)
  await expect(codingHeader.getByRole('button', { name: 'Load more sessions' })).toBeVisible()
  await expect(page.locator('.source-badge')).toHaveText('Built-in Agent')
})

for (const width of [1440, 390]) {
  test(`opens history batch selection from the search menu at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page)
    await mockHistoryApi(page)
    await page.goto('/#/hermes/history/session/hist-alpha')
    await expect(page.getByText('Answer from Alpha History Session')).toBeVisible()
    if (width < 769) await page.getByRole('button', { name: 'Menu', exact: true }).click()
    const sidebar = page.locator(width < 769 ? '.studio-mobile-drawer .session-list' : '.history-panel .session-list')
    await expect(sidebar).toBeVisible()
    await expect(sidebar.getByRole('button', { name: 'New Chat', exact: true })).toHaveCount(0)
    if (width < 769) {
      await expect(page.locator('.studio-mobile-drawer')).toHaveCSS('width', '351px')
      const content = page.locator('.studio-mobile-navigation__content')
      expect((await sidebar.boundingBox())!.width).toBeCloseTo((await content.boundingBox())!.width, 2)
    } else {
      await expect(sidebar).toHaveCSS('width', '240px')
    }
    const more = sidebar.getByRole('button', { name: 'Session list actions', exact: true })
    await expect(sidebar.locator('.session-list-toolbar')).toHaveCount(0)
    await expect(sidebar.locator('.page-sidebar-top')).toHaveCSS('border-bottom-width', '0px')
    expect((await more.boundingBox())!.y).toBe((await sidebar.getByRole('button', { name: 'Search', exact: true }).boundingBox())!.y)
    await more.press('Enter')
    await expect(page.getByText('Filter by Profile', { exact: true })).toHaveCount(0)
    await page.getByText('Batch selection', { exact: true }).click()
    const toolbar = sidebar.locator('.session-list-toolbar')
    await expect(toolbar).toContainText('0 selected')
    const selectAll = toolbar.getByRole('button', { name: 'Select all', exact: true })
    await selectAll.click()
    await expect(toolbar).toContainText('3 selected')
    await expect(selectAll).toHaveAttribute('aria-pressed', 'true')
    await expect(toolbar.getByRole('button', { name: 'Cancel', exact: true })).toHaveText('')
    await sidebar.locator('.page-sidebar-top').hover({ position: { x: 2, y: 2 } })
    expect(await toolbar.getByRole('button', { name: 'Delete', exact: true }).evaluate(element => getComputedStyle(element).color))
      .toBe(await selectAll.evaluate(element => getComputedStyle(element).color))
    await page.screenshot({ animations: 'disabled', path: `/tmp/studio-history-batch-${width}.png` })
    await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Delete 3 selected sessions?', { exact: true })).toBeVisible()
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Cancel', exact: true }).click()
    await selectAll.click()
    await expect(toolbar).toContainText('0 selected')
    await expect(selectAll).toHaveAttribute('aria-pressed', 'false')
    await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(toolbar).toHaveCount(0)
    await expect(sidebar.locator('.session-item-checkbox')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width < 769) {
      await page.locator('.studio-mobile-drawer').getByRole('button', { name: 'Close', exact: true }).click()
      await expect(page.locator('.studio-mobile-drawer')).not.toBeVisible()
    }
  })
}

for (const width of [1280, 390]) {
  test(`history virtual messages fill the pane and stay scrollable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 })
    await authenticate(page)
    await mockHistoryApi(page)
    const detail = detailFor('hist-beta')!
    const messages = Array.from({ length: 180 }, (_, index) => ({
      ...detail.messages[index % 2], id: index + 1,
      content: `History message ${index + 1}\n\n${'A longer historical message for checking viewport layout. '.repeat(10)}`,
      timestamp: detail.started_at + index,
    }))
    await page.route('**/api/studio/sessions/conversations/hist-beta/messages/paginated*', route => route.fulfill({ json: {
      session: detail, messages, total: messages.length, offset: 0, limit: 180, hasMore: false,
    } }))
    await page.goto('/#/hermes/history/session/hist-beta')
    await expect(page.locator('.history-panel')).toHaveAttribute('aria-busy', 'false')
    const scroller = page.locator('.history-panel .virtual-message-list')
    await expect(scroller).toBeVisible()
    const pane = page.locator('.history-panel .chat-main')
    await expect(pane).toHaveCSS('margin', '0px')
    await expect(pane).toHaveCSS('border-top-width', '0px')
    await expect(pane).toHaveCSS('border-radius', '0px')
    await expect(pane).toHaveCSS('box-shadow', 'none')
    const panelBounds = (await page.locator('.history-panel').boundingBox())!
    const listBounds = (await scroller.boundingBox())!
    expect(listBounds.x + listBounds.width).toBe(panelBounds.x + panelBounds.width)
    expect(listBounds.y + listBounds.height).toBe(panelBounds.y + panelBounds.height)
    if (width > 768) {
      expect(listBounds.y).toBe(panelBounds.y)
      expect(listBounds.x).toBe(panelBounds.x + 240)
      const toggle = page.locator('.studio-page-header .history-sidebar-toggle')
      await toggle.click()
      await expect.poll(async () => (await scroller.boundingBox())?.x).toBe(panelBounds.x)
      await expect(pane).toHaveCSS('margin', '0px')
      await toggle.click()
      await expect.poll(async () => (await scroller.boundingBox())?.x).toBe(panelBounds.x + 240)
    }
    await page.screenshot({ path: `/tmp/studio-history-layout-${width}.png`, animations: 'disabled' })
    await expect.poll(() => scroller.evaluate(el => el.clientHeight)).toBeGreaterThan(600)
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1000)
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(5)
    await scroller.hover()
    await page.mouse.wheel(0, -500)
    await expect.poll(() => scroller.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(400)
    const viewport = await scroller.boundingBox()
    expect(viewport!.x + viewport!.width).toBeLessThanOrEqual(width)
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true)
  })
}

// repair-release@2 S2: the History caller pages by stored rows only and keeps passive-notice metadata.
const noticeSession = { ...historySessions[1], id: 'hist-notice', title: 'Notice History Session', message_count: 200, started_at: 10, last_active: 2000 }
const noticeStored = Array.from({ length: 200 }, (_, index) => ({
  id: index + 1, session_id: 'hist-notice', role: index % 2 ? 'assistant' : 'user', content: `Stored row ${index + 1}`,
  tool_call_id: null, tool_calls: null, tool_name: null, run_marker: null, timestamp: (index + 1) * 10,
  token_count: null, finish_reason: null, reasoning: null,
}))
function historyNotice(id: number, timestamp: number, view: Record<string, unknown>, content = '') {
  return {
    id: `studio-notice-${id}`, session_id: 'hist-notice', role: 'system', display_role: 'system', content, timestamp,
    studio_notice: { kind: 'cron', notification_id: id, disposition: 'notified', job_id: `job-${id}`, job_name: `Job ${id}`,
      execution_id: `exec-${id}`, status: 'completed', success: true, reason: null, error: null, truncated: false, finished_at: null, ...view },
  }
}
// Notices: three in the newest page (a result, an empty-answer failure, a status-only run), one
// between the two pages (gap), one equal to the older page's newest row, and one in the oldest page.
const historyNotices = [
  historyNotice(1, 1995, {}, 'Newest page result'),
  historyNotice(5, 1985, { status: 'failed', success: false, error: 'Synthetic provider failure' }),
  historyNotice(6, 1975, { disposition: 'status_only', status: 'completed', success: null, reason: 'output_unavailable_for_runtime' }),
  historyNotice(2, 505, {}, 'Gap result'),
  historyNotice(3, 500, {}, 'Equal timestamp result'),
  historyNotice(4, 15, {}, 'Oldest page result'),
]
// Mirrors the server: stored rows by id DESC with offset/limit; a notice belongs to the page whose
// interval (timestamp of the next older stored row, timestamp of the page's newest row] contains it.
function noticePage(offset: number, limit: number) {
  const newestFirst = [...noticeStored].reverse()
  const stored = newestFirst.slice(offset, offset + limit)
  const upper = offset > 0 ? newestFirst[offset]?.timestamp ?? Infinity : Infinity
  const lower = newestFirst[offset + stored.length]?.timestamp ?? -Infinity
  const notices = historyNotices.filter(notice => notice.timestamp > lower && notice.timestamp <= upper)
  const messages = [...stored.reverse(), ...notices].sort((a, b) => a.timestamp - b.timestamp)
  return { session: noticeSession, messages, taskPlans: [], workspaceRunChanges: [], total: noticeStored.length, offset, limit,
    hasMore: offset + stored.length < noticeStored.length }
}

for (const { name, width, height } of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'mobile', width: 390, height: 844 }]) {
  test(`history pages every stored row and passive notice once, with notice metadata (${name})`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height })
    await authenticate(page)
    await mockHistoryApi(page, [...historySessions, noticeSession])
    const offsets: number[] = []
    await page.route('**/api/studio/sessions/conversations/hist-notice/messages/paginated*', route => {
      const url = new URL(route.request().url())
      const offset = Number(url.searchParams.get('offset') || 0)
      offsets.push(offset)
      return route.fulfill({ json: noticePage(offset, Number(url.searchParams.get('limit') || 150)) })
    })
    await page.goto('/#/hermes/history/session/hist-notice')
    await expect(page.locator('#message-200')).toBeAttached()

    // Attribution, the known error of an empty-answer failure, and the status-only explanation.
    await expect(page.locator('#message-studio-notice-1 .studio-notice-header')).toContainText('Scheduled task “Job 1” finished')
    const failed = page.locator('#message-studio-notice-5 .studio-notice-header')
    await expect(failed).toContainText('Scheduled task “Job 5” failed')
    await expect(failed.locator('.studio-notice-detail')).toHaveText('Synthetic provider failure')
    const statusOnly = page.locator('#message-studio-notice-6 .studio-notice-header')
    await expect(statusOnly).toContainText('Scheduled task “Job 6” finished')
    await expect(statusOnly.locator('.studio-notice-detail')).toHaveText('Result unavailable for this runtime (script-only job); status only.')
    const box = await failed.boundingBox()
    expect(box && box.x + box.width).toBeLessThanOrEqual(width)

    // Load the older page as a user would, by scrolling to the top.
    const list = page.locator('.history-panel .virtual-message-list')
    await list.hover()
    await expect.poll(async () => { await page.mouse.wheel(0, -4000); return offsets.length }, { timeout: 30_000 }).toBeGreaterThan(1)
    // The older page starts after the 150 stored rows, never after stored rows plus notices.
    expect(offsets).toEqual([0, 150])

    // Every stored row and notice is in the list exactly once, in timestamp order: the list index of
    // each rendered row equals its position among all 200 rows and 6 notices (notice after an
    // equal-timestamp row). A skipped or duplicated item shifts every later index.
    const all = [...noticeStored, ...historyNotices].sort((a, b) => a.timestamp - b.timestamp || (a.studio_notice ? 1 : 0) - (b.studio_notice ? 1 : 0))
    const expectedIndex = (id: string) => all.findIndex(item => String(item.id) === id)
    const indexOf = (id: string) => page.locator(`.virtual-row:has(> * #message-${id}), .virtual-row:has(#message-${id})`).first().getAttribute('data-virtual-index')
    const reveal = async (id: string, deltaY: number) => {
      const row = page.locator(`#message-${id}`)
      await expect.poll(async () => {
        if (await row.count() === 0) await page.mouse.wheel(0, deltaY)
        return row.count()
      }, { timeout: 30_000 }).toBe(1)
      expect(Number(await indexOf(id))).toBe(expectedIndex(id))
    }
    await reveal('1', -4000)
    await reveal('studio-notice-4', -4000)
    await reveal('200', 4000)
    await reveal('studio-notice-1', 4000)
    expect(all).toHaveLength(206)
    expect(offsets).toEqual([0, 150])
  })
}
