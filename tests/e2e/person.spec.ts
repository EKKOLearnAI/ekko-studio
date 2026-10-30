import { expect, test, type Locator, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, mockTerminalWebSocket } from './fixtures'
import { installDesktopBridge } from './desktop-bridge-fixture'
import sharp from 'sharp'
import { PERSON_BOTS, personBotNameKey } from '../../packages/shared/person-bots'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import type { SessionListState } from '../../packages/shared/session-state'

async function setup(page: Page, mode: 'light' | 'dark', wallpaper = true, customAppearance = true) {
  await authenticate(page)
  await mockChatSocket(page)
  await mockHermesApi(page, { theme: { brightness: mode, ...(wallpaper ? { background: { name: 'person.png', mime: 'image/png', updatedAt: 1 } } : {}), ...(customAppearance ? { appearance: { global: { opacity: 0.5 }, regions: { card: { opacity: 0.65, blur: 12 } } } } : {}) } })
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#345678' } }).png().toBuffer()
  await page.route('**/api/theme/background?*', route => route.request().method() === 'GET'
    ? route.fulfill({ contentType: 'image/png', body: image }) : route.fallback())
  const globalModel = { model: 'global-model', provider: 'provider', profile: 'default' }
  const state: any = { settings: { workspace: '', model: globalModel, reasoningEffort: 'low', timezone: 'UTC', compressionThreshold: null, maxSteps: 12, maxConcurrentTasks: 6, agents: [{ id: 'worker', name: 'Research assistant', description: 'Research and write reports', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'provider', model: 'global-model', reasoningEffort: '' } }] }, contextTokens: 200000, compression: { enabled: true, threshold: 0.5, globalThreshold: 0.5 }, inherits_global_model: true, reasoning_efforts: ['none', 'low', 'high'], revision: 0, busy: false, history_revision: 0, can_clear: false, tasks: [{ id: 'task1', title: 'Check report', summary: 'Verify a report', status: 'open', revision: 0, execution_id: 'execution1', execution_state: 'running', running: true }], schedules: [], memories: [], interactions: [] }
  state.session = { id: 'person-main-1', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', profile: 'default', title: 'Person', workspace: '/tmp/person/default', model: 'global-model', provider: 'provider', started_at: 1, ended_at: null, message_count: 0, tool_call_count: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '' }
  state.conversations = [state.session]
  state.conversationMessages = {}
  state.tasks[0].session_id = state.session.id
  await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__ = { 'person-main-1': { session_id: 'person-main-1', messages: [], isWorking: false, events: [] }, ...(window as any).__PW_CHAT_SOCKET_RESUMES__ } })
  const operations: any[] = []
  function removeConversation(id: string) {
    state.conversations = state.conversations.filter((session: any) => session.id !== id)
    const removedIds = new Set(state.tasks.filter((task: any) => task.session_id === id).map((task: any) => task.id))
    state.tasks = state.tasks.filter((task: any) => !removedIds.has(task.id))
    state.schedules = state.schedules.filter((schedule: any) => !removedIds.has(schedule.task_id))
  }
  await page.route('**/api/studio/sessions/batch-delete', async route => {
    const req = route.request(); const body = req.postDataJSON()
    operations.push({ path: new URL(req.url()).pathname, body, headers: req.headers() })
    if (state.failBatchRequest) return route.fulfill({ status: 500, json: { error: 'Batch unavailable' } })
    const errors = body.ids.filter((id: string) => state.batchFailedIds?.includes(id)).map((id: string) => ({ id, error: 'Task stop failed' }))
    for (const id of body.ids) if (!errors.some((error: any) => error.id === id)) removeConversation(id)
    await emit(page, 'person.updated', {})
    await state.afterDelete?.()
    return route.fulfill({ json: { deleted: body.ids.length - errors.length, failed: errors.length, errors } })
  })
  await page.route('**/api/studio/sessions/*/rename', route => {
    const req = route.request(); const path = new URL(req.url()).pathname; const body = req.postDataJSON()
    operations.push({ path, body, headers: req.headers() })
    if (state.failRename) return route.fulfill({ status: 500, json: { error: 'Rename failed' } })
    const session = state.conversations.find((item: any) => item.id === decodeURIComponent(path.split('/').at(-2)!))
    if (!session) return route.fulfill({ status: 404, json: { error: 'Conversation not found' } })
    session.title = body.title
    return route.fulfill({ json: { ok: true } })
  })
  await page.route(/^https?:\/\/[^/]+\/api\/studio\/person(?:\/|\?|$)/, async route => {
    const req = route.request(); const path = new URL(req.url()).pathname; const body = req.postDataJSON()
    operations.push({ path, body, headers: req.headers() })
    if (path.endsWith('/conversations')) {
      if (req.method() === 'POST') {
        if (state.failCreate) return route.fulfill({ status: 503, json: { error: 'Creation unavailable' } })
        if (state.conflictingBotName === body.title || state.conversations.some((session: any) => personBotNameKey(session.title) === personBotNameKey(body.title)))
          return route.fulfill({ status: 409, json: { error: 'A BOT with this name already exists', code: 'PERSON_BOT_NAME_EXISTS' } })
        if (body.workspace !== undefined) {
          state.settings.workspace = body.workspace
          for (const session of state.conversations) session.workspace = body.workspace || '/tmp/person/default'
        }
        const session = { ...state.session, id: `person-main-new-${operations.length}`, title: body.title, bot_type: body.bot_type || 'zhezhe', workspace: state.settings.workspace || '/tmp/person/default', ...(body.model ? { model: body.model.model, provider: body.model.provider } : {}), history_revision: 0 }
        state.conversations.unshift(session)
        await page.evaluate(sessionId => {
          (window as any).__PW_CHAT_SOCKET_RESUMES__[sessionId] = { session_id: sessionId, messages: [], isWorking: false, events: [] }
        }, session.id)
        return route.fulfill({ json: session })
      }
      const query = new URL(req.url()).searchParams.get('search')?.toLowerCase() || ''
      const sessions = state.conversations.filter((session: any) => !query || session.title.toLowerCase().includes(query) || (state.conversationMessages[session.id] || []).some((message: any) => message.content.toLowerCase().includes(query)))
      return route.fulfill({ json: { sessions, next_offset: null } })
    }
    if (path.includes('/conversations/') && req.method() === 'DELETE') {
      if (state.failDelete) return route.fulfill({ status: 409, json: { error: 'Conversation changed; reload and retry' } })
      const id = decodeURIComponent(path.split('/').at(-1)!)
      removeConversation(id)
      await emit(page, 'person.updated', {})
      await state.afterDelete?.()
      return route.fulfill({ json: { deleted: true, session_id: id } })
    }
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { agents: [{ runtime: 'ekko', installed: true }, { runtime: 'codex', installed: true }], native_allowed: true } })
    if (path.endsWith('/models') || path.endsWith('/agent-models')) return route.fulfill({ json: { groups: [{ provider: 'provider', profile: 'default', label: 'My provider', models: ['global-model', 'fast-model'], model_meta: { 'global-model': { reasoning_efforts: ['none', 'low', 'high'] }, 'fast-model': { reasoning: false } } }] } })
    if (path.endsWith('/settings')) {
      if (body.expected_revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Settings changed' } })
      for (const key of ['compressionThreshold', 'maxSteps', 'maxConcurrentTasks', 'timezone']) if (body[key] !== undefined) state.settings[key] = body[key]
      if (body.workspace !== undefined) { state.settings.workspace = body.workspace; state.session.workspace = body.workspace || '/tmp/person/default' }
      if (body.agents) state.settings.agents = body.agents
      if (body.model) { state.settings.model = body.model; state.inherits_global_model = false; state.reasoning_efforts = []; state.settings.reasoningEffort = '' }
      if (body.reasoning_effort !== undefined) state.settings.reasoningEffort = body.reasoning_effort
      if (body.use_global_default) { state.settings.model = globalModel; state.inherits_global_model = true; state.reasoning_efforts = ['none', 'low', 'high'] }
      state.contextTokens = state.settings.model.model === 'fast-model' ? 128000 : 200000
      state.compression.threshold = state.settings.compressionThreshold ?? state.compression.globalThreshold
      state.revision++
      return route.fulfill({ json: { contextTokens: state.contextTokens, compression: state.compression, settings: state.settings, revision: state.revision, inherits_global_model: state.inherits_global_model, reasoning_efforts: state.reasoning_efforts } })
    }
    if (path.endsWith('/clear')) {
      if (body.expected_history_revision !== state.history_revision || state.busy || state.tasks.some((task: any) => task.running)) return route.fulfill({ status: 409, json: { error: 'Wait for Person tasks and result delivery to finish' } })
      state.tasks = []; state.schedules = []; state.interactions = []; state.history_revision++
      await page.evaluate(() => {
        (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = []
        ;(window as any).__PW_CHAT_SOCKET__.broadcast('session.command', { event: 'session.command', session_id: 'person-main-1', command: 'clear', action: 'clear', ok: true, clearHistory: true })
      })
      return route.fulfill({ json: { cleared: true } })
    }
    if (path.endsWith('/tasks/task1/chat')) {
      if (req.method() === 'POST') {
        if (body.expected_revision !== state.tasks[0].revision) return route.fulfill({ status: 409, json: { error: 'Task changed' } })
        state.pending ||= []
        state.pending.push({ id: `followup${state.pending.length + 1}`, input: body.input })
        if (!state.tasks[0].running) { state.tasks[0].execution_state = 'queued'; state.tasks[0].execution_id = 'execution2' }
        state.tasks[0].running = true; state.tasks[0].status = 'open'; state.tasks[0].revision++
      }
      const executions = state.executions || [{ id: state.tasks[0].execution_id || 'execution1', session_id: 'person-task-task1', state: state.tasks[0].execution_state, created_at: 1 }]
      const execution = executions.find((run: any) => run.id === new URL(req.url()).searchParams.get('execution_id')) || executions[0]
      return route.fulfill({ json: { pending: state.pending || [], task: state.tasks[0], executions, execution, session: { ...state.session, id: execution.session_id, title: state.tasks[0].title } } })
    }
    if (path.endsWith('/tasks/apply')) {
      if (body.expected_revision !== state.tasks[0].revision || (body.action === 'stop' && body.execution_id !== state.tasks[0].execution_id)) return route.fulfill({ status: 409, json: { error: 'Execution changed' } })
      if (body.action === 'stop') { state.tasks[0].execution_state = 'stopping'; state.pending = [] }
      else state.tasks[0].status = body.action === 'close' ? 'closed' : 'open'
      state.tasks[0].revision++
      return route.fulfill({ json: { task: state.tasks[0] } })
    }
    if (path.endsWith('/flows/apply')) {
      const flow = state.flows.find((item: any) => item.id === body.flow_id)
      if (body.expected_revision !== flow.revision) return route.fulfill({status:409,json:{error:'Flow changed'}})
      flow.state = body.action === 'stop' ? 'stopped' : 'active'; flow.revision++
      return route.fulfill({json:flow})
    }
    if (path.endsWith('/schedules/apply')) {
      if (body.action === 'create') state.schedules.push({ ...body, id: `schedule${state.schedules.length + 1}`, state: 'active', next_at: Date.now() + 86400000, revision: 0 })
      else {
        const schedule = state.schedules.find((item: any) => item.id === body.schedule_id)
        if (!schedule || body.expected_revision !== schedule.revision) return route.fulfill({ status: 409, json: { error: 'Schedule changed' } })
        if (body.action === 'delete') {
          if (state.failScheduleDelete) return route.fulfill({ status: 500, json: { error: 'Schedule deletion failed' } })
          state.schedules = state.schedules.filter((item: any) => item.id !== schedule.id)
        } else if (body.action === 'update') Object.assign(schedule, body)
        else schedule.state = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[body.action as string]
        schedule.revision++
      }
      return route.fulfill({ json: {} })
    }
    if (path.endsWith('/memory')) { state.memories = state.memories.filter((m: any) => m.id !== body.id); return route.fulfill({ json: {} }) }
    const requested = new URL(req.url()).searchParams.get('session_id')
    const selected = requested ? state.conversations.find((session: any) => session.id === requested) : null
    if (requested && !selected) return route.fulfill({ status: 404, json: { error: 'Conversation not found' } })
    state.can_clear = !state.busy && !state.tasks.some((task: any) => task.running)
    state.session.model = state.settings.model?.model || ''; state.session.provider = state.settings.model?.provider || ''; state.session.reasoning_effort = state.settings.reasoningEffort
    if (path.endsWith('/tasks/query')) return route.fulfill({ json: { tasks: state.tasks.filter((task: any) => !body.session_id || (task.session_id || state.session.id) === body.session_id) } })
    return route.fulfill({ json: { ...state, session: selected, tasks: state.tasks.filter((task: any) => selected && (task.session_id || state.session.id) === selected.id), schedules: state.schedules.filter((schedule: any) => schedule.session_id === selected?.id || state.tasks.some((task: any) => task.id === schedule.task_id && (task.session_id || state.session.id) === selected?.id)) } })
  })
  return { state, operations }
}

for (const listState of ['existing', 'empty', 'unavailable']) {
  test(`leaving a focused Person result sends to ordinary chat (${listState} list)`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    const ordinarySession = { ...state.session, id: 'ordinary-chat', agent_preset: '', title: 'Ordinary chat' }
    await page.route(/\/api\/studio\/sessions(?:\?.*)?$/, route => route.fulfill({
      status: listState === 'unavailable' ? 503 : 200,
      json: listState === 'unavailable' ? { error: 'Session list unavailable' }
        : { sessions: listState === 'existing' ? [ordinarySession] : [] },
    }))
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [
        { id: 580, role: 'assistant', content: 'Private Person search result', timestamp: 1 },
      ]
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__['ordinary-chat'] = {
        session_id: 'ordinary-chat', messages: [], isWorking: false, events: [],
      }
    })
    await page.goto('/#/person?session=person-main-1&message=580')
    await expect(page.getByText('Private Person search result', { exact: true })).toBeVisible()

    await page.getByRole('link', { name: 'Chat', exact: true }).click()
    await expect(page).toHaveURL(/#\/hermes\/chat$/)
    await expect(page.locator('.chat-panel')).toBeVisible()
    await expect(page.getByText('Private Person search result', { exact: true })).toHaveCount(0)
    await page.locator('.input-textarea').fill('Continue in ordinary chat')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
    const [run] = await emitted(page, 'run')
    expect(run.session_id).toBeTruthy()
    expect(run.session_id).not.toMatch(/^person-(main|task)-/)
    if (listState === 'existing') expect(run.session_id).toBe('ordinary-chat')
  })
}

async function setupSessionModels(page: Page, mode: 'light' | 'dark' = 'light') {
  const { state, operations } = await setup(page, mode, mode === 'dark', mode === 'dark')
  const second = { ...state.session, id: 'person-main-second', title: 'Second' }
  state.conversations.push(second)
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__[id] = { session_id: id, messages: [], isWorking: false, events: [] }
  }, second.id)
  const models = new Map(state.conversations.map((session: any) => [session.id, {
    model: structuredClone(state.settings.model), reasoningEffort: 'low', inherits: true,
  }])) as Map<string, { model: any; reasoningEffort: string; inherits: boolean }>
  function snapshot(id: string) {
    const selected = models.get(id)!
    return { ...state, settings: { ...state.settings, model: selected.model, reasoningEffort: selected.reasoningEffort },
      inherits_global_model: selected.inherits, reasoning_efforts: selected.model.model === 'fast-model' ? [] : ['none', 'low', 'high'],
      session: { ...state.conversations.find((session: any) => session.id === id), model: selected.model.model, provider: selected.model.provider, reasoning_effort: selected.reasoningEffort }, tasks: [], schedules: [] }
  }
  await page.route(/\/api\/studio\/person(?:\?.*)?$/, route => {
    const id = new URL(route.request().url()).searchParams.get('session_id')
    return id && models.has(id) ? route.fulfill({ json: snapshot(id) }) : route.fallback()
  })
  await page.route('**/api/studio/person/settings', async route => {
    const body = route.request().postDataJSON()
    operations.push({ path: '/api/studio/person/settings', body })
    const selected = models.get(body.session_id)
    if (!selected) return route.fulfill({ status: 400, json: { error: 'session_id is required' } })
    await state.beforeModelSave?.(body)
    if (body.expected_revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Settings changed' } })
    if (body.model) { selected.model = body.model; selected.inherits = false; selected.reasoningEffort = body.model.model === 'fast-model' ? '' : 'low' }
    if (body.reasoning_effort !== undefined) selected.reasoningEffort = body.reasoning_effort
    if (body.use_global_default) { selected.model = structuredClone(state.settings.model); selected.inherits = true; selected.reasoningEffort = 'low' }
    state.revision++
    const { session, ...result } = snapshot(body.session_id)
    return route.fulfill({ json: result })
  })
  return { state, operations, models, second }
}

async function switchPersonSession(page: Page, id: string) {
  await page.evaluate(id => { window.location.hash = `/person?session=${id}` }, id)
  await expect(page.locator('.person-view')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.input-model-button')).toBeVisible()
}

async function mockPersonWorkspace(page: Page) {
  const requests: { sessionId: string; path: string; endpoint: string }[] = []
  await page.route(/\/api\/studio\/sessions\/[^/]+\/workspace-(?:files|file)\//, route => {
    const url = new URL(route.request().url())
    const sessionId = decodeURIComponent(url.pathname.split('/')[4])
    const path = url.searchParams.get('path') || ''
    const endpoint = url.pathname.split('/').at(-1)!
    requests.push({ sessionId, path, endpoint })
    if (endpoint === 'list') return route.fulfill({ json: { path, absolutePath: '/tmp/person/default', entries: [
      { name: 'README.md', path: 'README.md', isDir: false, size: 70, modTime: '2026-10-30T00:00:00.000Z' },
    ] } })
    if (endpoint === 'diff') return route.fulfill({ json: { patch: '', additions: 0, deletions: 0, binary: false, truncated: false } })
    if (endpoint === 'read') return route.fulfill({ json: { path, size: 70, content: '# Assistant workspace\n\nBrowse the personal assistant files here.' } })
    if (endpoint === 'content') return route.fulfill({ contentType: 'text/plain', body: 'line one\nline two\nline three\n' })
    return route.fallback()
  })
  return requests
}

for (const { mode, width, wallpaper } of [
  { mode: 'light' as const, width: 1440, wallpaper: false },
  { mode: 'dark' as const, width: 1440, wallpaper: true },
  { mode: 'light' as const, width: 390, wallpaper: true },
  { mode: 'dark' as const, width: 390, wallpaper: false },
]) {
  test(`Person browses workspace files and previews message links in ${mode} at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await setup(page, mode, wallpaper, wallpaper)
    const requests = await mockPersonWorkspace(page)
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [
        { id: 'file-link', role: 'assistant', content: '[View source](/tmp/person/default/report.ts:2:1)', timestamp: 1 },
      ]
    })
    await page.goto('/#/person?session=person-main-1')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    await page.locator('.person-compose .input-textarea').fill('Keep this main draft')
    await expect(page.getByRole('button', { name: 'Workspace', exact: true })).toBeDisabled()
    const panelToggle = page.getByRole('button', { name: 'Side panel', exact: true })
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'false')
    await page.screenshot({ path: testInfo.outputPath('person-shared-side-panel-button.png'), animations: 'disabled' })
    await panelToggle.click()
    const drawer = page.locator('.person-files-drawer')
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer.locator('.n-drawer-content')).toHaveAttribute('id', (await panelToggle.getAttribute('aria-controls'))!)
    await expect(drawer.locator('.file-tree')).toBeVisible()
    await drawer.getByText('README.md', { exact: true }).click()
    await expect(drawer.locator('.workspace-markdown-preview')).toContainText('Browse the personal assistant files here.')
    expect(requests.some(request => request.sessionId === 'person-main-1' && request.path === 'README.md' && request.endpoint === 'read')).toBe(true)
    await drawer.screenshot({ path: testInfo.outputPath('person-workspace-files.png'), animations: 'disabled' })
    await drawer.locator('.n-drawer-header').getByRole('button', { name: 'close', exact: true }).click()
    await expect(drawer).toBeHidden()
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'false')

    await page.locator('.person-view .markdown-file-link').click()
    await expect(panelToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(drawer.locator('.file-preview')).toBeVisible()
    await expect(drawer.locator('.preview-source-line.is-target-line')).toHaveCount(1)
    await expect(drawer.locator('.preview-source-line.is-target-line')).toContainText('line two')
    expect(requests.some(request => request.sessionId === 'person-main-1' && request.path === 'report.ts' && request.endpoint === 'content')).toBe(true)
    await expect(drawer.locator('.file-tree')).toHaveCount(0)
    await drawer.screenshot({ path: testInfo.outputPath('person-file-link-preview.png'), animations: 'disabled' })
    await drawer.locator('.file-preview').getByRole('button', { name: 'Close', exact: true }).click()
    await expect(drawer).toBeHidden()
    await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep this main draft')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('Person previews task files with the task session and leaves the main conversation selected', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  Object.assign(state.tasks[0], { status: 'completed', running: false, execution_state: 'finished' })
  const requests = await mockPersonWorkspace(page)
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = {
      session_id: 'person-task-task1', messages: [
        { id: 'task-file', role: 'assistant', content: '[Task output](/tmp/external-task/report.txt)', timestamp: 1 },
      ], isWorking: false, events: [],
    }
  })
  await page.goto('/#/person?session=person-main-1')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const taskDrawer = page.locator('.person-task-chat')
  await taskDrawer.locator('.markdown-file-link').click()
  const files = page.locator('.person-files-drawer')
  await expect(files.locator('.preview-code')).toContainText('line two')
  expect(requests.filter(request => request.endpoint === 'content')).toEqual([
    { sessionId: 'person-task-task1', path: '/tmp/external-task/report.txt', endpoint: 'content' },
  ])
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
  await files.locator('.file-preview').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(files).toBeHidden()
  await taskDrawer.getByRole('button', { name: 'Side panel', exact: true }).click()
  await expect(files.locator('.file-tree')).toBeVisible()
  expect(requests.filter(request => request.endpoint === 'list').every(request => request.sessionId === 'person-task-task1')).toBe(true)
})

test('Person retains workspace attachments and unsaved edits when returning to the conversation', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  state.tasks = []
  const second = { ...state.session, id: 'person-main-files-second', title: 'Second files' }
  state.conversations.push(second)
  await page.addInitScript(secondId => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__[secondId] = { session_id: secondId, messages: [], isWorking: false, events: [] }
  }, second.id)
  await mockPersonWorkspace(page)
  await page.goto('/#/person?session=person-main-1')
  await page.getByRole('button', { name: 'Side panel', exact: true }).click()
  const files = page.locator('.person-files-drawer')
  await files.getByText('README.md', { exact: true }).click({ button: 'right' })
  await page.getByText('Add to Chat', { exact: true }).click()
  await expect(page.locator('.person-compose .attachment-preview')).toContainText('README.md')
  await files.getByText('README.md', { exact: true }).click()
  await files.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(files.locator('.monaco-editor')).toBeVisible()
  await files.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' Keep my unsaved changes')
  await expect(files.locator('.monaco-editor .view-lines')).toContainText('Keep my unsaved changes')
  await files.locator('.n-drawer-header').getByRole('button', { name: 'close', exact: true }).click()
  await expect(files).toBeVisible()
  await switchPersonSession(page, second.id)
  await expect(files).toBeHidden()
  await switchPersonSession(page, 'person-main-1')
  await page.getByRole('button', { name: 'Side panel', exact: true }).click()
  await expect(files.locator('.monaco-editor .view-lines')).toContainText('Keep my unsaved changes')
  await expect(page.locator('.person-compose .attachment-preview')).toContainText('README.md')
})

for (const mode of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`Person shares the terminal tabs and preserves the terminal across tab switches in ${mode} at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      await setup(page, mode, mode === 'dark', mode === 'dark')
      await mockPersonWorkspace(page)
      await mockTerminalWebSocket(page)
      await page.goto('/#/person?session=person-main-1')
      await page.getByRole('button', { name: 'Side panel', exact: true }).click()
      const panel = page.locator('.person-files-drawer')
      await expect(panel.getByRole('tab', { name: 'Workspace', exact: true })).toBeVisible()
      await expect(panel.getByRole('tab', { name: 'Browser', exact: true })).toHaveCount(0)
      await panel.getByRole('tab', { name: 'Terminal', exact: true }).click()
      await expect(panel.getByRole('button', { name: 'zsh #1', exact: true })).toBeVisible()
      await panel.locator('.xterm-helper-textarea').focus()
      await page.keyboard.type('pwd')
      await page.keyboard.press('Enter')
      await expect.poll(() => page.evaluate(() => (window as any).__PW_TERMINAL_WS__.sent
        .filter((entry: any) => !entry.data.startsWith('{')).map((entry: any) => entry.data).join(''))).toContain('pwd\r')
      await panel.getByRole('tab', { name: 'Workspace', exact: true }).click()
      await expect(panel.locator('.file-tree')).toBeVisible()
      await panel.getByRole('tab', { name: 'Terminal', exact: true }).click()
      expect(await page.evaluate(() => (window as any).__PW_TERMINAL_WS__.sockets
        .filter((socket: any) => new URL(String(socket.url), location.href).pathname === '/api/hermes/terminal').length)).toBe(1)
      await panel.screenshot({ path: testInfo.outputPath('person-terminal.png'), animations: 'disabled' })
    })
  }
}

test('Person opens the shared browser from links, hides it behind overlays and sends annotations to the main conversation', async ({ page }, testInfo) => {
  await installDesktopBridge(page, 'darwin', true)
  await setup(page, 'light', false, false)
  await mockPersonWorkspace(page)
  await page.route('**/api/studio/uploads', route => route.fulfill({ json: { files: [{ name: 'browser.png', path: '/tmp/person/browser.png' }] } }))
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [
      { id: 'browser-link', role: 'assistant', content: '[Open example](https://example.test)', timestamp: 1 },
    ]
  })
  await page.goto('/#/person?session=person-main-1')
  await page.getByRole('link', { name: 'Open example', exact: true }).click()
  const panel = page.locator('.person-files-drawer')
  await expect(panel.getByRole('tab', { name: 'Browser', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(true)
  await panel.getByRole('tab', { name: 'Workspace', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(false)
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('hermes:open-desktop-browser-panel')))
  await expect(panel.getByRole('tab', { name: 'Browser', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('person-browser.png'), animations: 'disabled' })
  await page.evaluate(() => {
    const overlay = document.createElement('div')
    overlay.className = 'n-modal-mask'
    overlay.dataset.personBrowserOverlay = 'true'
    Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '9999' })
    document.body.appendChild(overlay)
  })
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(false)
  await page.evaluate(() => document.querySelector('[data-person-browser-overlay]')?.remove())
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(true)
  await page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.requestAnnotation({ tabId: 'tab-1', mode: 'element' }))
  await panel.locator('.annotation-editor textarea').fill('Inspect the main assistant page')
  await panel.locator('.annotation-session-bar').getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
  const [run] = await emitted(page, 'run')
  expect(run.session_id).toBe('person-main-1')
  expect(JSON.stringify(run)).toContain('Inspect the main assistant page')
  await panel.locator('.n-drawer-header').getByRole('button', { name: 'close', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(false)
})

test('Person task conversations share the terminal and browser and submit annotations to the task', async ({ page }, testInfo) => {
  await installDesktopBridge(page, 'darwin', true)
  const { state, operations } = await setup(page, 'dark', true, true)
  Object.assign(state.tasks[0], { status: 'completed', running: false, execution_state: 'finished' })
  await mockPersonWorkspace(page)
  await page.route('**/api/studio/uploads', route => route.fulfill({ json: { files: [{ name: 'browser.png', path: '/tmp/person/browser.png' }] } }))
  await mockTerminalWebSocket(page)
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = {
      session_id: 'person-task-task1', messages: [
        { id: 'task-browser-link', role: 'assistant', content: '[Inspect task page](https://example.test/task)', timestamp: 1 },
      ], isWorking: false, events: [],
    }
  })
  await page.goto('/#/person?session=person-main-1')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const task = page.locator('.person-task-chat')
  await task.getByRole('button', { name: 'Side panel', exact: true }).click()
  const panel = page.locator('.person-files-drawer')
  await panel.getByRole('tab', { name: 'Terminal', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'zsh #1', exact: true })).toBeVisible()
  await panel.locator('.n-drawer-header').getByRole('button', { name: 'close', exact: true }).click()
  await task.getByRole('link', { name: 'Inspect task page', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.viewportCalls.at(-1)?.visible)).toBe(true)
  await panel.screenshot({ path: testInfo.outputPath('person-task-browser.png'), animations: 'disabled' })
  await page.evaluate(() => (window as any).__PW_DESKTOP_BROWSER__.requestAnnotation({ tabId: 'tab-1', mode: 'region' }))
  await panel.locator('.annotation-editor textarea').fill('Task-specific browser annotation')
  await panel.locator('.annotation-session-bar').getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
  expect(JSON.stringify(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body.input)).toContain('Task-specific browser annotation')
  expect(await emitted(page, 'run')).toEqual([])
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
})

test('Person cancels late file previews and reports failures without downloading the file', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  state.tasks = []
  const second = { ...state.session, id: 'person-main-files-second', title: 'Second files' }
  state.conversations.push(second)
  await page.addInitScript(secondId => {
    const resumes = (window as any).__PW_CHAT_SOCKET_RESUMES__
    resumes['person-main-1'].messages = [{ id: 'slow-file', role: 'assistant', content: '[Slow file](/tmp/person/default/slow.txt)', timestamp: 1 }]
    resumes[secondId] = { session_id: secondId, messages: [], isWorking: false, events: [] }
  }, second.id)
  let requested = false
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/studio/sessions/person-main-1/workspace-file/content**', async route => {
    requested = true
    await held
    await route.fulfill({ contentType: 'text/plain', body: 'Late preview from the previous conversation' })
  })
  await page.goto('/#/person?session=person-main-1')
  await page.locator('.markdown-file-link').click()
  const files = page.locator('.person-files-drawer')
  await expect(files.locator('.person-file-loading')).toBeVisible()
  await expect.poll(() => requested).toBe(true)
  await files.locator('.n-drawer-header').getByRole('button', { name: 'close', exact: true }).click()
  await switchPersonSession(page, second.id)
  release()
  await expect(files).toBeHidden()
  await expect(page.getByText('Late preview from the previous conversation')).toHaveCount(0)

  await page.route('**/api/studio/sessions/person-main-1/workspace-file/content**', route => route.fulfill({ status: 404, json: { error: 'Preview file missing' } }))
  await switchPersonSession(page, 'person-main-1')
  const downloads: string[] = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  await page.locator('.markdown-file-link').click()
  await expect(page.locator('.n-message')).toContainText('Preview file missing')
  await expect(files).toBeHidden()
  expect(downloads).toEqual([])
})

test('Person session models and efforts stay independent across switching, refresh and sending', async ({ page }) => {
  const { models, second, operations } = await setupSessionModels(page)
  await page.goto('/#/person?session=person-main-1')
  await page.locator('.input-model-button').click()
  await page.locator('.model-cascader:visible').getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
  await switchPersonSession(page, second.id)
  await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')
  await page.locator('.reasoning-effort-button').click()
  await page.getByRole('slider').focus(); await page.keyboard.press('ArrowRight')
  await expect.poll(() => models.get(second.id)?.reasoningEffort).toBe('high')
  await page.keyboard.press('Escape')
  await switchPersonSession(page, 'person-main-1')
  await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
  await page.reload()
  await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
  await page.locator('.input-model-button').click()
  await page.getByRole('button', { name: 'Use global default model', exact: true }).click()
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /low/i)
  await switchPersonSession(page, second.id)
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await page.reload()
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await page.locator('.input-textarea').fill('Check this conversation')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => emitted(page, 'run')).toEqual([expect.objectContaining({ session_id: second.id, model: 'global-model', reasoning_effort: 'high' })])
  expect(operations.filter(op => op.path.endsWith('/settings')).map(op => op.body.session_id)).toEqual(['person-main-1', second.id, 'person-main-1'])
})

test('Person session switch clears optimistic effort while another session save is pending', async ({ page }) => {
  const { state, models, second } = await setupSessionModels(page)
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let started = false
  state.beforeModelSave = async () => { started = true; await pending }
  await page.goto('/#/person?session=person-main-1')
  await page.locator('.reasoning-effort-button').click()
  await page.getByRole('slider').focus(); await page.keyboard.press('ArrowRight')
  await expect.poll(() => started).toBe(true)
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
  await page.keyboard.press('Escape')
  try {
    await switchPersonSession(page, second.id)
    await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /low/i)
  } finally { release() }
  await expect.poll(() => models.get('person-main-1')?.reasoningEffort).toBe('high')
  await expect(page.locator('.input-model-button')).toBeEnabled()
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /low/i)
  await switchPersonSession(page, 'person-main-1')
  await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
})

test('Person session switch closes a model picker opened for the previous session', async ({ page }) => {
  const { second, operations } = await setupSessionModels(page)
  await page.goto('/#/person?session=person-main-1')
  await page.locator('.input-model-button').click()
  await expect(page.locator('.model-cascader:visible')).toBeVisible()
  await switchPersonSession(page, second.id)
  await expect(page.locator('.model-cascader:visible')).toHaveCount(0)
  expect(operations.filter(op => op.path.endsWith('/settings'))).toEqual([])
})

test('Person keeps its dialogue and composer mounted while switching conversations', async ({ page }) => {
  const { second } = await setupSessionModels(page)
  await page.goto('/#/person?session=person-main-1')
  await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
  const before = await page.locator('.person-compose .input-textarea').elementHandle()
  const messages = await page.locator('.message-list-shell').elementHandle()
  let release!: () => void
  const snapshot = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/studio/person?session_id=${second.id}`, async route => {
    await snapshot
    return route.fallback()
  })
  try {
    await page.locator('.person-sidebar .session-item').filter({ hasText: second.title }).click()
    await expect(page.locator('.person-title')).toHaveText(second.title)
    await expect(page.locator('.person-view')).toHaveAttribute('inert', '')
    expect(await before!.evaluate(el => el.isConnected)).toBe(true)
    expect(await messages!.evaluate(el => el.isConnected)).toBe(true)
    await expect(page.locator('.person-view > .page-loading-overlay')).toHaveCount(0)
  } finally { release() }
  await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
  expect(await before!.evaluate(el => el.isConnected)).toBe(true)
  expect(await messages!.evaluate(el => el.isConnected)).toBe(true)
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person fades the resumed BOT transcript before its settings snapshot completes in ${mode}`, async ({ page }) => {
    const { second } = await setupSessionModels(page, mode)
    await page.addInitScript(id => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__[id].messages = [{ id: 2, role: 'assistant', content: 'The second BOT reply', timestamp: 1 }]
    }, second.id)
    await page.goto('/#/person?session=person-main-1')
    await expect(page.locator('.person-view')).toHaveAttribute('aria-busy', 'false')
    const input = await page.locator('.person-compose .input-textarea').elementHandle()
    let release!: () => void
    const snapshot = new Promise<void>(resolve => { release = resolve })
    await page.route(`**/api/studio/person?session_id=${second.id}`, async route => { await snapshot; return route.fallback() })
    try {
      await page.locator('.person-sidebar .session-item').filter({ hasText: second.title }).click()
      await expect(page.getByText('The second BOT reply', { exact: true })).toBeVisible()
      await expect(page.locator('.person-view')).toHaveAttribute('inert', '')
      const surface = page.locator('.person-chat-surface')
      await expect.poll(() => surface.evaluate(el => el.getAnimations().length)).toBe(1)
      const reveal = await surface.evaluate(el => {
        const animation = el.getAnimations()[0]
        animation.pause(); animation.currentTime = 750
        return { timing: animation.effect!.getTiming(), keyframes: (animation.effect as KeyframeEffect).getKeyframes(), opacity: Number(getComputedStyle(el).opacity) }
      })
      expect(reveal.timing).toMatchObject({ duration: 1500, easing: 'ease' })
      expect(reveal.keyframes.map(frame => Number(frame.opacity))).toEqual([0, 1])
      expect(reveal.opacity).toBeGreaterThan(0)
      expect(reveal.opacity).toBeLessThan(1)
      expect(await input!.evaluate(el => el.isConnected)).toBe(true)
      await page.screenshot({ path: `/tmp/studio-person-switch-fade-${mode}.png` })
      await surface.evaluate(el => el.getAnimations()[0]?.finish())
      expect(await page.evaluate(id => (window as any).__PW_CHAT_SOCKET__.emitted.filter((entry: any) => entry.event === 'resume' && entry.payload.session_id === id).length, second.id)).toBe(1)
    } finally { release() }
    await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
  })
}

test('Person starts resume while its initial snapshot is still loading', async ({ page }) => {
  await setupSessionModels(page)
  let release!: () => void
  const snapshot = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/studio/person?session_id=person-main-1', async route => { await snapshot; return route.fallback() })
  await page.goto('/#/person?session=person-main-1')
  try {
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.emitted.some((entry: any) => entry.event === 'resume' && entry.payload.session_id === 'person-main-1') || false)).toBe(true)
  } finally { release() }
  await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
})

test('Person shows its welcome only after history confirms an empty BOT', async ({ page }) => {
  const { state, second, models } = await setupSessionModels(page)
  const empty = { ...second, id: 'person-main-empty', title: 'Empty BOT' }
  const unknown = { ...second, id: 'person-main-unknown', title: 'Unknown BOT' }
  for (const session of [empty, unknown]) {
    state.conversations.push(session)
    models.set(session.id, structuredClone(models.get(second.id)!))
  }
  await page.addInitScript(id => { delete (window as any).__PW_CHAT_SOCKET_RESUMES__[id] }, second.id)
  await page.goto('/#/person?session=person-main-1')
  const welcome = page.locator('.person-chat-messages .empty-state')
  await expect(welcome).toBeVisible()
  const select = async (session: { id: string; title: string }) => {
    await page.locator('.person-sidebar .session-item').filter({ hasText: session.title }).click()
    await page.waitForFunction(id => (window as any).__PW_CHAT_SOCKET__.emitted.some((entry: any) => entry.event === 'resume' && entry.payload.session_id === id), session.id)
    await expect(welcome).toHaveCount(0)
  }
  const resumed = async (id: string, messages?: any[]) => page.evaluate(({ id, messages }) => {
    (window as any).__PW_CHAT_SOCKET__.latest.__trigger('resumed', {
      session_id: id, isWorking: false, events: [], messageTotal: messages?.length ?? 0,
      ...(messages ? { messages } : {}),
    })
  }, { id, messages })
  await select(second)
  await resumed(second.id, [{ id: 1, role: 'assistant', content: 'Existing BOT history', timestamp: 1 }])
  await expect(page.getByText('Existing BOT history', { exact: true })).toBeVisible()
  await expect(welcome).toHaveCount(0)
  await select(empty)
  await resumed(empty.id, [])
  await expect(welcome).toBeVisible()
  await select(unknown)
  await resumed(unknown.id)
  await expect(page.locator('.person-chat-messages')).toBeVisible()
  await expect(welcome).toHaveCount(0)
})

test('Person fades cached BOT messages immediately without restarting on the fresh resume', async ({ page }) => {
  const { second } = await setupSessionModels(page)
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__[id].messages = [{ id: 2, role: 'assistant', content: 'Cached BOT reply', timestamp: 1 }]
  }, second.id)
  await page.goto('/#/person?session=person-main-1')
  await expect(page.locator('.person-view')).toHaveAttribute('aria-busy', 'false')
  const row = (title: string) => page.locator('.person-sidebar .session-item').filter({ hasText: title })
  await row(second.title).click()
  await expect(page.getByText('Cached BOT reply', { exact: true })).toBeVisible()
  await row('Person').click()
  await expect(page.locator('.person-title')).toHaveText('Person')
  await page.evaluate(id => { delete (window as any).__PW_CHAT_SOCKET_RESUMES__[id] }, second.id)
  await row(second.title).click()
  await expect(page.getByText('Cached BOT reply', { exact: true })).toBeVisible()
  const surface = page.locator('.person-chat-surface')
  await expect.poll(() => surface.evaluate(el => el.getAnimations().length)).toBe(1)
  await surface.evaluate(el => {
    const animation = el.getAnimations()[0]
    animation.pause(); animation.currentTime = 750
    ;(window as any).__cachedBotReveal = animation
  })
  await page.evaluate(id => (window as any).__PW_CHAT_SOCKET__.latest.__trigger('resumed', {
    session_id: id, isWorking: false, events: [], messages: [{ id: 2, role: 'assistant', content: 'Fresh BOT reply', timestamp: 1 }],
  }), second.id)
  await expect(page.getByText('Fresh BOT reply', { exact: true })).toBeVisible()
  expect(await surface.evaluate(el => el.getAnimations()[0] === (window as any).__cachedBotReveal)).toBe(true)
  await surface.evaluate(el => el.getAnimations()[0]?.finish())
})

test('Person reveals only the latest BOT during rapid switches and respects reduced motion', async ({ page }) => {
  const { state, second, models } = await setupSessionModels(page)
  const third = { ...second, id: 'person-main-third', title: 'Third' }
  state.conversations.push(third)
  models.set(third.id, structuredClone(models.get(second.id)!))
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__[id] = { session_id: id, messages: [{ id: 3, role: 'assistant', content: 'The latest BOT reply', timestamp: 1 }], isWorking: false, events: [] }
  }, third.id)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/#/person?session=person-main-1')
  await expect(page.locator('.person-view')).toHaveAttribute('aria-busy', 'false')
  let release!: () => void
  const snapshot = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/api/studio/person?session_id=${second.id}`, async route => { await snapshot; return route.fallback() })
  try {
    await page.locator('.person-sidebar .session-item').filter({ hasText: second.title }).click()
    await expect(page.locator('.person-view')).toHaveAttribute('inert', '')
    await page.locator('.person-sidebar .session-item').filter({ hasText: third.title }).click()
    await expect(page.locator('.person-title')).toHaveText(third.title)
    await expect(page.locator('.person-view')).not.toHaveAttribute('inert')
    await expect(page.getByText('The latest BOT reply', { exact: true })).toBeVisible()
    expect(await page.locator('.person-chat-surface').evaluate(el => el.getAnimations().length)).toBe(0)
  } finally { release() }
  await expect(page.locator('.person-title')).toHaveText(third.title)
  await expect(page.locator('.person-alert')).toHaveCount(0)
})

test('Person events use the existing global question notification and open the main window',async({page})=>{
  await setup(page,'light',false,false)
  await page.goto('/#/person')
  await expect(page.locator('.person-title')).toHaveText('Person')
  await page.getByRole('link',{name:'Chat',exact:true}).click()
  await expect(page).toHaveURL(/#\/hermes\/chat$/)
  await expect.poll(()=>page.evaluate(()=>(window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket:any)=>String(socket.url).endsWith('/chat-run')))).toBe(true)
  await page.evaluate(()=>{
    const socket=(window as any).__PW_CHAT_SOCKET__.allSockets.find((socket:any)=>String(socket.url).endsWith('/chat-run') && !socket.options?.query?.session_state)
    socket.__trigger('person.clarification.requested',{event:'person.clarification.requested',session_id:'person-main-1',clarify_id:'main-question',question:'Choose the report scope',choices:['Today','This week'],durable:true})
  })
  const title=page.getByRole('button',{name:'zhezhe · The agent has a question for you'})
  await expect(title).toBeVisible()
  await expect(page.getByText('Choose the report scope',{exact:true})).toBeVisible()
  await title.click()
  await expect(page).toHaveURL(/#\/person\?session=person-main-1$/)
  await expect(page.locator('.person-title')).toHaveText('Person')
})

async function backgroundTaskCount(page: Page, count: number, _state = 'searching', sessionId = 'person-main-1') {
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket: any) => socket.options?.query?.session_state === '1'))).toBe(true)
  await page.evaluate(({ count, sessionId }) => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => socket.options?.query?.session_state === '1')
    socket.__trigger('sessions.state.updated', { sessionId, working: count > 0, backgroundPending: count,
      lastMessageId: 0, readMessageId: 0, unread: false })
  }, { count, sessionId })
}

test('Person scopes task indicators to the conversation and receives remote unread receipts', async ({ page }) => {
  const { second } = await setupSessionModels(page)
  await page.goto('/#/person?session=person-main-1')
  await expect(page.locator('.person-title')).toHaveText('Person')
  const island = page.locator('.person-task-island')
  await backgroundTaskCount(page, 2, 'searching', second.id)
  await expect(island).toHaveCount(0)
  const row = page.locator('.person-sidebar .session-item').filter({ hasText: 'Second' })
  await expect(row.locator('.session-item-agent-logo-wrap.streaming')).toBeVisible()
  await page.evaluate(sessionId => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => socket.options?.query?.session_state === '1')
    socket.__trigger('sessions.state.updated', { sessionId, working: true, backgroundPending: 2,
      lastMessageId: 10, readMessageId: 0, unread: true })
  }, second.id)
  await expect(row.locator('.session-item-unread-dot')).toHaveCount(0)
  await backgroundTaskCount(page, 1)
  await expect(island).toBeVisible()
  await switchPersonSession(page, second.id)
  await expect(island.locator('.person-task-island__count')).toHaveText('2')
  expect(await emitted(page, 'sessions.read')).not.toContainEqual({ sessionId: second.id, messageId: 10 })
  await page.evaluate(sessionId => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => socket.options?.query?.session_state === '1')
    socket.__trigger('sessions.state.updated', { sessionId, working: false, backgroundPending: 0,
      lastMessageId: 10, readMessageId: 0, unread: true })
  }, second.id)
  await expect.poll(() => emitted(page, 'sessions.read')).toContainEqual({ sessionId: second.id, messageId: 10 })
  await page.evaluate(sessionId => {
    const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => socket.options?.query?.session_state === '1')
    socket.__trigger('sessions.state.updated', { sessionId, working: false, backgroundPending: 0,
      lastMessageId: 10, readMessageId: 10, unread: false })
  }, second.id)
  await expect(island).toHaveCount(0)
  await expect(row.locator('.session-item-unread-dot')).toHaveCount(0)
  await expect(page.locator('.person-sidebar .session-item').filter({ hasText: 'Person' }).locator('.session-item-agent-logo-wrap.streaming')).toBeVisible()
})

test('Person shows collaboration activity first and unread only after execution ends', async ({ page }) => {
  const { second } = await setupSessionModels(page)
  await page.goto('/#/person?session=person-main-1')
  await expect(page.locator('.person-title')).toHaveText('Person')
  await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket: any) => socket.options?.query?.session_state === '1'))).toBe(true)
  const row = page.locator('.person-sidebar .session-item').filter({ hasText: 'Second' })
  async function notice(attentionId: number, readAttentionId: number, working = true) {
    await page.evaluate(state => {
      const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => socket.options?.query?.session_state === '1')
      socket.__trigger('sessions.state.updated', state)
    }, { sessionId: second.id, working, backgroundPending: 0, lastMessageId: 0, readMessageId: 0,
      lastAttentionId: attentionId, readAttentionId, unread: attentionId > readAttentionId })
  }
  await notice(1, 0)
  await expect(row.locator('.session-item-agent-logo-wrap.streaming')).toBeVisible()
  await expect(row.locator('.session-item-unread-dot')).toHaveCount(0)
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  await page.screenshot({ path: '/tmp/person-collaboration-state.png', animations: 'disabled' })
  await notice(1, 0, false)
  await expect(row.locator('.session-item-unread-dot')).toBeVisible()
  await notice(1, 1, false)
  await expect(row.locator('.session-item-unread-dot')).toHaveCount(0)
  await expect(row.locator('.session-item-agent-logo-wrap.streaming')).toHaveCount(0)
  await notice(2, 1)
  await expect(row.locator('.session-item-unread-dot')).toHaveCount(0)
  await switchPersonSession(page, second.id)
  expect(await emitted(page, 'sessions.read')).not.toContainEqual({ sessionId: second.id, messageId: 0, attentionId: 2 })
  await notice(2, 1, false)
  await expect.poll(() => emitted(page, 'sessions.read')).toContainEqual({ sessionId: second.id, messageId: 0, attentionId: 2 })
  await notice(2, 2, false)
  await expect(row.locator('.session-item-unread-dot')).toHaveCount(0)
  await expect(row.locator('.session-item-agent-logo-wrap.streaming')).toHaveCount(0)
})

test('Person receives relay activity over real sockets after the app presence connection', async ({ page }) => {
  const { state, second } = await setupSessionModels(page)
  const http = createServer()
  const server = new Server(http, { cors: { origin: true } })
  const states = new Map<string, SessionListState>([state.session.id, second.id].map(sessionId => [sessionId, {
    sessionId, working: false, backgroundPending: 0, lastMessageId: 0, readMessageId: 0,
    lastAttentionId: 0, readAttentionId: 0, unread: false,
  }]))
  const subscriptions = new Set<import('socket.io').Socket>()
  const namespaces: string[] = []
  server.of(/^\/.+$/).on('connection', socket => {
    namespaces.push(socket.nsp.name)
    if (socket.nsp.name !== '/chat-run') return
    if (socket.handshake.query.session_state === '1') {
      subscriptions.add(socket)
      socket.on('disconnect', () => subscriptions.delete(socket))
      socket.emit('sessions.state.snapshot', { sessions: [...states.values()] })
      socket.on('sessions.read', (receipt, ack) => {
        const current = states.get(receipt.sessionId)!
        if (current.working) return ack({ ok: false })
        current.readMessageId = Math.max(current.readMessageId, Math.min(receipt.messageId, current.lastMessageId))
        current.readAttentionId = Math.max(current.readAttentionId!, Math.min(receipt.attentionId || 0, current.lastAttentionId!))
        current.unread = current.lastMessageId > current.readMessageId || current.lastAttentionId! > current.readAttentionId
        for (const device of subscriptions) device.emit('sessions.state.updated', current)
        ack({ ok: true })
      })
    }
    socket.on('resume', ({ session_id }) => socket.emit('resumed', {
      session_id, isWorking: false, messages: [], events: [],
      messageTotal: 0, messageLoadedCount: 0, hasMoreBefore: false,
    }))
  })
  try {
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(http.address() as any).port}`
    // Keep HTTP fixtures, but load the real Socket.IO library. Only redirect
    // its server origin; namespace Manager reuse and handshakes remain real.
    await page.unroute('**/node_modules/.vite/**/socket__io-client.js*')
    await page.route('**/node_modules/.vite/**/socket__io-client.js*', route => {
      const original = new URL(route.request().url())
      if (original.searchParams.has('real-socket')) return route.continue()
      original.searchParams.set('real-socket', '1')
      return route.fulfill({ contentType: 'application/javascript', body: `
        export * from ${JSON.stringify(original.href)};
        import { io as actualIo } from ${JSON.stringify(original.href)};
        export const io = (url, options) => actualIo(${JSON.stringify(origin)} + new URL(url, location.href).pathname, options);
      ` })
    })
    await page.goto('/#/person?session=person-main-1')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    await expect.poll(() => subscriptions.size).toBe(1)
    expect(namespaces).toContain('/person-presence')
    expect(namespaces.indexOf('/person-presence')).toBeLessThan(namespaces.indexOf('/chat-run'))
    const creator = page.locator('.person-sidebar .session-item').filter({ hasText: 'Person' })
    const recipient = page.locator('.person-sidebar .session-item').filter({ hasText: 'Second' })
    function publish(sessionId: string, patch: Partial<SessionListState>) {
      const next = { ...states.get(sessionId)!, ...patch }
      states.set(sessionId, next)
      for (const socket of subscriptions) socket.emit('sessions.state.updated', next)
    }
    publish(state.session.id, { working: true })
    await expect(creator.locator('.session-item-agent-logo-wrap.streaming')).toBeVisible()
    publish(state.session.id, { working: false })
    publish(second.id, { working: true, lastMessageId: 1, unread: true })
    await expect(creator.locator('.session-item-agent-logo-wrap.streaming')).toHaveCount(0)
    await expect(recipient.locator('.session-item-agent-logo-wrap.streaming')).toBeVisible()
    await expect(recipient.locator('.session-item-unread-dot')).toHaveCount(0)
    await expect(page.locator('.person-task-island')).toHaveCount(0)
    await page.screenshot({ path: '/tmp/person-real-socket-relay.png', animations: 'disabled' })
    publish(second.id, { working: false })
    await expect(recipient.locator('.session-item-unread-dot')).toBeVisible()
    await recipient.click()
    await expect(page.locator('.person-title')).toHaveText('Second')
    await expect(recipient.locator('.session-item-unread-dot')).toHaveCount(0)
    expect(states.get(second.id)?.readMessageId).toBe(1)
    publish(state.session.id, { working: false, lastAttentionId: 2, unread: true })
    await expect(creator.locator('.session-item-agent-logo-wrap.streaming')).toHaveCount(0)
    await expect(recipient.locator('.session-item-agent-logo-wrap.streaming')).toHaveCount(0)
    await expect(creator.locator('.session-item-unread-dot')).toBeVisible()
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person background-task island expands from the center and updates live in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode, mode === 'dark', false)
    state.tasks[0].running = false; state.tasks[0].status = 'completed'; state.tasks[0].execution_state = 'finished'
    await page.setViewportSize({ width: mode === 'dark' ? 360 : 1440, height: 900 })
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toBeVisible()
    await expect(page.locator('.person-view')).toHaveAttribute('aria-busy', 'false')
    const island = page.locator('.person-task-island')
    await expect(island).toHaveCount(0)
    const messages = page.locator('.person-view .message-list-shell')
    const composer = page.locator('.person-compose')
    const messageBounds = await messages.boundingBox(), composerBounds = await composer.boundingBox()
    await page.evaluate(async () => { const image = new Image(); image.src = '/person/searching.gif'; await image.decode() })
    await backgroundTaskCount(page, 3)
    const animations = await page.evaluate(async () => {
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
      const animations = document.querySelector('.person-task-activity')!.getAnimations({ subtree: true })
      for (const animation of animations) { animation.pause(); animation.currentTime = 100 }
      return animations.length
    })
    expect(animations).toBeGreaterThan(0)
    await page.screenshot({ path: `/tmp/person-task-island-enter-${mode}.png` })
    await page.evaluate(() => document.querySelector('.person-task-activity')!.getAnimations({ subtree: true }).forEach(animation => animation.finish()))
    await expect(page.getByRole('button', { name: 'zhezhe · Background tasks · 3', exact: true })).toBeVisible()
    await expect(island.locator('img')).toHaveAttribute('src', '/person/searching.gif')
    const box = await island.boundingBox()
    expect(Math.abs(box!.x + box!.width / 2 - messageBounds!.x - messageBounds!.width / 2)).toBeLessThan(1)
    await expect(page.locator('.person-task-activity')).toHaveCSS('position', 'absolute')
    expect(await messages.boundingBox()).toEqual(messageBounds)
    expect(await composer.boundingBox()).toEqual(composerBounds)
    const headerBounds = await page.locator('.person-header').boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-task-island-expanded-${mode}.png`, animations: 'disabled' })
    await island.evaluate(element => { (element as HTMLElement).dataset.instance = 'same-task-animation' })
    // The server count can exceed the current task-list page; feedback never hides active tasks.
    await backgroundTaskCount(page, 24, 'done')
    await expect(page.getByRole('button', { name: 'zhezhe · Background tasks · 24', exact: true })).toBeVisible()
    await expect(island).toHaveAttribute('data-instance', 'same-task-animation')
    await expect(island.locator('img')).toHaveAttribute('src', '/person/searching.gif')
    await island.click()
    await expect(page.locator('.session-tasks-drawer')).toBeVisible()
    await expect(island).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-tasks-drawer')).not.toBeVisible()
    await backgroundTaskCount(page, 0, 'idle')
    await expect(island).toHaveCount(0)
    expect(await messages.boundingBox()).toEqual(messageBounds)
    expect(await composer.boundingBox()).toEqual(composerBounds)
    await backgroundTaskCount(page, 1)
    await expect(island).toBeVisible()
    await page.setViewportSize({ width: mode === 'dark' ? 1440 : 360, height: 900 })
    await expect.poll(async () => {
      const resized = await island.boundingBox()
      const chat = await messages.boundingBox()
      return Math.abs(resized!.x + resized!.width / 2 - chat!.x - chat!.width / 2)
    }).toBeLessThan(1)
    await page.locator('.person-compose textarea').click()
    await expect(page.locator('.person-compose textarea')).toBeFocused()
    await island.focus(); await page.keyboard.press('Enter')
    await expect(page.locator('.session-tasks-drawer')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await expect(island).toHaveCount(0)
  })

  test(`Person background-task island follows wallpaper, regional and reset themes in ${mode}`, async ({ page }) => {
    await setup(page, mode, true, false)
    const island = page.locator('.person-task-island')
    async function open() { await page.goto('/#/person'); await backgroundTaskCount(page, 2); await expect(island).toBeVisible() }
    const wallpaper = mode === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(42, 42, 42, 0.72)'
    await open()
    await expect(island).toHaveCSS('background-color', wallpaper)
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await open()
    await expect(island).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-backgroundColor').fill('#336699')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await page.getByTestId('theme-card-radius').fill('18')
    await page.getByTestId('theme-card-radius').dispatchEvent('change')
    await page.getByTestId('theme-card-blur').fill('4')
    await page.getByTestId('theme-card-blur').dispatchEvent('change')
    await open()
    await expect(island).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(island).toHaveCSS('border-radius', '18px')
    await expect(island).toHaveCSS('opacity', '1')
    await expect(island).toHaveCSS('backdrop-filter', /blur\(4px\)/)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await open()
    await expect(island).toHaveCSS('background-color', wallpaper)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await open()
    await expect(island).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
  })
}

test('Person background-task island supports reduced motion and hides for main-chat activity alone', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setup(page, 'light', false, false)
  await page.goto('/#/person')
  await backgroundTaskCount(page, 0, 'thinking')
  await expect(page.locator('.person-task-island')).toHaveCount(0)
  await backgroundTaskCount(page, 1)
  const island = page.getByRole('button', { name: 'zhezhe · Background tasks · 1', exact: true })
  await expect(island).toBeVisible()
  await expect(island.locator('img')).toHaveAttribute('src', '/coding-agents/person.jpg')
  expect(await island.evaluate(element => element.getAnimations().length)).toBe(0)
  await island.click()
  await expect(page.locator('.session-tasks-drawer')).toBeVisible()
})

test('Person general settings save independently, survive refresh and retain drafts across tabs', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  const originalAgents = structuredClone(state.settings.agents)
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'General', exact: true })).toHaveAttribute('aria-selected', 'true')
  const panel = page.locator('.person-general-settings')
  const save = panel.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await expect(panel.locator('.model-context-capacity')).toContainText('200,000')
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toBeDisabled()
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  await panel.getByRole('textbox', { name: 'Compression Threshold' }).fill('60')
  await panel.getByRole('textbox', { name: 'Maximum steps per reply' }).fill('20')
  await expect(panel.getByRole('textbox', { name: 'Concurrent background tasks' })).toHaveValue('6')
  await panel.getByRole('textbox', { name: 'Concurrent background tasks' }).fill('12')
  await panel.locator('.n-select').click()
  await panel.locator('.n-base-selection-input').fill('Asia/Shanghai')
  await page.locator('.n-base-select-option__content:visible').getByText('Asia/Shanghai', { exact: true }).click()
  await page.getByRole('tab', { name: /^Agents/ }).click()
  await expect(page.locator('.agent-card')).toHaveCount(1)
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toHaveValue('60')
  await save.click()
  await expect(panel.getByRole('status')).toHaveText('Settings saved')
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body).toEqual({ compressionThreshold: 0.6, maxSteps: 20, maxConcurrentTasks: 12, timezone: 'Asia/Shanghai', session_id: 'person-main-1', expected_revision: 0 })
  expect(state.settings.agents).toEqual(originalAgents)
  expect(state.settings.model.model).toBe('global-model')
  await page.reload()
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toHaveValue('60')
  await expect(panel.getByRole('textbox', { name: 'Maximum steps per reply' })).toHaveValue('20')
  await expect(panel.getByRole('textbox', { name: 'Concurrent background tasks' })).toHaveValue('12')
  await expect(panel.locator('.n-select')).toContainText('Asia/Shanghai')
})

test('Person general settings preserve edits on conflicts and prevent writes during a reply', async ({ page }) => {
  const { state, operations } = await setup(page, 'dark')
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  const panel = page.locator('.person-general-settings')
  const threshold = panel.getByRole('textbox', { name: 'Compression Threshold' })
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  const save = panel.getByRole('button', { name: 'Save', exact: true })
  await threshold.fill('65')
  state.settings.maxConcurrentTasks = 4; state.revision++
  await save.click()
  await expect(panel.getByRole('alert')).toContainText('Settings changed')
  await expect(threshold).toHaveValue('65')
  await expect(panel.getByRole('textbox', { name: 'Concurrent background tasks' })).toHaveValue('4')
  await expect(panel.getByRole('status')).toHaveText('Unsaved changes')
  await save.click()
  await expect(panel.getByRole('status')).toHaveText('Settings saved')
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body).toEqual({ compressionThreshold: 0.65, session_id: 'person-main-1', expected_revision: 1 })
  await panel.getByRole('textbox', { name: 'Maximum steps per reply' }).fill('')
  await panel.getByRole('textbox', { name: 'Maximum steps per reply' }).press('Tab')
  await expect(save).toBeDisabled()
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(threshold).toHaveValue('65')
  await threshold.fill('55')
  await threshold.press('Tab')
  await emit(page, 'run.started', {})
  await expect(save).toBeDisabled()
  await expect(panel.getByRole('alert')).toContainText('Settings can be saved after the current reply finishes.')
  await emit(page, 'run.completed', { output: 'Done' })
  await expect(save).toBeEnabled()
})

test('Person compression follows the interaction model and can restore the global threshold', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  await page.goto('/#/person')
  const settings = page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true })
  const panel = page.locator('.person-general-settings')
  await settings.click()
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  await panel.getByRole('textbox', { name: 'Compression Threshold' }).fill('60')
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel).toContainText('120,000 tokens')
  await page.keyboard.press('Escape')
  await page.locator('.input-model-button').click()
  await page.locator('.model-cascader:visible').getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await settings.click()
  await expect(panel.locator('.model-context-name')).toHaveText('fast-model')
  await expect(panel.locator('.model-context-capacity')).toContainText('128,000')
  await expect(panel).toContainText('76,800 tokens')
  // The interaction model changed; the independent worker preset is unchanged.
  expect(state.settings.agents[0].selection.model).toBe('global-model')
  state.compression.globalThreshold = 0.7
  await panel.getByRole('switch', { name: 'Follow global threshold' }).click()
  await panel.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toHaveValue('70')
  await expect(panel.getByRole('textbox', { name: 'Compression Threshold' })).toBeDisabled()
  await expect(panel).toContainText('89,600 tokens')
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body).toEqual({ compressionThreshold: null, session_id: 'person-main-1', expected_revision: 2 })
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person general cards follow global, regional and restored themes in ${mode}`, async ({ page }) => {
    await setup(page, mode, true, false)
    const card = page.locator('.person-general-settings .context-card')
    async function openSettings() {
      await page.goto('/#/person')
      await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
      await expect(card).toBeVisible()
    }
    const wallpaper = mode === 'light' ? 'rgba(255, 255, 255, 0.72)' : 'rgba(42, 42, 42, 0.72)'
    await openSettings()
    await expect(card).toHaveCSS('background-color', wallpaper)
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await openSettings()
    await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('card')
    await page.getByTestId('theme-card-opacity').fill('0')
    await page.getByTestId('theme-card-opacity').dispatchEvent('change')
    await openSettings()
    await expect(card).toHaveCSS('background-color', 'rgba(34, 51, 68, 0)')
    await expect(card).toHaveCSS('opacity', '1')
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await openSettings()
    await expect(card).toHaveCSS('background-color', wallpaper)
    await page.keyboard.press('Escape')
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await openSettings()
    await expect(card).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
  })
}

for (const mode of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`Person general settings preview in ${mode} at ${width}px`, async ({ page }) => {
      const { state } = await setup(page, mode, mode === 'dark', mode === 'dark')
      await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
      await page.setViewportSize({ width, height: 960 })
      await page.goto('/#/person')
      await page.locator('.person-header-actions').getByRole('button', { name: '设置', exact: true }).click()
      const panel = page.locator('.person-general-settings')
      await expect(panel.getByRole('heading', { name: '通用设置' })).toBeVisible()
      await expect(panel.locator('.model-context-capacity')).toContainText('200,000')
      await expect(panel.getByRole('textbox', { name: '压缩阈值' })).toHaveValue('50')
      await expect(panel).toContainText('100,000 tokens')
      await page.mouse.move(100, 200)
      await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
      const drawer = page.locator('.person-workspace-drawer')
      expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      await page.screenshot({ path: `/tmp/person-general-${mode}-${width}.png`, animations: 'disabled' })
      await page.getByRole('tab', { name: /智能体/ }).click()
      await expect(page.locator('.agent-card')).toHaveCount(1)
    })
  }
}

for (const { locale, title, width, executing } of [
  { locale: 'zh', title: '个人助理', width: 1280, executing: '正在执行' },
  { locale: 'zh', title: '个人助理', width: 390, executing: '正在执行' },
  { locale: 'ja', title: 'パーソナルアシスタント', width: 390, executing: '実行中' },
  { locale: 'ar', title: 'المساعد الشخصي', width: 390, executing: 'جارٍ التنفيذ' },
]) {
  test(`localizes the assistant title and keeps zhezhe's identity in ${locale} at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, 'light', false)
    state.session.title = title
    await page.addInitScript(value => localStorage.setItem('hermes_locale', value), locale)
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toHaveText(title)
    await expect(page.locator('.empty-logo--person')).toHaveAttribute('alt', locale.startsWith('zh') ? '折折' : 'zhezhe')
    await expect(page.locator('.input-settings-button')).toHaveCount(0)
    await expect(page.locator('.person-header-actions')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.locator('.person-header-actions').evaluate(el => {
      const bounds = el.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth
    })).toBe(true)
    await page.screenshot({ path: `/tmp/person-interface-${locale}-${width}.png`, animations: 'disabled' })
    await emit(page, 'run.started', { run_id: 'localized-run', autonomous: true })
    await emit(page, 'reasoning.delta', { delta: 'Internal reasoning.' })
    await expect(page.locator('.thinking-status-label')).toHaveText(executing)
    await expect(page.locator('.thinking-status-label')).toBeVisible()
    await expect(page.locator('.live-reasoning-detail')).toHaveCount(0)
    await page.screenshot({ path: `/tmp/person-executing-${locale}-${width}.png`, animations: 'disabled' })
  })
}

async function expectPersonAvatarFraming(image: Locator, bot: typeof PERSON_BOTS[number], thinking = false) {
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  const actual = await image.evaluate((el: HTMLImageElement, measureStill) => {
    const position = getComputedStyle(el).objectPosition.match(/calc\([^)]*\)|[-\d.]+(?:%|px)/g) || []
    const offsets = position.map(part => {
      const pixels = part.match(/([+-]?)\s*([\d.]+)px/)
      return pixels ? Number(pixels[2]) * (pixels[1] === '-' ? -1 : 1) : 0
    })
    let errorX = 0, errorY = 0
    if (measureStill) {
      const canvas = document.createElement('canvas'); canvas.width = el.naturalWidth; canvas.height = el.naturalHeight
      const context = canvas.getContext('2d')!; context.drawImage(el, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let left = canvas.width, right = -1, top = canvas.height, bottom = -1
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 16) {
          left = Math.min(left, x); right = Math.max(right, x)
          top = Math.min(top, y); bottom = Math.max(bottom, y)
        }
      }
      errorX = (left + right + 1) / 2 / canvas.width * el.clientWidth + offsets[0] - el.clientWidth / 2
      errorY = (top + bottom + 1) / 2 / canvas.height * el.clientHeight + offsets[1] - el.clientHeight / 2
    }
    return { width: el.clientWidth, height: el.clientHeight, offsets, errorX, errorY }
  }, !thinking && bot.type !== 'zhezhe')
  const offset = thinking ? bot.thinkingOffset : bot.avatarOffset
  expect(actual.offsets[0]).toBeCloseTo(offset.x * actual.width, 2)
  expect(actual.offsets[1]).toBeCloseTo(offset.y * actual.height, 2)
  expect(Math.abs(actual.errorX)).toBeLessThan(0.02)
  expect(Math.abs(actual.errorY)).toBeLessThan(0.02)
}

for (const [mode, width] of [['light', 1440], ['dark', 390]] as const) {
  test(`Person centers all static and working Bot avatars in ${mode} at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, mode, mode === 'dark')
    state.conversations = PERSON_BOTS.map(bot => ({ ...state.session, id: `person-main-${bot.type}`, title: bot.type, bot_type: bot.type }))
    await page.addInitScript(sessions => {
      for (const [index, session] of sessions.entries()) (window as any).__PW_CHAT_SOCKET_RESUMES__[session.id] = {
        session_id: session.id, messages: [{ id: 800 + index, role: 'assistant', content: `Hello from ${session.title}`, timestamp: 1 }], isWorking: false, events: [],
      }
    }, state.conversations)
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#/person?session=person-main-zhezhe')
    for (const bot of PERSON_BOTS) {
      if (width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).click()
      const row = page.locator('.person-sidebar .session-item').filter({ hasText: bot.type })
      await expectPersonAvatarFraming(row.locator('.session-item-agent-logo'), bot)
      await row.click()
      await expect(page.locator('.person-title')).toHaveText(bot.type)
      const avatar = page.locator('.assistant-message-author .msg-avatar').first()
      await expect(avatar).toHaveAttribute('src', bot.avatar)
      await expectPersonAvatarFraming(avatar, bot)
      await page.locator('.person-compose .input-textarea').fill('Check avatar framing')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await emit(page, 'run.started', { session_id: `person-main-${bot.type}`, run_id: `framing-${bot.type}` })
      await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', bot.animations.thinking)
      await expectPersonAvatarFraming(page.locator('.thinking-avatar'), bot, true)
      if (bot.type === 'paidui') await page.screenshot({ path: `/tmp/studio-bot-framing/avatars-${mode}-${width}.png`, animations: 'disabled' })
      await emit(page, 'run.completed', { session_id: `person-main-${bot.type}`, run_id: `framing-${bot.type}`, output: 'Checked' })
      await expect(page.locator('.thinking-avatar')).toHaveCount(0)
    }
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person reuses single chat controls, inherits defaults and switches models in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    await page.goto('/#/person')
    const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
    await expect(page.locator('.person-title')).toHaveText('Person')
    await expect(page.locator('.input-settings-button')).toHaveCount(0)
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')
    await expect(page.getByRole('heading', { name: 'Choose a model' })).toHaveCount(0)
    await expect(input).toBeVisible()
    await page.screenshot({ path: `/tmp/person-chat-${mode}-empty.png`, animations: 'disabled' })
    await page.locator('.reasoning-effort-button').click()
    const slider = page.getByRole('slider')
    await expect(slider).toHaveAttribute('aria-valuemax', '2')
    await slider.focus()
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
    await expect(page.locator('.reasoning-effort-button')).toHaveAttribute('aria-label', /high/i)
    await page.keyboard.press('Escape')
    await input.fill('Check the report')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === 'run').length)).toBe(1)
    const run = await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.find((e: any) => e.event === 'run').payload)
    expect(run).toMatchObject({ session_id: 'person-main-1', agent_id: 'ekko-agent', model: 'global-model', reasoning_effort: 'high' })
    await emit(page, 'run.started', { run_id: 'person-run' })
    await expect(page.locator('.thinking-avatar')).toHaveAttribute('src', '/person/thinking.gif')
    await expect.poll(() => page.locator('.thinking-avatar').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await emit(page, 'reasoning.delta', { delta: 'Checking the task requirements.' })
    await expect(page.locator('.thinking-status-label')).toHaveText('Executing')
    await expect(page.locator('.live-reasoning-detail')).toHaveCount(0)
    await expect(page.getByText('Checking the task requirements.', { exact: true })).toHaveCount(0)
    await page.mouse.move(600, 30)
    await page.locator('.thinking-avatar').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `/tmp/person-animation-thinking-${mode}.png`, animations: 'disabled' })
    await emit(page, 'tool.started', { tool_call_id: 'tasks-query', tool: 'bot_tasks_query', arguments: {} })
    await expect(page.locator('.tool-call-name')).toHaveCount(0)
    await emit(page, 'tool.completed', { tool_call_id: 'tasks-query', tool: 'bot_tasks_query', output: '{"tasks":[]}' })
    await emit(page, 'message.delta', { delta: 'I will follow up on your task.' })
    await emit(page, 'run.completed', { run_id: 'person-run', output: 'I will follow up on your task.' })
    await expect(page.locator('.streaming-indicator .thinking-status')).toHaveCount(0)
    await expect(page.getByText('I will follow up on your task.')).toBeVisible()
    await expect(page.locator('.thinking-block')).toHaveCount(0)
    await expect(page.locator('.tool-run-card')).toHaveCount(0)
    await expect(page.getByText('bot_tasks_query', { exact: true })).toHaveCount(0)
    await expect(page.locator('.assistant-message-author .message-author-name')).toHaveText('zhezhe')
    expect(operations.some(op => op.path.endsWith('/chat'))).toBe(false)
    expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.reasoning_effort).toBe('high')
    await page.mouse.move(600, 30)
    await page.screenshot({ path: `/tmp/person-chat-${mode}-desktop.png`, animations: 'disabled' })

    await page.locator('.input-model-button').click()
    const menu = page.locator('.model-cascader:visible')
    await expect(menu).toBeVisible()
    await page.screenshot({ path: `/tmp/person-chat-${mode}-models.png`, animations: 'disabled' })
    await menu.getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
    await page.reload()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
    await page.locator('.reasoning-effort-button').click()
    await expect(page.getByRole('slider')).toHaveAttribute('aria-disabled', 'true')
    await page.keyboard.press('Escape')
    await page.locator('.input-model-button').click()
    await page.getByRole('button', { name: 'Use global default model', exact: true }).click()
    await expect(page.locator('.input-model-button')).toHaveAttribute('aria-label', 'global-model')

    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('[role=status]:visible')).toContainText('Running')
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeDisabled()
    await expect(page.getByRole('button', { name: /^(Pause|Resume|Cancel run|Accept result|Details)$/ })).toHaveCount(0)
    await page.screenshot({ path: `/tmp/person-tasks-${mode}-running.png`, animations: 'disabled' })
    await page.keyboard.press('Escape')
    state.memories = [{ id: 'saved-memory', revision: 2, content: 'Keep responses short' }]
    await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: /Memory/ }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toBeVisible()
    await expect(page.getByText('Tell zhezhe what to remember or correct', { exact: false })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Memory', exact: true })).toHaveCount(0)
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.screenshot({ path: `/tmp/person-memory-${mode}.png` })
    await page.getByRole('button', { name: 'Forget', exact: true }).click()
    await expect(page.getByText('Keep responses short', { exact: true })).toHaveCount(0)
    expect(operations.filter(op => op.path.endsWith('/memory')).at(-1).body).toEqual({ id: 'saved-memory', expected_revision: 2, forget: true })
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-drawer:visible')).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(input).toBeVisible()
    await expect(page.locator('.input-model-button')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-chat-${mode}-mobile.png`, animations: 'disabled' })
    await page.locator('.input-model-button').click()
    await expect(menu.getByRole('menuitemradio').filter({ hasText: 'global-model' })).toBeVisible()
    await page.keyboard.press('Escape')
    expect(operations.every(op => !op.headers['x-hermes-profile'])).toBe(true)
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
  })
}

test('Person replays single-chat questions and uses the same reply, approval and abort events', async ({ page }) => {
  await setup(page, 'light', false)
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] = {
      session_id: 'person-main-1', messages: [{ id: 1, role: 'user', content: 'Check report', timestamp: 1 }], isWorking: true,
      events: [{ event: 'clarify.requested', data: { event: 'clarify.requested', session_id: 'person-main-1', clarify_id: 'person-interaction:q:0', question: 'Which report?', choices: ['Weekly', 'Monthly'], durable: true } }],
    }
  })
  await page.goto('/#/person')
  await expect(page.getByText('Which report?', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weekly', exact: true })).toHaveCount(1)
  await expect(page.locator('.pending-interaction-countdown:visible')).toHaveCount(0)
  await page.getByRole('button', { name: 'Weekly', exact: true }).click()
  await expect.poll(() => emitted(page, 'clarify.respond')).toEqual([expect.objectContaining({ session_id: 'person-main-1', clarify_id: 'person-interaction:q:0', response: 'Weekly' })])
  await emit(page, 'clarify.resolved', { clarify_id: 'person-interaction:q:0', resolved: true })
  await emit(page, 'approval.requested', { approval_id: 'person-interaction:a:0', command: 'Publish report', description: 'Allow publishing this report?', choices: ['once','deny'], allow_permanent: false })
  await expect(page.getByText('Allow publishing this report?')).toBeVisible()
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect.poll(() => emitted(page, 'approval.respond')).toEqual([expect.objectContaining({ session_id: 'person-main-1', approval_id: 'person-interaction:a:0', choice: 'once' })])
  await emit(page, 'approval.resolved', { approval_id: 'person-interaction:a:0', resolved: true, choice: 'once' })
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect.poll(() => emitted(page, 'abort')).toEqual([expect.objectContaining({ session_id: 'person-main-1' })])
  await emit(page, 'abort.completed', { synced: true })
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  expect(await emitted(page, 'run')).toEqual([])
})

async function emit(page: Page, event: string, payload: Record<string, unknown>) {
  await page.evaluate(({ event, payload }) => (window as any).__PW_CHAT_SOCKET__.broadcast(event, { event, session_id: 'person-main-1', run_id: 'person-run', ...payload }), { event, payload })
}
async function emitted(page: Page, event: string) {
  return page.evaluate(event => (window as any).__PW_CHAT_SOCKET__.emitted.filter((e: any) => e.event === event).map((e: any) => e.payload), event)
}

test('Person displays a delivered screenshot while keeping the artifact tool hidden', async ({ page }) => {
  await setup(page, 'light', false)
  const path = '/Users/tester/person/workspace/桌面 screenshot.png'
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#f9ad42' } }).png().toBuffer()
  let downloadedPath = ''
  await page.route('**/api/studio/files/download?*', route => {
    downloadedPath = new URL(route.request().url()).searchParams.get('path') || ''
    return route.fulfill({ contentType: 'image/png', body: png })
  })
  await page.goto('/#/person')
  const input = page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)')
  await input.fill('你桌面截个图发我')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
  await emit(page, 'run.started', {})
  await emit(page, 'tool.started', { tool_call_id: 'screenshot', tool: 'bot_artifact_read', arguments: { path } })
  await emit(page, 'tool.completed', { tool_call_id: 'screenshot', tool: 'bot_artifact_read', output: JSON.stringify({ absolute_path: path, kind: 'image', size: png.length }) })
  const output = `![桌面截图](<${path}>)`
  await emit(page, 'message.delta', { delta: output })
  await emit(page, 'run.completed', { output })
  const image = page.getByRole('img', { name: '桌面截图', exact: true })
  await expect(image).toBeVisible()
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(320)
  expect(downloadedPath).toBe(path)
  await expect(page.locator('.tool-run-card')).toHaveCount(0)
  await expect(page.getByText('bot_artifact_read', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person navigation keeps the idle GIF across account events on desktop and mobile in ${mode}`, async ({ page }) => {
    await setup(page, mode, mode === 'dark')
    await page.goto('/#/person')
    const avatar = page.locator('.studio-navigation-rail__avatar:visible')
    for (const state of ['idle', 'thinking', 'searching', 'done', 'error', 'sleeping']) {
      await expect.poll(() => page.evaluate(() => (window as any).__PW_CHAT_SOCKET__?.allSockets?.some((socket: any) => String(socket.url).endsWith('/person-presence')))).toBe(true)
      await page.evaluate(state => {
        const socket = (window as any).__PW_CHAT_SOCKET__.allSockets.find((socket: any) => String(socket.url).endsWith('/person-presence'))
        socket.__trigger('person.presence', { state, lastActivityAt: 1, sleepAt: 600001 })
      }, state)
      await expect(avatar).toHaveAttribute('src', '/person/idle.gif')
      await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    }
    await page.screenshot({ path: `/tmp/person-navigation-${mode}-desktop.png`, animations: 'disabled' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(page.locator('.studio-mobile-drawer')).toBeVisible()
    await expect(avatar).toBeInViewport()
    await expect(avatar).toHaveAttribute('src', '/person/idle.gif')
    await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    await page.screenshot({ path: `/tmp/person-navigation-${mode}-mobile.png`, animations: 'disabled' })
    expect(await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.emitted.some((event: any) => event.event === 'person.activity'))).toBe(false)
    await page.getByRole('link', { name: 'Your account assistant', exact: true }).click()
    await expect(page.locator('.studio-mobile-drawer .person-sidebar .session-item')).toBeVisible()
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person keeps task results without usage or reasoning and opens the task drawer in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode, false, false)
    state.tasks[0].running = false
    state.tasks[0].status = 'completed'
    state.tasks[0].execution_state = 'finished'
    const summary = 'Verify the report against the original source material.\nInclude a concise explanation of the findings, supporting evidence and any remaining questions so the user can review the full result.'
    const agent = mode === 'light' ? 'codex' : 'ekko'
    state.tasks[0].summary = summary
    state.tasks[0].selection_json = JSON.stringify({ runtime: agent })
    const receipt = { taskId: 'task1', executionId: 'execution1', assistantMessageId: '42', title: 'Check report', summary, agent, state: 'finished' }
    const usage = { runId: 'return-run', assistantMessageId: '42', inputTokens: 120, outputTokens: 35, isEstimated: false }
    await page.goto('/#/person')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    await emit(page, 'run.started', { run_id: 'return-run', autonomous: true })
    await emit(page, 'message.delta', { run_id: 'return-run', delta: 'Your report is ready.' })
    await emit(page, 'run.completed', { run_id: 'return-run', message_id: '42', output: 'Your report is ready.', person_task_return: receipt, run_usage: usage })
    const card = page.locator('.person-task-return-card')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('status')).toHaveText('Completed')
    await expect(card.getByRole('img', { name: mode === 'light' ? 'Codex' : 'Ekko' })).toBeVisible()
    await expect(card).toContainText('Check report')
    await expect(page.locator('.run-usage-card')).toHaveCount(0)
    await page.addInitScript(({ receipt, usage }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] = {
        session_id: 'person-main-1', isWorking: false, events: [], messages: [
          { id: 40, role: 'assistant', content: 'Unrelated reply', timestamp: 1 },
          { id: 42, role: 'assistant', content: '<think>Private analysis.</think>Your report is ready.', reasoning: 'Reviewing the report.', timestamp: 2, person_task_return: receipt, run_usage: usage },
          { id: 43, role: 'assistant', content: '<think>Private analysis only.</think>', timestamp: 3, run_usage: { ...usage, assistantMessageId: '43' } },
        ],
      }
      ;(window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = {
        session_id: 'person-task-task1', isWorking: false, events: [], messages: [{ id: 50, role: 'assistant', content: 'Task output', timestamp: 1 }],
      }
    }, { receipt, usage })
    await page.reload()
    await expect(card).toHaveCount(1)
    await expect(card).toBeVisible()
    await expect(page.locator('.run-usage-card, .thinking-block')).toHaveCount(0)
    await expect(page.getByText('Your report is ready.', { exact: true })).toBeVisible()
    await expect(page.getByText(/Private analysis|Reviewing the report/)).toHaveCount(0)
    await expect(page.locator('.message.assistant')).toHaveCount(2)
    await page.locator('.person-compose .input-textarea').fill('Keep draft')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}.png`, animations: 'disabled' })
    const details = card.locator('details')
    await expect(details).not.toHaveAttribute('open')
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open')
    await expect(page.locator('.person-task-chat')).toHaveCount(0)
    expect(await card.locator('.task-return-description').evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}-expanded.png`, animations: 'disabled' })
    await details.locator('summary').click()
    await expect(details).not.toHaveAttribute('open')
    const tagStyle = await card.getByRole('status').evaluate(el => {
      const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderRadius, s.padding, s.fontSize]
    })
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    expect(await page.locator('.status-cell .task-status').evaluate(el => {
      const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.borderRadius, s.padding, s.fontSize]
    })).toEqual(tagStyle)
    await page.keyboard.press('Escape')
    await card.getByRole('button', { name: 'View in conversation: Check report' }).click()
    const drawer = page.locator('.person-task-chat')
    await expect(drawer.getByText('Task output', { exact: true })).toBeVisible()
    await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep draft')
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(card).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await details.locator('summary').click()
    await expect(details).toHaveAttribute('open')
    await page.screenshot({ path: `/tmp/person-return-card-${mode}-mobile.png`, animations: 'disabled' })
    await card.getByRole('button', { name: 'View in conversation: Check report' }).click()
    await expect(drawer.getByText('Task output', { exact: true })).toBeVisible()
  })
}

test('Person offers model selection when the global default is unavailable', async ({ page }) => {
  const { state } = await setup(page, 'dark', false)
  state.settings.model = null; state.reasoning_efforts = []
  await page.goto('/#/person')
  await page.screenshot({ path: '/tmp/person-chat-dark-preset.png', animations: 'disabled' })
  await page.locator('.input-textarea').fill('Hello')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Global default model is unavailable. Choose a model.' }).click()
  await page.getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})


test('Person saves agent presets, preserves unsaved edits and only offers opening or closing idle tasks', async ({ page }) => {
  const { state, operations } = await setup(page, 'light')
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^Agents/ }).click()
  await expect(page.locator('.agent-card')).toContainText('Research assistant')
  await page.getByRole('button', { name: 'Add agent', exact: true }).click()
  await page.getByRole('textbox', { name: 'Agent name', exact: true }).fill('Research assistant')
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Research and write reports')
  await emit(page, 'person.updated', {})
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await page.locator('.person-agent-settings .scoped-model-selector button').click()
  await page.getByRole('menuitemradio').filter({ hasText: 'global-model' }).click()
  await page.locator('.person-agent-settings .n-select').last().click()
  await page.locator('.n-base-select-option__content:visible').getByText('High', { exact: true }).click()
  state.revision++ // Another window changed settings; keep the draft retryable.
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.person-agent-settings .n-alert')).toContainText('Settings changed')
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.settings.agents.length).toBe(2)
  expect(state.settings.agents[1]).toMatchObject({ name: 'Research assistant', description: 'Research and write reports', selection: { runtime: 'codex', mode: 'scoped', provider: 'provider', model: 'global-model', reasoningEffort: 'high' } })
  await page.screenshot({ path: '/tmp/person-agent-settings.png', animations: 'disabled' })
  await page.reload()
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /^Agents/ }).click()
  await expect(page.locator('.agent-card').last()).toContainText('Research assistant')
  await page.locator('.agent-card').last().getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Research assistant')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/person-agent-settings-mobile.png', animations: 'disabled' })
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.locator('.agent-card').last().getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.person-agent-settings').getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => state.settings.agents.length).toBe(1)
  Object.assign(state.tasks[0], { execution_state: 'finished', status: 'completed', running: false })
  await emit(page, 'person.updated', {})
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Completed')
  await expect(page.getByRole('button', { name: 'Accept result', exact: true })).toHaveCount(0)
  const status = page.locator('.task-row button[aria-haspopup=menu]:visible')
  await status.click()
  await expect(page.getByRole('menuitem')).toHaveCount(2)
  await page.getByRole('menuitem', { name: 'Closed', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Closed')
  await status.click()
  await page.getByRole('menuitem', { name: 'Incomplete', exact: true }).click()
  await expect(page.locator('[role=status]:visible')).toContainText('Open')
  await page.screenshot({ path: '/tmp/person-tasks-mobile.png', animations: 'disabled' })
  expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body.action)).toEqual(['close', 'reopen'])
})

for (const [width, mode] of [[1440, 'light'], [390, 'dark']] as const) {
  test(`Person task list shows the executing Agent avatar at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, mode, false, false)
    state.tasks = ['hermes', 'ekko', 'claude-code'].map(runtime => ({ ...state.tasks[0], id: `task-${runtime}`,
      title: `Work by ${runtime}`, execution_state: 'finished', running: false,
      selection_json: JSON.stringify({ runtime, profile: 'default' }) }))
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    const drawer = page.locator('.session-tasks-drawer')
    await expect(drawer.locator('.task-row')).toHaveCount(3)
    for (const [runtime, label, asset] of [['hermes', 'Hermes', 'hermes.png'], ['ekko', 'Ekko', 'ekko-agent.png'], ['claude-code', 'Claude', 'claude-code.svg']]) {
      const row = drawer.locator('.task-row').filter({ hasText: `Work by ${runtime}` })
      const source = row.locator(width === 390 ? '.mobile-source' : '.source-session')
      if (width === 1440) await expect(source).toContainText(label)
      await expect(source.locator('img')).toHaveAttribute('src', `/coding-agents/${asset}`)
      await expect.poll(() => source.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    }
    await page.screenshot({ path: `/tmp/person-task-agent-avatars-${width}.png`, animations: 'disabled' })
  })
}

for (const scenario of ['after-request', 'reconnect', 'idle-schedule'] as const) {
  test(`Person streams a background result to the main window (${scenario})`, async ({ page }) => {
    const { state, operations } = await setup(page, 'light', false)
    if (scenario === 'reconnect') {
      await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].backgroundPending = 1 })
    }
    await page.goto('/#/person')
    const input = page.locator('.input-textarea')
    await expect(input).toBeVisible()
    if (scenario === 'after-request') {
      await input.fill('Check Xiamen weather')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await emit(page, 'run.started', { run_id: 'foreground' })
      await emit(page, 'message.delta', { run_id: 'foreground', delta: 'I have started the background task.' })
      await page.evaluate(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].backgroundPending = 1 })
      await emit(page, 'run.completed', { run_id: 'foreground', output: 'I have started the background task.', background_pending: 1 })
      await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    }
    await emit(page, 'run.started', { run_id: 'callback', autonomous: true })
    await emit(page, 'message.delta', { run_id: 'callback', delta: 'Xiamen is sunny, 25°C.' })
    await expect(page.getByText('Xiamen is sunny, 25°C.', { exact: true })).toBeVisible()
    await emit(page, 'run.completed', { run_id: 'callback', output: 'Xiamen is sunny, 25°C.', autonomous: true, background_pending: 0 })
    Object.assign(state.tasks[0], { execution_state: 'finished', status: 'completed', running: false })
    await emit(page, 'person.updated', {})
    await expect(page.getByText('Xiamen is sunny, 25°C.', { exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('[role=status]:visible')).toContainText('Completed')
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
    if (scenario === 'after-request') await page.screenshot({ path: '/tmp/person-background-return.png', animations: 'disabled' })
  })
}

test('opens a hidden task in a right drawer, continues it and restores the Person window', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  Object.assign(state.tasks[0], { status: 'completed', running: false, execution_state: 'finished', updated_at: Date.now() })
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [
      { id: 'previous-user', role: 'user', content: 'Remember report code LIME-42', timestamp: 1 },
      { id: 'previous-tool', role: 'tool', content: 'Stored the code', tool_name: 'write_file', tool_call_id: 'save-report', timestamp: 1.5 },
      { id: 'previous-answer', role: 'assistant', content: 'Saved report code LIME-42.', timestamp: 2 },
    ], isWorking: false, events: [] }
    ;(window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 'main-answer', role: 'assistant', content: 'The report task has finished.', timestamp: 1 }]
  })
  await page.goto('/#/person')
  await page.locator('.person-compose .input-textarea').fill('Keep my main conversation draft')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.task-list')).toBeVisible()
  await expect(page.locator('.task-pagination')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Previous|More)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const dialog = page.locator('.person-task-chat')
  await expect(dialog.getByText('Saved report code LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.locator('.input-settings-button')).toHaveCount(0)
  await expect(dialog.locator('.message.tool')).toBeVisible()
  await expect(dialog.locator('.assistant-message-author .message-author-name')).toHaveText('Ekko')
  await expect(page.locator('.n-modal')).toHaveCount(0)
  const bounds = await dialog.boundingBox()
  expect(bounds?.y).toBeLessThanOrEqual(48)
  expect(bounds?.height).toBeGreaterThanOrEqual(page.viewportSize()!.height - 48)
  expect(bounds && Math.round(bounds.x + bounds.width)).toBe(page.viewportSize()!.width)
  await expect(page.locator('.person-compose')).toHaveCount(1)
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my main conversation draft')
  await expect(page.locator('.person-view').getByText('The report task has finished.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('hermes_active_session_default'))).toBe('person-main-1')
  await dialog.locator('.input-textarea').fill('What code did I give you?')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
  expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body).toMatchObject({ input: [{ type: 'text', text: 'What code did I give you?' }], expected_revision: 0 })
  expect(await emitted(page, 'run')).toEqual([])
  await emit(page, 'run.started', { session_id: 'person-task-task1', run_id: 'task-followup' })
  await emit(page, 'tool.started', { session_id: 'person-task-task1', run_id: 'task-followup', tool_call_id: 'read-report', tool: 'read_file', arguments: {} })
  await expect(dialog.locator('.tool-call-name').filter({ hasText: 'read_file' })).toBeVisible()
  await emit(page, 'tool.completed', { session_id: 'person-task-task1', run_id: 'task-followup', tool_call_id: 'read-report', tool: 'read_file', output: 'LIME-42' })
  await emit(page, 'message.delta', { session_id: 'person-task-task1', run_id: 'task-followup', delta: 'Your code was LIME-42.' })
  await expect(dialog.getByText('Your code was LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
  await page.screenshot({ path: '/tmp/person-task-chat-desktop.png', animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: '/tmp/person-task-chat-mobile.png', animations: 'disabled' })
  await emit(page, 'run.started', { run_id: 'return-to-main', autonomous: true })
  await emit(page, 'message.delta', { run_id: 'return-to-main', delta: 'The follow-up result is LIME-42.' })
  await emit(page, 'run.completed', { run_id: 'return-to-main', output: 'The follow-up result is LIME-42.', background_pending: 0 })
  await expect(page.locator('.person-view').getByText('The follow-up result is LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Your code was LIME-42.', { exact: true })).toBeVisible()
  await expect(dialog.getByText('The follow-up result is LIME-42.', { exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my main conversation draft')
  await expect(page.getByText('The follow-up result is LIME-42.', { exact: true })).toBeVisible()

})


test('Person uses the single-chat task drawer with search and filters but no pagination controls', async ({ page }) => {
  const { state, operations } = await setup(page, 'dark', false)
  state.tasks = Array.from({ length: 60 }, (_, i) => ({ ...state.tasks[0], id: `task${i}`, title: `Report ${i + 1}`, updated_at: Date.now() - i * 1000, running: false, execution_state: 'finished', status: 'completed' }))
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.locator('.session-tasks-drawer .task-row')).toHaveCount(60)
  await expect(page.locator('.task-pagination')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Previous|More)$/ })).toHaveCount(0)
  expect(operations.find(op => op.path.endsWith('/tasks/query')).body.limit).toBe(100)
  await page.getByRole('button', { name: 'Filter task status' }).click()
  await page.getByRole('menuitem', { name: 'Completed', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/query')).at(-1).body.status).toBe('completed')
  await page.getByRole('button', { name: 'Search tasks or conversations' }).click()
  await page.getByRole('textbox', { name: 'Search tasks or conversations' }).fill('Report 60')
  await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/query')).at(-1).body.search).toBe('Report 60')
})

for (const mode of ['light', 'dark'] as const) {
  test(`stops a Person task from the list and waits for acknowledgement in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    if (mode === 'dark') await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.getByRole('button', { name: 'Stop task', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body)).toEqual([
      { action: 'stop', task_id: 'task1', execution_id: 'execution1', expected_revision: 0, idempotency_key: expect.any(String) },
    ])
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeDisabled()
    await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-stop-list-${mode}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
    await emit(page, 'person.updated', {})
    await expect(page.locator('[role=status]:visible')).toContainText('Interrupted')
    await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0)
    await expect(page.locator('.task-row button[aria-haspopup=menu]:visible')).toBeEnabled()
    expect(await emitted(page, 'abort')).toEqual([])
  })
}

test('stops a waiting task inside its conversation, then continues it without stopping Person', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].execution_state = 'waiting_user'
  await page.addInitScript(() => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: false, events: [] }
  })
  await page.goto('/#/person')
  await page.locator('.person-compose .input-textarea').fill('Keep my draft')
  await emit(page, 'run.started', { run_id: 'main-active' })
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const drawer = page.locator('.person-task-chat')
  await drawer.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
  await expect(drawer.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
  await page.screenshot({ path: '/tmp/person-stop-chat-mobile.png' })
  Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
  await emit(page, 'person.updated', {})
  await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toHaveCount(0)
  await drawer.locator('.input-textarea').fill('Continue from the saved result')
  await drawer.getByRole('button', { name: 'Send', exact: true }).click()
  expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body.expected_revision).toBe(1)
  await expect(drawer.getByRole('button', { name: 'Stop task', exact: true })).toBeEnabled()
  expect(await emitted(page, 'abort')).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep my draft')
  await emit(page, 'message.delta', { run_id: 'main-active', delta: 'Person is still responding.' })
  await expect(page.locator('.person-view').getByText('Person is still responding.', { exact: true })).toBeVisible()
})

test('refreshes a stale stop without automatically cancelling a newer execution', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible()
  Object.assign(state.tasks[0], { execution_id: 'execution2', revision: 2 })
  await page.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(page.getByText('Could not update task status. Refresh and try again.')).toBeVisible()
  expect(operations.filter(op => op.path.endsWith('/tasks/apply'))).toHaveLength(1)
  expect(state.tasks[0].execution_state).toBe('running')
  await page.getByRole('button', { name: 'Stop task', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
  expect(operations.filter(op => op.path.endsWith('/tasks/apply')).at(-1).body).toMatchObject({ execution_id: 'execution2', expected_revision: 2 })
})

for (const mode of ['light', 'dark'] as const) {
  test(`queues follow-ups in the running task drawer and preserves them on reopen in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode)
    if (mode === 'dark') await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: true, events: [] }
    })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    const open = () => page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
    await open()
    const drawer = page.locator('.person-task-chat')
    await drawer.locator('.input-textarea').fill('Wait for CI, then merge if all checks pass.')
    await drawer.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(drawer.locator('.task-chat-queue')).toContainText('Wait for CI, then merge if all checks pass.')
    await expect(drawer.locator('.input-textarea')).toHaveValue('')
    expect(state.tasks[0].execution_id).toBe('execution1')
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0)
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await open()
    await expect(drawer.locator('.task-chat-queue')).toContainText('1 follow-up(s) queued')
    await drawer.locator('.input-textarea').fill('Send me the merge result too.')
    await drawer.locator('.input-textarea').press('Enter')
    await expect(drawer.locator('.task-chat-queue li')).toHaveCount(2)
    expect(operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).map(op => op.body.expected_revision)).toEqual([0, 1])
    await page.mouse.move(2, 2)
    await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-task-followups-${mode}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await drawer.getByRole('button', { name: 'Stop task', exact: true }).click()
    await expect(drawer.locator('.task-chat-queue')).toHaveCount(0)
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).at(-1).body.execution_id).toBe('execution1')
    expect(await emitted(page, 'run')).toEqual([])
    expect(await emitted(page, 'abort')).toEqual([])
  })
}

for (const executionState of ['running', 'queued', 'waiting_user'] as const) {
  test(`stops ${executionState} Person work with a saved follow-up draft`, async ({ page }) => {
    const { state, operations } = await setup(page, executionState === 'queued' ? 'dark' : 'light', false)
    state.tasks[0].execution_state = executionState
    if (executionState !== 'running') await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(({ streaming }) => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-task-task1'] = { session_id: 'person-task-task1', messages: [], isWorking: streaming, events: [] }
    }, { streaming: executionState === 'running' })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
    const drawer = page.locator('.person-task-chat')
    const composer = drawer.locator('.input-textarea')
    await composer.fill('Keep this follow-up draft')
    await expect(drawer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    const headerStop = drawer.getByRole('button', { name: 'Stop task', exact: true })
    await expect(headerStop).toBeEnabled()
    await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
    await page.screenshot({ path: `/tmp/person-composer-stop-${executionState}.png` })
    await headerStop.click()
    const stop = drawer.locator('.input-actions').getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeDisabled()
    await expect(stop).toHaveAttribute('aria-busy', 'true')
    await composer.press('Enter')
    expect(operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body)).toHaveLength(0)
    await expect(drawer.getByRole('button', { name: 'Stopping', exact: true })).toBeDisabled()
    await expect(composer).toHaveValue('Keep this follow-up draft')
    expect(operations.filter(op => op.path.endsWith('/tasks/apply')).map(op => op.body)).toEqual([
      { action: 'stop', task_id: 'task1', execution_id: 'execution1', expected_revision: 0, idempotency_key: expect.any(String) },
    ])
    expect(await emitted(page, 'abort')).toEqual([])
    await emit(page, 'run.failed', { session_id: 'person-task-task1', error: 'Person task stopped' })
    // The socket ending alone cannot restore Send before the durable stop acknowledgement.
    await expect(stop).toBeDisabled()
    Object.assign(state.tasks[0], { running: false, execution_state: 'interrupted' })
    await emit(page, 'person.updated', {})
    const send = drawer.locator('.input-actions').getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeEnabled()
    await expect(composer).toHaveValue('Keep this follow-up draft')
    await send.click()
    await expect.poll(() => operations.filter(op => op.path.endsWith('/tasks/task1/chat') && op.body).length).toBe(1)
    expect(operations.find(op => op.path.endsWith('/tasks/task1/chat') && op.body).body).toMatchObject({ expected_revision: 1, input: [{ type: 'text', text: 'Keep this follow-up draft' }] })
  })
}

for (const mode of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    test(`Person card workspace in ${mode} at ${width}px`, async ({ page }) => {
      const { state } = await setup(page, mode, false, false)
      await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
      await page.setViewportSize({ width, height: 960 })
      state.tasks = [
        { id: 'task1', title: '每天一份 AI 行业简报', status: 'open' },
        { id: 'task2', title: '整理本周项目进展', status: 'open' },
        { id: 'task3', title: '检查产品反馈与新需求', status: 'open' },
        { id: 'task4', title: '月度阅读清单', status: 'open' },
      ]
      state.schedules = state.tasks.map((task: any, index: number) => ({ id: `s${index}`, task_id: task.id, expression: ['0 9 * * *', '0 18 * * 1-5', '30 10 * * 1-5', '2026-11-01T10:00:00+08:00'][index], timezone: 'Asia/Shanghai', next_at: Date.parse('2026-10-28T09:00:00+08:00') + index * 3600000, state: index === 2 ? 'paused' : 'active', revision: 0 }))
      state.memories = [
        '回答优先使用中文，先给结论，再补充必要的解释。',
        '我正在做 Ekko Studio，希望产品简单、清晰，让每个人都能用好 AI。',
        '界面喜欢有留白的卡片布局，注重排版和信息层次。',
        '技术调研优先查官方文档。重要结论附上来源，方便我继续阅读。',
        '通常在上午处理需要专注的工作，下午安排讨论和沟通。',
        '交付前请检查实际效果，涉及界面时给我看截图。',
      ].map((content, index) => ({ id: `m${index}`, content, revision: 0 }))
      state.settings.agents = [
        { id: 'research', name: '研究助理', description: '查找可靠来源，整理行业动态与技术资料，让每个结论都有依据。', selection: { runtime: 'ekko', mode: 'scoped', model: 'deepseek-chat', provider: 'provider', profile: 'default', reasoningEffort: 'high' } },
        { id: 'coder', name: '开发搭档', description: '处理代码实现、问题排查和测试验证，把想法变成可以运行的产品。', selection: { runtime: 'codex', mode: 'scoped', model: 'gpt-5-codex', provider: 'provider', profile: 'default', reasoningEffort: 'high' } },
      ]
      await page.route('**/api/studio/person/agent-models', route => route.fulfill({ json: { groups: [{ provider: 'provider', profile: 'default', label: '团队模型', models: ['deepseek-chat', 'gpt-5-codex'] }] } }))
      await page.goto('/#/person')
      await expect(page.locator('.person-header-actions').getByRole('button', { name: /定时计划|记忆/ })).toHaveCount(0)
      await page.locator('.person-header-actions').getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('tab', { name: /定时计划/ }).click()
      const drawer = page.locator('.person-workspace-drawer')
      await expect(drawer.locator('.schedule-tile')).toHaveCount(4)
      await expect.poll(async () => (await drawer.boundingBox())?.width || 0).toBeGreaterThan(width === 390 ? 389 : 1100)
      const capture = async (name: string) => {
        await page.mouse.move(2, 940)
        await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))) })
        expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        await page.screenshot({ path: `/tmp/person-ui-${name}-${mode}-${width}.png`, animations: 'disabled' })
      }
      await capture('schedules')
      await page.getByRole('tab', { name: /记忆/ }).click()
      await expect(drawer.locator('.memory-tile')).toHaveCount(6)
      await capture('memory')
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('官方文档')
      await expect(drawer.locator('.memory-tile')).toHaveCount(1)
      await page.getByRole('textbox', { name: '搜索', exact: true }).fill('不存在的记忆')
      await expect(drawer.locator('.memory-tile')).toHaveCount(0)
      await expect(drawer.locator('.panel-empty')).toBeVisible()
      await page.getByRole('tab', { name: /智能体/ }).click()
      await expect(drawer.locator('.agent-card')).toHaveCount(2)
      await capture('agents')
      await drawer.getByRole('button', { name: '添加 Agent', exact: true }).click()
      await drawer.locator('.runtime-option').filter({ hasText: 'Ekko' }).click()
      await page.getByRole('textbox', { name: 'Agent 名称', exact: true }).fill('新搭档')
      await page.getByRole('textbox', { name: '用途说明', exact: true }).fill('整理会议纪要，提炼关键决策，并持续跟进待办事项。')
      await drawer.locator('.scoped-model-selector button').click()
      await page.getByRole('menuitemradio').filter({ hasText: 'deepseek-chat' }).click()
      await capture('agent-editor')
      await drawer.getByRole('button', { name: '取消', exact: true }).click()
      await expect(drawer.locator('.agent-card')).toHaveCount(2)
    })
  }
}

test('Person schedule cards create, edit, pause, resume and cancel without losing a failed edit', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].running = false
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  const drawer = page.locator('.person-workspace-drawer')
  await expect(drawer.locator('.panel-empty')).toBeVisible()
  await drawer.getByRole('button', { name: 'New schedule', exact: true }).click()
  await drawer.getByLabel('Execution mode', { exact: true }).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Run background task', { exact: true }).click()
  await drawer.getByLabel('Tasks', { exact: true }).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Check report', { exact: true }).click()
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.schedule-tile')).toHaveCount(1)
  expect(state.schedules[0].expression).toBe('0 9 * * *')
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  await drawer.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(drawer.locator('.n-tag')).toHaveText('Paused')
  await drawer.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(drawer.locator('.n-tag')).toHaveText('Active')
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Timezone', exact: true }).fill('Asia/Shanghai')
  state.schedules[0].revision++
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.workspace-error')).toContainText('Schedule changed')
  await expect(drawer.getByRole('textbox', { name: 'Timezone', exact: true })).toHaveValue('Asia/Shanghai')
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Timezone', exact: true }).fill('Asia/Shanghai')
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  expect(state.schedules[0].timezone).toBe('Asia/Shanghai')
  await drawer.getByRole('button', { name: 'Cancel schedule', exact: true }).click()
  await expect(drawer.locator('.n-tag')).toHaveText('Cancelled')
  expect(operations.filter(op => op.path.endsWith('/schedules/apply')).map(op => op.body.action)).toEqual(['create', 'pause', 'resume', 'update', 'update', 'cancel'])
})

test('Person schedule editor preserves weekday, custom and one-time expressions', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  const drawer = page.locator('.person-workspace-drawer')
  await drawer.getByRole('button', { name: 'New schedule', exact: true }).click()
  await drawer.getByLabel('Execution mode', { exact: true }).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Run background task', { exact: true }).click()
  await drawer.getByLabel('Tasks', { exact: true }).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Check report', { exact: true }).click()
  await drawer.locator('.panel-editor .n-select').nth(3).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Weekdays', { exact: true }).click()
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.schedule-tile')).toHaveCount(1)
  expect(state.schedules[0].expression).toBe('0 9 * * 1-5')
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.locator('.panel-editor .n-select').nth(3).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Custom', { exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Schedule expression', exact: true }).fill('15 10 * * 1,3,5')
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  expect(state.schedules[0].expression).toBe('15 10 * * 1,3,5')
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(drawer.getByRole('textbox', { name: 'Schedule expression', exact: true })).toHaveValue('15 10 * * 1,3,5')
  await drawer.locator('.panel-editor .n-select').nth(2).click()
  await page.locator('.n-base-select-option__content:visible').getByText('Once', { exact: true }).click()
  const dateInput = drawer.locator('.n-date-picker input')
  await dateInput.fill('2099-12-01 09:30:00')
  await dateInput.press('Enter')
  await drawer.getByRole('textbox', { name: 'Timezone', exact: true }).click()
  await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  const expected = await page.evaluate(() => new Date(2099, 11, 1, 9, 30).toISOString())
  expect(operations.filter(op => op.path.endsWith('/schedules/apply')).at(-1).body).toMatchObject({ kind: 'once', expression: expected })
  await drawer.locator('.schedule-tile').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(dateInput).toHaveValue('2099-12-01 09:30:00')
})

for (const width of [1440, 390]) {
  test(`Person keeps long agent names compact at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    const longName = 'Research and engineering coordination assistant for complex cross-team requirements and delivery work'
    state.settings.agents = [
      { id: 'long', name: longName, description: 'Research tasks', selection: { runtime: 'ekko', mode: 'scoped', model: 'global-model', provider: 'provider', profile: 'default', reasoningEffort: '' } },
      { id: 'short', name: 'Assistant', description: 'Research tasks', selection: { runtime: 'codex', mode: 'scoped', model: 'global-model', provider: 'provider', profile: 'default', reasoningEffort: '' } },
    ]
    await page.route('**/api/studio/person/capabilities', route => route.fulfill({ json: { agents: ['ekko', 'codex', 'dsh', 'copilot', 'claude-code', 'opencode'].map(runtime => ({ runtime, installed: true })), native_allowed: true } }))
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/#/person')
    const settings = page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true })
    await expect(settings).toHaveText('')
    await settings.click()
    await expect(settings).toHaveAttribute('aria-expanded', 'true')
    const drawer = page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab', { name: /^Agents/ }).click()
    const names = drawer.locator('.agent-card h3')
    await expect(names.first()).toHaveText(longName)
    await expect(names.first()).toHaveAttribute('title', longName)
    const first = await names.first().boundingBox()
    const second = await names.nth(1).boundingBox()
    expect(first!.height).toBeLessThanOrEqual(second!.height + 1)
    const cards = await drawer.locator('.agent-card').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height))
    expect(Math.abs(cards[0]! - cards[1]!)).toBeLessThanOrEqual(1)
    const inset = await drawer.evaluate(el => el.querySelector('.panel-grid')!.getBoundingClientRect().left - el.getBoundingClientRect().left)
    expect(inset).toBeLessThanOrEqual(width === 390 ? 17 : 25)
    await drawer.locator('.agent-card').first().getByRole('button', { name: 'Edit', exact: true }).click()
    const title = drawer.locator('.editor-heading h3')
    expect((await title.boundingBox())!.height).toBeLessThan(30)
    await expect(drawer.locator('.runtime-option')).toHaveCount(6)
    const sizes = await drawer.locator('.runtime-option').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().height))
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    await drawer.getByRole('button', { name: 'DeepSeek Harness', exact: true }).click()
    await expect(drawer.getByRole('button', { name: 'DeepSeek Harness', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-ui-long-names-${width}.png`, animations: 'disabled' })
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('tab', { name: /Memory/ }).click()
    await expect(settings).toHaveAttribute('aria-expanded', 'true')
  })
}

for (const width of [1440, 390]) {
  test(`Person checks execution agents on send and preserves the draft at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    state.settings.agents = []
    await page.route('**/api/studio/uploads', route => route.fulfill({ json: { files: [{ name: 'notes.txt', path: '/tmp/person/notes.txt' }] } }))
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toBeVisible()
    const dialog = page.getByRole('dialog', { name: 'Add an execution agent' })
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Go to settings', exact: true })).toHaveCount(0)
    await page.locator('.input-textarea').fill('Continue the idiom game')
    await page.locator('.file-input-hidden').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this attachment') })
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toContainText('at least one execution agent')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.locator('.input-textarea').press('Enter')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'close', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await page.locator('.input-textarea').press('Enter')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    expect(await emitted(page, 'run')).toHaveLength(0)
    await expect(page.locator('.input-textarea')).toHaveValue('Continue the idiom game')
    await expect(page.locator('.attachment-preview')).toContainText('notes.txt')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await dialog.getByRole('button', { name: 'Go to settings', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    const drawer = page.locator('.person-workspace-drawer')
    await expect(drawer.getByRole('tab', { name: /^Agents/ })).toHaveAttribute('aria-selected', 'true')
    await expect(drawer.getByText('No Agents yet', { exact: true })).toBeVisible()
    await addExecutionAgent(page)
    await expect.poll(() => state.settings.agents.length).toBe(1)
    await page.keyboard.press('Escape')
    await expect(drawer).not.toBeVisible()
    await expect(page.locator('.input-textarea')).toHaveValue('Continue the idiom game')
    await expect(page.locator('.attachment-preview')).toContainText('notes.txt')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
    await expect(page.locator('.input-textarea')).toHaveValue('')
    await expect(page.locator('.attachment-preview')).toHaveCount(0)
    await expect(dialog).not.toBeVisible()
  })
}

async function addExecutionAgent(page: Page, conflict = false) {
  const settings = page.locator('.person-agent-settings')
  await settings.getByRole('button', { name: 'Add agent', exact: true }).click()
  await settings.getByRole('button', { name: 'Ekko', exact: true }).click()
  await settings.getByRole('textbox', { name: 'Agent name', exact: true }).fill('Task executor')
  await settings.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Handle assistant tasks')
  await settings.locator('.scoped-model-selector button').click()
  await page.getByRole('menuitemradio').filter({ hasText: 'global-model' }).click()
  await settings.getByRole('button', { name: 'Save', exact: true }).click()
  if (conflict) {
    await expect(settings.locator('.n-alert')).toContainText('Settings changed')
    await expect(settings.getByRole('textbox', { name: 'Agent name', exact: true })).toHaveValue('Task executor')
    await settings.getByRole('button', { name: 'Save', exact: true }).click()
  }
  await expect(settings.locator('.agent-card')).toContainText('Task executor')
}

for (const existing of [false, true]) {
  test(`Person configures an execution agent before creating a BOT (${existing ? 'existing conversations' : 'first conversation'})`, async ({ page }) => {
    const { state, operations } = await setup(page, 'light', false, false)
    state.settings.agents = []
    if (!existing) state.conversations = []
    await page.goto('/#/person')
    if (existing) await page.getByRole('button', { name: 'New BOT role', exact: true }).click()
    const draft = page.locator('.new-chat-page')
    await draft.getByRole('textbox', { name: 'BOT name' }).fill('New assistant')
    await draft.locator('.input-textarea').fill('My first message')
    await draft.getByRole('button', { name: 'Send', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add an execution agent' })
    await expect(dialog).toBeVisible()
    expect(operations.filter(op => op.path.endsWith('/conversations') && op.body)).toHaveLength(0)
    expect(await emitted(page, 'run')).toHaveLength(0)
    await dialog.getByRole('button', { name: 'Go to settings', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^Agents/ })).toHaveAttribute('aria-selected', 'true')
    // Another window changed shared settings; retry must retain the Agent draft.
    state.revision++
    await addExecutionAgent(page, true)
    expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.session_id).toBeUndefined()
    await page.keyboard.press('Escape')
    await expect(draft.getByRole('textbox', { name: 'BOT name' })).toHaveValue('New assistant')
    await expect(draft.locator('.input-textarea')).toHaveValue('My first message')
    await draft.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.person-title')).toHaveText('New assistant')
    await expect.poll(() => emitted(page, 'run')).toHaveLength(1)
    expect(operations.filter(op => op.path.endsWith('/conversations') && op.body)).toHaveLength(1)
  })
}

for (const { width, mode } of [{ width: 1440, mode: 'light' }, { width: 390, mode: 'dark' }] as const) {
  test(`previews execution Agent prompt in Chinese in ${mode} at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, mode, false, false)
    state.settings.agents = []
    await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toBeVisible()
    const dialog = page.getByRole('dialog', { name: '请先添加执行智能体' })
    await expect(dialog).not.toBeVisible()
    await page.locator('.input-textarea').fill('帮我整理今天的任务')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toContainText('个人助理至少需要一个执行智能体来处理任务')
    await page.screenshot({ path: `/tmp/person-agent-setup-zh-${mode}-${width}.png`, animations: 'disabled' })
    await dialog.getByRole('button', { name: '去设置', exact: true }).click()
    await expect(page.getByRole('tab', { name: /^智能体/ })).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.person-workspace-drawer .panel-empty')).toBeVisible()
    await page.screenshot({ path: `/tmp/person-agent-setup-drawer-zh-${mode}-${width}.png`, animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person Agent prompt and cards follow wallpaper and regional themes in ${mode}`, async ({ page }) => {
    const { state } = await setup(page, mode)
    state.settings.agents = []
    await page.goto('/#/person')
    const dialog = page.getByRole('dialog', { name: 'Add an execution agent' })
    async function openPrompt() {
      await page.locator('.input-textarea').fill('Check execution agents')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveCSS('opacity', '1')
    }
    await openPrompt()
    await expect(dialog).toHaveCSS('background-color', /rgba\(.+, 0\.5\)/)
    await dialog.getByRole('button', { name: 'Go to settings', exact: true }).click()
    const empty = page.locator('.person-agent-settings .panel-empty')
    await expect(empty).toHaveCSS('background-color', /rgba\(.+, 0\.65\)/)
    await expect(empty).toHaveCSS('backdrop-filter', 'blur(12px) saturate(1.1)')
    // Persist a regional override through the mocked theme API and verify it after reload.
    await page.evaluate(async () => {
      await fetch('/api/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appearance: {
        global: { opacity: 0.3 }, regions: { overlay: { backgroundColor: '#336699', opacity: 0, radius: 18, blur: 8 }, card: { backgroundColor: '#336699', opacity: 0, radius: 18, blur: 12 } },
      } }) })
    })
    await page.reload()
    await openPrompt()
    await expect(dialog).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(dialog).toHaveCSS('border-radius', '18px')
    await dialog.getByRole('button', { name: 'Go to settings', exact: true }).click()
    await expect(empty).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(empty).toHaveCSS('opacity', '1')
    await expect(empty).toHaveCSS('border-radius', '18px')
    await page.evaluate(async () => {
      await fetch('/api/theme', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ background: null, appearance: { global: {}, regions: {} } }) })
    })
    await page.reload()
    await openPrompt()
    await expect(dialog).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
    await dialog.getByRole('button', { name: 'Go to settings', exact: true }).click()
    await expect(empty).toHaveCSS('background-color', mode === 'light' ? 'rgb(255, 255, 255)' : 'rgb(42, 42, 42)')
  })
}

test('Person persists the selected xhigh effort and sends it after a reload', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  state.settings.model.model = 'gpt-6.1-sol'
  state.settings.agents[0].selection = { ...state.settings.agents[0].selection, model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }
  state.reasoning_efforts = ['low', 'medium', 'high', 'xhigh', 'max']
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await page.goto('/#/person')
  const effort = page.locator('.reasoning-effort-button')
  await expect(effort).toHaveAttribute('aria-label', /低/)
  await effort.click()
  const slider = page.getByRole('slider')
  await expect(slider).toHaveAttribute('aria-valuemax', '4')
  await slider.focus()
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
  await expect(effort).toHaveAttribute('aria-label', /超高/)
  await expect.poll(() => state.settings.reasoningEffort).toBe('xhigh')
  await page.keyboard.press('Escape')
  await page.reload()
  await expect(effort).toHaveAttribute('aria-label', /超高/)
  await page.locator('.input-textarea').fill('用超高思考强度检查报告')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => emitted(page, 'run')).toEqual([expect.objectContaining({ model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' })])
  expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.reasoning_effort).toBe('xhigh')
  expect(state.settings.agents[0].selection.reasoningEffort).toBe('xhigh')
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person uses shared loading until its snapshot and conversation are ready in ${mode}`, async ({ page }) => {
    if (mode === 'dark') await page.setViewportSize({ width: 390, height: 844 })
    await setup(page, mode, mode === 'dark')
    await page.addInitScript(() => { delete (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'] })
    let releaseSnapshot!: () => void
    let releaseRefresh!: () => void
    const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
    const refresh = new Promise<void>(resolve => { releaseRefresh = resolve })
    let requests = 0
    await page.route(/\/api\/studio\/person(?:\?.*)?$/, async route => {
      requests++
      await (requests === 1 ? snapshot : refresh)
      await route.fallback()
    })
    await page.goto('/#/person')
    const surface = page.locator('.person-view')
    const overlay = surface.locator(':scope > .page-loading-overlay')
    await expect(overlay.locator('.studio-loading-logo')).toBeVisible()
    await expect(surface).toHaveAttribute('aria-busy', 'true')
    await expect(surface.locator(':scope > .page-loading-content')).toHaveAttribute('inert', '')
    await expect(surface.locator(':scope > .page-loading-content')).not.toBeVisible()
    await page.screenshot({ path: `/tmp/person-shared-loading-${mode}.png` })
    releaseSnapshot()
    await expect.poll(() => emitted(page, 'resume')).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: 'person-main-1' })]))
    await expect(overlay.locator('.studio-loading-logo')).toBeVisible()
    await backgroundTaskCount(page, 2)
    await expect(page.locator('.person-task-island')).toHaveCount(0)
    await page.evaluate(() => (window as any).__PW_CHAT_SOCKET__.latest.__trigger('resumed', {
      session_id: 'person-main-1', isWorking: false, events: [],
      messages: [{ id: 1, role: 'user', content: 'Loaded Person history', timestamp: 1 }],
      messageTotal: 1, messageLoadedCount: 1, hasMoreBefore: false,
    }))
    await expect(overlay).toHaveCount(0)
    await expect(page.locator('.person-task-island')).toBeVisible()
    await expect(page.getByText('Loaded Person history', { exact: true })).toBeVisible()
    const input = surface.locator('.input-textarea')
    await input.fill('Keep this Person draft')
    await emit(page, 'person.updated', {})
    await expect.poll(() => requests).toBeGreaterThan(1)
    await expect(overlay).toHaveCount(0)
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('Keep this Person draft')
    releaseRefresh()
  })
}

test('Person releases shared loading and displays its initial request error', async ({ page }) => {
  await setup(page, 'light', false)
  await page.route(/\/api\/studio\/person(?:\?.*)?$/, route => route.fulfill({ status: 503, json: { error: 'Person temporarily unavailable' } }))
  await page.goto('/#/person')
  await expect(page.locator('.person-view > .page-loading-overlay')).toHaveCount(0)
  await expect(page.locator('.person-alert')).toContainText('Person temporarily unavailable')
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible()
})

for (const mode of ['light', 'dark'] as const) {
  test(`Person selects the shared workspace and clears history and tasks with a broom in ${mode}`, async ({ page }) => {
    if (mode === 'dark') await page.setViewportSize({ width: 360, height: 780 })
    const { state, operations } = await setup(page, mode, mode === 'dark')
    state.tasks[0].running = false
    state.memories = [{ id: 'kept-memory', revision: 0, content: 'Keep my preference' }]
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 1, role: 'assistant', content: 'Old Person conversation', timestamp: 1 }]
    })
    await page.goto('/#/person')
    await expect(page.getByText('Old Person conversation', { exact: true })).toBeVisible()
    const workspace = page.getByRole('button', { name: 'Workspace', exact: true })
    const broom = page.getByRole('button', { name: 'Clear chat history and tasks', exact: true })
    await expect(workspace).toBeEnabled()
    await expect(broom).toBeEnabled()
    expect((await broom.textContent())?.trim()).toBe('')
    await workspace.click()
    const picker = page.locator('.n-modal:visible')
    await expect(picker.getByText('All background tasks use this workspace.', { exact: false })).toBeVisible()
    await picker.locator('.folder-path-input input').fill('/workspace/person-shared')
    await picker.getByRole('button', { name: 'OK', exact: true }).click()
    await expect(picker).toHaveCount(0)
    expect(operations.filter(op => op.path.endsWith('/settings')).at(-1).body.workspace).toBe('/workspace/person-shared')
    await page.reload()
    await expect(page.getByText('Old Person conversation', { exact: true })).toBeVisible()
    await workspace.click()
    await expect(picker.locator('.folder-path-input input')).toHaveValue('/workspace/person-shared')
    await picker.screenshot({ path: `/tmp/person-workspace-picker-${mode}.png` })
    await picker.getByRole('button', { name: 'Cancel', exact: true }).click()
    await broom.click()
    await expect(page.getByText('Clear Person chat history, tasks and their schedules?', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(operations.filter(op => op.path.endsWith('/clear'))).toHaveLength(0)
    await expect(page.getByText('Old Person conversation', { exact: true })).toBeVisible()
    await broom.click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByText('Old Person conversation', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Chat history and tasks cleared.', { exact: true })).toBeVisible()
    expect(operations.filter(op => op.path.endsWith('/clear'))).toEqual([expect.objectContaining({ body: { session_id: 'person-main-1', expected_history_revision: 0 } })])
    expect(state.tasks).toEqual([])
    expect(state.memories).toHaveLength(1)
    expect(state.settings.workspace).toBe('/workspace/person-shared')
    await page.getByRole('button', { name: 'Tasks', exact: true }).click()
    await expect(page.locator('.session-tasks-drawer .task-row')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.locator('.session-tasks-drawer:visible')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const bounds = await broom.boundingBox()
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.screenshot({ path: `/tmp/person-header-controls-${mode}.png`, animations: 'disabled' })
  })
}

test('Person disables workspace and broom controls while tasks or main replies are running', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  await page.goto('/#/person')
  const workspace = page.getByRole('button', { name: 'Workspace', exact: true })
  const broom = page.getByRole('button', { name: 'Clear chat history and tasks', exact: true })
  await expect(workspace).toBeDisabled(); await expect(broom).toBeDisabled()
  state.tasks[0].running = false
  await emit(page, 'person.updated', {})
  await expect(workspace).toBeEnabled(); await expect(broom).toBeEnabled()
  await emit(page, 'run.started', {})
  await expect(workspace).toBeDisabled(); await expect(broom).toBeDisabled()
  expect(operations.filter(op => op.path.endsWith('/clear'))).toHaveLength(0)
})

test('Person preserves records when work starts after opening the clear confirmation', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.tasks[0].running = false
  await page.addInitScript(() => { (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages = [{ id: 1, role: 'user', content: 'Keep the old conversation', timestamp: 1 }] })
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Clear chat history and tasks', exact: true }).click()
  state.tasks[0].running = true
  await page.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(page.locator('.person-alert')).toContainText('Wait for Person tasks')
  await expect(page.getByText('Keep the old conversation', { exact: true })).toBeVisible()
  expect(state.tasks).toHaveLength(1)
  expect(operations.filter(op => op.path.endsWith('/clear'))).toHaveLength(1)
})


test('Person updates all character names with the interface language while retaining selection and scroll position', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  state.conversations = []
  await page.goto('/#/person')
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  const picker = page.locator('.person-bot-picker')
  const viewport = picker.locator('.person-bot-viewport')
  await viewport.hover()
  await page.mouse.wheel(160, 0)
  await expect(picker.locator('[aria-pressed="true"]')).toHaveAttribute('data-bot', 'xiaohe')
  const left = await viewport.evaluate(el => el.scrollLeft)
  for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ar', 'en']) {
    await page.evaluate(async locale => {
      const path = '/src/i18n/index.ts'
      const { switchLocale } = await import(path)
      await switchLocale(locale)
    }, locale)
    for (const bot of PERSON_BOTS) {
      await expect(picker.getByRole('button', { name: locale.startsWith('zh') ? bot.name : bot.type, exact: true })).toHaveCount(1)
    }
    await expect(page.locator('#person-conversation-name')).toHaveValue(locale.startsWith('zh') ? '小鹤' : 'xiaohe')
    await expect(picker.locator('[aria-pressed="true"]')).toHaveAttribute('data-bot', 'xiaohe')
    expect(await viewport.evaluate(el => el.scrollLeft)).toBe(left)
    if (locale === 'zh' || locale === 'en') await page.screenshot({ path: `/tmp/studio-bot-picker/carousel-locale-${locale}.png`, animations: 'disabled' })
  }
  await page.locator('#person-conversation-name').fill('My custom companion')
  await page.evaluate(async () => { const path = '/src/i18n/index.ts'; await (await import(path)).switchLocale('zh') })
  await expect(page.locator('#person-conversation-name')).toHaveValue('My custom companion')
  await picker.getByRole('button', { name: '小鹤', exact: true }).click()
  await expect(page.locator('#person-conversation-name')).toHaveValue('小鹤')
})

test('Person accumulates small wheel deltas without snapping back between wheel events', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  state.conversations = []
  await page.goto('/#/person')
  await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
  const picker = page.locator('.person-bot-picker')
  const viewport = picker.locator('.person-bot-viewport')
  const selected = picker.locator('[aria-pressed="true"]')
  await expect(selected).toHaveAttribute('data-bot', 'zhezhe')
  // Hover the viewport: hovering the child asks Playwright to scroll that
  // button into view, which can move the carousel before the wheel gesture.
  await viewport.hover()
  await expect.poll(() => viewport.evaluate(el => {
    const slot = el.querySelector<HTMLElement>('[aria-pressed="true"]')!.parentElement!
    return Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - el.scrollLeft - el.clientWidth / 2)
  })).toBeLessThan(1)
  const start = await viewport.evaluate(el => el.scrollLeft)
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 16)
    await page.waitForTimeout(32)
  }
  await expect.poll(async () => await viewport.evaluate(el => el.scrollLeft) - start).toBeCloseTo(160, 0)
  await expect(selected).toHaveAttribute('data-bot', 'xiaohe')
  const stopped = await viewport.evaluate(el => el.scrollLeft)
  await page.waitForTimeout(400)
  expect(await viewport.evaluate(el => el.scrollLeft)).toBe(stopped)
  await page.mouse.move(0, 0)
  const bounds = (await viewport.boundingBox())!
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100)
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(-16, 0)
    await page.waitForTimeout(32)
  }
  await expect(selected).toHaveAttribute('data-bot', 'zhezhe')
})

async function expectPersonBotHit(page: Page, viewport: Locator) {
  await expect.poll(() => viewport.evaluate(el => {
    const middle = el.scrollLeft + el.clientWidth / 2
    const slots = Array.from(el.querySelectorAll<HTMLElement>('.person-bot-slot'))
    const closest = slots.reduce((best, slot) => Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - middle)
      < Math.abs(best.offsetLeft + best.offsetWidth / 2 - middle) ? slot : best)
    return closest.querySelector('button')?.getAttribute('aria-pressed') === 'true'
  })).toBe(true)
  const selected = viewport.locator('[aria-pressed="true"]')
  const botType = await selected.getAttribute('data-bot')
  await expect(page.locator('#person-conversation-name')).toHaveValue(botType!)
  await expect(selected.locator('img')).toHaveAttribute('src', PERSON_BOTS.find(bot => bot.type === botType)!.animations.idle)
  await expect.poll(() => selected.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
}

for (const width of [1440, 390]) {
  test(`Person keeps Bot hits and GIFs in sync after fast wheel bursts at ${width}px`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    state.conversations = []
    await page.setViewportSize({ width, height: 960 })
    await page.goto('/#/person')
    await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
    const viewport = page.locator('.person-bot-viewport')
    await viewport.hover()
    for (const direction of [1, -1]) {
      for (const delta of [3200, 1900, 720, 280, 73]) await page.mouse.wheel(direction * delta, 0)
      // Check the settled hit without clicking the row or issuing another gesture.
      await page.waitForTimeout(300)
      await expectPersonBotHit(page, viewport)
    }
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person previews transparent Bot characters on interaction in ${mode}`, async ({ page }) => {
    await setup(page, mode, mode === 'dark', mode === 'dark')
    await page.setViewportSize({ width: 1440, height: 1050 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'New BOT role', exact: true }).click()
    await page.mouse.move(0, 0)
    const picker = page.locator('.person-bot-picker')
    await expect(picker.getByRole('button')).toHaveCount(PERSON_BOTS.length)
    await expect(page.locator('.new-chat-page .agent-card')).toHaveCount(0)
    for (const bot of PERSON_BOTS) {
      const image = picker.getByRole('button', { name: bot.type, exact: true }).locator('img')
      await expect(image).toHaveAttribute('src', bot.idleFrame)
      await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
      expect(await image.evaluate((image: HTMLImageElement) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, 1, 1).data[3]
      })).toBe(0)
    }
    const crane = picker.getByRole('button', { name: 'xiaohe', exact: true })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await crane.hover()
    await expect(crane.locator('img')).toHaveAttribute('src', '/person/xiaohe/idle.png')
    await expect(crane).toHaveAttribute('aria-pressed', 'false')
    expect(await crane.locator('img').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBe(1)
    await page.mouse.move(0, 0)
    await expect(crane.locator('img')).toHaveAttribute('src', '/person/xiaohe/idle.png')
    await expect.poll(() => crane.locator('img').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeLessThan(1.01)
    await picker.getByRole('button', { name: 'zhezhe', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(crane).toBeFocused()
    await expect(crane).toHaveAttribute('aria-pressed', 'true')
    await expect(crane.locator('img')).toHaveAttribute('src', '/person/xiaohe/idle.gif')
    await expect.poll(() => crane.locator('img').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a)).toBeGreaterThan(1.2)
    await page.keyboard.press('ArrowRight')
    await expect(crane.locator('img')).toHaveAttribute('src', '/person/xiaohe/idle.png')
    const viewport = picker.locator('.person-bot-viewport')
    const selected = picker.locator('.person-bot-option[aria-pressed="true"]')
    const centerError = () => viewport.evaluate(el => {
      const button = el.querySelector<HTMLElement>('[aria-pressed="true"]')!, slot = button.parentElement!
      return Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - el.scrollLeft - el.clientWidth / 2)
    })
    await page.keyboard.press('Home')
    await expect.poll(centerError).toBeLessThan(1)
    const step = await viewport.evaluate(el => {
      const slots = el.querySelectorAll<HTMLElement>('.person-bot-slot')
      return slots[1].offsetLeft - slots[0].offsetLeft
    })
    const bounds = (await viewport.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 8)
    let index = 0
    for (const direction of [1, -1]) {
      for (let i = 0; i < PERSON_BOTS.length + 2; i++) {
        index = (index + direction + PERSON_BOTS.length) % PERSON_BOTS.length
        await page.mouse.wheel(direction === 1 ? step : 0, direction === -1 ? -step : 0)
        await expect(selected).toHaveAttribute('data-bot', PERSON_BOTS[index].type)
        await expect.poll(centerError).toBeLessThan(1)
      }
    }
    // Dragging selects the role under the center and must not click the original role on release.
    const beforeDrag = await selected.getAttribute('data-bot')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 - step * 1.2, bounds.y + 100, { steps: 8 })
    await page.mouse.up()
    await expect(selected).not.toHaveAttribute('data-bot', beforeDrag!)
    const stoppedLeft = await viewport.evaluate(el => el.scrollLeft)
    await page.waitForTimeout(300)
    expect(await viewport.evaluate(el => el.scrollLeft)).toBe(stoppedLeft)
    expect(await centerError()).toBeGreaterThan(10)
    const afterDrag = await selected.getAttribute('data-bot')
    await page.mouse.move(0, 0)
    await page.mouse.move(bounds.x + 20, bounds.y + 8)
    await expect(selected).toHaveAttribute('data-bot', afterDrag!)
    await selected.focus()
    await page.keyboard.press('End')
    await expect.poll(centerError).toBeLessThan(1)
  })

  test(`Person creates the selected Bot role and restores its idle avatar after reload in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode, mode === 'dark', mode === 'dark')
    await page.setViewportSize({ width: 1440, height: 1050 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/#/person')
    await page.getByRole('button', { name: 'New BOT role', exact: true }).click()
    const picker = page.locator('.person-bot-picker')
    const viewport = picker.locator('.person-bot-viewport')
    const selected = picker.locator('.person-bot-option[aria-pressed="true"]')
    const centerError = () => viewport.evaluate(el => {
      const button = el.querySelector<HTMLElement>('[aria-pressed="true"]')!, slot = button.parentElement!
      return Math.abs(slot.offsetLeft + slot.offsetWidth / 2 - el.scrollLeft - el.clientWidth / 2)
    })
    await selected.focus()
    await page.keyboard.press('End')
    const party = picker.getByRole('button', { name: 'paidui', exact: true })
    await party.click()
    await expect(party).toHaveAttribute('aria-pressed', 'true')
    await expect(picker.getByRole('button', { name: 'zhezhe', exact: true })).toHaveAttribute('aria-pressed', 'false')
    await page.locator('.new-chat-page').getByRole('textbox', { name: 'BOT name' }).fill('Party companion')
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `/tmp/studio-bot-picker/carousel-${mode}-desktop.png`, animations: 'disabled' })
    await page.setViewportSize({ width: 1180, height: 800 })
    await expect(selected).toHaveAttribute('data-bot', 'paidui')
    await expect.poll(centerError).toBeLessThan(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await party.hover()
    await expect(party.locator('img')).toHaveAttribute('src', '/person/paidui/idle.png')
    await page.locator('.new-chat-page .input-textarea').fill('Hello party')
    await page.locator('.new-chat-page').getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.person-title')).toHaveText('Party companion')
    expect(state.conversations.find((session: any) => session.title === 'Party companion').bot_type).toBe('paidui')
    expect(operations.filter(op => op.path.endsWith('/conversations') && op.body).at(-1).body.bot_type).toBe('paidui')
    // Page-local resume fixtures disappear on reload. Confirm empty history for
    // the created conversation before expecting its empty-state character.
    const created = state.conversations.find((session: any) => session.title === 'Party companion')
    await page.addInitScript(sessionId => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__ = {
        ...(window as any).__PW_CHAT_SOCKET_RESUMES__,
        [sessionId]: { session_id: sessionId, messages: [], messageTotal: 0, isWorking: false, events: [] },
      }
    }, created.id)
    await page.reload()
    await expect(page.locator('.empty-logo--person')).toHaveAttribute('alt', 'paidui')
    await expect(page.locator('.empty-logo--person')).toHaveAttribute('src', '/person/paidui/idle.png')
  })

  test(`Person swipes looping Bot characters by touch without cards or page overflow in ${mode}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
    const mobile = await context.newPage()
    try {
      const { state } = await setup(mobile, mode, mode === 'dark', mode === 'dark')
      state.conversations = []
      await mobile.goto('/#/person')
      const picker = mobile.locator('.person-bot-picker')
      const viewport = picker.locator('.person-bot-viewport')
      const selected = picker.locator('.person-bot-option[aria-pressed="true"]')
      await expect(selected).toHaveAttribute('data-bot', 'zhezhe')
      await expect.poll(() => selected.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
      await expect(mobile.locator('.page-loading-overlay:visible')).toHaveCount(0)
      const bounds = (await viewport.boundingBox())!
      const session = await context.newCDPSession(mobile)
      const x = bounds.x + bounds.width * .75, y = bounds.y + 100
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      for (let i = 1; i <= 12; i++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - bounds.width * .5 * i / 12, y }] })
        await mobile.waitForTimeout(16)
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(selected).not.toHaveAttribute('data-bot', 'zhezhe')
      async function settleSwipe() {
        let previousLeft = -Infinity, stable = 0
        await expect.poll(async () => {
          const left = await viewport.evaluate(el => el.scrollLeft)
          stable = Math.abs(left - previousLeft) < .5 ? stable + 1 : 0
          previousLeft = left
          return stable
        }, { intervals: [100] }).toBeGreaterThanOrEqual(3)
        await expectPersonBotHit(mobile, viewport)
      }
      await settleSwipe()
      for (const direction of [1, -1]) {
        const startX = bounds.x + bounds.width * (direction === 1 ? .8 : .2)
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y }] })
        for (let i = 1; i <= 4; i++) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: startX - direction * bounds.width * .65 * i / 4, y }] })
          await mobile.waitForTimeout(8)
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await settleSwipe()
      }
      const next = await picker.locator('.person-bot-option').evaluateAll(buttons => buttons.findIndex(el => el.getAttribute('aria-pressed') === 'true') + 1)
      const neighbor = picker.locator('.person-bot-option').nth(next)
      const botType = await neighbor.getAttribute('data-bot')
      await neighbor.tap()
      await expect(selected).toHaveAttribute('data-bot', botType!)
      await expect(selected.locator('img')).toHaveAttribute('src', PERSON_BOTS.find(bot => bot.type === botType)!.animations.idle)
      await mobile.getByRole('textbox', { name: 'BOT name' }).tap()
      await mobile.getByRole('textbox', { name: 'BOT name' }).fill('Music companion')
      expect(await picker.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await mobile.screenshot({ path: `/tmp/studio-bot-picker/carousel-${mode}-mobile.png`, animations: 'disabled' })
    } finally { await context.close() }
  })

  test(`Person creates named conversations, switches and deletes only the selected conversation in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode, true, true)
    state.tasks[0].running = false; state.tasks[0].execution_state = 'finished'
    await page.goto('/#/person')
    await expect(page.locator('.person-title')).toHaveText('Person')
    await page.getByRole('button', { name: 'New BOT role', exact: true }).click()
    const draft = page.locator('.new-chat-page')
    await expect(draft.getByRole('button', { name: 'zhezhe', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(draft.getByRole('heading', { name: 'New BOT role', exact: true })).toBeVisible()
    await expect(draft.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: `/tmp/person-new-chat-${mode}-desktop.png`, animations: 'disabled' })
    await draft.getByRole('textbox', { name: 'BOT name' }).fill('旅行计划')
    await draft.locator('.input-textarea').fill('Hello BOT')
    await draft.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.person-title')).toHaveText('旅行计划')
    const created = state.conversations.find((session: any) => session.title === '旅行计划')
    expect(created.id).not.toBe(state.session.id)
    await expect(page).toHaveURL(new RegExp(`session=${created.id}`))
    await expect(draft).not.toBeVisible()
    expect(created.bot_type).toBe('zhezhe')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    await page.screenshot({ path: `/tmp/person-multi-session-${mode}.png`, animations: 'disabled' })
    await page.locator('.person-sidebar .session-item').filter({ hasText: 'Person' }).click()
    await expect(page.locator('.person-title')).toHaveText('Person')
    const row = page.locator('.person-sidebar .session-item').filter({ hasText: '旅行计划' })
    await row.hover(); await row.locator('.session-item-delete').click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(page.locator('.person-title')).toHaveText('Person')
    expect(state.tasks.map((task: any) => task.id)).toEqual(['task1'])
    expect(operations.some(operation => operation.path.endsWith(`/conversations/${created.id}`))).toBe(true)
  })
}

for (const locale of ['en', 'zh'] as const) for (const mobile of [false, true]) {
  test(`Person fills the hit character name and deploys its transparent done animation (${locale}, ${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(String(error)))
    const { state, operations } = await setup(page, mobile ? 'dark' : 'light', mobile, mobile)
    state.conversations = []
    await page.addInitScript(locale => localStorage.setItem('hermes_locale', locale), locale)
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
    await page.goto('/#/person')
    await expect(page.locator('.page-loading-overlay:visible')).toHaveCount(0)
    const name = page.locator('#person-conversation-name')
    await expect(name).toHaveValue(locale === 'zh' ? '折折' : 'zhezhe')
    const picker = page.locator('.person-bot-picker')
    await expect(picker.getByRole('button', { name: locale === 'zh' ? '折折' : 'zhezhe', exact: true })).toBeVisible()
    const viewport = picker.locator('.person-bot-viewport')
    const step = await viewport.evaluate(el => {
      const slots = el.querySelectorAll<HTMLElement>('.person-bot-slot')
      return slots[1].offsetLeft - slots[0].offsetLeft
    })
    await viewport.hover()
    await page.mouse.wheel(-step, 0)
    const selected = picker.locator('[aria-pressed="true"]')
    await expect(selected).toHaveAttribute('data-bot', 'paidui')
    await expect(name).toHaveValue(locale === 'zh' ? '派对' : 'paidui')
    await expect.poll(() => selected.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    // Follow the same summoning and landing lifecycle as ordinary single chat.
    await page.evaluate(() => {
      const state = { frames: [] as any[], until: performance.now() + 5000 }
      ;(window as any).personDeploymentFrames = state
      const sample = () => {
        const overlay = document.querySelector<HTMLElement>('.agent-deployment-overlay')
        const hero = overlay?.querySelector<HTMLElement>('.agent-deployment-hero')
        const target = document.querySelector<HTMLElement>('[data-agent-deployment-target]:not([data-agent-deployment-target=""])')
        if (hero && target) {
          const h = hero.getBoundingClientRect(), t = target.getBoundingClientRect()
          state.frames.push({ phase: overlay!.dataset.phase, opacity: hero.style.opacity, targetOpacity: target.style.opacity,
            dx: h.x + h.width / 2 - t.x - t.width / 2, dy: h.y + h.height / 2 - t.y - t.height / 2,
            height: h.height, targetHeight: t.height })
        }
        if (performance.now() < state.until) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })
    await page.locator('.new-chat-page .input-textarea').fill('Hello from the selected character')
    await page.locator('.new-chat-page').getByRole('button', { name: 'Send', exact: true }).click()
    const overlay = page.locator('.agent-deployment-overlay')
    await expect(overlay).toHaveCount(1)
    await expect(overlay.locator('img.agent-deployment-card-face')).toHaveAttribute('src', '/person/paidui/done.gif')
    await expect.poll(() => overlay.locator('img.agent-deployment-card-face').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
    await expect(overlay.locator('img.agent-deployment-card-face')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(overlay.locator('.agent-card')).toHaveCount(0)
    const created = state.conversations.find((session: any) => session.bot_type === 'paidui')
    await expect(page).toHaveURL(new RegExp(`session=${created.id}`))
    const target = page.locator(`[data-agent-deployment-target="${created.id}"]`)
    await expect(target).toHaveAttribute('src', '/person/paidui/thinking.gif')
    await expect(target).toHaveAttribute('data-agent-deployment-image', 'ready')
    await page.waitForTimeout(650)
    await page.screenshot({ path: `/tmp/studio-bot-picker/deployment-${locale}-${mobile ? 'mobile' : 'desktop'}.png` })
    await expect(overlay).toHaveCount(0, { timeout: 5000 })
    const frames = await page.evaluate(() => (window as any).personDeploymentFrames.frames)
    expect(frames.some((frame: any) => frame.phase === 'landing' && frame.targetOpacity === '0')).toBe(true)
    const landed = frames.find((frame: any) => frame.phase === 'landing' && frame.targetOpacity !== '0' && frame.opacity === '1')
    expect(landed, JSON.stringify(frames.slice(-10))).toBeDefined()
    expect(Math.abs(landed.dx)).toBeLessThan(1)
    expect(Math.abs(landed.dy)).toBeLessThan(1)
    expect(Math.abs(landed.height - landed.targetHeight)).toBeLessThan(1)
    expect(await target.evaluate(el => (el as HTMLElement).style.opacity)).toBe('')
    expect(operations.filter(op => op.path.endsWith('/conversations') && op.body)).toHaveLength(1)
    await expect.poll(() => emitted(page, 'run')).toEqual([expect.objectContaining({ session_id: created.id, input: 'Hello from the selected character' })])
    expect(errors).toEqual([])
  })
}

test('Person drafts its name, model and first message without changing the current conversation, and retries a failed create', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  state.tasks[0].running = false; state.tasks[0].execution_state = 'finished'
  await page.goto('/#/person')
  await expect(page.locator('.person-title')).toHaveText('Person')
  await page.locator('.person-compose .input-textarea').fill('Keep the current draft')
  await page.getByRole('button', { name: 'New BOT role', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  await draft.locator('.input-textarea').fill('Plan my trip')
  await expect(draft.getByRole('textbox', { name: 'BOT name' })).toHaveValue('zhezhe')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await draft.getByRole('textbox', { name: 'BOT name' }).fill('')
  await expect(draft.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await draft.getByRole('textbox', { name: 'BOT name' }).fill('旅行搭子')
  await expect(draft.getByPlaceholder('Enter BOT name')).toBeVisible()
  await draft.getByRole('textbox', { name: 'BOT name' }).press('Enter')
  expect(operations.filter(operation => operation.path.endsWith('/conversations') && operation.body)).toHaveLength(0)
  await draft.getByRole('button', { name: 'Workspace', exact: true }).click()
  const workspacePicker = page.getByRole('dialog')
  await workspacePicker.locator('.folder-path-input input').fill('/workspace/bot-draft')
  await workspacePicker.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(workspacePicker).toBeHidden()
  expect(state.settings.workspace).toBe('')
  await page.screenshot({ path: '/tmp/studio-bot-send-create/draft-light-desktop.png', animations: 'disabled' })
  await draft.locator('.input-model-button').click()
  await page.locator('.model-cascader:visible').getByRole('menuitemradio').filter({ hasText: 'fast-model' }).click()
  await expect(draft.locator('.input-model-button')).toHaveAttribute('aria-label', 'fast-model')
  expect(operations.some(operation => operation.path.endsWith('/settings'))).toBe(false)
  expect(state.session.model).toBe('global-model')
  state.failCreate = true
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('Creation unavailable', { exact: false })).toBeVisible()
  await expect(page.locator('.agent-deployment-overlay')).toHaveCount(0)
  await expect(draft.locator('.input-textarea')).toHaveValue('Plan my trip')
  await expect(draft.getByRole('textbox', { name: 'BOT name' })).toHaveValue('旅行搭子')
  expect(state.conversations).toHaveLength(1)
  state.failCreate = false
  await draft.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.person-title')).toHaveText('旅行搭子')
  const created = state.conversations.find((session: any) => session.title === '旅行搭子')
  const request = operations.find(operation => operation.path.endsWith('/conversations') && operation.body?.title === '旅行搭子')
  expect(request.body).toMatchObject({ bot_type: 'zhezhe', model: { profile: 'default', provider: 'provider', model: 'fast-model' }, workspace: '/workspace/bot-draft', expected_revision: 0 })
  expect(created.workspace).toBe('/workspace/bot-draft')
  await expect.poll(() => emitted(page, 'run')).toEqual([expect.objectContaining({ session_id: created.id, input: 'Plan my trip' })])
  await page.locator('.person-sidebar .session-item').filter({ hasText: 'Person' }).click()
  await expect(page.locator('.person-compose .input-textarea')).toHaveValue('Keep the current draft')
})

test('Person checks duplicate BOT names only on send and keeps the first message for correction', async ({ page }) => {
  const { state, operations } = await setup(page, 'dark', true, true)
  state.conversations.push({ ...state.session, id: 'person-main-default-bot', title: 'zhezhe' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await page.getByRole('button', { name: 'New BOT role', exact: true }).click()
  const draft = page.locator('.new-chat-page')
  const name = draft.getByRole('textbox', { name: 'BOT name' })
  const send = draft.getByRole('button', { name: 'Send', exact: true })
  await expect(name).toHaveValue('zhezhe')
  await expect(name).toHaveAttribute('aria-invalid', 'false')
  await expect(draft.getByRole('alert')).toHaveCount(0)
  await draft.locator('.input-textarea').fill('Keep this first message')
  await name.fill(' ＰＥＲＳＯＮ ')
  await expect(name).toHaveAttribute('aria-invalid', 'false')
  await expect(draft.getByRole('alert')).toHaveCount(0)
  await expect(send).toBeEnabled()
  expect(operations.filter(operation => operation.path.endsWith('/conversations') && operation.body)).toHaveLength(0)
  await send.click()
  await expect(name).toHaveAttribute('aria-invalid', 'true')
  await expect(draft.getByRole('alert')).toContainText('already exists')
  await expect(send).toBeEnabled()
  expect(operations.filter(operation => operation.path.endsWith('/conversations') && operation.body)).toHaveLength(1)
  await send.click()
  await expect(draft.getByRole('alert')).toContainText('already exists')
  await expect(send).toBeEnabled()
  expect(operations.filter(operation => operation.path.endsWith('/conversations') && operation.body)).toHaveLength(2)
  state.conflictingBotName = 'Unlisted BOT'
  await name.fill('Unlisted BOT')
  await expect(draft.getByRole('alert')).toHaveCount(0)
  await send.click()
  await expect(draft.getByRole('alert')).toContainText('already exists')
  await expect(draft.locator('.input-textarea')).toHaveValue('Keep this first message')
  await expect(send).toBeEnabled()
  await page.screenshot({ path: '/tmp/studio-bot-send-create/duplicate-dark-mobile.png', animations: 'disabled' })
  await name.fill('New helper')
  await expect(draft.getByRole('alert')).toHaveCount(0)
  await send.evaluate(button => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await expect(page.locator('.person-title')).toHaveText('New helper')
  expect(state.conversations.filter((session: any) => session.title === 'New helper')).toHaveLength(1)
  expect(operations.filter(operation => operation.path.endsWith('/conversations') && operation.body?.title === 'New helper')).toHaveLength(1)
  await expect.poll(() => emitted(page, 'run')).toEqual([expect.objectContaining({ input: 'Keep this first message' })])
})

async function longPressConversation(page: Page, row: Locator) {
  await row.tap({ trial: true })
  const box = (await row.boundingBox())!
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
    await expect(page.locator('.n-dropdown-option:visible').filter({ hasText: /^Rename$/ })).toBeVisible()
  } finally {
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await client.detach()
  }
}

test.describe('Person mobile conversation actions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  for (const mode of ['light', 'dark'] as const) {
    test(`long-presses to rename and delete the target conversation in ${mode}`, async ({ page }) => {
      const { state, operations } = await setup(page, mode, mode === 'dark', true)
      const other = { ...state.session, id: 'person-main-travel', title: '旅行计划' }
      state.conversations.push(other)
      state.tasks.push({ ...state.tasks[0], id: 'travel-task', session_id: other.id, running: false, execution_state: 'finished' })
      state.schedules.push({ id: 'travel-schedule', task_id: 'travel-task' })
      await page.addInitScript(id => {
        (window as any).__PW_CHAT_SOCKET_RESUMES__[id] = { session_id: id, messages: [], isWorking: false, events: [] }
      }, other.id)
      await page.goto('/#/person')
      await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
      const sidebar = page.locator('.person-sidebar')
      const menu = page.locator('.n-dropdown-option:visible')
      const openSidebar = () => page.getByRole('button', { name: 'Menu', exact: true }).click()
      await openSidebar()
      await expect(sidebar.locator('.session-item-delete')).toHaveCount(0)
      await sidebar.locator('.session-item').filter({ hasText: other.title }).tap()
      await expect(page.locator('.person-title')).toHaveText(other.title)
      await expect(page.locator('.studio-mobile-drawer')).toBeHidden()
      await openSidebar()
      await sidebar.locator('.session-item').filter({ hasText: 'Person' }).tap()
      await expect(page.locator('.person-title')).toHaveText('Person')
      await openSidebar()
      await longPressConversation(page, sidebar.locator('.session-item').filter({ hasText: other.title }))
      await expect(page.locator('.studio-mobile-drawer')).toBeVisible()
      await expect(page).toHaveURL(/session=person-main-1$/)
      await expect(menu).toHaveText(['Rename', 'Delete', 'Batch selection'])
      await expect(menu.last()).toBeInViewport()
      await page.screenshot({ path: `/tmp/person-session-touch-menu-${mode}.png`, animations: 'disabled' })
      await menu.filter({ hasText: /^Rename$/ }).click()
      const naming = page.getByRole('dialog').filter({ hasText: 'Rename Session' })
      await expect(page.locator('.studio-mobile-drawer')).toBeHidden()
      await expect(naming.getByRole('textbox', { name: 'Conversation name' })).toHaveValue('旅行计划')
      await naming.getByRole('textbox').fill('   ')
      await expect(naming.getByRole('button', { name: 'OK', exact: true })).toBeDisabled()
      await naming.getByRole('textbox').fill('研究计划')
      await page.screenshot({ path: `/tmp/person-session-touch-rename-${mode}.png`, animations: 'disabled' })
      await naming.getByRole('textbox').press('Enter')
      await expect(naming).toBeHidden()
      await expect(page.locator('.person-title')).toHaveText('Person')
      expect(operations.filter(op => op.path.endsWith('/rename')).map(op => [op.path, op.body.title]))
        .toEqual([['/api/studio/sessions/person-main-travel/rename', '研究计划']])
      await page.reload()
      await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
      await openSidebar()
      const renamed = sidebar.locator('.session-item').filter({ hasText: '研究计划' })
      await expect(renamed).toBeVisible()
      await longPressConversation(page, renamed)
      await menu.filter({ hasText: /^Delete$/ }).click()
      const confirmation = page.getByRole('dialog').filter({ hasText: 'Delete this session?' })
      await expect(confirmation).toBeVisible()
      await expect(confirmation).toContainText('tasks')
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click({ trial: true })
      await confirmation.screenshot({ path: `/tmp/person-session-touch-delete-${mode}.png`, animations: 'disabled' })
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(state.conversations).toHaveLength(2)
      expect(operations.some(op => op.path.endsWith('/conversations/person-main-travel'))).toBe(false)
      await openSidebar()
      await longPressConversation(page, renamed)
      await menu.filter({ hasText: /^Delete$/ }).click()
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(page.locator('.person-title')).toHaveText('Person')
      expect(state.tasks.map((task: any) => task.id)).toEqual(['task1'])
      expect(state.schedules).toHaveLength(0)
      await openSidebar()
      await expect(renamed).toHaveCount(0)
      await longPressConversation(page, sidebar.locator('.session-item'))
      await menu.filter({ hasText: /^Rename$/ }).click()
      await naming.getByRole('textbox').fill('工作安排')
      await naming.getByRole('button', { name: 'OK', exact: true }).click()
      await expect(page.locator('.person-title')).toHaveText('工作安排')
      await expect(page).toHaveURL(/session=person-main-1$/)
      await openSidebar()
      await longPressConversation(page, sidebar.locator('.session-item'))
      await menu.filter({ hasText: /^Delete$/ }).click()
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(page.locator('.new-chat-page')).toBeVisible()
      expect(state.conversations).toHaveLength(0)
      expect(state.tasks).toHaveLength(0)
      await page.getByRole('textbox', { name: 'BOT name' }).fill('新会话')
      await page.locator('.new-chat-page .input-textarea').fill('Hello BOT')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      await expect(page.locator('.person-title')).toHaveText('新会话')
      expect(operations.filter(op => op.path === '/api/studio/person/conversations' && op.body?.title)).toHaveLength(1)
    })
  }
})

for (const deletion of ['single', 'batch'] as const) {
  test(`Person returns to BOT creation without stale-session errors after ${deletion} deletion`, async ({ page }) => {
    const { state } = await setup(page, 'light', false, false)
    let releaseDeletion!: () => void
    const deleting = new Promise<void>(resolve => { releaseDeletion = resolve })
    state.afterDelete = () => deleting
    const staleRequests: string[] = []
    await page.route(/\/api\/studio\/person\?session_id=/, route => {
      if (!state.conversations.length) staleRequests.push(route.request().url())
      return route.fallback()
    })
    await page.goto('/#/person')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    const sidebar = page.locator('.person-sidebar')
    if (deletion === 'single') {
      await sidebar.locator('.session-item').hover()
      await sidebar.locator('.session-item-delete').click()
    } else {
      await sidebar.getByRole('button', { name: 'Session list actions', exact: true }).click()
      await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Batch selection$/ }).click()
      const toolbar = sidebar.locator('.session-list-toolbar')
      await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
      await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
    }
    await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
    try {
      // The socket notification arrives before the deletion response, as on the server.
      await expect(sidebar.locator('.session-item')).toHaveCount(0)
      expect(staleRequests).toEqual([])
    } finally { releaseDeletion() }
    await expect(page.locator('.new-chat-page')).toBeVisible()
    await expect(page).toHaveURL(/#\/person$/)
    await expect(page.locator('.person-alert')).toHaveCount(0)
    await page.getByRole('textbox', { name: 'BOT name' }).fill('Replacement BOT')
    await page.locator('.new-chat-page .input-textarea').fill('Hello again')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.locator('.person-title')).toHaveText('Replacement BOT')
    expect(state.conversations).toHaveLength(1)
    await expect(page.locator('.person-alert')).toHaveCount(0)
  })
}

for (const status of [404, 503]) {
  test(`Person ignores a delayed ${status} from a deleted BOT`, async ({ page }) => {
    const { state } = await setup(page, 'dark', true, false)
    await page.goto('/#/person')
    await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
    let releaseSnapshot!: () => void
    const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
    let intercepted = false
    await page.route(/\/api\/studio\/person\?session_id=person-main-1$/, async route => {
      if (intercepted) return route.fallback()
      intercepted = true
      await snapshot
      return route.fulfill({ status, json: { error: status === 404 ? 'Session not found' : 'Temporarily unavailable' } })
    })
    await emit(page, 'person.updated', {})
    await expect.poll(() => intercepted).toBe(true)
    try {
      const row = page.locator('.person-sidebar .session-item')
      await row.hover()
      await row.locator('.session-item-delete').click()
      await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(page).toHaveURL(/#\/person$/)
      expect(state.conversations).toHaveLength(0)
    } finally { releaseSnapshot() }
    await expect(page.locator('.new-chat-page')).toBeVisible()
    await expect(page.locator('.person-alert')).toHaveCount(0)
  })
}

test('Person recovers a deleted BOT link without displaying an API error', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  state.conversations = []
  await page.goto('/#/person?session=person-main-deleted')
  await expect(page.locator('.new-chat-page')).toBeVisible()
  await expect(page).toHaveURL(/#\/person$/)
  await expect(page.locator('.person-alert')).toHaveCount(0)
})

test('Person keeps the newly selected BOT when an old snapshot returns 404', async ({ page }) => {
  const { state } = await setup(page, 'light', false, false)
  const other = { ...state.session, id: 'person-main-other', title: 'Other BOT' }
  state.conversations.push(other)
  await page.addInitScript(id => {
    (window as any).__PW_CHAT_SOCKET_RESUMES__[id] = { session_id: id, messages: [], isWorking: false, events: [] }
  }, other.id)
  await page.goto('/#/person')
  await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
  let releaseSnapshot!: () => void
  const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve })
  let intercepted = false
  await page.route(/\/api\/studio\/person\?session_id=person-main-1$/, async route => {
    intercepted = true
    await snapshot
    return route.fulfill({ status: 404, json: { error: 'Session not found' } })
  })
  await emit(page, 'person.updated', {})
  await expect.poll(() => intercepted).toBe(true)
  try {
    await page.locator('.person-sidebar .session-item').filter({ hasText: other.title }).click()
    await expect(page).toHaveURL(/session=person-main-other$/)
  } finally { releaseSnapshot() }
  await expect(page.locator('.person-title')).toHaveText(other.title)
  await expect(page).toHaveURL(/session=person-main-other$/)
  await expect(page.locator('.person-alert')).toHaveCount(0)
})

test.describe('Person batch conversation deletion', () => {
  test.use({ hasTouch: true })
  for (const [width, mode] of [[1440, 'light'], [390, 'dark']] as const) {
    test(`selects conversations, preserves failures and retries deletion at ${width}px in ${mode}`, async ({ page }) => {
      const { state, operations } = await setup(page, mode, mode === 'dark', true)
      const second = { ...state.session, id: 'person-main-second', title: '第二个会话' }
      const third = { ...state.session, id: 'person-main-third', title: '第三个会话' }
      state.conversations.push(second, third)
      state.tasks.push(...[second, third].map(session => ({ ...state.tasks[0], id: session.id, session_id: session.id })))
      state.schedules.push(...[second, third].map(session => ({ id: session.id, task_id: session.id })))
      state.failBatchRequest = true
      state.batchFailedIds = [third.id]
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/#/person')
      await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
      if (width < 769) await page.getByRole('button', { name: 'Menu', exact: true }).click()
      const sidebar = page.locator('.person-sidebar')
      const toolbar = sidebar.locator('.session-list-toolbar')
      const rows = sidebar.locator('.session-item')
      const batchRequests = () => operations.filter(op => op.path === '/api/studio/sessions/batch-delete')
      await sidebar.getByRole('button', { name: 'Session list actions', exact: true }).click()
      await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Batch selection$/ }).click()
      await expect(toolbar).toContainText('0 selected')
      await toolbar.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(toolbar).toHaveCount(0)
      if (width < 769) {
        await longPressConversation(page, rows.filter({ hasText: second.title }))
        await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Batch selection$/ }).click()
        await expect(toolbar).toContainText('1 selected')
        await rows.filter({ hasText: third.title }).click()
      } else {
        await sidebar.getByRole('button', { name: 'Session list actions', exact: true }).click()
        await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Batch selection$/ }).click()
        await rows.filter({ hasText: second.title }).getByRole('checkbox').click()
        await rows.filter({ hasText: third.title }).click()
      }
      await expect(toolbar).toContainText('2 selected')
      await expect(page).toHaveURL(/session=person-main-1$/)
      await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
      const confirmation = page.locator('.n-popconfirm')
      await expect(confirmation).toContainText('Delete 2 selected sessions?')
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(batchRequests()).toHaveLength(0)
      await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
      await expect(toolbar).toContainText('3 selected')
      await rows.filter({ hasText: 'Person' }).click()
      await expect(toolbar).toContainText('2 selected')
      await page.screenshot({ path: `/tmp/person-session-batch-${width}.png`, animations: 'disabled' })
      await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(page.getByText('Batch delete failed', { exact: true })).toBeVisible()
      await expect(toolbar).toContainText('2 selected')
      expect(state.conversations).toHaveLength(3)
      state.failBatchRequest = false
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(toolbar).toContainText('1 selected')
      await expect(rows.filter({ hasText: second.title })).toHaveCount(0)
      await expect(rows.filter({ hasText: third.title }).getByRole('checkbox')).toBeChecked()
      expect(state.tasks.map((task: any) => task.session_id)).toEqual(['person-main-1', third.id])
      expect(state.schedules.map((schedule: any) => schedule.task_id)).toEqual([third.id])
      expect(batchRequests().map(op => op.body.ids)).toEqual([[second.id, third.id], [second.id, third.id]])
      await page.screenshot({ path: `/tmp/person-session-batch-retry-${width}.png`, animations: 'disabled' })
      state.batchFailedIds = []
      await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(toolbar).toHaveCount(0)
      await expect(rows).toHaveCount(1)
      await sidebar.getByRole('button', { name: 'Session list actions', exact: true }).click()
      await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Batch selection$/ }).click()
      await toolbar.getByRole('button', { name: 'Select all', exact: true }).click()
      await toolbar.getByRole('button', { name: 'Delete', exact: true }).click()
      await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(page.locator('.new-chat-page')).toBeAttached()
      expect(state.conversations).toHaveLength(0)
      expect(state.tasks).toHaveLength(0)
      expect(state.schedules).toHaveLength(0)
      expect(batchRequests().map(op => op.body.ids)).toEqual([[second.id, third.id], [second.id, third.id], [third.id], ['person-main-1']])
    })
  }
})

for (const hasTouch of [false, true]) {
  test.describe(`Person desktop delete controls with touch=${hasTouch}`, () => {
    test.use({ hasTouch, viewport: { width: 1440, height: 900 } })
    test('shows delete only for mouse hover or keyboard focus and allows deleting the last current conversation', async ({ page }) => {
      const { state } = await setup(page, hasTouch ? 'dark' : 'light', hasTouch, false)
      const other = { ...state.session, id: 'person-main-travel', title: '旅行计划' }
      state.conversations.push(other)
      await page.addInitScript(id => {
        (window as any).__PW_CHAT_SOCKET_RESUMES__[id] = { session_id: id, messages: [], isWorking: false, events: [] }
      }, other.id)
      await page.goto('/#/person')
      await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
      const row = page.locator('.person-sidebar .session-item').filter({ hasText: other.title })
      const remove = row.locator('.session-item-delete')
      await page.mouse.move(1200, 600)
      await expect(remove).toHaveCSS('opacity', '0')
      await expect(remove).toHaveCSS('pointer-events', 'none')
      await row.hover()
      await expect(remove).toHaveCSS('opacity', '1')
      await row.click()
      await expect(page.locator('.person-title')).toHaveText(other.title)
      await page.mouse.move(1200, 600)
      await expect(remove).toHaveCSS('opacity', '0')
      await page.screenshot({ path: `/tmp/person-session-pc-delete-hidden-${hasTouch}.png`, animations: 'disabled' })
      await row.press('Tab')
      await expect(remove).toBeFocused()
      await expect(remove).toHaveCSS('opacity', '1')
      await page.locator('.person-compose .input-textarea').click()
      await expect(remove).toHaveCSS('opacity', '0')
      await page.locator('.person-sidebar .session-item').filter({ hasText: 'Person' }).click({ button: 'right' })
      await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Delete$/ }).click()
      await page.getByRole('dialog').filter({ hasText: 'Delete this session?' }).getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(page.locator('.person-sidebar .session-item')).toHaveCount(1)
      await row.hover()
      await expect(remove).toHaveCSS('opacity', '1')
      await remove.click()
      await page.locator('.n-popconfirm').getByRole('button', { name: 'Confirm', exact: true }).click()
      await expect(page.locator('.new-chat-page')).toBeVisible()
      await expect(page.locator('.person-sidebar .session-item')).toHaveCount(0)
    })
  })
}

test('Person preserves rename and delete targets on failure and retries from the desktop context menu', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', true, true)
  const other = { ...state.session, id: 'person-main-travel', title: '旅行计划' }
  state.conversations.push(other)
  state.failRename = true; state.failDelete = true
  await page.goto('/#/person')
  await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
  const row = page.locator('.person-sidebar .session-item').filter({ hasText: other.title })
  await row.hover()
  await expect(row.locator('.session-item-delete')).toBeVisible()
  await row.click({ button: 'right' })
  await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Rename$/ }).click()
  const naming = page.getByRole('dialog').filter({ hasText: 'Rename Session' })
  await naming.getByRole('textbox').fill('重命名后')
  await naming.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(naming.locator('.n-alert')).toContainText('Rename failed')
  await expect(naming.getByRole('textbox')).toHaveValue('重命名后')
  expect(other.title).toBe('旅行计划')
  state.failRename = false
  await naming.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(naming).toBeHidden()
  const renamed = page.locator('.person-sidebar .session-item').filter({ hasText: '重命名后' })
  await renamed.click({ button: 'right' })
  await page.locator('.n-dropdown-option:visible').filter({ hasText: /^Delete$/ }).click()
  const confirmation = page.getByRole('dialog').filter({ hasText: 'Delete this session?' })
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(confirmation.locator('.n-alert')).toContainText('Conversation changed')
  await expect(renamed).toHaveCount(1)
  state.failDelete = false
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
  await expect(confirmation).toBeHidden()
  await expect(renamed).toHaveCount(0)
  await expect(page.locator('.person-title')).toHaveText('Person')
  expect(operations.filter(op => op.path.endsWith('/rename'))).toHaveLength(2)
  expect(operations.filter(op => op.path.endsWith('/conversations/person-main-travel'))).toHaveLength(2)
})

test('Person search uses the shared search dialog and only requests assistant conversation content', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false, false)
  const other = { ...state.session, id: 'person-main-travel', title: '旅行' }
  state.conversations.push(other)
  state.conversationMessages[other.id] = [{ role: 'user', content: 'JAPAN-RECEIPT-73' }]
  await page.goto('/#/person')
  await expect(page.locator('.person-title')).toBeVisible()
  await page.locator('.person-sidebar').getByRole('button', { name: 'Search', exact: true }).click()
  const search = page.locator('.session-search-modal')
  await expect(search.getByText('Search personal assistant conversations only.')).toBeVisible()
  await search.locator('input').fill('JAPAN-RECEIPT-73')
  await expect(search.locator('.result-item')).toHaveCount(1)
  await search.locator('.result-item').click()
  await expect(page.locator('.person-title')).toHaveText('旅行')
  expect(operations.filter(operation => operation.path.endsWith('/conversations')).length).toBeGreaterThan(1)
})

for (const [mode, wallpaper] of [['light', false], ['dark', true]] as const) {
test(`Person uses the same desktop and mobile sidebar layout as single chat in ${mode}`, async ({ page }) => {
  const { state } = await setup(page, mode, wallpaper, false)
  state.session.title = '旅行计划与工作安排：需要保持时间完整显示的长会话名称'
  async function expectSingleLineSession() {
    const row = page.locator('.person-sidebar .session-item')
    const layout = await row.evaluate(el => {
      const avatar = el.querySelector('.session-item-agent-logo')!.getBoundingClientRect()
      const title = el.querySelector<HTMLElement>('.session-item-title')!
      const name = title.getBoundingClientRect()
      const time = el.querySelector('.session-item-time')!.getBoundingClientRect()
      return {
        avatarBeforeName: avatar.right < name.left,
        nameBeforeTime: name.right < time.left,
        avatarCenter: avatar.y + avatar.height / 2,
        nameCenter: name.y + name.height / 2,
        timeCenter: time.y + time.height / 2,
        nameTruncated: title.scrollWidth > title.clientWidth,
        fitsRow: time.right <= el.getBoundingClientRect().right && el.scrollWidth <= el.clientWidth,
      }
    })
    expect(layout.avatarBeforeName).toBe(true)
    expect(layout.nameBeforeTime).toBe(true)
    expect(Math.abs(layout.avatarCenter - layout.nameCenter)).toBeLessThan(1)
    expect(Math.abs(layout.avatarCenter - layout.timeCenter)).toBeLessThan(1)
    expect(layout.nameTruncated).toBe(true)
    expect(layout.fitsRow).toBe(true)
    await expect(row.locator('.session-item-time')).not.toBeEmpty()
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/hermes/chat')
  const chatSidebar = page.locator('.chat-panel > .session-list')
  await expect(chatSidebar.locator('.page-sidebar-top')).toBeVisible()
  const chatTitleX = (await page.locator('.studio-page-header .header-session-title').boundingBox())!.x
  const desktop = await chatSidebar.evaluate(el => ({
    width: el.getBoundingClientRect().width,
    headerPadding: getComputedStyle(el.querySelector('.page-sidebar-top')!).padding,
    listPadding: getComputedStyle(el.querySelector('.session-items')!).padding,
    background: getComputedStyle(el).backgroundColor,
  }))
  await page.screenshot({ path: `/tmp/sidebar-single-chat-desktop-${mode}.png`, animations: 'disabled' })
  await page.getByRole('link', { name: 'Your account assistant', exact: true }).click()
  const sidebar = page.locator('.person-sidebar')
  await expect(sidebar.locator('.session-item')).toBeVisible()
  await expect(page.locator('.person-compose .input-textarea')).toBeVisible()
  const person = await sidebar.evaluate(el => ({
    width: el.getBoundingClientRect().width,
    headerPadding: getComputedStyle(el.querySelector('.page-sidebar-top')!).padding,
    listPadding: getComputedStyle(el.querySelector('.session-items')!).padding,
    background: getComputedStyle(el).backgroundColor,
  }))
  await expectSingleLineSession()
  await page.screenshot({ path: `/tmp/sidebar-person-desktop-${mode}.png`, animations: 'disabled' })
  expect(person).toEqual(desktop)
  expect((await page.locator('.studio-page-header .person-title').boundingBox())!.x).toBe(chatTitleX)
  const toggle = page.getByRole('button', { name: 'Collapse menu', exact: true })
  await toggle.click()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(0)
  await expect(page.locator('.studio-page-header .header-sidebar-control')).toHaveAttribute('class', /--collapsed/)
  await page.getByRole('button', { name: 'Expand menu', exact: true }).click()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(desktop.width)
  await page.getByRole('separator', { name: 'Resize sidebar' }).focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(sidebar).toHaveCSS('width', `${desktop.width + 40}px`)
  await expect(page.locator('.header-sidebar-control')).toHaveCSS('width', `${desktop.width + 40}px`)
  await page.reload()
  await expect(sidebar).toHaveCSS('width', `${desktop.width + 40}px`)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const drawer = page.locator('.studio-mobile-drawer')
  await expect(drawer.locator('.person-sidebar .session-item')).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1)
  await expect(drawer).toHaveCSS('width', '351px')
  await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(65)
  await expect(page.locator('.page-sidebar-account-btn')).toHaveCount(1)
  await expectSingleLineSession()
  await page.screenshot({ path: `/tmp/sidebar-person-mobile-${mode}.png`, animations: 'disabled' })
  await sidebar.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(page.locator('.session-search-modal')).toBeVisible()
  await expect(drawer).not.toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await drawer.getByRole('link', { name: 'Chat', exact: true }).click()
  await expect(drawer.locator('.session-list .session-items')).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1)
  await page.screenshot({ path: `/tmp/sidebar-single-chat-mobile-${mode}.png`, animations: 'disabled' })
  await drawer.getByRole('link', { name: 'Your account assistant', exact: true }).click()
  await expect(drawer.locator('.person-sidebar .session-item')).toBeVisible()
  await expect(drawer).toBeVisible()
  await sidebar.getByRole('button', { name: 'New BOT role', exact: true }).click()
  await expect(drawer).not.toBeVisible()
  await expect(page.locator('.new-chat-page')).toBeVisible()
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  await drawer.locator('.person-sidebar .session-item').click()
  await expect(drawer).not.toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(sidebar).toHaveCSS('width', `${desktop.width + 40}px`)
  await expect(page.locator('.page-sidebar-account-btn')).toHaveCount(1)
})
}

for (const mode of ['light', 'dark'] as const) {
  test(`Person sidebar follows regional appearance and reset in ${mode}`, async ({ page }) => {
    await setup(page, mode, true, false)
    const sidebar = page.locator('.person-sidebar')
    async function open() { await page.goto('/#/person'); await expect(page.locator('.person-compose .input-textarea')).toBeVisible() }
    await open()
    const original = await sidebar.evaluate(el => getComputedStyle(el).backgroundColor)
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-global-backgroundColor').fill('#223344')
    await page.getByTestId('theme-global-opacity').fill('0.4')
    await page.getByTestId('theme-global-opacity').dispatchEvent('change')
    await open()
    await expect(sidebar).toHaveCSS('background-color', 'rgba(34, 51, 68, 0.4)')
    await page.goto('/#/hermes/theme')
    await page.getByTestId('theme-scope').selectOption('sidebar')
    await page.getByTestId('theme-sidebar-backgroundColor').fill('#336699')
    await page.getByTestId('theme-sidebar-opacity').fill('0')
    await page.getByTestId('theme-sidebar-opacity').dispatchEvent('change')
    await page.getByTestId('theme-sidebar-blur').fill('4')
    await page.getByTestId('theme-sidebar-blur').dispatchEvent('change')
    await open()
    await expect(sidebar).toHaveCSS('background-color', 'rgba(51, 102, 153, 0)')
    await expect(sidebar).toHaveCSS('opacity', '1')
    await expect(sidebar).toHaveCSS('backdrop-filter', /blur\(4px\)/)
    await page.screenshot({ path: `/tmp/sidebar-person-theme-${mode}.png`, animations: 'disabled' })
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Restore defaults', exact: true }).click()
    await open()
    await expect(sidebar).toHaveCSS('background-color', original)
    await page.goto('/#/hermes/theme')
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.goto('/#/hermes/chat')
    await expect(page.locator('.chat-panel > .session-list')).toBeVisible()
    const preset = await page.locator('.chat-panel > .session-list').evaluate(el => getComputedStyle(el).backgroundColor)
    await open()
    await expect(sidebar).toHaveCSS('background-color', preset)
  })
}

test('Person starts with the shared new conversation page and creates on mobile', async ({ page }) => {
  const { state } = await setup(page, 'dark', false, false)
  state.conversations = []; state.tasks = []
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/person')
  await expect(page.locator('.new-chat-page')).toBeVisible()
  await page.screenshot({ path: '/tmp/person-new-chat-dark-mobile.png', animations: 'disabled' })
  await page.getByRole('textbox', { name: 'BOT name' }).fill('移动会话')
  await page.locator('.new-chat-page .input-textarea').fill('Hello BOT')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.person-title')).toHaveText('移动会话')
  await expect(page.locator('.input-textarea')).toBeVisible()
  await page.screenshot({ path: '/tmp/person-multi-session-mobile.png', animations: 'disabled' })
})

for (const width of [1440, 390]) {
  test(`Person shows pure dialogue results and controls a flow without worker tasks at ${width}px`, async ({ page }) => {
    const { state, operations } = await setup(page, 'light', false, false)
    state.settings.agents=[]; state.tasks=[]
    state.flows=[{id:'flow1',title:'Idiom chain',goal:'Each role adds one idiom',state:'active',revision:0,current_position:1,error:'',stages:[
      {id:'stage1',session_id:'person-main-1',session_title:'First role',goal:'Start the chain',state:'completed',result_message_id:7,tasks:[]},
      {id:'stage2',session_id:'person-main-1',session_title:'Second role',goal:'Add an idiom',state:'active',result_message_id:null,tasks:[]},
    ]}]
    await page.setViewportSize({width,height:900})
    await page.goto('/#/person')
    await page.locator('.person-header-actions').getByRole('button',{name:'Settings',exact:true}).click()
    const drawer=page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab',{name:'Flows',exact:true}).click()
    await drawer.getByRole('button',{name:'Idiom chain',exact:true}).click()
    await expect(drawer.locator('.flow-card').getByText('First role',{exact:true})).toBeVisible()
    await expect(drawer.getByRole('button',{name:'View result',exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'Stop flow',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'Resume',exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'Resume',exact:true}).click()
    await expect(drawer.getByRole('button',{name:'Stop flow',exact:true})).toBeVisible()
    expect(operations.filter(op=>op.path.endsWith('/flows/apply')).map(op=>op.body.action)).toEqual(['stop','resume'])
    expect(operations.some(op=>op.path.endsWith('/tasks/apply'))).toBe(false)
    await page.screenshot({path:`/tmp/person-flow-${width}.png`,animations:'disabled'})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await drawer.getByRole('button',{name:'View result',exact:true}).click()
    await expect(page).toHaveURL(/session=person-main-1&message=7/)
    await expect(drawer).not.toBeVisible()
  })
}

for (const { width, mode } of [{ width:1440, mode:'light' }, { width:390, mode:'dark' }] as const) {
  test(`Person unlocks automatically after a collaboration failure and keeps its history in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page,mode,mode === 'dark',mode === 'dark')
    await page.setViewportSize({width,height:900})
    state.tasks=[];state.busy=true
    state.flows=[{id:'failed-flow',title:'Failure recovery',goal:'Work then review',state:'active',revision:0,current_position:0,error:'',stages:[
      {id:'failed-stage',position:0,group_position:0,session_id:'person-main-1',session_title:'Worker role',goal:'Prepare result',state:'active',result_message_id:null,tasks:[]},
      {id:'dependent-stage',position:1,group_position:1,session_id:'person-main-b',session_title:'Review role',goal:'Review result',state:'pending',result_message_id:null,tasks:[]},
    ]}]
    await page.addInitScript(() => {
      (window as any).__PW_CHAT_SOCKET_RESUMES__['person-main-1'].messages=[{id:1,role:'assistant',content:'Keep this conversation history',timestamp:1}]
    })
    await page.goto('/#/person')
    const broom=page.getByRole('button',{name:'Clear chat history and tasks',exact:true})
    await expect(broom).toBeDisabled()
    state.busy=false
    Object.assign(state.flows[0],{state:'failed',revision:1,error:'Provider unavailable'})
    Object.assign(state.flows[0].stages[0],{state:'failed',delivery_state:'failed',delivery_error:'Provider unavailable'})
    await emit(page,'person.updated',{})
    await expect(broom).toBeEnabled()
    await expect(page.getByText('Keep this conversation history',{exact:true})).toBeVisible()
    expect(operations.filter(op=>op.path.endsWith('/clear'))).toHaveLength(0)
    await page.locator('.person-header-actions').getByRole('button',{name:'Settings',exact:true}).click()
    const drawer=page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab',{name:'Flows',exact:true}).click()
    await drawer.locator('.flow-filters button').filter({hasText:'Failed'}).click()
    await drawer.getByRole('button',{name:'Failure recovery',exact:true}).click()
    await expect(drawer.getByText('Provider unavailable',{exact:true}).first()).toBeVisible()
    await expect(drawer.locator('.flow-overview')).toContainText('Needs attention')
    await expect(drawer.locator('.flow-role').filter({hasText:'Review role'})).toContainText('Waiting')
    await page.screenshot({path:`/tmp/person-flow-auto-unlock-${mode}.png`,animations:'disabled'})
    await drawer.getByRole('button',{name:'Resume',exact:true}).click()
    expect(operations.filter(op=>op.path.endsWith('/flows/apply')).map(op=>op.body.action)).toEqual(['resume'])
    expect(operations.filter(op=>op.path.endsWith('/clear'))).toHaveLength(0)
  })

  test(`Person displays parallel branches, waits for peers and opens their results in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page,mode,mode === 'dark',mode === 'dark')
    state.tasks=[]
    state.conversations.push({ ...state.session,id:'person-main-b',title:'Competitor researcher' },{ ...state.session,id:'person-main-c',title:'Needs researcher' })
    state.flows=[{ id:'parallel-flow',title:'Parallel research',goal:'Research independently, then write a combined proposal',state:'active',revision:0,current_position:0,error:'',stages:[
      { id:'a',position:0,group_position:0,session_id:'person-main-b',session_title:'Competitor researcher',goal:'Research competitor offerings',state:'completed',result_message_id:101,tasks:[] },
      { id:'b',position:1,group_position:0,session_id:'person-main-c',session_title:'Needs researcher',goal:'Analyze user needs',state:'active',result_message_id:null,tasks:[] },
      { id:'c',position:2,group_position:1,session_id:'person-main-1',session_title:'Summary writer',goal:'Combine both research results',state:'pending',result_message_id:null,tasks:[] },
    ] }]
    await page.setViewportSize({width,height:900})
    await page.goto('/#/person')
    await page.locator('.person-header-actions').getByRole('button',{name:'Settings',exact:true}).click()
    const drawer=page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab',{name:'Flows',exact:true}).click()
    await drawer.getByRole('button',{name:'Parallel research',exact:true}).click()
    await expect(drawer.getByText('Step 1',{exact:true})).toBeVisible()
    await expect(drawer.getByText('Step 2',{exact:true})).toBeVisible()
    await expect(drawer.getByText('Parallel · 2 roles',{exact:true})).toBeVisible()
    await expect(drawer.getByText('Waiting for other roles',{exact:true})).toBeVisible()
    const summary=drawer.locator('.flow-role').filter({hasText:'Summary writer'})
    await expect(summary.getByText('Waiting for prior results',{exact:true})).toBeVisible()
    await expect(summary.getByText('Waiting for Needs researcher',{exact:true})).toBeVisible()
    await drawer.getByRole('button',{name:'Stop flow',exact:true}).click()
    await expect(drawer.getByText('Waiting for other roles',{exact:true})).toHaveCount(0)
    await drawer.getByRole('button',{name:'Resume',exact:true}).click()
    await expect(drawer.getByText('Waiting for other roles',{exact:true})).toBeVisible()
    await page.screenshot({path:`/tmp/person-parallel-flow-${mode}.png`,animations:'disabled'})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    state.flows[0].stages[1].state='completed';state.flows[0].stages[1].result_message_id=102
    state.flows[0].stages[2].state='active';state.flows[0].current_position=1
    await emit(page,'person.updated',{})
    await expect(drawer.getByText('Waiting for other roles',{exact:true})).toHaveCount(0)
    await expect(summary.getByText('In progress',{exact:true})).toBeVisible()
    await expect(drawer.getByRole('button',{name:'View result',exact:true})).toHaveCount(2)
    expect(operations.filter(op=>op.path.endsWith('/flows/apply')).map(op=>op.body.action)).toEqual(['stop','resume'])
    await drawer.locator('.flow-role').filter({hasText:'Competitor researcher'}).getByRole('button',{name:'View result',exact:true}).click()
    await expect(page).toHaveURL(/session=person-main-b&message=101/)
    await expect(drawer).not.toBeVisible()
  })
}

for (const { width, mode, wallpaper } of [
  { width:1440,mode:'light',wallpaper:false }, { width:1440,mode:'dark',wallpaper:true },
  { width:390,mode:'light',wallpaper:true }, { width:390,mode:'dark',wallpaper:false },
] as const) {
  test(`previews the role collaboration graph at ${width}px in ${mode}`,async ({ page }) => {
    const { state } = await setup(page,mode,wallpaper,wallpaper)
    await page.addInitScript(() => localStorage.setItem('hermes_locale','zh'))
    state.session.title='负责人'
    state.conversations.push({ ...state.session,id:'person-main-b',title:'程序员',bot_type:'xiaohe' },{ ...state.session,id:'person-main-c',title:'文案',bot_type:'yingying' })
    Object.assign(state.tasks[0],{session_id:'person-main-c',title:'检查页面文案',summary:'检查页面表达与行动按钮',selection_json:'{"runtime":"codex"}'})
    state.flows=[{ id:'review-flow',title:'产品页面上线评审',goal:'程序员和文案分别检查页面，完成后由负责人汇总上线建议。',state:'active',revision:0,current_position:0,error:'',stages:[
      { id:'a',position:0,group_position:0,session_id:'person-main-b',session_title:'程序员',bot_type:'xiaohe',goal:'检查页面交互与移动端适配，整理需要修复的问题。',state:'completed',result_message_id:101,tasks:[] },
      { id:'b',position:1,group_position:0,session_id:'person-main-c',session_title:'文案',bot_type:'yingying',goal:'检查首页文案与行动按钮，给出具体修改建议。',state:'active',result_message_id:null,tasks:[{id:'task1',title:'检查页面文案',status:'open',execution_state:'running',agent:'codex'}] },
      { id:'c',position:2,group_position:1,session_id:'person-main-1',session_title:'负责人',bot_type:'zhezhe',goal:'综合两份评审结果，输出最终上线清单。',state:'pending',result_message_id:null,tasks:[] },
    ] }]
    await page.setViewportSize({width,height:width < 640 ? 1400 : 1080})
    await page.goto('/#/person')
    await page.locator('.person-header-actions').getByRole('button',{name:'设置',exact:true}).click()
    const drawer=page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab',{name:'协作流程',exact:true}).click()
    await drawer.getByRole('button',{name:'产品页面上线评审',exact:true}).click()
    await expect(drawer.getByText('等待 文案 完成',{exact:true})).toBeVisible()
    await expect(drawer.getByText('2 个角色并行，已完成 1 个',{exact:true})).toBeVisible()
    const branches=drawer.locator('.flow-group').first().locator('.flow-role')
    const boxes=await branches.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width}}))
    if(width > 640) expect(Math.abs(boxes[0].y-boxes[1].y)).toBeLessThan(2)
    else expect(boxes[1].y).toBeGreaterThan(boxes[0].y)
    const copy=drawer.getByRole('region',{name:'文案',exact:true})
    await copy.locator('summary').click()
    await expect(copy.getByRole('button',{name:/检查页面文案/})).toBeVisible()
    await expect(drawer.getByRole('region',{name:'程序员',exact:true}).locator('.flow-role-avatar')).toHaveAttribute('src',/\/person\/xiaohe\/idle\.png$/)
    await page.evaluate(()=>document.fonts.ready)
    await drawer.locator('.flow-card').scrollIntoViewIfNeeded()
    if(width < 640) await page.screenshot({path:`/tmp/person-flow-ui-${width}-${mode}.png`})
    else {
      const previewBounds=await drawer.locator('.flow-card').boundingBox()
      await page.screenshot({path:`/tmp/person-flow-ui-${width}-${mode}.png`,clip:previewBounds!})
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if(width === 1440 && mode === 'dark') {
      await page.evaluate(async()=>{
        const path='/src/composables/useTheme.ts'; const {useTheme}=await import(path)
        await useTheme().saveThemeCustomization({appearance:{global:{opacity:0.4},regions:{card:{backgroundColor:'#336699',borderColor:'#6688aa',opacity:0.25,blur:8,radius:18}}}})
      })
      await drawer.locator('.flow-card').screenshot({path:'/tmp/person-flow-ui-regional.png',animations:'disabled'})
      await page.evaluate(async()=>{
        const path='/src/composables/useTheme.ts'; const {useTheme}=await import(path)
        await useTheme().saveThemeCustomization({appearance:{global:{opacity:0.4},regions:{card:{opacity:0}}}})
      })
      await expect(copy.getByRole('button',{name:/检查页面文案/})).toBeVisible()
      await drawer.locator('.flow-card').screenshot({path:'/tmp/person-flow-ui-transparent.png',animations:'disabled'})
      await page.evaluate(async()=>{
        const path='/src/composables/useTheme.ts'; const {useTheme}=await import(path)
        const theme=useTheme();await theme.resetCustomization();await theme.removeBackground()
      })
      await drawer.getByRole('button',{name:'打开 程序员 的对话',exact:true}).focus()
      await expect(drawer.getByRole('button',{name:'打开 程序员 的对话',exact:true})).toBeFocused()
    }
    if(width === 1440 && mode === 'light') {
      state.flows[0]={...state.flows[0],title:'大家介绍一下自己',goal:'每个角色介绍自己的职责和擅长的工作。',stages:state.flows[0].stages.map((stage:any,index:number)=>({...stage,group_position:0,state:index ? 'active' : 'completed',goal:'介绍自己的职责与擅长的工作。',tasks:[]}))}
      await emit(page,'person.updated',{})
      await expect(drawer.getByRole('button',{name:'大家介绍一下自己',exact:true})).toHaveAttribute('aria-expanded','true')
      await expect(drawer.locator('.flow-handoff')).toHaveCount(0)
      await drawer.locator('.flow-card').screenshot({path:'/tmp/person-flow-ui-everyone.png',animations:'disabled'})
    }
    if(width === 390 && mode === 'light') {
      await page.setViewportSize({width,height:844})
      await copy.getByRole('button',{name:/检查页面文案/}).click()
      await expect(page.locator('.person-task-chat')).toBeVisible()
      return
    }
    await drawer.getByRole('button',{name:'打开 程序员 的对话',exact:true}).click()
    await expect(page).toHaveURL(/session=person-main-b/)
    await expect(drawer).not.toBeVisible()
  })
}

for (const mode of ['light', 'dark'] as const) {
  test(`schedules an assistant goal without a worker preset in ${mode}`, async ({ page }) => {
    const { state, operations } = await setup(page, mode, mode === 'dark')
    state.settings.agents = []; state.tasks = []
    await page.goto('/#/person')
    await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: /Schedules/ }).click()
    const drawer = page.locator('.person-workspace-drawer')
    await drawer.getByRole('button', { name: 'New schedule', exact: true }).click()
    await drawer.getByRole('textbox', { name: 'Schedule title', exact: true }).fill('Daily greeting')
    await drawer.getByRole('textbox', { name: 'Scheduled goal', exact: true }).fill('Say good morning directly, without a background task')
    await page.screenshot({ path: `/tmp/person-role-schedule-${mode}.png`, animations: 'disabled' })
    await drawer.locator('.panel-editor').getByRole('button', { name: 'Save', exact: true }).click()
    await expect(drawer.locator('.schedule-tile')).toContainText('Daily greeting')
    expect(operations.filter(op => op.path.endsWith('/schedules/apply')).at(-1).body).toMatchObject({ mode: 'assistant', session_id: 'person-main-1', goal: 'Say good morning directly, without a background task' })
    expect(operations.some(op => op.path.endsWith('/tasks/apply'))).toBe(false)
    await page.setViewportSize({ width: 390, height: 844 })
    await drawer.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(drawer.getByRole('textbox', { name: 'Scheduled goal', exact: true })).toHaveValue('Say good morning directly, without a background task')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/person-role-schedule-${mode}-mobile.png`, animations: 'disabled' })
  })
}

test('switches execution conversations and keeps a historical follow-up on the selected run', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  Object.assign(state.tasks[0], { status: 'completed', running: false, execution_state: 'finished', execution_id: 'second' })
  state.executions = [
    { id: 'second', session_id: 'person-task-second', created_at: 2000, state: 'finished' },
    { id: 'first', session_id: 'person-task-first', created_at: 1000, state: 'finished' },
  ]
  await page.addInitScript(() => {
    for (const run of ['first', 'second']) (window as any).__PW_CHAT_SOCKET_RESUMES__[`person-task-${run}`] = {
      session_id: `person-task-${run}`, messages: [{ id: run, role: 'assistant', content: `${run} occurrence result`, timestamp: 1 }], isWorking: false, events: [],
    }
  })
  await page.goto('/#/person')
  await page.getByRole('button', { name: 'Tasks', exact: true }).click()
  await page.getByRole('button', { name: 'View in conversation: Check report', exact: true }).click()
  const drawer = page.locator('.person-task-chat')
  await expect(drawer.getByText('second occurrence result', { exact: true })).toBeVisible()
  await drawer.getByLabel('Execution history', { exact: true }).click()
  await page.locator('.n-base-select-option:visible').last().click()
  await expect(drawer.getByText('first occurrence result', { exact: true })).toBeVisible()
  await expect(drawer.getByText('second occurrence result', { exact: true })).toHaveCount(0)
  await drawer.locator('.input-textarea').fill('Explain this occurrence')
  await drawer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => operations.filter(op => op.path.endsWith('/chat') && op.body?.input).at(-1)?.body).toMatchObject({ execution_id: 'first', expected_execution_id: 'second' })
  await expect(drawer.getByText('first occurrence result', { exact: true })).toBeVisible()
})

for (const [mode, width, status, executionMode] of [
  ['light', 1440, 'active', 'worker'], ['dark', 390, 'paused', 'assistant'],
  ['light', 390, 'cancelled', 'worker'], ['dark', 1440, 'exhausted', 'assistant'],
] as const) {
  test(`deletes a ${status} ${executionMode} schedule in ${mode} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const { state, operations } = await setup(page, mode, width === 390)
    const schedule = { id: 'delete-target', session_id: 'person-main-1', mode: executionMode, task_id: executionMode === 'worker' ? 'task1' : null,
      title: 'Schedule to remove', goal: 'Saved goal', kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', next_at: Date.now() + 86400000, state: status, revision: 3 }
    state.schedules = [schedule, { ...schedule, id: 'keep-plan', title: 'Keep this plan', state: 'active' }]
    await page.goto('/#/person')
    await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: /Schedules/ }).click()
    const drawer = page.locator('.person-workspace-drawer')
    const card = drawer.locator('.schedule-tile').filter({ has: page.getByRole('heading', { name: 'Schedule to remove', exact: true }) })
    await card.getByRole('button', { name: 'Delete', exact: true }).click()
    const confirm = page.locator('.n-dialog')
    await expect(confirm).toContainText('Existing tasks, execution history and running work are kept.')
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(card).toBeVisible()
    expect(operations.filter(op => op.body?.action === 'delete')).toHaveLength(0)
    if (status !== 'cancelled') {
      await card.getByRole('button', { name: 'Edit', exact: true }).click()
      await expect(drawer.locator('.panel-editor')).toBeVisible()
    }
    await card.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(confirm).toBeVisible()
    await page.evaluate(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
    })
    const confirmationBounds = await confirm.boundingBox()
    expect(confirmationBounds!.x).toBeGreaterThanOrEqual(0)
    expect(confirmationBounds!.x + confirmationBounds!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: `/tmp/person-schedule-delete-${status}-${width}.png`, animations: 'disabled' })
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(drawer.locator('.schedule-tile')).toHaveCount(1)
    await expect(drawer.getByRole('heading', { name: 'Keep this plan', exact: true })).toBeVisible()
    await expect(drawer.locator('.panel-editor')).toHaveCount(0)
    expect(operations.filter(op => op.body?.action === 'delete').at(-1).body).toMatchObject({ schedule_id: 'delete-target', expected_revision: 3 })
    expect(state.tasks[0].running).toBe(true)
    expect(operations.some(op => op.path.endsWith('/tasks/apply') || op.path.endsWith('/flows/apply'))).toBe(false)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('keeps a schedule and its edit draft on deletion failure, then allows retry', async ({ page }) => {
  const { state, operations } = await setup(page, 'light', false)
  state.schedules = [{ id: 'retry-delete', mode: 'assistant', session_id: 'person-main-1', task_id: null, title: 'Retry deletion', goal: 'Original goal',
    kind: 'cron', expression: '0 9 * * *', timezone: 'UTC', next_at: Date.now() + 86400000, state: 'active', revision: 0 }]
  state.failScheduleDelete = true
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: /Schedules/ }).click()
  const drawer = page.locator('.person-workspace-drawer')
  const card = drawer.locator('.schedule-tile')
  await card.getByRole('button', { name: 'Edit', exact: true }).click()
  await drawer.getByRole('textbox', { name: 'Scheduled goal', exact: true }).fill('Keep this unsaved draft')
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(drawer.locator('.workspace-error')).toContainText('Schedule deletion failed')
  await expect(card).toBeVisible()
  await expect(drawer.getByRole('textbox', { name: 'Scheduled goal', exact: true })).toHaveValue('Keep this unsaved draft')
  state.failScheduleDelete = false
  await card.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(card).toHaveCount(0)
  await expect(drawer.locator('.panel-editor')).toHaveCount(0)
  await expect(drawer.locator('.panel-empty')).toBeVisible()
  expect(operations.filter(op => op.body?.action === 'delete')).toHaveLength(2)
})

for (const { width, mode } of [{ width:1440,mode:'light' },{ width:390,mode:'dark' }] as const) {
  test(`keeps many collaboration flows compact and expands one at a time at ${width}px`,async ({ page }) => {
    const { state }=await setup(page,mode,false,false)
    await page.addInitScript(()=>localStorage.setItem('hermes_locale','zh'))
    state.tasks=[]
    const titles=['产品页面上线评审','大家介绍一下自己','竞品调研与方案','本周内容发布计划','移动端交互走查','支付接入评审','本周工作汇总','用户反馈分类','首页文案迭代','注册流程验收','活动方案整理','帮助中心更新']
    state.flows=titles.map((title,index)=>({
      id:`compact-${index}`,title,goal:'各角色分别完成分工，交由负责人整理最终结果。',state:index < 5 ? 'active' : index === 5 ? 'stopped' : 'completed',revision:0,current_position:0,error:'',
      stages:(index === 1 ? ['程序员','文案','负责人'] : index === 2 ? ['竞品研究员','需求研究员','负责人'] : ['程序员','文案','负责人']).map((session_title,position)=>({
        id:`compact-${index}-${position}`,position,group_position:index === 1 ? 0 : position < 2 ? 0 : 1,
        session_id:'person-main-1',session_title,bot_type:['xiaohe','yingying','zhezhe'][position],goal:['检查交互与移动端适配。','检查文案与行动按钮。','汇总结果，输出最终清单。'][position],
        state:index > 5 || position === 0 ? 'completed' : index === 1 || position === 1 ? 'active' : 'pending',result_message_id:index > 5 || position === 0 ? 101 : null,
        tasks:index === 4 && position === 1 ? [{id:'approval',title:'确认调整方案',status:'open',execution_state:'waiting_approval'}] : [],
      })),
    }))
    state.flows[11].stages=Array.from({length:13},(_,position)=>({ ...state.flows[11].stages[position % 3],id:`long-${position}`,position,group_position:position,session_title:`多语言校对角色 ${position + 1}` }))
    await page.setViewportSize({width,height:width > 640 ? 1040 : 844})
    await page.goto('/#/person')
    await page.locator('.person-header-actions').getByRole('button',{name:'设置',exact:true}).click()
    const drawer=page.locator('.person-workspace-drawer')
    await drawer.getByRole('tab',{name:'协作流程',exact:true}).click()
    const rows=drawer.locator('.flow-row')
    await expect(rows).toHaveCount(12)
    await expect(drawer.locator('.flow-card')).toHaveCount(0)
    await expect(rows.first()).toHaveAttribute('aria-expanded','false')
    await expect(rows.first().locator('.flow-route')).toHaveText(/程序员 ∥ 文案\s*→\s*负责人/)
    await expect(rows.nth(1).locator('.flow-route')).toHaveText('程序员 ∥ 文案 ∥ 负责人')
    await expect(rows.nth(4)).toContainText('等待你回答')
    await page.evaluate(async()=>{
      await document.fonts.ready
      await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations !== Infinity).map(a=>a.finished.catch(()=>{})))
    })
    const bounds=await rows.evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {height:r.height,width:r.width,x:r.x}}))
    expect(bounds.every(r=>r.height <= 80 && r.x >= 0 && r.x+r.width <= width)).toBe(true)
    if(width > 640) {
      const clip=await drawer.boundingBox()
      await page.screenshot({path:'/tmp/person-flows-compact-desktop.png',clip:clip!})
    } else await page.screenshot({path:'/tmp/person-flows-compact-mobile.png'})
    await rows.first().focus()
    await page.keyboard.press('Enter')
    await expect(rows.first()).toHaveAttribute('aria-expanded','true')
    await expect(drawer.locator('.flow-card')).toHaveCount(1)
    await rows.nth(1).click()
    await expect(rows.first()).toHaveAttribute('aria-expanded','false')
    await expect(rows.nth(1)).toHaveAttribute('aria-expanded','true')
    await expect(drawer.locator('.flow-card')).toHaveCount(1)
    await rows.nth(1).click()
    await expect(drawer.locator('.flow-card')).toHaveCount(0)
    const filters=drawer.locator('.flow-filters')
    await filters.getByRole('button',{name:/^进行中\s*5$/}).click()
    await expect(rows).toHaveCount(5)
    await expect(filters.getByRole('button',{name:/^进行中\s*5$/})).toHaveAttribute('aria-pressed','true')
    const search=drawer.getByRole('textbox',{name:'搜索流程或角色',exact:true})
    await search.fill('竞品研究员')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('竞品调研与方案')
    await rows.first().click()
    await search.fill('不存在的流程')
    await expect(rows).toHaveCount(0)
    await expect(drawer.getByText('没有匹配的流程。',{exact:true})).toBeVisible()
    await search.fill('')
    await expect(drawer.locator('.flow-card')).toHaveCount(0)
    await filters.getByRole('button',{name:/^已停止\s*1$/}).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('支付接入评审')
    await filters.getByRole('button',{name:/^已完成\s*6$/}).click()
    await expect(rows).toHaveCount(6)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}

test('limits collaboration display and filters to the latest 50 flows',async ({page})=>{
  const {state}=await setup(page,'light',false,false)
  state.tasks=[]
  state.flows=Array.from({length:51},(_,index)=>({
    id:`limited-${index}`,title:`Collaboration ${index+1}`,goal:'Complete the assigned work',state:index < 10 || index === 50 ? 'active' : 'completed',revision:0,current_position:0,error:'',
    stages:[{id:`limited-stage-${index}`,position:0,group_position:0,session_id:'person-main-1',session_title:'Reviewer',goal:'Save the review result',state:index < 10 || index === 50 ? 'active' : 'completed',result_message_id:index < 10 || index === 50 ? null : 7,tasks:[]}],
  }))
  await page.goto('/#/person')
  await page.locator('.person-header-actions').getByRole('button',{name:'Settings',exact:true}).click()
  const drawer=page.locator('.person-workspace-drawer')
  await drawer.getByRole('tab',{name:'Flows',exact:true}).click()
  const rows=drawer.locator('.flow-row'),filters=drawer.locator('.flow-filters')
  await expect(rows).toHaveCount(50)
  await expect(filters.getByRole('button',{name:/^All\s*50$/})).toBeVisible()
  await filters.getByRole('button',{name:/^In progress\s*10$/}).click()
  await expect(rows).toHaveCount(10)
  await filters.getByRole('button',{name:/^All\s*50$/}).click()
  const search=drawer.getByRole('textbox',{name:'Search flows or roles',exact:true})
  await search.fill('Collaboration 51')
  await expect(rows).toHaveCount(0)
  await expect(drawer.getByText('No matching flows.',{exact:true})).toBeVisible()
  await search.fill('Collaboration 50')
  await expect(rows).toHaveCount(1)
  await rows.first().click()
  await drawer.getByRole('button',{name:'View result',exact:true}).click()
  await expect(page).toHaveURL(/session=person-main-1&message=7/)
  await expect(drawer).not.toBeVisible()
})
