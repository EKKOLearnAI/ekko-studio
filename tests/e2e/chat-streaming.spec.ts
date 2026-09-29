import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const inputPlaceholder = 'Type a message... (Enter to send, Shift+Enter for new line)'

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
    return run
      ? {
          socket: {
            url: state.latest.url,
            options: state.latest.options,
          },
          run: run.payload,
          runCount: runs.length,
          socketCount: state.sockets.length,
        }
      : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

function readLiveReasoningStyles(status: Element) {
  const avatar = status.querySelector<HTMLElement>('.thinking-avatar')!
  const label = status.querySelector<HTMLElement>('.thinking-status-label')!
  const statusStyle = getComputedStyle(status)
  const avatarStyle = getComputedStyle(avatar)
  const labelStyle = getComputedStyle(label)
  return {
    statusBackground: statusStyle.backgroundImage,
    statusShadow: statusStyle.boxShadow,
    statusPadding: statusStyle.padding,
    avatarWidth: avatarStyle.width,
    avatarHeight: avatarStyle.height,
    avatarRadius: avatarStyle.borderRadius,
    labelFontSize: labelStyle.fontSize,
    labelFontWeight: labelStyle.fontWeight,
    labelAnimation: labelStyle.animationName,
  }
}

test('sends a chat run and renders streamed Socket.IO response events', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Summarize the queue')

  await expect(page.locator('p').filter({ hasText: /^Summarize the queue$/ })).toBeVisible()

  const { socket, run } = await waitForRun(page)

  expect(socket.url).toBe('/chat-run')
  expect(socket.options.auth).toEqual({ token: TEST_ACCESS_KEY })
  expect(socket.options.query).toEqual({ profile: 'research' })
  expect(run).toMatchObject({
    input: 'Summarize the queue',
    queue_id: expect.any(String),
    session_id: expect.any(String),
    source: 'cli',
  })
  expect(run.model).toBe('test-model')

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-1' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'Streaming ' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'answer from Hermes' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-1',
      output: 'Streaming answer from Hermes',
      inputTokens: 11,
      outputTokens: 7,
    })
  }, run.session_id)

  await expect(page.getByText('Streaming answer from Hermes')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('freezes the current reasoning between the thinking animation and its tool call', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await sendChatMessage(page, 'Reason about the queue')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', {
      event: 'run.started',
      session_id: sid,
      run_id: 'run-reasoning',
    })
  }, run.session_id)

  await expect(page.locator('.streaming-indicator .thinking-status')).toBeVisible()
  const thinkingAvatar = page.locator('.streaming-indicator .thinking-avatar')
  await expect(thinkingAvatar).toHaveAttribute('src', '/coding-agents/hermes.png')
  await expect(thinkingAvatar).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(thinkingAvatar).toHaveCSS('object-fit', 'contain')

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('reasoning.delta', {
      event: 'reasoning.delta',
      session_id: sid,
      run_id: 'run-reasoning',
      delta: 'Inspecting the pending work.',
    })
  }, run.session_id)

  const liveReasoning = page.locator('.streaming-indicator .live-reasoning-detail')
  await expect(liveReasoning).toContainText('Inspecting the pending work.')
  await expect(page.locator('.message.assistant .thinking-block')).toHaveCount(0)
  await expect(page.locator('.streaming-indicator .thinking-status')).toBeVisible()
  await expect(page.locator('.streaming-indicator .live-reasoning-status > .thinking-status + .live-reasoning-detail')).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-reasoning',
      tool_call_id: 'read-queue-1',
      tool: 'read_file',
      arguments: { path: 'queue.json' },
    })
  }, run.session_id)

  await expect(liveReasoning).toContainText('Inspecting the pending work.')
  await expect(page.locator('.streaming-indicator > .live-reasoning-status + .tool-calls-panel')).toBeVisible()
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-reasoning',
      tool_call_id: 'read-queue-1',
      tool: 'read_file',
      output: '{"pending":0}',
    })
    socket.__trigger('reasoning.delta', {
      event: 'reasoning.delta',
      session_id: sid,
      run_id: 'run-reasoning',
      delta: 'Summarizing the tool result.',
    })
  }, run.session_id)

  await expect(liveReasoning).toContainText('Summarizing the tool result.')
  await expect(liveReasoning).not.toContainText('Inspecting the pending work.')

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-reasoning',
      delta: 'The queue is ready.',
    })
  }, run.session_id)

  const assistantBubble = page.locator('.message.assistant .message-bubble').filter({ hasText: 'The queue is ready.' })
  await expect(liveReasoning).toContainText('Summarizing the tool result.')
  await expect(assistantBubble.locator('.thinking-block')).toHaveCount(0)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-reasoning',
      output: 'The queue is ready.',
    })
  }, run.session_id)

  await expect(page.locator('.streaming-indicator .thinking-status')).toHaveCount(0)
  await expect(assistantBubble.locator('.thinking-block')).toHaveCount(1)
  await expect(assistantBubble).toContainText('Summarizing the tool result.')

  const toolRunCard = page.locator('.tool-run-card[data-run-id="run-reasoning"]')
  await expect(toolRunCard).toContainText('read_file')
  await toolRunCard.locator('.tool-run-header').click()
  const toolMessage = toolRunCard.locator('.message.tool').filter({ hasText: 'read_file' })
  await toolMessage.locator('.tool-line').click()
  await expect(toolMessage.locator('.tool-detail-reasoning')).toContainText('Inspecting the pending work.')
  expect(api.unexpectedRequests).toEqual([])
})

test('shows one real subagent card and opens its live chat stream in the resizable preview panel', async ({ page }, testInfo) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await sendChatMessage(page, 'Delegate the research task')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-delegate' })
    socket.__trigger('reasoning.delta', {
      event: 'reasoning.delta',
      session_id: sid,
      run_id: 'run-delegate',
      delta: 'Preparing the delegated task.',
    })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-delegate',
      tool_call_id: 'delegate-call-1',
      tool: 'delegate_task',
      arguments: { mode: 'background', goal: 'Research the latest technology news' },
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-delegate',
      tool_call_id: 'delegate-call-1',
      tool: 'delegate_task',
      output: JSON.stringify({
        mode: 'background',
        status: 'dispatched',
        delegation_id: 'delegation-1',
      }),
    })
    socket.__trigger('delegation.updated', {
      event: 'delegation.updated',
      session_id: sid,
      delegation_id: 'delegation-1',
      status: 'running',
      background_pending: 1,
    })
  }, run.session_id)

  const singleChatLiveReasoning = page.locator('.streaming-indicator > .live-reasoning-status')
  await expect(singleChatLiveReasoning).toBeVisible()
  const singleChatThinkingStyles = await singleChatLiveReasoning.evaluate(readLiveReasoningStyles)
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('01-mocked-foreground-working.png') })

  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-delegate',
      output: 'Delegation started.',
      background_pending: 1,
    })
  }, run.session_id)

  await expect(page.locator('.subagent-entry')).toHaveCount(0)
  // Parent has finished, but the existing sidebar working glow must stay on.
  const workingLogos = page.locator('.session-item.active .session-item-agent-logo-wrap')
  await expect(workingLogos).toHaveCount(2)
  await expect(workingLogos).toHaveClass([/streaming/, /streaming/])

  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('subagent.start', {
      event: 'subagent.start',
      session_id: sid,
      subagent_id: 'child-1',
      task_index: 0,
      task_count: 1,
      goal: 'Research the latest technology news',
      model: 'test-model',
      background_seq: 1,
    })
    socket.__trigger('subagent.thinking', {
      event: 'subagent.thinking',
      session_id: sid,
      subagent_id: 'child-1',
      text: 'Inspecting sources before searching.',
      background_seq: 2,
    })
    socket.__trigger('subagent.tool', {
      event: 'subagent.tool',
      session_id: sid,
      subagent_id: 'child-1',
      tool: 'search_web',
      arguments: { query: 'technology news' },
      preview: 'technology news',
      tool_count: 1,
      background_seq: 3,
    })
  }, run.session_id)

  const subagentCards = page.locator('.message.tool .subagent-entry')
  await expect(subagentCards).toHaveCount(1)
  await expect(subagentCards).toContainText('delegate_task')
  await subagentCards.click()

  const panel = page.locator('.subagent-stream-panel')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Research the latest technology news')
  await expect(panel.locator('.subagent-run-indicator .thinking-avatar')).toBeVisible()
  await expect(panel.locator('.subagent-run-indicator .live-reasoning-detail')).toContainText('Inspecting sources before searching.')
  await expect(panel.locator('.subagent-live-tool')).toContainText('search_web')
  await expect(panel.getByText('Waiting for live output...')).toHaveCount(0)
  await expect(workingLogos).toHaveClass([/streaming/, /streaming/])
  await expect(singleChatLiveReasoning).toHaveCount(0)
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('02-mocked-background-working.png') })
  await expect(panel.locator('.message-bubble.system')).toHaveCount(0)
  const subagentThinkingStyles = await panel
    .locator('.live-reasoning-status')
    .evaluate(readLiveReasoningStyles)
  expect(subagentThinkingStyles).toEqual(singleChatThinkingStyles)
  expect(subagentThinkingStyles).toMatchObject({
    statusBackground: 'none',
    statusShadow: 'none',
    statusPadding: '0px',
    avatarWidth: '40px',
    avatarHeight: '40px',
  })
  expect(subagentThinkingStyles.labelAnimation).not.toBe('none')
  const reasoningDetailStyle = await panel.locator('.live-reasoning-detail').evaluate((detail) => {
    const style = getComputedStyle(detail)
    return {
      background: style.backgroundColor,
      borderInlineStartWidth: style.borderInlineStartWidth,
      borderLeftWidth: style.borderLeftWidth,
      padding: style.padding,
    }
  })
  expect(reasoningDetailStyle.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(reasoningDetailStyle.borderInlineStartWidth).toBe('0px')
  expect(reasoningDetailStyle.borderLeftWidth).toBe('0px')
  expect(reasoningDetailStyle.padding).toBe('5px 10px')

  for (const surface of [page.locator('.chat-tool-panel'), panel]) {
    const bounds = await surface.boundingBox()
    const viewport = page.viewportSize()
    expect(bounds).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1)
  }

  await page.setViewportSize({ width: 640, height: 820 })
  await expect(panel).toBeVisible()
  for (const surface of [page.locator('.chat-tool-panel'), panel]) {
    const bounds = await surface.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(641)
  }

  const backgrounds = await page.evaluate(() => ({
    chat: getComputedStyle(document.querySelector('.chat-main-content')!).backgroundColor,
    panel: getComputedStyle(document.querySelector('.subagent-stream-panel')!).backgroundColor,
    transcript: getComputedStyle(document.querySelector('.subagent-stream-panel .virtual-message-list')!).backgroundColor,
  }))
  expect(backgrounds.panel).toBe(backgrounds.chat)
  expect(backgrounds.transcript).toBe(backgrounds.chat)

  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('subagent.thinking', {
      event: 'subagent.thinking',
      session_id: sid,
      subagent_id: 'child-1',
      text: 'Summarizing the search result.',
      background_seq: 4,
    })
    socket.__trigger('subagent.text', {
      event: 'subagent.text',
      session_id: sid,
      subagent_id: 'child-1',
      text: 'Child live answer.',
      background_seq: 5,
    })
  }, run.session_id)

  await expect(panel.locator('.subagent-run-indicator .live-reasoning-detail')).toContainText('Summarizing the search result.')
  await expect(panel.locator('.subagent-run-indicator .live-reasoning-detail')).not.toContainText('Inspecting sources before searching.')
  await expect(panel).toContainText('Child live answer.')
  await expect(panel.locator('.message.assistant .thinking-block')).toHaveCount(0)

  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('subagent.thinking', {
      event: 'subagent.thinking',
      session_id: sid,
      subagent_id: 'child-1',
      text: 'Preparing the final summary.',
      background_seq: 6,
    })
  }, run.session_id)

  await expect(panel.locator('.subagent-run-indicator .live-reasoning-detail')).toContainText('Preparing the final summary.')
  await expect(panel.locator('.message.assistant .thinking-block')).toHaveCount(0)

  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('subagent.complete', {
      event: 'subagent.complete',
      session_id: sid,
      subagent_id: 'child-1',
      task_index: 0,
      task_count: 1,
      status: 'completed',
      summary: 'Research finished.',
      background_seq: 7,
    })
  }, run.session_id)

  await expect(panel.locator('.subagent-status')).toHaveText('Completed')
  await expect(panel.locator('.subagent-run-indicator')).toHaveCount(0)
  await expect(panel).toContainText('Research finished.')
  await expect(panel.locator('.message-bubble.system')).toHaveCount(0)

  // A child completion is not the aggregate lifecycle: delivery can still be pending.
  await page.setViewportSize({ width: 1280, height: 720 })
  // Entering mobile closes the sessions pane; resizing does not reopen it.
  await page.locator('.header-sidebar-toggle').click()
  await expect(workingLogos).toHaveClass([/streaming/, /streaming/])
  await page.evaluate((sid) => {
    const socket = { __trigger: (window as any).__PW_CHAT_SOCKET__.broadcast }
    socket.__trigger('delegation.updated', {
      event: 'delegation.updated', session_id: sid, delegation_id: 'delegation-1',
      status: 'completed', background_pending: 0,
    })
  }, run.session_id)
  await expect(page.locator('.session-item.active .session-item-agent-logo-wrap.streaming')).toHaveCount(0)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('03-mocked-all-terminal.png') })

  const completedTool = panel.locator('.message.tool').filter({ hasText: 'search_web' })
  await completedTool.locator('.tool-line').click()
  await expect(completedTool.locator('.tool-detail-reasoning')).toContainText('Inspecting sources before searching.')
  const childAnswer = panel.locator('.message.assistant .message-bubble').filter({ hasText: 'Child live answer.' })
  await expect(childAnswer.locator('.thinking-block')).toContainText('Summarizing the search result.')
  const childSummary = panel.locator('.message.assistant .message-bubble').filter({ hasText: 'Research finished.' })
  await expect(childSummary.locator('.thinking-block')).toContainText('Preparing the final summary.')
  expect(api.unexpectedRequests).toEqual([])
})

test('settles a running subagent card when Stop completes without a child terminal event', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await sendChatMessage(page, 'Start background work')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-stop-child' })
    socket.__trigger('subagent.start', {
      event: 'subagent.start',
      session_id: sid,
      subagent_id: 'child-stop',
      task_index: 0,
      task_count: 1,
      goal: 'Long-running background work',
      background_seq: 1,
    })
    socket.__trigger('subagent.thinking', {
      event: 'subagent.thinking',
      session_id: sid,
      subagent_id: 'child-stop',
      text: 'Thinking without producing a reply.',
      background_seq: 2,
    })
  }, run.session_id)

  const subagentCard = page.locator('.subagent-entry').filter({ hasText: 'delegate_task' })
  await expect(subagentCard).toHaveCount(1)
  await subagentCard.click()
  const panel = page.locator('.subagent-stream-panel')
  await expect(panel.locator('.subagent-status')).toHaveText('Running')
  await expect(panel.locator('.live-reasoning-detail')).toContainText('Thinking without producing a reply.')
  await expect(panel.locator('.message.assistant')).toHaveCount(0)
  await expect(subagentCard.locator('.tool-call-spinner')).toHaveCount(1)

  await page.getByRole('button', { name: 'Stop' }).click()
  await page.waitForFunction((sid) => {
    const emitted = (window as any).__PW_CHAT_SOCKET__?.emitted || []
    return emitted.some((item: any) => item.event === 'abort' && item.payload?.session_id === sid)
  }, run.session_id)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('abort.completed', {
      event: 'abort.completed',
      session_id: sid,
      run_id: 'run-stop-child',
      synced: true,
    })
  }, run.session_id)

  await expect(panel.locator('.subagent-status')).toHaveText('Interrupted')
  await expect(panel.locator('.subagent-live-dot')).not.toHaveClass(/active/)
  await expect(panel.locator('.subagent-run-indicator')).toHaveCount(0)
  await expect(panel.locator('.message.assistant')).toHaveCount(0)
  await expect(subagentCard.locator('.tool-call-spinner, .tool-spinner')).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('uses the newly selected profile for the next chat-run socket after profile switch reload', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'default')
  const api = await mockHermesApi(page, { initialProfileName: 'default' })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  expect(await page.evaluate(() => window.localStorage.getItem('hermes_active_profile_name'))).toBe('default')

  await sendChatMessage(page, 'Warm up default socket')
  const defaultRun = await waitForRun(page)
  expect(defaultRun.socket.options.query).toEqual({ profile: 'default' })
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-default' })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-default', delta: 'Default profile reply' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-default',
      output: 'Default profile reply',
    })
  }, defaultRun.run.session_id)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)

  await page.evaluate(() => window.localStorage.setItem('hermes_active_profile_name', 'research'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  expect(await page.evaluate(() => window.localStorage.getItem('hermes_active_profile_name'))).toBe('research')

  await sendChatMessage(page, 'Use the active research profile')
  const { socket, run } = await waitForRun(page)

  expect(socket.url).toBe('/chat-run')
  expect(socket.options.auth).toEqual({ token: TEST_ACCESS_KEY })
  expect(socket.options.query).toEqual({ profile: 'research' })
  expect(run.input).toBe('Use the active research profile')
  expect(await page.evaluate(() => window.localStorage.getItem('hermes_active_profile_name'))).toBe('research')

  expect(api.requests.some((request) => request.pathname === '/api/hermes/profiles/active')).toBe(false)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps queued runs on one socket and does not duplicate streamed handlers', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'First queued contract')
  const first = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-1', queue_length: 1 })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-1', delta: 'First answer' })
  }, first.run.session_id)
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()

  await sendChatMessage(page, 'Second queued contract')
  const second = await waitForRun(page, 1)

  expect(second.socketCount).toBe(1)
  expect(second.runCount).toBe(2)
  expect(second.run.session_id).toBe(first.run.session_id)
  expect(second.run.input).toBe('Second queued contract')
  await expect(page.locator('p').filter({ hasText: /^Second queued contract$/ })).toHaveCount(0)

  const insertionArrow = page.getByRole('button', { name: 'Insert queued message' })
  await expect(insertionArrow).toBeVisible()
  await insertionArrow.click()
  const insertionRequest = await page.waitForFunction(() => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return state?.emitted?.find((item: any) => item.event === 'insert_queued_run')?.payload || null
  })
  await expect(insertionRequest.jsonValue()).resolves.toEqual({
    session_id: first.run.session_id,
    queue_id: second.run.queue_id,
  })
  await page.evaluate(({ sid, queueId }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.queue_insertion.updated', {
      event: 'run.queue_insertion.updated',
      session_id: sid,
      generation: 'generation-1',
      run_id: 'run-1',
      queue_id: queueId,
      runtime: 'hermes',
      phase: 'waiting_for_tool_batch',
      guarantee: 'strict',
      requested_at: Date.now(),
    })
  }, { sid: first.run.session_id, queueId: second.run.queue_id })
  await expect(page.getByRole('button', { name: 'Waiting for the current tools to finish' })).toBeDisabled()

  await page.evaluate(({ sid, queueId }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id: sid,
      message: {
        id: queueId,
        role: 'user',
        content: 'Second queued contract',
        timestamp: Date.now() / 1000,
      },
    })
  }, { sid: first.run.session_id, queueId: second.run.queue_id })
  await expect(page.locator('p').filter({ hasText: /^Second queued contract$/ })).toHaveCount(0)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-1',
      output: 'First answer',
      queue_remaining: 1,
    })
  }, first.run.session_id)

  await expect(page.locator('p').filter({ hasText: /^Second queued contract$/ })).toHaveCount(0)

  await page.evaluate(({ sid, queueId }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.queued', {
      event: 'run.queued',
      session_id: sid,
      queue_length: 0,
      dequeued_queue_id: queueId,
      queued_messages: [],
    })
    socket.__trigger('run.queue_insertion.updated', {
      event: 'run.queue_insertion.updated',
      session_id: sid,
      generation: 'generation-1',
      queue_id: queueId,
      runtime: 'hermes',
      phase: 'starting_queued_message',
      guarantee: 'strict',
      requested_at: Date.now(),
    })
    socket.__trigger('run.peer_user_message', {
      event: 'run.peer_user_message',
      session_id: sid,
      message: {
        id: queueId,
        role: 'user',
        content: 'Second queued contract',
        timestamp: Date.now() / 1000,
      },
    })
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-2', queue_length: 0 })
    socket.__trigger('message.delta', { event: 'message.delta', session_id: sid, run_id: 'run-2', delta: 'Second answer' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-2',
      output: 'Second answer',
      queue_remaining: 0,
    })
  }, { sid: first.run.session_id, queueId: second.run.queue_id })

  await expect(page.locator('p').filter({ hasText: /^First answer$/ })).toHaveCount(1)
  await expect(page.locator('p').filter({ hasText: /^Second queued contract$/ })).toHaveCount(1)
  await expect(page.locator('p').filter({ hasText: /^Second answer$/ })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('does not report a safe queue insertion stop as an empty model response', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Current request')
  const first = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', {
      event: 'run.started',
      session_id: sid,
      run_id: 'run-empty-before-insertion',
    })
  }, first.run.session_id)

  await sendChatMessage(page, 'Insert this next')
  const second = await waitForRun(page, 1)
  await page.getByRole('button', { name: 'Insert queued message' }).click()
  await page.evaluate(({ sid, queueId }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.queue_insertion.updated', {
      event: 'run.queue_insertion.updated',
      session_id: sid,
      generation: 'generation-empty-output',
      run_id: 'run-empty-before-insertion',
      queue_id: queueId,
      runtime: 'hermes',
      phase: 'stopping_current_turn',
      guarantee: 'strict',
      requested_at: Date.now(),
    })
    socket.__trigger('run.failed', {
      event: 'run.failed',
      session_id: sid,
      run_id: 'run-empty-before-insertion',
      error: 'Agent reported failure',
      interrupted: true,
      stop_reason: 'queue_insertion',
      boundary_guarantee: 'strict',
      queue_remaining: 1,
    })
  }, { sid: first.run.session_id, queueId: second.run.queue_id })

  await expect(page.getByText(/Agent returned no output/)).toHaveCount(0)
  await expect(page.getByText(/Agent reported failure/)).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('clears previous compression status when a new run starts', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Trigger compression before answering')
  const first = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-1' })
    socket.__trigger('compression.completed', {
      event: 'compression.completed',
      session_id: sid,
      totalMessages: 12,
      beforeTokens: 24000,
      afterTokens: 6000,
      compressed: true,
    })
  }, first.run.session_id)

  await expect(page.getByText(/Compressed 12 msgs/)).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-1',
      output: 'First answer',
    })
  }, first.run.session_id)

  await sendChatMessage(page, 'Start another turn')
  const second = await waitForRun(page, 1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-2' })
  }, second.run.session_id)

  await expect(page.getByText(/Compressed 12 msgs/)).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('surfaces an empty completed run as an error instead of leaving chat stalled', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Call a broken provider')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-empty' })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-empty',
      output: '',
      inputTokens: 0,
      outputTokens: 0,
    })
  }, run.session_id)

  await expect(page.getByText(/Agent returned no output/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('renders tool trace and sends explicit approval decisions over the chat-run socket', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Use write_file with approval')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-approval' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-approval',
      tool_call_id: 'tool-call-1',
      tool: 'write_file',
      preview: 'Writing approved file',
      arguments: JSON.stringify({ path: '/tmp/approved.txt', content: 'hello' }),
    })
    socket.__trigger('approval.requested', {
      event: 'approval.requested',
      session_id: sid,
      run_id: 'run-approval',
      approval_id: 'approval-1',
      command: 'write_file /tmp/approved.txt',
      description: 'Allow write_file to create /tmp/approved.txt',
      choices: ['once', 'deny'],
      allow_permanent: false,
      timeout_ms: 300_000,
      remaining_timeout_ms: 90_000,
    })
  }, run.session_id)

  await expect(page.getByText('write_file', { exact: true })).toBeVisible()
  await expect(page.getByText('Writing approved file')).toBeVisible()
  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'write_file' })).toBeVisible()
  await expect(page.getByText('Allow write_file to create /tmp/approved.txt')).toBeVisible()
  await expect(page.getByText('write_file /tmp/approved.txt')).toBeVisible()
  await expect(page.locator('.pending-interaction-countdown')).toContainText(/01:(29|30) remaining/)
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow session' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('approval.resolved', {
      event: 'approval.resolved',
      session_id: sid,
      run_id: 'run-approval',
      approval_id: 'approval-other',
      choice: 'deny',
      resolved: true,
    })
  }, run.session_id)
  await expect(page.getByText('Allow write_file to create /tmp/approved.txt')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible()

  await page.getByRole('button', { name: 'Allow once' }).click()

  await expect(page.getByText('Allow write_file to create /tmp/approved.txt')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Allow once' })).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => {
    const emitted = (window as any).__PW_CHAT_SOCKET__.emitted
    return emitted.filter((item: any) => item.event === 'approval.respond')
  })).toEqual([
    {
      event: 'approval.respond',
      payload: {
        session_id: run.session_id,
        approval_id: 'approval-1',
        choice: 'once',
      },
    },
  ])

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('approval.resolved', {
      event: 'approval.resolved',
      session_id: sid,
      run_id: 'run-approval',
      approval_id: 'approval-1',
      choice: 'once',
      resolved: true,
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-approval',
      tool_call_id: 'tool-call-1',
      tool: 'write_file',
      output: JSON.stringify({ ok: true, path: '/tmp/approved.txt' }),
      duration: 42,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-approval',
      delta: 'Delta-only approved tool result.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-approval',
      output: 'Completion fallback should stay hidden.',
    })
  }, run.session_id)

  const toolRunCard = page.locator('.tool-run-card[data-run-id="run-approval"]')
  await expect(toolRunCard).toContainText('write_file')
  await toolRunCard.locator('.tool-run-header').click()
  const persistedToolTrace = toolRunCard.locator('.message.tool .tool-line').filter({ hasText: 'write_file' })
  await expect(persistedToolTrace).toHaveCount(1)
  await persistedToolTrace.click()
  const toolDetails = toolRunCard.locator('.message.tool .tool-details')
  await expect(toolDetails).toContainText('/tmp/approved.txt')
  await expect(toolDetails).toContainText('ok')
  await expect(page.getByText('Delta-only approved tool result.')).toBeVisible()
  await expect(page.getByText('Completion fallback should stay hidden.')).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'write_file' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('renders free-text and choice clarifications and sends responses over the chat-run socket', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Ask before choosing a target')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', {
      event: 'run.started',
      session_id: sid,
      run_id: 'run-clarify',
    })
    socket.__trigger('clarify.requested', {
      event: 'clarify.requested',
      session_id: sid,
      run_id: 'run-clarify',
      clarify_id: 'clarify-free-text',
      question: 'Which directory should I update?',
      choices: null,
      timeout_ms: 300_000,
      remaining_timeout_ms: 75_000,
    })
  }, run.session_id)

  await expect(page.getByText('Agent has a question for you')).toBeVisible()
  await expect(page.getByText('Which directory should I update?')).toBeVisible()
  await expect(page.locator('.pending-interaction-countdown')).toContainText(/01:(14|15) remaining/)
  const clarifyInput = page.getByPlaceholder('Type your answer...')
  await clarifyInput.fill('packages/client')
  await page.getByRole('button', { name: 'Reply' }).click()

  await expect(page.getByText('Which directory should I update?')).toHaveCount(0)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('clarify.requested', {
      event: 'clarify.requested',
      session_id: sid,
      run_id: 'run-clarify',
      clarify_id: 'clarify-choice',
      question: 'Keep or replace the existing file?',
      choices: ['Keep', 'Replace'],
      timeout_ms: 300_000,
    })
  }, run.session_id)

  await expect(page.getByText('Keep or replace the existing file?')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Replace', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible()
  await page.getByRole('button', { name: 'Replace', exact: true }).click()

  await expect(page.getByText('Keep or replace the existing file?')).toHaveCount(0)
  await expect.poll(async () => page.evaluate(() => {
    const emitted = (window as any).__PW_CHAT_SOCKET__.emitted
    return emitted.filter((item: any) => item.event === 'clarify.respond')
  })).toEqual([
    {
      event: 'clarify.respond',
      payload: {
        session_id: run.session_id,
        clarify_id: 'clarify-free-text',
        response: 'packages/client',
      },
    },
    {
      event: 'clarify.respond',
      payload: {
        session_id: run.session_id,
        clarify_id: 'clarify-choice',
        response: 'Replace',
      },
    },
  ])

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-clarify',
      output: 'Updated the selected target.',
    })
  }, run.session_id)

  await expect(page.getByText('Updated the selected target.')).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('reports and closes timed-out approval and clarification prompts after an attempted action', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')
  await sendChatMessage(page, 'Wait for a stale prompt')
  const { run } = await waitForRun(page)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-stale-prompt' })
    socket.__trigger('approval.requested', {
      event: 'approval.requested',
      session_id: sid,
      run_id: 'run-stale-prompt',
      approval_id: 'approval-stale',
      command: 'write_file stale.txt',
      description: 'This approval has already timed out',
      choices: ['once', 'deny'],
      timeout_ms: 1,
      remaining_timeout_ms: 0,
    })
  }, run.session_id)

  const prompt = page.locator('.approval-float-panel')
  await expect(prompt).toContainText('This approval has already timed out')
  await expect(prompt.locator('.pending-interaction-countdown')).toContainText('00:00 · Awaiting server confirmation')
  await expect(prompt.locator('.float-panel-close')).toHaveCount(0)
  await prompt.locator('.approval-float-actions button').first().click()
  await expect(prompt).toHaveCount(0)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('approval.resolved', {
      event: 'approval.resolved',
      session_id: sid,
      approval_id: 'approval-stale',
      resolved: false,
      stale: true,
      error: 'Approval is no longer pending.',
    })
  }, run.session_id)
  await expect(page.getByText('This request has timed out and was closed.').last()).toBeVisible()

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('clarify.requested', {
      event: 'clarify.requested',
      session_id: sid,
      run_id: 'run-stale-prompt',
      clarify_id: 'clarify-stale',
      question: 'This question has already timed out',
      choices: ['staging'],
      timeout_ms: 1,
      remaining_timeout_ms: 0,
    })
  }, run.session_id)

  await expect(prompt).toContainText('This question has already timed out')
  await expect(prompt.locator('.pending-interaction-countdown')).toContainText('00:00 · Awaiting server confirmation')
  await expect(prompt.locator('.float-panel-close')).toHaveCount(0)
  await prompt.locator('.approval-float-actions button').first().click()
  await expect(prompt).toHaveCount(0)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('clarify.resolved', {
      event: 'clarify.resolved',
      session_id: sid,
      clarify_id: 'clarify-stale',
      resolved: false,
      stale: true,
      error: 'Clarification is no longer pending.',
    })
  }, run.session_id)
  await expect(page.getByText('This request has timed out and was closed.').last()).toBeVisible()
  expect(await page.evaluate(() => (
    (window as any).__PW_CHAT_SOCKET__.emitted
      .filter((item: any) => item.event === 'approval.respond' || item.event === 'clarify.respond')
  ))).toEqual([
    {
      event: 'approval.respond',
      payload: {
        session_id: run.session_id,
        approval_id: 'approval-stale',
        choice: 'once',
      },
    },
    {
      event: 'clarify.respond',
      payload: {
        session_id: run.session_id,
        clarify_id: 'clarify-stale',
        response: 'staging',
      },
    },
  ])
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps prior tool trace visible while hiding only the active run tool trace', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'First tool trace')
  const first = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-history-1' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-history-1',
      tool_call_id: 'tool-history-1',
      tool: 'read_file',
      preview: 'Read historical file',
      arguments: JSON.stringify({ path: '/tmp/history.txt' }),
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-history-1',
      tool_call_id: 'tool-history-1',
      tool: 'read_file',
      output: JSON.stringify({ ok: true, path: '/tmp/history.txt' }),
      duration: 12,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-history-1',
      delta: 'First tool answer.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-history-1',
      output: 'First fallback should stay hidden.',
    })
  }, first.run.session_id)

  const firstRunCard = page.locator('.tool-run-card[data-run-id="run-history-1"]')
  await expect(firstRunCard).toContainText('read_file')
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)

  await sendChatMessage(page, 'Second tool trace')
  const second = await waitForRun(page, 1)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-history-2' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-history-2',
      tool_call_id: 'tool-history-2',
      tool: 'write_file',
      preview: 'Write current file',
      arguments: JSON.stringify({ path: '/tmp/current.txt', content: 'now' }),
    })
  }, second.run.session_id)

  await expect(firstRunCard).toContainText('read_file')
  await expect(page.locator('.tool-run-card[data-run-id="run-history-2"]')).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'write_file' })).toHaveCount(1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-history-2',
      tool_call_id: 'tool-history-2',
      tool: 'write_file',
      output: JSON.stringify({ ok: true, path: '/tmp/current.txt' }),
      duration: 15,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-history-2',
      delta: 'Second tool answer.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-history-2',
      output: 'Second fallback should stay hidden.',
    })
  }, second.run.session_id)

  const secondRunCard = page.locator('.tool-run-card[data-run-id="run-history-2"]')
  await expect(firstRunCard).toContainText('read_file')
  await expect(secondRunCard).toContainText('write_file')
  await firstRunCard.locator('.tool-run-header').click()
  await secondRunCard.locator('.tool-run-header').click()
  await expect(firstRunCard.locator('.message.tool .tool-line').filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(secondRunCard.locator('.message.tool .tool-line').filter({ hasText: 'write_file' })).toHaveCount(1)
  await expect(page.getByText('First fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByText('Second fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('moves completed same-run tools into the transcript while the remaining tools keep running', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Run multiple tools')
  const { run } = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-multi-tool' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-1',
      tool: 'read_file',
      preview: 'Read config',
      arguments: JSON.stringify({ path: '/tmp/config.json' }),
    })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-2',
      tool: 'shell_exec',
      preview: 'Run command',
      arguments: JSON.stringify({ command: 'false' }),
    })
  }, run.session_id)

  const transcriptTools = page.locator('.message.tool .tool-line')
  await expect(transcriptTools).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'shell_exec' })).toHaveCount(1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-1',
      tool: 'read_file',
      output: JSON.stringify({ ok: true, path: '/tmp/config.json' }),
      duration: 11,
    })
  }, run.session_id)

  const toolRunCard = page.locator('.tool-run-card[data-run-id="run-multi-tool"]')
  await expect(toolRunCard).toContainText('read_file')
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'shell_exec' })).toHaveCount(1)

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-multi-tool',
      tool_call_id: 'tool-multi-2',
      tool: 'shell_exec',
      output: 'exit status 1',
      error: true,
      duration: 13,
    })
  }, run.session_id)

  await expect(toolRunCard).toContainText('read_file')
  await expect(toolRunCard).toContainText('shell_exec')
  await expect(page.locator('.tool-calls-panel .tool-call-name')).toHaveCount(0)
  await toolRunCard.locator('.tool-run-header').click()
  await expect(transcriptTools).toHaveCount(2)
  await expect(transcriptTools.filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(transcriptTools.filter({ hasText: 'shell_exec' })).toHaveCount(1)
  await expect(toolRunCard.locator('.tool-error-badge')).toHaveCount(1)
  await transcriptTools.filter({ hasText: 'shell_exec' }).click()
  await expect(toolRunCard.locator('.message.tool .tool-details')).toContainText('exit status 1')

  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-multi-tool',
      delta: 'Multiple tools finished.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-multi-tool',
      output: 'Multi-tool fallback should stay hidden.',
    })
  }, run.session_id)

  await expect(transcriptTools).toHaveCount(2)
  await expect(transcriptTools.filter({ hasText: 'read_file' })).toHaveCount(1)
  await expect(transcriptTools.filter({ hasText: 'shell_exec' })).toHaveCount(1)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'read_file' })).toHaveCount(0)
  await expect(page.locator('.tool-calls-panel .tool-call-name').filter({ hasText: 'shell_exec' })).toHaveCount(0)
  await expect(toolRunCard.locator('.tool-error-badge')).toHaveCount(1)
  await expect(page.getByText('Multi-tool fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps unnamed tool trace messages out of the transcript after completion', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await sendChatMessage(page, 'Run internal unnamed tool')
  const { run } = await waitForRun(page)
  await page.evaluate((sid) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.latest
    socket.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'run-unnamed-tool' })
    socket.__trigger('tool.started', {
      event: 'tool.started',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      tool_call_id: 'tool-unnamed-1',
      preview: 'Internal unnamed work',
      arguments: JSON.stringify({ internal: true }),
    })
    socket.__trigger('tool.completed', {
      event: 'tool.completed',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      tool_call_id: 'tool-unnamed-1',
      output: JSON.stringify({ internal: true, ok: true }),
      duration: 9,
    })
    socket.__trigger('message.delta', {
      event: 'message.delta',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      delta: 'Unnamed internal tool finished.',
    })
    socket.__trigger('run.completed', {
      event: 'run.completed',
      session_id: sid,
      run_id: 'run-unnamed-tool',
      output: 'Unnamed fallback should stay hidden.',
    })
  }, run.session_id)

  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.getByText('Unnamed internal tool finished.')).toBeVisible()
  await expect(page.getByText('Unnamed fallback should stay hidden.')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  expect(api.unexpectedRequests).toEqual([])
})

test('keeps unnamed resumed tool traces hidden after session reload', async ({ page }) => {
  const sessionId = 'session-history-unnamed-tool'
  const sessionSummary = {
    id: sessionId,
    source: 'api_server',
    model: 'test-model',
    title: 'Unnamed tool history',
    preview: 'History answer visible.',
    started_at: 1,
    ended_at: 4,
    last_active: 4,
    message_count: 4,
    tool_call_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'test-provider',
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'none',
    workspace: null,
  }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((sid) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid,
        isWorking: false,
        events: [],
        messages: [
          {
            id: 1,
            session_id: sid,
            role: 'user',
            content: 'Resume unnamed internal tool',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1,
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
            tool_calls: [{ id: 'tool-resume-unnamed-1', type: 'function', function: { arguments: JSON.stringify({ internal: true }) } }],
            tool_name: null,
            timestamp: 2,
            token_count: null,
            finish_reason: 'tool_calls',
            reasoning: null,
          },
          {
            id: 3,
            session_id: sid,
            role: 'tool',
            content: JSON.stringify({ internal: true, ok: true }),
            tool_call_id: 'tool-resume-unnamed-1',
            tool_calls: null,
            tool_name: null,
            timestamp: 3,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 4,
            session_id: sid,
            role: 'assistant',
            content: 'History answer visible.',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 4,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ],
      },
    }
  }, sessionId)
  const api = await mockHermesApi(page, { sessions: [sessionSummary] })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await expect(page.getByText('History answer visible.')).toBeVisible()
  await expect(page.locator('.message.tool .tool-line')).toHaveCount(0)
  await expect(page.locator('.message.tool')).toHaveCount(0)
  const resumeRequest = await page.waitForFunction((sid) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    return state?.emitted?.some((item: any) => item.event === 'resume' && item.payload?.session_id === sid)
  }, sessionId)
  expect(await resumeRequest.jsonValue()).toBe(true)
  expect(api.unexpectedRequests).toEqual([])
})

test('restores named resumed tool traces from assistant tool calls after session reload', async ({ page }) => {
  const sessionId = 'session-history-named-tool'
  const sessionSummary = {
    id: sessionId,
    source: 'api_server',
    model: 'test-model',
    title: 'Named tool history',
    preview: 'Named history answer visible.',
    started_at: 1,
    ended_at: 4,
    last_active: 4,
    message_count: 4,
    tool_call_count: 1,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    billing_provider: 'test-provider',
    estimated_cost_usd: 0,
    actual_cost_usd: null,
    cost_status: 'none',
    workspace: null,
  }
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  await page.addInitScript((sid) => {
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = {
      [sid]: {
        session_id: sid,
        isWorking: false,
        events: [],
        messages: [
          {
            id: 1,
            session_id: sid,
            role: 'user',
            content: 'Resume named tool',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 1,
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
            tool_calls: [{ id: 'tool-resume-named-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '/tmp/history.txt' }) } }],
            tool_name: null,
            timestamp: 2,
            token_count: null,
            finish_reason: 'tool_calls',
            reasoning: null,
          },
          {
            id: 3,
            session_id: sid,
            role: 'tool',
            content: JSON.stringify({ ok: true, path: '/tmp/history.txt' }),
            tool_call_id: 'tool-resume-named-1',
            tool_calls: null,
            tool_name: null,
            timestamp: 3,
            token_count: null,
            finish_reason: null,
            reasoning: null,
          },
          {
            id: 4,
            session_id: sid,
            role: 'assistant',
            content: 'Named history answer visible.',
            tool_call_id: null,
            tool_calls: null,
            tool_name: null,
            timestamp: 4,
            token_count: null,
            finish_reason: 'stop',
            reasoning: null,
          },
        ],
      },
    }
  }, sessionId)
  const api = await mockHermesApi(page, { sessions: [sessionSummary] })
  await mockChatSocket(page)

  await page.goto('/#/hermes/chat')

  await expect(page.getByText('Named history answer visible.')).toBeVisible()
  const restoredTrace = page.locator('.message.tool .tool-line').filter({ hasText: 'read_file' })
  await expect(restoredTrace).toHaveCount(1)
  await restoredTrace.click()
  await expect(page.locator('.message.tool .tool-details')).toContainText('/tmp/history.txt')
  expect(api.unexpectedRequests).toEqual([])
})
