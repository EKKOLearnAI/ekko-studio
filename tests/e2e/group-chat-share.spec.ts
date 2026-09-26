import { expect, test, type Page, type Route } from '@playwright/test'

const sharedRoom = {
  id: 'room-shared',
  name: 'Shared Planning Room',
  inviteCode: null,
  canManage: false,
  summaryProfile: 'default',
  summaryProvider: 'test-provider',
  summaryModel: 'test-model',
  summaryApiMode: 'chat_completions',
  summaryEveryTurns: 20,
  totalTokens: 10,
  workspace: '',
}

const previewPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nZQAAAAASUVORK5CYII=',
  'base64',
)

async function mockInviteSocket(page: Page, joinFailure: { code: string, error: string } | null = null, workerContent = 'How can I help?', withTools = false, historyCards: unknown[] = []) {
  const joinFailureJson = JSON.stringify(joinFailure)
  await page.route('**/node_modules/.vite/**/socket__io-client.js*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
const state = window.__PW_SHARED_GROUP_SOCKET__ || (window.__PW_SHARED_GROUP_SOCKET__ = { options: null, emitted: [] })
const joinFailure = ${joinFailureJson}
export function io(url, options) {
  state.options = options
  const listeners = new Map()
  const socket = {
    id: 'shared-socket-1',
    connected: true,
    on(event, handler) {
      const handlers = listeners.get(event) || []
      handlers.push(handler)
      listeners.set(event, handlers)
      return this
    },
    once(event, handler) {
      const wrapped = (...args) => {
        this.off(event, wrapped)
        handler(...args)
      }
      return this.on(event, wrapped)
    },
    off(event, handler) {
      if (!handler) listeners.delete(event)
      else listeners.set(event, (listeners.get(event) || []).filter(item => item !== handler))
      return this
    },
    emit(event, payload, ack) {
      state.emitted.push({ event, payload })
      if (event === 'join' && typeof ack === 'function') {
        if (joinFailure) {
          ack(joinFailure)
          return this
        }
        ack({
          roomId: 'room-shared',
          roomName: 'Shared Planning Room',
          members: [{ id: 'member-1', userId: 'guest-1', name: 'Guest', description: '', joinedAt: 1 }],
          messages: [...${JSON.stringify(historyCards)}, {
            id: 'shared-message-1',
            roomId: 'room-shared',
            senderId: 'member-owner',
            senderName: 'Owner',
            content: 'Welcome to the shared room',
            timestamp: 1,
            role: 'user',
          }, ...${JSON.stringify(withTools ? [{
            id: 'shared-tool-1', roomId: 'room-shared', senderId: 'agent-worker',
            senderName: 'Worker', role: 'tool', run_id: 'shared-run',
            content: 'File contents', timestamp: 2, tool_name: 'read_file',
            tool_call_id: 'read-call',
          }] : [])}, {
            id: 'shared-message-2',
            roomId: 'room-shared',
            senderId: 'agent-worker',
            senderName: 'Worker',
            run_id: 'shared-run',
            content: ${JSON.stringify(workerContent)},
            timestamp: 3,
            role: 'assistant',
          }],
          agents: [{
            id: 'room-agent-worker',
            roomId: 'room-shared',
            agentId: 'agent-worker',
            agent: 'hermes',
            profile: 'default',
            provider: 'test-provider',
            model: 'test-model',
            apiMode: 'chat_completions',
            reasoningEffort: '',
            name: 'Worker',
            description: '',
            avatar: '',
            invited: 1,
          }],
          rooms: ['room-shared'],
          total: ${withTools ? 3 : 2},
          offset: 0,
          limit: ${withTools ? 3 : 2},
          hasMore: false,
          typingUsers: [],
          contextStatuses: [],
        })
      }
      if (event === 'message' && typeof ack === 'function') ack({ id: payload && payload.id })
      return this
    },
    __trigger(event, payload) { for (const handler of listeners.get(event) || []) handler(payload) },
    disconnect() {
      this.connected = false
      return this
    },
  }
  state.socket = socket
  return socket
}
export default { io }
`,
    })
  })
}

async function mockInviteApi(page: Page, valid = true, delayMs = 0) {
  const protectedRequests: string[] = []
  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url())
    if (!url.pathname.startsWith('/api/')) {
      await route.fallback()
      return
    }

    if (url.pathname === '/api/studio/group-chat/rooms/join/ROOM1') {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
      await route.fulfill({
        status: valid ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(valid ? { room: sharedRoom } : { error: 'Room not found' }),
      })
      return
    }

    if (
      route.request().method() === 'POST' &&
      url.pathname === '/api/studio/group-chat/invites/ROOM1/attachments'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          files: [{
            name: 'visitor-image.png',
            path: '0123456789abcdef0123456789abcdef.png',
          }],
        }),
      })
      return
    }

    if (
      route.request().method() === 'GET' &&
      url.pathname === '/api/studio/group-chat/invites/ROOM1/attachments/0123456789abcdef0123456789abcdef.png'
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: previewPng,
      })
      return
    }

    protectedRequests.push(url.pathname)
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Unauthorized' }),
    })
  })
  return protectedRequests
}

test.describe('invite-only group chat share page', () => {
  test('folds group tool calls with the same summary used in single chat', async ({ page }) => {
    const reply = 'Read the project files. ' + 'The tool summary should fill the existing message bubble. '.repeat(6)
    await mockInviteSocket(page, null, reply, true)
    await mockInviteApi(page)
    await page.goto('/#/share/group-chat/ROOM1')
    await page.locator('#group-chat-guest-name input').fill('Visitor')
    await page.getByRole('button', { name: 'Enter room' }).click()

    const card = page.locator('.group-agent-run').filter({ has: page.locator('.tool-run-card') })
    const toggle = card.locator('.tool-run-header')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText('read_file')
    await expect(card.locator('.run-tool-list')).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(card.locator('.run-tool-item')).toHaveCount(1)
    await expect(card.locator('.run-tool-list')).toBeVisible()
    await card.locator('.tool-line').click()
    await expect(card.locator('.tool-details')).toContainText('File contents')
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await expect.poll(() => card.locator('.tool-run-card').evaluate(element => {
        const summary = element.getBoundingClientRect()
        const bubble = element.closest('.run-card')!.getBoundingClientRect()
        const header = element.querySelector('.tool-run-header')!.getBoundingClientRect()
        const list = element.querySelector('.run-tool-list')!.getBoundingClientRect()
        const style = getComputedStyle(element)
        const innerWidth = summary.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        return Math.abs(summary.width - bubble.width) < 0.75
          && Math.abs(header.width - innerWidth) < 0.75 && Math.abs(list.width - innerWidth) < 0.75
          && element.scrollWidth <= element.clientWidth
      }), { message: `Tool summary and expanded calls fill the bubble at ${width}px` }).toBe(true)
    }
    await toggle.press('Enter')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(card.locator('.run-tool-list')).toHaveCount(0)
    await expect(page.getByText(reply.trim(), { exact: true })).toBeVisible()
  })

  test('loads an Agent Markdown image through the room invite without filesystem API access', async ({ page }) => {
    await mockInviteSocket(page, null, 'Here is the image: ![result](/Users/owner/workspace/agent-result.png)')
    const protectedRequests = await mockInviteApi(page)
    await page.route('**/api/studio/group-chat/invites/ROOM1/attachments/agent-result.png*', route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: previewPng }))
    await page.goto('/#/share/group-chat/ROOM1')
    await page.locator('#group-chat-guest-name input').fill('Visitor')
    await page.getByRole('button', { name: 'Enter room' }).click()
    const picture = page.locator('.markdown-body img[alt="result"]')
    await expect(picture).toHaveAttribute('src', /\/invites\/ROOM1\/attachments\/agent-result\.png$/)
    await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    expect(protectedRequests).toEqual([])
  })
  test('joins one room without login, app sidebar, room list, or protected API calls', async ({ page }) => {
    await mockInviteSocket(page)
    const protectedRequests = await mockInviteApi(page, true, 300)

    await page.goto('/#/share/group-chat/ROOM1')

    await expect(page.locator('#group-chat-guest-name input')).toBeVisible()
    await expect(page.locator('.guest-avatar-editor')).toBeVisible()
    await page.locator('.guest-avatar-file').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: previewPng,
    })
    await page.locator('#group-chat-guest-name input').fill('Visitor')
    await page.getByRole('button', { name: 'Enter room' }).click()
    await expect(page.locator('.invite-loading')).toBeVisible()
    await expect(page.locator('.invite-card')).toHaveCount(0)
    await expect(page.locator('.room-title-text')).toHaveText('Shared Planning Room')
    await expect(page.getByText('Welcome to the shared room')).toBeVisible()
    await expect(page.locator('.room-sidebar')).toHaveCount(0)
    await expect(page.locator('.header-sidebar-toggle')).toHaveCount(0)
    await expect(page.locator('.app-layout > .sidebar')).toHaveCount(0)
    await expect(page.locator('.file-input-hidden')).toHaveCount(1)
    await expect(page.locator('.input-settings-button')).toHaveCount(0)
    await expect(page.locator('.speech-bubble-btn')).toHaveCount(0)
    await page.locator('.agent-avatar-rail-item[aria-label="Worker"]').click()
    await expect(page.locator('.input-textarea')).toHaveValue('@Worker ')
    await page.locator('.input-textarea').fill('')
    await page.locator('.file-input-hidden').setInputFiles({
      name: 'visitor-image.png',
      mimeType: 'image/png',
      buffer: previewPng,
    })
    await expect(page.locator('.attachment-preview.image')).toBeVisible()
    await page.locator('.send-button').click()
    await expect(page.locator('.msg-attachment-thumb')).toBeVisible()
    await expect(page.locator('.msg-attachment-thumb')).toHaveAttribute(
      'src',
      /\/api\/studio\/group-chat\/invites\/ROOM1\/attachments\/0123456789abcdef0123456789abcdef\.png/,
    )
    expect(protectedRequests).toEqual([])

    const socketState = await page.evaluate(() => (window as any).__PW_SHARED_GROUP_SOCKET__)
    const socketAuth = socketState?.options?.auth
    expect(socketAuth).toMatchObject({ inviteCode: 'ROOM1' })
    expect(socketAuth.token).toBeUndefined()
    const joinEvent = socketState?.emitted?.find((event: any) => event.event === 'join')
    expect(JSON.parse(joinEvent?.payload?.avatar || '{}')).toMatchObject({ type: 'image' })
    const messageEvent = socketState?.emitted?.find((event: any) => event.event === 'message')
    expect(messageEvent?.payload?.content).toEqual([
      expect.objectContaining({
        type: 'image',
        path: '0123456789abcdef0123456789abcdef.png',
      }),
    ])
  })

  test('shows an invite error without redirecting to account login', async ({ page }) => {
    await mockInviteSocket(page)
    await mockInviteApi(page, false)

    await page.goto('/#/share/group-chat/ROOM1')

    await page.locator('#group-chat-guest-name input').fill('Visitor')
    await page.getByRole('button', { name: 'Enter room' }).click()
    await expect(page.locator('.invite-error')).toBeVisible()
    await expect(page).toHaveURL(/#\/share\/group-chat\/ROOM1$/)
    await expect(page.locator('.invite-card')).toBeVisible()
  })

  test('keeps the name step open when another participant already uses that name', async ({ page }) => {
    await mockInviteSocket(page, {
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })
    await mockInviteApi(page)

    await page.goto('/#/share/group-chat/ROOM1')
    await page.locator('#group-chat-guest-name input').fill('Worker')
    await page.getByRole('button', { name: 'Enter room' }).click()

    await expect(page.locator('.invite-error')).toHaveText(/already in use/i)
    await expect(page.locator('#group-chat-guest-name input')).toHaveValue('Worker')
    await expect(page.locator('.group-chat-panel')).toHaveCount(0)
  })
})

const groupPlan = (revision: number, agent = 'worker') => ({
  id: `plan-${agent}`, roomId: 'room-shared', senderId: `agent-${agent}`, senderName: agent,
  role: 'tool', tool_name: 'task_plan', tool_call_id: `plan-${agent}`, run_id: 'shared-run', timestamp: 2,
  content: JSON.stringify({ session_id: `session-${agent}`, run_id: 'shared-run', plan_id: 'plan', revision,
    execution_state: revision > 1 ? 'interrupted' : 'running', created_at: 2, updated_at: revision + 2,
    plan: [{ id: 'a', step: `Inspect ${agent}`, status: revision > 1 ? 'completed' : 'in_progress' },
      { id: 'b', step: 'Verify results', status: 'pending' }] }),
})

test('group task cards survive history reload and live stale updates with tool traces hidden', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('hermes_show_tool_calls', 'false'))
  await mockInviteSocket(page, null, 'Task output', false, [groupPlan(2)])
  await mockInviteApi(page)
  await page.goto('/#/share/group-chat/ROOM1')
  await page.locator('#group-chat-guest-name input').fill('Visitor')
  await page.getByRole('button', { name: 'Enter room' }).click()
  const cards = page.getByTestId('task-plan-card')
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText('1/2 completed')
  await page.evaluate(message => (window as any).__PW_SHARED_GROUP_SOCKET__.socket.__trigger('message', message), groupPlan(1))
  await expect(cards).toContainText('1/2 completed')
  await page.evaluate(message => (window as any).__PW_SHARED_GROUP_SOCKET__.socket.__trigger('message', message), groupPlan(1, 'reviewer'))
  await expect(cards).toHaveCount(2)
  await expect(page.locator('.group-agent-run').filter({ hasText: 'Task output' }).getByTestId('task-plan-card')).toHaveCount(1)
  await page.evaluate(() => {
    const state = (window as any).__PW_SHARED_GROUP_SOCKET__
    state.socket.__trigger('message', { id: 'short-self', roomId: 'room-shared', senderId: state.options.auth.userId,
      senderName: 'Visitor', role: 'user', content: 'OK', timestamp: 4 })
  })
  await expect(page.locator('.group-message.self .msg-content')).toContainText('OK')
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => cards.evaluateAll(elements => elements.every(element => {
      const card = element.getBoundingClientRect()
      const container = element.parentElement!.getBoundingClientRect()
      const run = element.closest('.group-agent-run')!.getBoundingClientRect()
      const column = element.closest('.run-column')!.getBoundingClientRect()
      const gaps = [card.left - container.left, container.right - card.right,
        card.top - container.top, container.bottom - card.bottom]
      return gaps.every(gap => Math.abs(gap - 5) < 0.75)
        && column.width >= Math.min(260, run.width) - 0.75 && column.width <= run.width + 0.75
        && (window.innerWidth < 768 || column.width < run.width / 2)
        && element.scrollWidth <= element.clientWidth
    })), { message: `Task cards retain four visible 5px gaps without stretching short message bubbles at ${width}px` }).toBe(true)
    await expect.poll(() => page.locator('.group-message:not(.embedded) .msg-content').evaluateAll(elements =>
      elements.every(element => {
        const bubble = element.getBoundingClientRect()
        const row = element.closest('.group-message')!.getBoundingClientRect()
        return bubble.width >= Math.min(260, row.width) - 0.75 && bubble.width <= row.width + 0.75
      })), { message: `Short user bubbles retain the 260px minimum when space permits at ${width}px` }).toBe(true)
  }
  await cards.first().getByRole('button').click()
  await expect(cards.first().locator('ol')).toHaveCount(0)
  await page.reload()
  await page.locator('#group-chat-guest-name input').fill('Visitor')
  await page.getByRole('button', { name: 'Enter room' }).click()
  await expect(cards).toHaveCount(1)
  await expect(cards).toContainText('1/2 completed')
})
