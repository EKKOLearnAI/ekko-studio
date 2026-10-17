import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

async function setup(page: Page, agent = 'hermes', brightness = 'light', wallpaper = false, compressed = false) {
  await authenticate(page)
  const session = {
    id: 'delete-chat', profile: 'default', source: agent === 'hermes' ? 'cli' : 'builtin_agent', agent,
    title: 'Message selection', model: 'test-model', provider: 'test-provider',
    started_at: 1, last_active: 10, message_count: 7,
  }
  const otherSession = { ...session, id: 'other-chat', title: 'Other conversation', message_count: 1 }
  const message = (id: number, role: string, content: string, run_marker?: string) => ({
    id, session_id: session.id, role, content, run_marker, timestamp: id,
  })
  let rows = [
    message(1, 'user', 'First question'),
    { ...message(2, 'assistant', '', 'r1'), reasoning: 'Read before answering', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { ...message(3, 'tool', 'Tool result', 'r1'), tool_call_id: 'call1', tool_name: 'read_file' },
    message(4, 'assistant', 'First answer segment', 'r1'),
    message(5, 'assistant', 'Second answer segment', 'r1'),
    message(6, 'user', 'Keep this question'),
    message(7, 'assistant', 'Keep this answer', 'r2'),
  ]
  let revision = 0
  let contextTokens = 19_000
  const requests: any[] = []
  const resume = () => ({ session_id: session.id, messages: rows, isWorking: false, events: [], messageTotal: rows.length, messageLoadedCount: rows.length, hasMoreBefore: false,
    inputTokens: 100_000, outputTokens: 36_100, contextTokens })
  await page.addInitScript(payload => {
    const saved = sessionStorage.getItem('deletion-resume')
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'delete-chat': saved ? JSON.parse(saved) : payload,
      'other-chat': { session_id: 'other-chat', messages: [{ id: 100, role: 'user', content: 'Other session input', timestamp: 1 }], isWorking: false, events: [] } }
  }, resume())
  await mockHermesApi(page, { sessions: [session, otherSession], theme: {
    brightness,
    ...(wallpaper ? { background: { name: 'test.svg', mime: 'image/svg+xml', updatedAt: 1 } } : {}),
    appearance: wallpaper ? { global: { opacity: 0.3 }, regions: { content: { opacity: 0, blur: 12, radius: 10 }, overlay: { opacity: 0.85 } } } : undefined,
  } })
  if (wallpaper) await page.route('**/api/theme/background?*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#687b91" d="M0 0h64v64H0z"/></svg>' }))
  await mockChatSocket(page)
  const messagePage = () => ({
    session, messages: rows, taskPlans: [], workspaceRunChanges: [], total: rows.length, offset: 0, limit: 150, hasMore: false,
  })
  await page.route('**/api/studio/sessions/conversations/delete-chat/messages/paginated*', route => route.fulfill({ json: messagePage() }))
  await page.route('**/api/studio/sessions/delete-chat/message-selection*', route => route.fulfill({ json: {
    historyRevision: revision,
    groups: [
      { id: 1, kind: 'message', messageIds: [1] },
      { id: 2, kind: 'run', messageIds: [2, 3, 4, 5], runMarker: 'r1' },
      { id: 6, kind: 'message', messageIds: [6] },
      { id: 7, kind: 'run', messageIds: [7], runMarker: 'r2' },
    ].filter(group => rows.some(row => group.messageIds.includes(row.id)))
      .map(group => ({ ...group, ...(compressed && group.id <= 2 ? { deleteBlockedReason: 'compressed' } : {}) })),
  } }))
  await page.route('**/api/studio/sessions/delete-chat/messages/batch-delete*', async route => {
    const body = route.request().postDataJSON()
    requests.push(body)
    const ids = body.messageIds.flatMap((id: number) => id === 2 ? [2, 3, 4, 5] : [id])
    rows = rows.filter(row => !ids.includes(row.id))
    revision += 1
    contextTokens = rows.length ? 18_000 : 0
    await page.evaluate(payload => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['delete-chat'] = payload
      sessionStorage.setItem('deletion-resume', JSON.stringify(payload))
    }, resume())
    await route.fulfill({ json: { deleted: ids.length, deletedGroups: body.messageIds.length, messageIds: ids, historyRevision: revision, contextTokens } })
  })
  await page.goto('/#/hermes/session/delete-chat')
  await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible({ timeout: 15_000 })
  const finishNextRun = async (turn: number, peer = false) => {
    const input = `Follow up after deletion ${turn}`
    const answer = `New answer after deletion ${turn}`
    rows.push(message(8 + turn * 2, 'user', input), message(9 + turn * 2, 'assistant', answer, `next-${turn}`))
    await page.evaluate(({ payload, input, answer, turn, peer }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['delete-chat'] = payload
      sessionStorage.setItem('deletion-resume', JSON.stringify(payload))
      const socket = (window as any).__PW_CHAT_SOCKET__.latest
      const metadata = { session_id: 'delete-chat', run_id: `next-${turn}` }
      if (peer) socket.__trigger('run.peer_user_message', {
        event: 'run.peer_user_message', ...metadata,
        message: { id: 8 + turn * 2, role: 'user', content: input, timestamp: 8 + turn * 2 },
      })
      socket.__trigger('run.started', { event: 'run.started', ...metadata })
      socket.__trigger('message.delta', { event: 'message.delta', ...metadata, delta: answer })
      socket.__trigger('run.completed', { event: 'run.completed', ...metadata, output: answer })
    }, { payload: resume(), input, answer, turn, peer })
  }
  return { requests, finishNextRun, messagePage }
}

async function enterSelection(page: Page) {
  await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
  await page.getByText('Select messages', { exact: true }).click()
  await expect(page.locator('.message-selection-row')).not.toHaveCount(0)
  await expect(page.locator('.message-selection-toolbar').getByRole('button')).toHaveCount(2)
}

async function mockNativeMessageMenu(page: Page, windowKind = 'main') {
  await page.addInitScript(kind => {
    const state = { requests: [] as any[], pending: [] as ((action: string | null) => void)[], closed: 0 }
    ;(window as any).__NATIVE_MESSAGE_MENU__ = state
    ;(window as any).hermesDesktop = {
      isDesktop: true, platform: 'darwin', windowKind: kind,
      getWindowState: async () => ({ isMaximized: false }),
      messageContextMenu: {
        show: (request: unknown) => {
          state.requests.push(request)
          return new Promise(resolve => state.pending.push(resolve))
        },
        // Deliberately allow a late response after close to verify renderer guards.
        close: async () => { state.closed += 1 },
      },
    }
  }, windowKind)
  return async (index: number, action: string | null) => {
    await page.evaluate(({ index, action }) => (window as any).__NATIVE_MESSAGE_MENU__.pending[index](action), { index, action })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  }
}

for (const agent of ['hermes', 'ekko-agent']) {
  for (const windowKind of ['main', 'chat']) {
    test(`${agent}: ${windowKind} desktop window delegates copy and message selection to the native menu`, async ({ page }) => {
      const resolveMenu = await mockNativeMessageMenu(page, windowKind)
      await setup(page, agent)
      if (windowKind === 'chat') {
        await page.goto('/#/desktop-chat/delete-chat')
        await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible()
      }
      const answer = page.getByText('Keep this answer', { exact: true })
      await answer.evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
      })
      await answer.click({ button: 'right', position: { x: 10, y: 10 } })
      expect(await page.evaluate(() => (window as any).__NATIVE_MESSAGE_MENU__.requests)).toEqual([
        { label: 'Select messages', enabled: true, hasSelection: true },
      ])
      await expect(page.getByText('Select messages', { exact: true })).not.toBeVisible()
      await resolveMenu(0, null)
      await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('Keep this answer')
      await answer.click({ button: 'right', position: { x: 10, y: 10 } })
      await resolveMenu(1, 'select-messages')
      await expect(page.getByRole('status').filter({ hasText: '0 selected' })).toBeVisible()
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
      await answer.click()
      await expect(page.getByRole('status').filter({ hasText: '1 selected' })).toBeVisible()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      await answer.click({ button: 'right' })
      expect(await page.evaluate(() => (window as any).__NATIVE_MESSAGE_MENU__.requests[2])).toEqual({ label: 'Select messages', enabled: true, hasSelection: false })
      await resolveMenu(2, 'select-messages')
      await expect(page.locator('.message-selection-toolbar')).toBeVisible()
      await page.locator('textarea').fill('Next turn')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await answer.click({ button: 'right' })
      expect(await page.evaluate(() => (window as any).__NATIVE_MESSAGE_MENU__.requests[3].enabled)).toBe(false)
      await resolveMenu(3, 'select-messages')
      await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    })
  }

  test(`${agent}: stale native menu actions cannot select after output or session switching`, async ({ page }) => {
    const resolveMenu = await mockNativeMessageMenu(page)
    const { finishNextRun } = await setup(page, agent)
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await finishNextRun(0, true)
    await expect.poll(() => page.evaluate(() => (window as any).__NATIVE_MESSAGE_MENU__.closed)).toBe(1)
    await resolveMenu(0, 'select-messages')
    await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await page.evaluate(() => { window.location.hash = '/hermes/session/other-chat' })
    await expect(page.getByText('Other session input', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__NATIVE_MESSAGE_MENU__.closed)).toBe(2)
    await page.evaluate(() => { window.location.hash = '/hermes/session/delete-chat' })
    await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible()
    await resolveMenu(1, 'select-messages')
    await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await resolveMenu(2, 'select-messages')
    await expect(page.locator('.message-selection-toolbar')).toBeVisible()
  })

  test(`${agent}: dragging text in selection mode does not toggle a run`, async ({ page }) => {
    await setup(page, agent)
    await enterSelection(page)
    const answer = page.getByText('Keep this answer', { exact: true })
    const bounds = await answer.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const rect = range.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 10 })
    await page.mouse.up()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Keep this answer')
    await expect(page.getByRole('status').filter({ hasText: '0 selected' })).toBeVisible()
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await answer.click()
    await expect(page.getByRole('status').filter({ hasText: '1 selected' })).toBeVisible()
  })

  test(`${agent}: selected text keeps the native copy menu alongside message selection`, async ({ page }) => {
    await setup(page, agent)
    await page.evaluate(() => {
      document.addEventListener('contextmenu', event => {
        ;(window as any).__PW_LAST_CONTEXT_MENU_EVENT__ = event
      }, true)
    })
    const expectNativeCopy = async (text: string) => {
      const message = page.getByText(text, { exact: true })
      await message.evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
      await message.click({ button: 'right', position: { x: 10, y: 10 } })
      expect(await page.evaluate(() => ({
        prevented: (window as any).__PW_LAST_CONTEXT_MENU_EVENT__.defaultPrevented,
        selection: window.getSelection()?.toString(),
      }))).toEqual({ prevented: false, selection: text })
      await expect(page.getByText('Select messages', { exact: true })).not.toBeVisible()
      await page.keyboard.press('Escape')
      await page.evaluate(() => window.getSelection()?.removeAllRanges())
    }

    await expectNativeCopy('Keep this answer')
    await expectNativeCopy('Keep this question')
    await enterSelection(page)
    await expectNativeCopy('Keep this answer')
    await expect(page.getByRole('status').filter({ hasText: '0 selected' })).toBeVisible()
    await page.getByText('Keep this answer', { exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '1 selected' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.locator('textarea').fill('Next turn')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expectNativeCopy('Keep this answer')
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await expect(page.locator('.n-dropdown-option-body').filter({ hasText: 'Select messages' })).toHaveClass(/disabled/)
  })

  test(`${agent}: deletion refresh cannot erase an immediately following turn`, async ({ page }) => {
    const { finishNextRun, messagePage } = await setup(page, agent)
    await enterSelection(page)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let requested = false
    await page.route('**/api/studio/sessions/conversations/delete-chat/messages/paginated*', async route => {
      const response = structuredClone(messagePage())
      requested = true
      await pending
      await route.fulfill({ json: response })
    })
    await page.getByText('First answer segment', { exact: true }).click()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => requested).toBe(true)
    await expect(page.locator('.n-dialog')).toHaveCount(0)
    await page.locator('textarea').fill('Follow up after deletion 0')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await finishNextRun(0)
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    const refreshed = page.waitForResponse('**/api/studio/sessions/conversations/delete-chat/messages/paginated*')
    release()
    await refreshed
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible()
    await expect(page.getByText('First question', { exact: true })).toBeVisible()
    await expect(page.getByText('First answer segment', { exact: true })).toHaveCount(0)
  })

  test(`${agent}: starting output cancels selection and blocks re-entry`, async ({ page }) => {
    const { requests, finishNextRun } = await setup(page, agent)
    await enterSelection(page)
    await page.getByText('Keep this answer', { exact: true }).click()
    await page.locator('textarea').fill('Follow up after deletion 0')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    await expect(page.locator('.message-selection-checkbox')).toHaveCount(0)
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await expect(page.locator('.n-dropdown-option-body').filter({ hasText: 'Select messages' })).toHaveClass(/disabled/)
    expect(requests).toEqual([])
    await page.keyboard.press('Escape')
    await finishNextRun(0)
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    await expect(page.getByText('Select messages', { exact: true })).not.toBeVisible()
    await enterSelection(page)
    await expect(page.getByRole('status').filter({ hasText: '0 selected' })).toBeVisible()
  })

  test(`${agent}: a peer run closes the delete dialog and a working resume stays locked`, async ({ page }) => {
    const { requests } = await setup(page, agent)
    await enterSelection(page)
    await page.getByText('Keep this answer', { exact: true }).click()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await expect(page.locator('.n-dialog')).toBeVisible()
    await page.evaluate(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['delete-chat'].isWorking = true
      ;(window as any).__PW_CHAT_SOCKET__.latest.__trigger('run.peer_user_message', {
        event: 'run.peer_user_message', session_id: 'delete-chat', message: { id: 8, role: 'user', content: 'Another tab starts a run', timestamp: 8 },
      })
    })
    await expect(page.locator('.n-dialog')).toHaveCount(0)
    await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    await page.evaluate(() => { window.location.hash = '/hermes/session/other-chat' })
    await expect(page.getByText('Other session input', { exact: true })).toBeVisible()
    await page.evaluate(() => { window.location.hash = '/hermes/session/delete-chat' })
    await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible()
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await expect(page.locator('.n-dropdown-option-body').filter({ hasText: 'Select messages' })).toHaveClass(/disabled/)
    expect(requests).toEqual([])
  })

  test(`${agent}: late selection hydration cannot erase a newly completed run`, async ({ page }) => {
    const { finishNextRun, messagePage } = await setup(page, agent)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let requested = false
    await page.route('**/api/studio/sessions/conversations/delete-chat/messages/paginated*', async route => {
      const response = structuredClone(messagePage())
      requested = true
      await pending
      await route.fulfill({ json: response })
    })
    await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
    await page.getByText('Select messages', { exact: true }).click()
    await expect.poll(() => requested).toBe(true)
    await page.locator('textarea').fill('Follow up after deletion 0')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await finishNextRun(0)
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    const hydrated = page.waitForResponse('**/api/studio/sessions/conversations/delete-chat/messages/paginated*')
    release()
    await hydrated
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('.message-selection-toolbar')).toHaveCount(0)
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    await expect(page.getByText('First question', { exact: true })).toBeVisible()
  })

  test(`${agent}: retains unselected history after deletion, two more runs and switching sessions`, async ({ page }) => {
    const { finishNextRun } = await setup(page, agent, 'light', false, true)
    await enterSelection(page)
    await page.getByText('Keep this answer', { exact: true }).click()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Keep this answer', { exact: true })).toHaveCount(0)
    for (const turn of [0, 1]) {
      await page.locator('textarea').fill(`Follow up after deletion ${turn}`)
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === 'run').length)).toBe(turn + 1)
      await finishNextRun(turn)
      await expect(page.getByText(`New answer after deletion ${turn}`, { exact: true })).toBeVisible()
      await page.evaluate(() => { window.location.hash = '/hermes/session/other-chat' })
      await expect(page.getByText('Other session input', { exact: true })).toBeVisible()
      await page.evaluate(() => { window.location.hash = '/hermes/session/delete-chat' })
      await expect(page.getByText('First question', { exact: true })).toBeVisible()
      await expect(page.getByText('First answer segment', { exact: true })).toBeVisible()
      await expect(page.getByText('Second answer segment', { exact: true })).toBeVisible()
      await expect(page.getByText('Keep this question', { exact: true })).toBeVisible()
      await expect(page.getByText(`New answer after deletion ${turn}`, { exact: true })).toBeVisible()
      await expect(page.getByText('Keep this answer', { exact: true })).toHaveCount(0)
    }
    await page.reload()
    await expect(page.getByText('First question', { exact: true })).toBeVisible()
    await expect(page.getByText('Keep this question', { exact: true })).toBeVisible()
    await expect(page.getByText('New answer after deletion 0', { exact: true })).toBeVisible()
    await expect(page.getByText('New answer after deletion 1', { exact: true })).toBeVisible()
    await expect(page.getByText('Keep this answer', { exact: true })).toHaveCount(0)
  })

  test(`${agent}: selects complete runs, cancels, deletes and reloads`, async ({ page }) => {
    const { requests } = await setup(page, agent)
    await expect(page.locator('.context-info')).toContainText('19.0k')
    await enterSelection(page)
    await expect(page.locator('.message-selection-row')).toHaveCount(4)
    const runs = page.getByRole('checkbox', { name: 'Agent run', exact: true })
    await expect(runs).toHaveCount(2)
    await expect(page.locator('.message-selection-row').first()).toHaveCSS('border-top-style', 'dashed')
    await page.getByText('First answer segment', { exact: true }).click()
    await expect(runs.first()).toBeChecked()
    await page.getByText('Second answer segment', { exact: true }).click()
    await expect(runs.first()).not.toBeChecked()
    await runs.first().check()
    const selectedRun = page.locator('.message-selection-row.is-selected')
    await expect(selectedRun).toHaveCSS('border-top-style', 'solid')
    await expect(selectedRun).toContainText('First answer segment')
    await expect(selectedRun).toContainText('Second answer segment')
    await page.evaluate(() => {
      (window as any).__selectionCopyCalls = 0
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { (window as any).__selectionCopyCalls += 1 },
      } })
    })
    await selectedRun.locator('.copy-bubble-btn').first().click()
    await expect(runs.first()).not.toBeChecked()
    expect(await page.evaluate(() => (window as any).__selectionCopyCalls)).toBe(0)
    await runs.first().check()
    await expect(page.getByRole('status').filter({ hasText: '1 selected' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await expect(page.getByText(/Permanently delete 1 selected items/)).toBeVisible()
    await page.locator('.n-dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(requests).toEqual([])
    await page.getByText('First question', { exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Message', exact: true }).first()).toBeChecked()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toEqual({ messageIds: [2, 1], historyRevision: 0 })
    await expect(page.locator('.context-info')).toContainText('18.0k')
    await expect(page.locator('.context-info')).not.toContainText('136.1k')
    await expect(page.getByText('First answer segment', { exact: true })).toHaveCount(0)
    await expect(page.getByText('First question', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible({ timeout: 15_000 })
    await page.reload()
    await expect(page.getByText('Keep this answer', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.context-info')).toContainText('18.0k')
    await expect(page.getByText('First answer segment', { exact: true })).toHaveCount(0)
    await enterSelection(page)
    await page.getByText('Keep this question', { exact: true }).click()
    await page.getByText('Keep this answer', { exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '2 selected' })).toBeVisible()
    await page.getByText('Keep this question', { exact: true }).click()
    await page.getByText('Keep this answer', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
    await page.getByText('Keep this question', { exact: true }).click()
    await page.getByText('Keep this answer', { exact: true }).click()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Keep this answer', { exact: true })).toHaveCount(0)
    await expect(page.locator('.empty-state')).toBeVisible()
    await expect(page.locator('.context-info')).toHaveText(/^\s*0\s+\/.*/)
    await page.reload()
    await expect(page.locator('.context-info')).toHaveText(/^\s*0\s+\/.*/)
  })
}

for (const brightness of ['light', 'dark']) {
  for (const wallpaper of [false, true]) {
    test(`selection stays usable on narrow ${brightness} layout, wallpaper ${wallpaper}`, async ({ page }) => {
      await page.setViewportSize({ width: 430, height: 900 })
      await setup(page, 'hermes', brightness, wallpaper)
      await enterSelection(page)
      const toolbar = page.locator('.message-selection-toolbar')
      const usage = page.locator('.context-usage-row')
      await expect(toolbar).toBeInViewport({ ratio: 1 })
      expect(await usage.evaluate(el => !!el.previousElementSibling?.querySelector('.message-selection-toolbar'))).toBe(true)
      const toolbarBox = (await toolbar.boundingBox())!
      const usageBox = (await usage.boundingBox())!
      expect(usageBox.y - toolbarBox.y - toolbarBox.height).toBeGreaterThanOrEqual(0)
      expect(usageBox.y - toolbarBox.y - toolbarBox.height).toBeLessThan(12)
      const run = page.locator('.message-selection-row').filter({ hasText: 'Keep this answer' })
      const user = page.locator('.message-selection-user').filter({ hasText: 'Keep this question' })
      for (const [row, side] of [[run, 'left'], [user, 'right']] as const) {
        const frame = (await row.boundingBox())!
        const checkbox = (await row.getByRole('checkbox').boundingBox())!
        expect(Math.abs(checkbox.y + checkbox.height / 2 - (frame.y + frame.height / 2))).toBeLessThan(3)
        if (side === 'left') expect(checkbox.x - frame.x).toBeLessThan(25)
        else expect(frame.x + frame.width - checkbox.x - checkbox.width).toBeLessThan(25)
      }
      await page.getByText('Keep this answer', { exact: true }).click()
      await expect(run.getByRole('checkbox')).toBeChecked()
      await expect(run).toHaveCSS('border-top-style', 'solid')
      await expect(user).toHaveCSS('border-top-style', 'dashed')
      await page.screenshot({ path: `/tmp/studio-message-selection-composer-${brightness}-${wallpaper}.png`, animations: 'disabled' })
      await page.getByText('First question', { exact: true }).click()
      await page.getByText('First answer segment', { exact: true }).click()
      await page.getByText('Keep this question', { exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: '4 selected' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
      await expect(page.locator('.n-dialog')).toBeVisible()
      await expect(page.locator('.n-dialog')).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: `/tmp/studio-message-selection-${brightness}-${wallpaper}.png`, animations: 'disabled' })
      await page.locator('.n-dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.locator('.message-selection-toolbar').getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(toolbar).toHaveCount(0)
      await page.evaluate(() => {
        (window as any).__PW_CHAT_SOCKET_RESUMES__['delete-chat'].isWorking = true
        ;(window as any).__PW_CHAT_SOCKET__.latest.__trigger('run.peer_user_message', {
          event: 'run.peer_user_message', session_id: 'delete-chat', message: { id: 8, role: 'user', content: 'Start another run', timestamp: 8 },
        })
      })
      await page.getByText('Keep this answer', { exact: true }).click({ button: 'right' })
      await expect(page.locator('.n-dropdown-option-body').filter({ hasText: 'Select messages' })).toHaveClass(/disabled/)
    })
  }
}

for (const agent of ['hermes', 'ekko-agent']) {
  test(`${agent}: compressed groups stay locked while selecting uncompressed messages`, async ({ page }) => {
    const { requests } = await setup(page, agent, 'light', false, true)
    await expect(page.locator('.context-info')).toContainText('19.0k')
    await enterSelection(page)
    await expect(page.locator('.message-selection-row.is-locked')).toHaveCount(2)
    await expect(page.getByRole('checkbox', { name: 'Agent run', exact: true }).first()).toBeDisabled()
    await expect(page.getByRole('checkbox', { name: 'Message', exact: true }).first()).toBeDisabled()
    await expect(page.getByText('Already compressed; cannot delete', { exact: true })).toHaveCount(2)
    await page.getByText('First answer segment', { exact: true }).click()
    await page.getByText('First question', { exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '0 selected' })).toBeVisible()
    await page.getByText('Keep this question', { exact: true }).click()
    await page.getByText('Keep this answer', { exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '2 selected' })).toBeVisible()
    await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
    await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => requests.length).toBe(1)
    expect(requests[0]).toEqual({ messageIds: [6, 7], historyRevision: 0 })
    await expect(page.locator('.context-info')).toContainText('18.0k')
    await expect(page.locator('.context-info')).not.toContainText('136.1k')
    await expect(page.getByText('First answer segment', { exact: true })).toBeVisible()
    await expect(page.getByText('Second answer segment', { exact: true })).toBeVisible()
    await expect(page.getByText('Keep this answer', { exact: true })).toHaveCount(0)
    await page.reload()
    await expect(page.getByText('First answer segment', { exact: true })).toBeVisible()
    await expect(page.locator('.context-info')).toContainText('18.0k')
    await page.getByText('First answer segment', { exact: true }).click({ button: 'right' })
    await page.getByText('Select messages', { exact: true }).click()
    await expect(page.locator('.message-selection-row.is-locked')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  })
}
