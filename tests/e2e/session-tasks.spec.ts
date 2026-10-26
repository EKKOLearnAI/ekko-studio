import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const now = Date.now()
const session = { id: 'task-chat', profile: 'research', source: 'coding_agent', agent: 'codex', title: 'Studio task conversation',
  started_at: 1, last_active: now / 1000, ended_at: null, message_count: 620, tool_call_count: 0,
  model: 'test-model', provider: 'test-provider', input_tokens: 0, output_tokens: 0 }
const rows = [
  { id: 'open', session_id: session.id, session_title: session.title, profile: session.profile, source: session.source, agent: session.agent,
    title: 'Design task list', summary: 'Keep the list simple on desktop and mobile', status: 'open', updated_at: now, message_id: 51 },
  { id: 'done', session_id: session.id, session_title: session.title, profile: session.profile, source: session.source, agent: session.agent,
    title: 'Fix GitHub build', summary: 'Tests and build passed', status: 'completed', updated_at: now - 60_000, message_id: 53 },
]

async function setup(page: Page, options: Parameters<typeof mockHermesApi>[1] = {}) {
  await authenticate(page)
  await mockHermesApi(page, { sessions: [session], ...options })
  await mockChatSocket(page)
  await page.route('**/api/studio/session-tasks?**', route => {
    const query = new URL(route.request().url()).searchParams
    expect(query.get('profile')).toBe('')
    const search = query.get('search')?.toLowerCase() || ''
    const tasks = rows.filter(t => (!query.get('status') || query.get('status') === t.status) && `${t.title} ${t.summary}`.toLowerCase().includes(search))
    return route.fulfill({ json: { tasks, total: tasks.length, has_more: false } })
  })
}

test('opens the task drawer from the single-chat header and filters inside the table header', async ({ page }) => {
  await setup(page)
  await page.goto('/#/hermes/chat')
  await page.locator('.chat-header').getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(2)
  await expect(page.locator('.studio-navigation-rail').getByRole('link', { name: 'Tasks', exact: true })).toHaveCount(0)
  await expect(page.locator('.session-tasks-drawer')).toBeVisible()
  await expect(page.locator('.session-tasks-drawer .sidebar, .session-tasks-drawer .page-header')).toHaveCount(0)
  await page.getByRole('button', { name: 'Filter task status' }).click()
  await page.getByRole('menuitem', { name: 'Completed', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(1)
  await expect(page.locator('.task-row')).toContainText('Fix GitHub build')
  await page.keyboard.press('Control+k')
  const search = page.getByRole('textbox', { name: 'Search tasks or conversations' })
  await expect(search).toBeFocused()
  await search.fill('no match')
  await expect(page.locator('.session-tasks-drawer').getByRole('status')).toContainText('No matching tasks')
  await expect(page.locator('.session-search-modal')).toHaveCount(0)
  await search.press('Escape')
  await expect(page.locator('.task-row')).toHaveCount(1)
  await page.getByRole('button', { name: 'Updated' }).click()
  await expect(page).toHaveURL(/taskOrder=oldest/)
})

for (const listed of [true, false]) {
  test(`task link loads old turn, highlights it and survives reload (listed: ${listed})`, async ({ page }) => {
    const messages = Array.from({ length: 620 }, (_, i) => ({ id: i + 1, role: i % 2 ? 'assistant' : 'user',
      content: `Historical task message ${i + 1}`, timestamp: i + 1 }))
    await page.addInitScript(({ sessionId, messages }) => {
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sessionId]: { session_id: sessionId, messages: messages.slice(-150),
        isWorking: false, events: [], messageTotal: messages.length, messageLoadedCount: 150, hasMoreBefore: true } }
    }, { sessionId: session.id, messages })
    await setup(page, { sessions: listed ? [session] : [] })
    await page.route(`**/api/studio/sessions/${session.id}?*`, route => route.fulfill({ json: { session } }))
    await page.route('**/api/studio/sessions/conversations/*/messages/paginated?**', route => {
      const query = new URL(route.request().url()).searchParams
      expect(query.get('profile')).toBe('research')
      const offset = Number(query.get('offset'))
      const end = messages.length - offset
      const start = Math.max(0, end - Number(query.get('limit')))
      return route.fulfill({ json: { session, messages: messages.slice(start, end), total: messages.length, offset, hasMore: start > 0 } })
    })
    await page.goto('/#/hermes/tasks?status=open')
    await page.getByRole('link', { name: 'View in conversation: Design task list' }).click()
    await expect(page).toHaveURL(/hermes\/session\/task-chat\?profile=research&message=51/)
    await expect(page.locator('#message-51.highlight')).toBeInViewport()
    await page.reload()
    await expect(page.locator('#message-51.highlight')).toBeInViewport()
    // A different target in the same chat must not be ignored.
    await page.evaluate(() => { location.hash = location.hash.replace('message=51', 'message=53') })
    await expect(page.locator('#message-53.highlight')).toBeInViewport()
    await page.goBack()
    await page.goBack()
    await expect(page).toHaveURL(/hermes\/chat\?tasks=1&taskStatus=open/)
    await expect(page.locator('.task-row')).toHaveCount(1)
  })
}

test('shows loading, error with retry, and an empty ledger without a misleading completion state', async ({ page }) => {
  await setup(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let fail = true
  await page.route('**/api/studio/session-tasks?**', async route => {
    if (fail) {
      await gate
      return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    }
    return route.fulfill({ json: { tasks: [], total: 0, has_more: false } })
  })
  await page.goto('/#/hermes/tasks')
  await expect(page.locator('.session-tasks-drawer').getByRole('status')).toContainText('Loading tasks')
  release()
  await expect(page.locator('.session-tasks-drawer').getByRole('status')).toContainText('Could not load tasks')
  fail = false
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.locator('.session-tasks-drawer').getByRole('status')).toContainText('Tasks recorded in your conversations will appear here')
})

test('warns when a deleted message cannot be located and keeps its conversation open', async ({ page }) => {
  await page.addInitScript(sessionId => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { [sessionId]: { session_id: sessionId,
      messages: [{ id: 620, role: 'assistant', content: 'Remaining conversation', timestamp: 620 }], isWorking: false, events: [], hasMoreBefore: false } }
  }, session.id)
  await setup(page)
  await page.goto('/#/hermes/session/task-chat?profile=research&message=51')
  await expect(page.getByText('The linked message is unavailable. The conversation has been opened.')).toBeVisible()
  await expect(page.getByText('Remaining conversation', { exact: true })).toBeVisible()
})

for (const brightness of ['light', 'dark'] as const) {
  for (const wallpaper of [false, true]) {
    test(`mobile task list and menu follow ${brightness} theme (wallpaper: ${wallpaper})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await setup(page, { theme: { brightness,
        ...(wallpaper ? { background: { name: 'tasks.png', mime: 'image/png', updatedAt: 1 } } : {}),
        appearance: { global: { opacity: 0.4 }, regions: { card: { backgroundColor: '#204060', opacity: 0, blur: 12, radius: 14 }, overlay: { backgroundColor: '#304050', opacity: 0.6, blur: 12 } } },
      } })
      await page.goto('/#/hermes/tasks')
      await expect(page.locator('.task-row')).toHaveCount(2)
      await expect(page.locator('.session-tasks-drawer')).toHaveCSS('background-color', 'rgba(48, 64, 80, 0.6)')
      await expect(page.locator('.task-list')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(page.locator('.session-tasks-drawer')).toHaveCSS('border-radius', '0px')
      await expect(page.locator('.session-tasks-drawer')).toHaveCSS('backdrop-filter', /blur\(12px\)/)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await expect(page.locator('.mobile-source').first()).toBeVisible()
      await expect(page.locator('.source-column').first()).toBeHidden()
      await page.getByRole('button', { name: 'Change task status: Design task list' }).click()
      await expect(page.getByRole('menuitem', { name: 'Completed', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: 'Closed', exact: true })).toBeVisible()
      await page.screenshot({ path: `/tmp/ekko-task-mobile-${brightness}-${wallpaper}.png`, animations: 'disabled' })
    })
  }
}
