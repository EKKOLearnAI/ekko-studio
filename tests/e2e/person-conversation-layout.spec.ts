import { test, expect, type Page, type Route } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

const selection = { runtime: 'codex', mode: 'scoped', profile: 'default', provider: 'fixture', model: 'test-model', reasoningEffort: '' }
async function setup(page: Page, fullShell = false, widths = { agent: 480, tools: 600 }) {
  const errors: string[] = [], posts: { path: string; body: any }[] = [], files: string[] = [], taskMutations: string[] = [], pinMutations: { path: string; body: any }[] = []
  const delayed = new Map<string, { promise: Promise<void>; release: () => void }>()
  function hold(path: string) {
    let release!: () => void
    const promise = new Promise<void>(done => { release = done })
    delayed.set(path, { promise, release })
    return () => { delayed.delete(path); release() }
  }
  page.on('pageerror', e => errors.push(e.message))
  await page.addInitScript(widths => {
    localStorage.setItem('hermes_locale', 'zh')
    localStorage.setItem('hermes_api_key', 'fixture.' + btoa(JSON.stringify({ sub: 1, role: 'user', username: 'fixture' })) + '.fixture')
    localStorage.setItem('hermes.person.agentPanelWidth', String(widths.agent))
    localStorage.setItem('hermes.person.toolDrawerWidth', String(widths.tools))
    const state = { available: true, activeProfileId: 'default', activeTabId: 'shared-tab', tabs: [{ id: 'shared-tab', profileId: 'default', title: '共享浏览器页', url: 'https://example.test/shared', loading: false, canGoBack: false, canGoForward: false, agentControl: 'idle' }], profiles: [{ id: 'default', name: 'Default' }], downloads: [], permissions: [], visible: true, maxTabs: 20 }
    ;(window as any).nativeViewportCalls = []
    const bridge: any = { getState: async () => state, setViewport: async (bounds: any, visible: boolean) => {
      ;(window as any).nativeViewportCalls.push({ ...bounds, visible })
    }, onStateChange: () => () => {}, onAnnotationRequest: (callback: any) => { (window as any).triggerAnnotation = () => callback({ tabId: 'shared-tab', mode: 'region' }); return () => {} } }
    for (const method of ['createTab','closeTab','activateTab','navigate','navigationAction','createProfile','chooseProfileRootDirectory','renameProfile','profileSwitchImpact','switchProfile','updateProfile','deleteProfile','clearProfileData','cancelDownload','takeOver','annotate','cancelAnnotation','updateAnnotationNote','captureAnnotations','clearAnnotations']) bridge[method] = async () => state
    const screenshot = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', mediaType: 'image/png', width: 1, height: 1 }
    bridge.annotate = async () => ({ tabId: 'shared-tab', url: 'https://example.test/shared', title: '共享浏览器页', screenshot, marker: 1, region: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 100, height: 100, scaleFactor: 1 } })
    bridge.captureAnnotations = async () => {
      ;(window as any).captureStarted = true
      await new Promise<void>(done => { (window as any).releaseCapture = done })
      return screenshot
    }
    ;(window as any).hermesDesktop = { isDesktop: true, browser: bridge }
  }, widths)
  const sessions: any[] = ['a','b','empty'].map((id,i) => ({ id: 'person-main-' + id, title: ['日常助手','研发 Bot','空 Bot'][i], workspace: '/fixture/' + id, bot_type: 'dachu', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }))
  sessions.push({ id: 'person-main-orphan', title: '无执行任务 Bot', workspace: '/fixture/orphan', bot_type: 'dachu', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 })
  const tasks: any[] = ['a1','a2','b1'].map((id,i) => ({ id, session_id: sessions[i === 2 ? 1 : 0].id, title: ['统一 App 界面（保留顶部）','修复协作流程完成回传','研发任务'][i], summary: '', status: 'open', revision: 1, execution_id: 'run-' + id, execution_state: 'finished', running: true, selection_json: JSON.stringify({ ...selection, agentId: id, agentName: ['前端工程师','后端工程师','研发执行器'][i] }), completion_evidence: '', updated_at: 1 }))
  tasks.push({ id: 'orphan', session_id: 'person-main-orphan', title: '没有执行记录的任务', summary: '', status: 'open', revision: 1, execution_id: null, execution_state: 'finished', running: false, selection_json: JSON.stringify({ ...selection, agentId: 'orphan', agentName: '未启动 Agent' }), completion_evidence: '', updated_at: 1 })
  const taskSession = (task: any) => ({ id: 'person-task-' + task.id, title: task.title, profile: 'default', source: 'coding_agent', agent: 'codex', agent_mode: 'scoped', workspace: '/fixture/' + task.id, model: 'test-model', started_at: 1, last_active: 1 })
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    ws.onMessage(raw => {
      const value = String(raw)
      if (value.startsWith('40')) ws.send(value.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
      if (!value.startsWith('42')) return
      const start = value.indexOf('['), [event, data] = JSON.parse(value.slice(start))
      if (event === 'resume') ws.send(value.slice(0, start) + JSON.stringify(['resumed', { session_id: data.session_id, messages: [], isWorking: false, queueLength: 0, events: [], workspace: '/fixture', model: 'test-model' }]))
    })
  })
  await page.route(url => url.pathname.startsWith('/api/'), async (route: Route) => {
    const request = route.request(), u = new URL(request.url())
    if (u.pathname.includes('/person/tasks') && request.method() !== 'GET') taskMutations.push(request.method() + ' ' + u.pathname)
    const gate = delayed.get(u.pathname + u.search) || delayed.get(u.pathname)
    if (gate) await gate.promise
    let json: any = {}
    if (u.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (u.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (u.pathname === '/api/hermes/available-models') json = { groups: [{ provider: 'fixture', models: ['test-model'], label: 'Fixture' }], allProviders: [], default: 'test-model', default_provider: 'fixture' }
    else if (u.pathname.includes('/profiles')) json = { profiles: [{ name: 'default', active: true }] }
    else if (u.pathname.endsWith('/pin') && u.pathname.startsWith('/api/studio/sessions/')) {
      const id = decodeURIComponent(u.pathname.split('/').at(-2)!)
      const session = sessions.find(item => item.id === id)
      if (!session) return route.fulfill({ status: 404, json: { error: 'Conversation not found' } })
      pinMutations.push({ path: u.pathname, body: request.postDataJSON() })
      session.is_pinned = Boolean(request.postDataJSON()?.is_pinned)
      json = { ok: true, is_pinned: session.is_pinned }
    } else if (u.pathname === '/api/studio/person/conversations') {
      json = {
        sessions: [...sessions].sort((left, right) =>
          Number(Boolean(right.is_pinned)) - Number(Boolean(left.is_pinned))
          || Number(right.last_active || 0) - Number(left.last_active || 0)
          || left.id.localeCompare(right.id)),
        next_offset: null,
      }
    }
    else if (u.pathname === '/api/studio/person') {
      const session = sessions.find(s => s.id === u.searchParams.get('session_id'))
      const ownTasks = tasks.filter(t => t.session_id === session?.id)
      json = { session: session || null, settings: { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, agents: [], workspace: session?.workspace || '', timezone: 'Asia/Shanghai', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null }, revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [], compression: { enabled: false, threshold: .8, globalThreshold: .8 }, contextTokens: 16000, tasks: ownTasks, active_tasks: ownTasks, active_agent_task_count: ownTasks.length, schedules: [], memories: [], interactions: [], flows: [] }
    } else if (/\/person\/tasks\/[^/]+\/chat$/.test(u.pathname)) {
      const task = tasks.find(t => u.pathname.includes('/' + t.id + '/'))!
      if (request.method() === 'POST') posts.push({ path: u.pathname, body: request.postDataJSON() })
      const execution = { id: task.execution_id, session_id: taskSession(task).id, state: 'finished', created_at: 1 }
      json = { task, session: taskSession(task), execution, executions: [execution], pending: [], canInsert: false, canRemove: false }
    } else if (u.pathname.includes('/messages/paginated')) {
      const task = tasks.find(t => u.pathname.includes('person-task-' + t.id))!
      json = { session: task ? taskSession(task) : sessions[0], messages: [], total: 0, hasMore: false }
    } else if (u.pathname.includes('/workspace-files/list')) {
      files.push(u.pathname)
      json = { entries: [{ name: u.pathname.includes('person-task-a1') ? 'a1-only.txt' : u.pathname.includes('person-task-a2') ? 'a2-only.txt' : 'bot-only.txt', path: 'only.txt', isDir: false, size: 1, modTime: '2026-11-04' }] }
    } else if (u.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    await route.fulfill({ json }).catch(() => {})
  })
  const entry = '/@fs/' + resolve(fullShell ? 'packages/client/src/main.ts' : 'tests/e2e/fixtures/person-conversation-layout.ts').replace(/^\//, '')
  await page.route('**/__conversation_layout__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__conversation_layout__' + (fullShell ? '#/person' : ''))
  await expect(page.locator('.person-title')).toHaveText('日常助手')
  return { errors, posts, files, tasks, sessions, hold, taskMutations, pinMutations }
}
async function chooseTask(page: Page, title: string) {
  await page.getByRole('button', { name: /日常助手.*Agent/ }).click()
  await page.getByRole('button', { name: title, exact: true }).click()
}
async function bot(page: Page, id: string) { await page.locator('.person-sidebar .session-item').filter({ hasText: id }).click() }
async function tools(page: Page) {
  await page.locator('.person-header-actions button[aria-controls^="person-files-panel"]').click()
  await expect(page.locator('.person-tools-panel')).toBeVisible()
}
async function evidence(page: Page, name: string, data?: unknown) {
  const dir = process.env.CONVERSATION_LAYOUT_EVIDENCE_DIR
  if (!dir) return
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: resolve(dir, name + '.png'), animations: 'disabled' })
  if (data) await writeFile(resolve(dir, name + '.json'), JSON.stringify(data, null, 2))
}
const rects = (page: Page) => page.locator('.person-task-chat, .person-tools-panel').evaluateAll(elements => elements.map(el => {
  const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }
}))

test('retains panel elements, geometry and browser tab across Agent and Bot switches; restores each Bot selection', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await tools(page)
  await page.getByRole('tab', { name: '浏览器', exact: true }).click()
  await expect(page.locator('.browser-panel .tab')).toContainText('共享浏览器页')
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '480px')
  await page.locator('.task-chat-resize').press('ArrowLeft')
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '512px')
  const resize = await page.locator('.person-tools-resize').boundingBox()
  await page.mouse.move(resize!.x + 3, resize!.y + 100)
  await page.mouse.down(); await page.mouse.move(resize!.x - 37, resize!.y + 100); await page.mouse.up()
  await expect(page.locator('.person-tools-panel')).toHaveCSS('width', '640px')
  const before = await rects(page)
  await page.evaluate(() => { (window as any).savedPanels = [...document.querySelectorAll('.person-task-chat, .person-tools-panel, .browser-panel')] })
  await evidence(page, '01-before', before)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  expect(await rects(page)).toEqual(before)
  const release = state.hold('/api/studio/person?session_id=person-main-b')
  await bot(page, '研发 Bot')
  await expect(page.locator('.person-title')).toHaveText('研发 Bot')
  expect(await rects(page)).toEqual(before)
  await expect(page.locator('.task-chat-heading')).not.toContainText(state.tasks[1].title)
  release()
  await expect(page.locator('.task-chat-heading .task-identity-title')).toHaveText('研发任务')
  expect(await rects(page)).toEqual(before)
  await bot(page, '日常助手')
  await expect(page.locator('.task-chat-heading .task-identity-title')).toHaveText(state.tasks[1].title)
  expect(await rects(page)).toEqual(before)
  expect(await page.evaluate(() => (window as any).savedPanels.every((el: Element, i: number) => el === document.querySelectorAll('.person-task-chat, .person-tools-panel, .browser-panel')[i]))).toBe(true)
  await evidence(page, '02-restored', { geometry: await rects(page), errors: state.errors })
  await bot(page, '空 Bot')
  await expect(page.locator('.person-task-chat')).toHaveCount(0)
  expect(await rects(page)).toEqual([before[1]])
  await expect(page.getByRole('tab', { name: '浏览器', exact: true })).toHaveAttribute('aria-selected', 'true')
  await evidence(page, '03-empty-bot')
  expect(state.errors).toEqual([])
})

for (const workspaceOpen of [false, true]) {
  test(`closes the Agent only after the current Bot confirms no tasks; workspace ${workspaceOpen ? 'open' : 'closed'} is preserved`, async ({ page }) => {
    await page.setViewportSize({ width: 2048, height: 1152 })
    const state = await setup(page, true)
    await chooseTask(page, state.tasks[0].title)
    await expect(page.locator('.person-task-chat')).toHaveCSS('width', '480px')
    if (workspaceOpen) await tools(page)
    const workspaceBefore = workspaceOpen ? await page.locator('.person-tools-panel').boundingBox() : null
    const release = state.hold('/api/studio/person?session_id=person-main-empty')
    await bot(page, '空 Bot')
    await expect(page.locator('.person-title')).toHaveText('空 Bot')
    await expect(page.locator('.person-task-chat .task-chat-loading')).toBeVisible()
    await expect(page.locator('.person-task-chat')).not.toContainText(state.tasks[0].title)
    await expect(page.locator('.person-tools-panel')).toHaveCount(workspaceOpen ? 1 : 0)
    await evidence(page, `empty-loading-${workspaceOpen}`)
    release()
    await expect(page.locator('.person-task-chat')).toHaveCount(0)
    await expect(page.locator('.person-tools-panel')).toHaveCount(workspaceOpen ? 1 : 0)
    if (workspaceOpen) {
      expect(await page.locator('.person-tools-panel').boundingBox()).toEqual(workspaceBefore)
      await expect.poll(() => state.files.some(path => path.includes('/person-main-empty/'))).toBe(true)
    }
    await evidence(page, `empty-confirmed-${workspaceOpen}`, { taskMutations: state.taskMutations, errors: state.errors })
    // Closing an empty panel does not implicitly open it again on another Bot.
    await bot(page, '日常助手')
    await expect(page.locator('.person-task-chat')).toHaveCount(0)
    await chooseTask(page, state.tasks[1].title)
    await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
    await expect(page.locator('.person-tools-panel')).toHaveCount(workspaceOpen ? 1 : 0)
    expect(state.taskMutations).toEqual([])
    expect(state.errors).toEqual([])
  })
}

test('does not treat a failed or stale Bot snapshot as confirmation of no tasks', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page, true)
  await chooseTask(page, state.tasks[0].title)
  await tools(page)
  const emptyUrl = '**/api/studio/person?session_id=person-main-empty'
  await page.route(emptyUrl, route => route.fulfill({ status: 503, json: { error: 'fixture unavailable' } }))
  await bot(page, '空 Bot')
  await expect(page.locator('.person-alert')).toContainText('fixture unavailable')
  await expect(page.locator('.person-task-chat .task-chat-loading')).toBeVisible()
  await expect(page.locator('.person-tools-panel')).toBeVisible()
  await evidence(page, 'empty-request-failed', { taskMutations: state.taskMutations })
  await page.unroute(emptyUrl)
  await bot(page, '日常助手')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  const release = state.hold('/api/studio/person?session_id=person-main-empty')
  await bot(page, '空 Bot')
  await expect(page.locator('.person-task-chat .task-chat-loading')).toBeVisible()
  await bot(page, '研发 Bot')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('研发执行器')
  release()
  // Force a new successful response so the canceled old read has been overtaken.
  await bot(page, '日常助手')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await expect(page.locator('.person-tools-panel')).toContainText('a1-only.txt')
  await evidence(page, 'empty-stale-ignored', { taskMutations: state.taskMutations, errors: state.errors })
  expect(state.taskMutations).toEqual([])
  expect(state.errors).toEqual([])
})

test('pins Person conversations ahead of newer unpinned conversations and persists the pin state', async ({ page }) => {
  const state = await setup(page, true)
  state.sessions[0].title = 'Older Bot'
  state.sessions[0].last_active = 100
  state.sessions[1].title = 'Newer Bot'
  state.sessions[1].last_active = 200
  state.sessions[2].last_active = 50
  await page.reload()
  const rows = () => page.locator('.person-sidebar .session-item')
  await expect(rows()).toHaveCount(4)
  await expect(rows().nth(0)).toContainText('Newer Bot')
  await expect(rows().nth(1)).toContainText('Older Bot')
  await rows().filter({ hasText: 'Older Bot' }).click({ button: 'right' })
  await page.locator('.n-dropdown-option:visible').filter({ hasText: /^置顶$|^Pin$/ }).click()
  await expect(rows().nth(0)).toContainText('Older Bot')
  await expect(rows().nth(0).locator('.session-item-pin')).toBeVisible()
  expect(state.pinMutations.at(-1)).toEqual({
    path: '/api/studio/sessions/person-main-a/pin',
    body: { is_pinned: true },
  })
  await rows().filter({ hasText: 'Older Bot' }).click({ button: 'right' })
  const unpin = page.locator('.n-dropdown-option:visible').filter({ hasText: /^取消置顶$|^Unpin$/ })
  await expect(unpin).toBeVisible()
  await expect(unpin).not.toHaveClass(/n-dropdown-option--disabled/)
  await page.reload()
  await expect(rows().nth(0)).toContainText('Older Bot')
  await expect(rows().nth(0).locator('.session-item-pin')).toBeVisible()
})

test('does not open the Agent panel for a Bot whose tasks have no execution to view', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page, true)
  await chooseTask(page, state.tasks[0].title)
  await bot(page, '无执行任务 Bot')
  await expect(page.locator('.person-title')).toHaveText('无执行任务 Bot')
  await expect(page.locator('.person-task-chat')).toHaveCount(0)
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await bot(page, '日常助手')
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.person-task-chat')).toBeVisible()
  expect(state.taskMutations).toEqual([])
  expect(state.errors).toEqual([])
})


test('rejects late Agent reads, refreshes files and sends only to the current Agent', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page)
  const release = state.hold('/api/studio/person/tasks/a1/chat')
  await chooseTask(page, state.tasks[0].title)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  release()
  await expect(page.locator('.person-task-chat textarea')).toBeVisible()
  await tools(page)
  await expect(page.locator('.person-tools-panel')).toContainText('a2-only.txt')
  await page.locator('.person-task-chat textarea').fill('只发送给当前 Agent')
  await page.locator('.person-task-chat').getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => state.posts.length).toBe(1)
  expect(state.posts[0].path).toContain('/tasks/a2/chat')
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.person-tools-panel')).toContainText('a1-only.txt')
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '480px')
  await expect(page.locator('.person-tools-panel')).not.toContainText('a2-only.txt')
  expect(state.errors).toEqual([])
  await evidence(page, '04-current-files', { posts: state.posts, files: state.files, errors: state.errors })
})

test('protects unsaved files when changing Bot or Agent and when closing the Agent panel', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const state = await setup(page)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await page.evaluate(() => { (window as any).personWorkspaceFixture.files.editingFile = { path: 'unsaved.txt', content: 'draft', originalContent: 'original', language: 'text', workspaceSessionId: 'person-task-a1' } })
  await bot(page, '研发 Bot')
  await expect(page.locator('.person-title')).toHaveText('日常助手')
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await page.locator('.task-chat-heading').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.person-task-chat')).toBeVisible()
  expect(await page.evaluate(() => (window as any).personWorkspaceFixture.files.editingFile.content)).toBe('draft')
  expect(state.errors).toEqual([])
})

test('shows two distinguishable Agent rows at mobile width with left logos spanning both lines', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const state = await setup(page)
  await page.getByRole('button', { name: /日常助手.*Agent/ }).click()
  const rows = page.locator('.activity-row .person-task-identity')
  await expect(rows).toHaveCount(2)
  const dimensions = await rows.evaluateAll(elements => elements.map(el => {
    const logo = el.querySelector('.task-identity-logo')!.getBoundingClientRect(), name = el.querySelector('.task-identity-name')!.getBoundingClientRect(), title = el.querySelector('.task-identity-title')!.getBoundingClientRect()
    return { logo: { x: logo.x, y: logo.y, height: logo.height }, name: { x: name.x, y: name.y, height: name.height }, title: { x: title.x, y: title.y, height: title.height }, overflow: el.scrollWidth > el.clientWidth }
  }))
  for (const r of dimensions) { expect(r.logo.x).toBeLessThan(r.name.x); expect(r.name.y).toBeLessThan(r.title.y); expect(r.logo.height).toBe(r.name.height + r.title.height); expect(r.overflow).toBe(false) }
  await expect(rows.nth(0)).toContainText('前端工程师')
  await expect(rows.nth(1)).toContainText('后端工程师')
  await evidence(page, '05-mobile-identity', { dimensions, errors: state.errors })
  await page.getByRole('button', { name: state.tasks[1].title, exact: true }).click()
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  await tools(page)
  await page.getByRole('tab', { name: '浏览器', exact: true }).click()
  await expect(page.locator('.browser-panel .tab')).toContainText('共享浏览器页')
  await page.locator('.person-tools-close').click()
  await expect(page.locator('.person-task-chat textarea')).toBeVisible()
  await evidence(page, '06-mobile-agent')
  expect(state.errors).toEqual([])
})

test('ignores a late file listing after changing Agent and keeps a deliberately closed tools panel closed', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const state = await setup(page)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  const oldPath = '/api/studio/sessions/person-task-a1/workspace-files/list'
  const release = state.hold(oldPath)
  const pending = page.waitForRequest(u => new URL(u.url()).pathname === oldPath)
  await tools(page)
  await pending
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.person-tools-panel')).toContainText('a2-only.txt')
  release()
  await expect.poll(() => state.files.includes(oldPath)).toBe(true)
  await expect(page.locator('.person-tools-panel')).toContainText('a2-only.txt')
  await expect(page.locator('.person-tools-panel')).not.toContainText('a1-only.txt')
  await page.locator('.person-tools-close').click()
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await bot(page, '研发 Bot')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('研发执行器')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  expect(state.errors).toEqual([])
})

test('keeps identity and controls readable through light/dark, wallpaper, regional transparency and reset', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const state = await setup(page)
  await chooseTask(page, state.tasks[0].title)
  await tools(page)
  for (const [name, brightness, opacity, wallpaper] of [
    ['light', 'light', 1, false], ['dark-wallpaper', 'dark', 0.6, true],
    ['light-transparent', 'light', 0, true], ['reset', 'light', 1, false],
  ] as const) {
    await page.evaluate(({ brightness, opacity, wallpaper }) => {
      const theme = (window as any).personWorkspaceFixture.theme
      theme.previewThemeSettings({ brightness, appearance: { global: { opacity: .7 }, regions: opacity === 1 ? {} : { card: { opacity, blur: 4, radius: 10, backgroundColor: '#627a94' } } } })
      // Use the same wallpaper CSS inputs as the application, without fetching a user's image.
      document.documentElement.classList.toggle('theme-has-custom-background', wallpaper)
      document.documentElement.style.setProperty('--app-background-image', wallpaper ? 'linear-gradient(120deg, #607080, #a0a090)' : 'none')
    }, { brightness, opacity, wallpaper })
    await expect(page.locator('.task-chat-heading .task-identity-name')).toBeVisible()
    await expect(page.locator('.task-chat-heading .task-identity-title')).toBeVisible()
    // Visibility becomes true before the panel's entrance opacity transition settles.
    await expect(page.locator('.task-chat-heading').locator('..')).toHaveCSS('opacity', '1')
    const visual = await page.locator('.task-chat-heading').evaluate(el => {
      const n = el.querySelector('.task-identity-name')!, logo = el.querySelector('.task-identity-logo')!
      return { color: getComputedStyle(n).color, background: getComputedStyle(el.parentElement!).backgroundColor, opacity: getComputedStyle(el.parentElement!).opacity, logoHeight: logo.getBoundingClientRect().height, name: n.textContent }
    })
    expect(visual.opacity).toBe('1')
    expect(visual.logoHeight).toBe(40)
    await page.getByRole('tab', { name: '浏览器', exact: true }).click()
    await expect(page.getByRole('tab', { name: '浏览器', exact: true })).toHaveAttribute('aria-selected', 'true')
    await evidence(page, 'theme-' + name, visual)
  }
  expect(state.errors).toEqual([])
})

test('does not submit a browser annotation capture to an Agent selected while capture was pending', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await tools(page)
  await page.getByRole('tab', { name: '浏览器', exact: true }).click()
  await expect(page.locator('.browser-panel .tab')).toContainText('共享浏览器页')
  await page.evaluate(() => (window as any).triggerAnnotation())
  const send = page.locator('.annotation-session-bar button').last()
  await expect(send).toBeVisible()
  await send.click()
  await expect.poll(() => page.evaluate(() => (window as any).captureStarted)).toBe(true)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  await page.evaluate(() => (window as any).releaseCapture())
  await page.waitForFunction(() => !document.querySelector('.annotation-session-bar .n-button--loading'))
  expect(state.posts).toEqual([])
  expect(state.errors).toEqual([])
  await evidence(page, '07-annotation-context', { posts: state.posts, errors: state.errors })
})

test('opens only the Agent from a closed workspace and preserves explicit closed state through switches', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page)
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await expect(page.locator('.person-task-chat textarea')).toBeVisible()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-title')).toHaveText(state.tasks[1].title)
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await bot(page, '研发 Bot')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('研发执行器')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await evidence(page, '08-agent-only', { fileRequests: state.files, errors: state.errors })
  expect(state.files).toEqual([])
  expect(state.errors).toEqual([])
})

test('keeps the workspace to the right of Agent when the workspace was opened first; manual close survives switches', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page)
  await tools(page)
  await expect(page.locator('.person-tools-panel')).toContainText('bot-only.txt')
  await expect(page.locator('.person-task-chat')).toHaveCount(0)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await expect(page.locator('.person-tools-panel')).toContainText('a1-only.txt')
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '480px')
  const bounds = async () => ({ agent: await page.locator('.person-task-chat').boundingBox(), tools: await page.locator('.person-tools-panel').boundingBox() })
  await expect.poll(async () => { const r = await bounds(); return r.agent!.x + r.agent!.width <= r.tools!.x }).toBe(true)
  const opened = await bounds()
  await evidence(page, '09-workspace-opened-first', opened)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.person-tools-panel')).toContainText('a2-only.txt')
  expect(await bounds()).toEqual(opened)
  await bot(page, '研发 Bot')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('研发执行器')
  await expect(page.locator('.person-tools-panel')).toContainText('bot-only.txt')
  expect(await bounds()).toEqual(opened)
  await page.locator('.person-tools-close').click()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await bot(page, '日常助手')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await tools(page)
  await expect(page.locator('.person-tools-panel')).toContainText('a1-only.txt')
  const reopened = await bounds()
  expect(reopened.agent!.x + reopened.agent!.width).toBeLessThanOrEqual(reopened.tools!.x)
  // The header toggle is also an explicit user close, not an Agent action.
  await page.locator('.person-header-actions button[aria-controls^="person-files-panel"]').click()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  expect(state.errors).toEqual([])
})

test('uses the application shell and real chat resume for Agent-only, explicit workspace open and both switch states', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1152 })
  const state = await setup(page, true)
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.person-task-chat textarea')).toBeVisible()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('后端工程师')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await tools(page)
  await expect(page.locator('.person-tools-panel')).toContainText('a2-only.txt')
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.person-tools-panel')).toContainText('a1-only.txt')
  await bot(page, '研发 Bot')
  await expect(page.locator('.person-task-chat textarea')).toBeVisible()
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('研发执行器')
  await expect(page.locator('.person-tools-panel')).toContainText('bot-only.txt')
  await page.locator('.person-tools-close').click()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await bot(page, '日常助手')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('前端工程师')
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.person-task-chat textarea')).toBeVisible()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await evidence(page, '10-full-application-agent-only', { errors: state.errors, files: state.files })
  expect(state.errors).toEqual([])
})

test('keeps native browser bounds aligned after position-only layout transitions without covering Agent', async ({ page }) => {
  await page.setViewportSize({ width: 1988, height: 1248 })
  const state = await setup(page, true)
  await tools(page)
  await page.getByRole('tab', { name: '浏览器', exact: true }).click()
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '480px')
  const native = () => page.evaluate(() => (window as any).nativeViewportCalls.at(-1))
  const actual = () => page.locator('.native-viewport').boundingBox()
  await expect.poll(async () => Math.abs((await native())?.x - (await actual())!.x)).toBeLessThan(1)
  // Native views are separate from DOM painting: a same-size relocation does
  // not trigger ResizeObserver. Exercise both an animated and a final position.
  await page.locator('.browser-panel').evaluate(el => {
    const panel = el as HTMLElement
    panel.style.transition = 'transform 120ms linear'
    panel.style.transform = 'translateX(24px)'
  })
  await expect.poll(async () => Math.abs((await native())?.x - (await actual())!.x)).toBeLessThan(1)
  await expect(page.locator('.browser-panel')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 24, 0)')
  await expect.poll(async () => Math.abs((await native())?.x - (await actual())!.x)).toBeLessThan(1)
  await page.locator('.browser-panel').evaluate(el => { (el as HTMLElement).style.transform = '' })
  await expect(page.locator('.browser-panel')).toHaveCSS('transform', 'none')
  await expect.poll(async () => Math.abs((await native())?.x - (await actual())!.x)).toBeLessThan(1)
  const agent = (await page.locator('.person-task-chat').boundingBox())!
  const workspace = (await page.locator('.person-tools-panel').boundingBox())!
  const final = await native()
  expect(agent.x + agent.width).toBeLessThanOrEqual(workspace.x)
  expect(final.visible).toBe(true)
  expect(final.x).toBeGreaterThanOrEqual(agent.x + agent.width)
  // Unchanged geometry must not flood the Electron IPC channel.
  const before = await page.evaluate(() => (window as any).nativeViewportCalls.length)
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => (window as any).nativeViewportCalls.length)).toBe(before)
  // A native view must also respect inherited CSS visibility (mobile/route
  // layouts can hide a panel while leaving its bounding box unchanged).
  await page.locator('.person-tools-panel').evaluate(el => { (el as HTMLElement).style.visibility = 'hidden' })
  await expect.poll(async () => (await native())?.visible).toBe(false)
  await page.locator('.person-tools-panel').evaluate(el => { (el as HTMLElement).style.visibility = '' })
  await expect.poll(async () => (await native())?.visible).toBe(true)
  await evidence(page, '11-native-alignment', { agent, workspace, native: final, viewport: await actual(), errors: state.errors })
  expect(state.errors).toEqual([])
})

test('keeps Bot Agent workspace order with wide saved panels, Agent close/reopen and workspace remount', async ({ page }) => {
  await page.setViewportSize({ width: 1988, height: 1248 })
  const state = await setup(page, true, { agent: 840, tools: 1200 })
  await tools(page)
  await page.getByRole('tab', { name: '浏览器', exact: true }).click()
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '840px')
  async function alignment() {
    const bot = (await page.locator('.person-chat-surface').boundingBox())!
    const agent = (await page.locator('.person-task-chat').boundingBox())!
    const workspace = (await page.locator('.person-tools-panel').boundingBox())!
    const viewport = (await page.locator('.native-viewport').boundingBox())!
    const native = await page.evaluate(() => (window as any).nativeViewportCalls.at(-1))
    expect(bot.width).toBeGreaterThanOrEqual(300)
    expect(bot.x + bot.width).toBeLessThanOrEqual(agent.x)
    expect(agent.x + agent.width).toBeLessThanOrEqual(workspace.x)
    expect(workspace.x + workspace.width).toBeLessThanOrEqual(1988)
    await expect.poll(async () => {
      const r = (await page.locator('.native-viewport').boundingBox())!
      const n = await page.evaluate(() => (window as any).nativeViewportCalls.at(-1))
      return Math.max(Math.abs(n.x - r.x), Math.abs(n.y - r.y), Math.abs(n.width - r.width), Math.abs(n.height - r.height))
    }).toBeLessThanOrEqual(1)
    return { bot, agent, workspace, viewport, native }
  }
  const before = await alignment()
  await page.locator('.task-chat-heading').getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.locator('.person-task-chat')).toHaveCount(0)
  await expect(page.locator('.person-tools-panel')).toBeVisible()
  await chooseTask(page, state.tasks[1].title)
  await expect(page.locator('.person-task-chat')).toHaveCSS('width', '840px')
  await alignment()
  await bot(page, '研发 Bot')
  await expect(page.locator('.task-chat-heading .task-identity-name')).toHaveText('研发执行器')
  await alignment()
  await page.locator('.person-tools-close').click()
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).nativeViewportCalls.at(-1)?.visible)).toBe(false)
  await bot(page, '日常助手')
  await chooseTask(page, state.tasks[0].title)
  await expect(page.locator('.person-tools-panel')).toHaveCount(0)
  await tools(page)
  await expect(page.locator('.native-viewport')).toBeVisible()
  const after = await alignment()
  await evidence(page, '12-wide-panel-order', { before, after, errors: state.errors })
  expect(state.errors).toEqual([])
})
