import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import type { PersonTask } from '../../packages/client/src/api/person'

async function setup(page: Page) {
  const errors: string[] = [], queries: Record<string, unknown>[] = [], actions: Record<string, unknown>[] = []
  const sessions = ['大厨', '空 Bot'].map((title, index) => ({ id: `person-main-${index}`, title, bot_type: 'dachu',
    workspace: `/fixture/${index}`, profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', agent_mode: 'scoped', history_revision: 0, started_at: 1, last_active: 1 }))
  const tasks: PersonTask[] = ['检查接口', '生成页面'].map((title, index) => ({ id: `task-${index}`, title, summary: `${title}的任务记录`,
    session_id: sessions[0].id, session_title: sessions[0].title, status: 'open', revision: 1, updated_at: 1000 + index,
    execution_id: `execution-${index}`, execution_state: index ? 'running' : 'finished', running: !!index,
    selection_json: JSON.stringify({ runtime: 'codex', profile: 'default', mode: 'scoped', provider: 'fixture', model: 'test-model' }), completion_evidence: '' }))
  const state = { fail: false }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url())
    let json: unknown = {}
    if (url.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (url.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (url.pathname.includes('/profiles')) json = { profiles: [{ name: 'default', active: true }] }
    else if (url.pathname === '/api/studio/person/conversations') json = { sessions, next_offset: null }
    else if (url.pathname === '/api/studio/person') {
      const session = sessions.find(session => session.id === url.searchParams.get('session_id'))
      json = { session: session || null, settings: { model: { profile: 'default', provider: 'fixture', model: 'test-model' }, agents: [], workspace: session?.workspace || '', timezone: 'Asia/Shanghai', maxSteps: 12, maxConcurrentTasks: 6, taskTimeoutMinutes: 60, compressionThreshold: null },
        revision: 0, busy: false, history_revision: 0, can_clear: false, inherits_global_model: true, reasoning_efforts: [], compression: { enabled: false, threshold: .8, globalThreshold: .8 }, contextTokens: 16000,
        tasks: tasks.filter(task => task.session_id === session?.id), active_tasks: [], active_agent_task_count: 0, schedules: [], memories: [], interactions: [], flows: [] }
    } else if (url.pathname === '/api/studio/person/tasks/query') {
      const query = request.postDataJSON(); queries.push(query)
      if (state.fail) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } })
      json = { tasks: tasks.filter(task => task.session_id === query.session_id && (!query.status || task.status === query.status) && (!query.search || task.title.includes(query.search))) }
    } else if (url.pathname === '/api/studio/person/tasks/apply') {
      const action = request.postDataJSON(); actions.push(action)
      const task = tasks.find(task => task.id === action.task_id)!
      task.revision++
      if (action.action === 'stop') { task.execution_state = 'interrupted'; task.running = false }
      else task.status = action.action === 'close' ? 'closed' : 'open'
      json = { task }
    } else if (/\/person\/tasks\/[^/]+\/chat$/.test(url.pathname)) {
      const task = tasks.find(task => url.pathname.includes(`/${task.id}/`))!
      const session = { ...sessions[0], id: `person-task-${task.id}`, title: task.title, source: 'coding_agent', agent: 'codex' }
      const execution = { id: task.execution_id, session_id: session.id, state: 'finished', created_at: 1 }
      json = { task, session, execution, executions: [execution], pending: [], canInsert: false, canRemove: false }
    } else if (url.pathname.includes('/messages/paginated')) json = { messages: [], total: 0, hasMore: false }
    else if (url.pathname === '/api/studio/workspace/directories') json = { directories: [] }
    await route.fulfill({ json })
  })
  await openFixture(page, 'person-conversation-layout')
  await expect(page.locator('.person-title')).toHaveText('大厨')
  return { errors, queries, actions, state }
}

async function openFixture(page: Page, fixture: string) {
  const entry = '/@fs/' + resolve(`tests/e2e/fixtures/${fixture}.ts`).replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__settings_tasks__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__settings_tasks__')
}
async function openTasks(page: Page) {
  await page.locator('.person-header-actions').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '任务', exact: true }).click()
}

test('moves Bot tasks into settings with search, filtering, status changes and task conversation access', async ({ page }, testInfo) => {
  const { errors, queries, actions } = await setup(page)
  const header = page.locator('.person-header-actions')
  for (const name of ['任务', '协作流程']) await expect(header.getByRole('button', { name, exact: true })).toHaveCount(0)
  await openTasks(page)
  await expect(page.getByRole('tab', { name: '任务', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.session-tasks-drawer')).toHaveCount(0)
  const panel = page.locator('.person-settings-tasks')
  await expect(panel.locator('.task-title')).toHaveText(['检查接口', '生成页面'])
  await panel.getByRole('button', { name: '搜索任务或会话', exact: true }).click()
  await panel.getByRole('textbox', { name: '搜索任务或会话', exact: true }).fill('检查')
  await expect(panel.locator('.task-title')).toHaveText(['检查接口'])
  await panel.getByRole('button', { name: '修改任务状态：检查接口', exact: true }).filter({ visible: true }).click()
  await page.getByRole('menuitem', { name: '已关闭', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(panel.locator('.task-row')).toContainText('已关闭')
  await panel.getByRole('button', { name: '筛选任务状态', exact: true }).click()
  await page.getByRole('menuitem', { name: '未完成', exact: true }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(panel).toContainText('没有符合条件的任务')
  await panel.getByRole('button', { name: '筛选任务状态', exact: true }).click()
  await page.getByRole('menuitem', { name: '已关闭', exact: true }).click()
  await expect(panel.locator('.task-title')).toHaveText(['检查接口'])
  await testInfo.attach('tasks-in-settings', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
  await panel.getByRole('button', { name: '在会话中查看：检查接口', exact: true }).click()
  await expect(page.locator('.task-chat-heading .task-identity-title')).toHaveText('检查接口')
  await expect(page.locator('.person-workspace-drawer')).toHaveCount(0)
  expect(queries.every(query => query.session_id === 'person-main-0')).toBe(true)
  expect(actions).toMatchObject([{ task_id: 'task-0', action: 'close', expected_revision: 1 }])
  expect(errors).toEqual([])
})

test('keeps loading, retry, stop and empty task states usable in narrow settings', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { errors, queries, actions, state } = await setup(page)
  state.fail = true
  await openTasks(page)
  const panel = page.locator('.person-settings-tasks')
  await expect(panel).toContainText('任务加载失败')
  state.fail = false
  await panel.getByRole('button', { name: '重试', exact: true }).click()
  await expect(panel.locator('.task-title')).toHaveCount(2)
  await panel.getByRole('button', { name: '停止任务', exact: true }).click()
  await expect(panel.getByRole('button', { name: '停止任务', exact: true })).toHaveCount(0)
  await expect(panel.locator('.task-row').filter({ hasText: '生成页面' })).toContainText('已中断')
  expect(await panel.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await testInfo.attach('tasks-in-settings-mobile', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' })
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).personWorkspaceFixture.router.push({ name: 'hermes.person', query: { session: 'person-main-1' } }))
  await expect(page.locator('.person-title')).toHaveText('空 Bot')
  await openTasks(page)
  await expect(panel).toContainText('会话中记录的任务会显示在这里')
  expect(queries.at(-1)?.session_id).toBe('person-main-1')
  expect(actions).toMatchObject([{ task_id: 'task-1', action: 'stop', execution_id: 'execution-1' }])
  expect(errors).toEqual([])
})

test('retains the ordinary chat task drawer when sharing its list with settings', async ({ page }) => {
  const changes: unknown[] = []
  const task = { id: 'ordinary-task', title: '普通聊天任务', summary: '保留现有抽屉行为', session_id: 'session-a', session_title: '普通会话', profile: 'default', source: 'builtin_agent', agent: 'ekko-agent', status: 'open', updated_at: 1000, message_id: 12 }
  await page.addInitScript(() => localStorage.setItem('hermes_locale', 'zh'))
  await page.routeWebSocket('**/socket.io/**', () => {})
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), url = new URL(request.url())
    if (request.method() === 'PATCH') { changes.push(request.postDataJSON()); task.status = request.postDataJSON().status }
    await route.fulfill({ json: url.pathname === '/api/studio/session-tasks' ? { tasks: [task], total: 1, has_more: false } : {} })
  })
  await openFixture(page, 'session-tasks-drawer')
  const drawer = page.locator('.session-tasks-drawer')
  await expect(drawer.locator('.task-count')).toHaveText('1')
  await expect(drawer.getByRole('link', { name: '在会话中查看：普通聊天任务', exact: true })).toHaveAttribute('href', '/session/session-a?profile=default&message=12')
  await drawer.getByRole('button', { name: '修改任务状态：普通聊天任务', exact: true }).filter({ visible: true }).click()
  await page.getByRole('menuitem', { name: '已完成', exact: true }).click()
  await expect(drawer.locator('.task-row')).toContainText('已完成')
  expect(changes).toEqual([{ status: 'completed', expected_updated_at: 1000 }])
})
