import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

async function setup(page: Page, failOnce = false) {
  const requests: Array<{ path: string; body: any }> = [], errors: string[] = [], resumes: string[] = []
  const channels: Array<(event: string, data: any) => void> = []
  const sessionId = 'person-task-original'
  const history: any[] = [
    { id: 1, role: 'user', content: '帮我查下厦门的天气', timestamp: 1793669967 },
    { id: 2, role: 'assistant', content: '正在查询厦门天气，还没有完成。', timestamp: 1793669978 },
  ]
  const task: any = { id: 'fixture-task', session_id: 'person-main-fixture', title: '查询厦门天气', summary: '查询厦门天气', status: 'open', revision: 1, requirements_revision: 0, execution_id: 'old', execution_state: 'running', running: true, selection_json: '{"runtime":"codex"}', completion_evidence: '', updated_at: 1 }
  const executions: any[] = [{ id: 'old', session_id: sessionId, state: 'running', created_at: 1, requirements_revision: 0 }]
  let pending: any[] = []
  const session = () => ({ id: sessionId, title: task.title, profile: 'default', source: 'coding_agent', agent: 'codex', agent_mode: 'scoped', workspace: '/fixture', model: 'fixture-model', started_at: 1, last_active: 1 })
  const publish = (event: string, data: any = {}) => channels.forEach(send => send(event, { event, session_id: sessionId, ...data }))
  const update = () => publish('person.updated', { session_id: 'person-main-fixture' })
  function correct() {
    executions[0].state = 'interrupted'
    executions.push({ id: 'next', session_id: sessionId, state: 'pending', created_at: 2, requirements_revision: 1 })
    Object.assign(task, { title: '查询贵阳天气', revision: task.revision + 1, requirements_revision: 1, execution_id: 'next', execution_state: 'pending', redirect_state: 'waiting', summary: '查询贵阳天气' })
    pending = [{ id: 'next', input: [{ type: 'text', text: '哦不查贵阳的吧' }] }]
  }
  function confirmStopAndFinish() {
    publish('abort.started', { run_id: 'old-native-run' })
    publish('abort.completed', { run_id: 'old-native-run', synced: true })
    Object.assign(task, { execution_state: 'running', redirect_state: 'completed' }); pending = []
    const user = { id: 3, role: 'user', content: '哦不查贵阳的吧', timestamp: 1793669986 }
    history.push(user)
    publish('run.peer_user_message', { message: user })
    publish('run.started', { run_id: 'next-native-run', run_marker: 'latest-turn' })
    publish('message.delta', { run_id: 'next-native-run', delta: '贵阳天气已经查好了。' })
    history.push({ id: 4, role: 'assistant', content: '贵阳天气已经查好了。', timestamp: 1793670026 })
    publish('run.completed', { run_id: 'next-native-run', output: '贵阳天气已经查好了。', message_id: 4 })
    Object.assign(task, { status: 'completed', running: false, execution_state: 'finished' }); executions.at(-1).state = 'finished'
    update()
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'zh'); localStorage.setItem('hermes_active_profile_name', 'default') })
  await page.routeWebSocket('**/socket.io/**', ws => {
    ws.send('0' + JSON.stringify({ sid: 'fixture', upgrades: [], pingInterval: 60000, pingTimeout: 60000 }))
    ws.onMessage(raw => {
      const s = String(raw)
      if (s.startsWith('40')) ws.send(s.split(',')[0] + ',' + JSON.stringify({ sid: 'fixture' }))
      if (s.startsWith('42')) {
        const start = s.indexOf('['), prefix = s.slice(0, start), [event, data] = JSON.parse(s.slice(start))
        if (event === 'resume') {
          resumes.push(data.session_id)
          channels.push((event, data) => ws.send(prefix + JSON.stringify([event, data])))
          ws.send(prefix + JSON.stringify(['resumed', { session_id: data.session_id, messages: history, isWorking: task.execution_state === 'running', queueLength: 0, events: [], workspace: '/fixture', model: 'fixture-model' }]))
        }
      }
    })
  })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request(), u = new URL(request.url())
    if (u.pathname === '/api/studio/person/tasks/fixture-task/chat') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); requests.push({ path: u.pathname, body })
        if (failOnce) { failOnce = false; return route.fulfill({ status: 409, json: { error: 'Task changed; query it again' } }) }
        if (body.input[0].text === '哦不查贵阳的吧') {
          correct()
          return route.fulfill({ json: { task, execution: executions.at(-1), pending } })
        }
        task.revision++; pending.push({ id: 'append', input: body.input }); return route.fulfill({ json: { task, pending } })
      }
      const execution = executions.find(e => e.id === (u.searchParams.get('execution_id') || task.execution_id))
      return route.fulfill({ json: { task, execution, executions: [executions.at(-1)], session: session(), pending, canInsert: task.redirect_state !== 'waiting', canRemove: true, protectedQueueId: task.redirect_state === 'waiting' ? 'next' : '' } })
    }
    let json: any = {}
    if (u.pathname === '/api/auth/me') json = { user: { id: 1, username: 'fixture', role: 'super_admin' } }
    else if (u.pathname === '/api/auth/avatar') json = { avatar: '' }
    else if (u.pathname.includes('/profiles')) json = { profiles: [{ name: 'default', active: true }] }
    else if (u.pathname.includes('/messages/paginated')) json = { session: session(), messages: history, total: history.length, hasMore: false }
    return route.fulfill({ json })
  })
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-task-redirection.ts').replace(/^\//, '')
  await page.route('**/__task_redirect__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__task_redirect__')
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page.getByText('正在查询厦门天气，还没有完成。', { exact: true })).toBeVisible()
  await page.locator('textarea').evaluate(el => el.setAttribute('data-original-composer', 'true'))
  return { requests, errors, resumes, sessionId, correctFromMain: () => { correct(); update() }, confirmStopAndFinish }
}
async function verifyContinuousHistory(page: Page) {
  for (const text of ['帮我查下厦门的天气', '正在查询厦门天气，还没有完成。', '哦不查贵阳的吧', '贵阳天气已经查好了。']) await expect(page.getByText(text, { exact: true })).toBeVisible()
}

test('stops and sends the latest request in the original conversation without replacing its composer or history', async ({ page }) => {
  await page.setViewportSize({width:1280,height:1000})
  const { requests, errors, resumes, sessionId, confirmStopAndFinish } = await setup(page)
  await page.locator('textarea').fill('还要注明数据来源')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.locator('textarea')).toHaveValue('')
  await page.locator('textarea').fill('哦不查贵阳的吧')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]).toMatchObject({ path: '/api/studio/person/tasks/fixture-task/chat', body: { expected_revision: 2, expected_execution_id: 'old', input: [{ type: 'text', text: '哦不查贵阳的吧' }] } })
  await expect(page.getByText('正在停止之前的工作，随后按最新要求继续。', { exact: true })).toBeVisible()
  await expect(page.locator('textarea')).toHaveAttribute('data-original-composer', 'true')
  await expect(page.getByText('正在查询厦门天气，还没有完成。', { exact: true })).toBeVisible()
  for (const selector of ['.task-message-intent', '.task-chat-queue', '.task-executions']) await expect(page.locator(selector)).toHaveCount(0)
  confirmStopAndFinish()
  await verifyContinuousHistory(page)
  await expect(page.locator('textarea')).toHaveAttribute('data-original-composer', 'true')
  expect(new Set(resumes)).toEqual(new Set([sessionId]))
  if (process.env.TASK_REDIRECT_EVIDENCE_DIR) {
    await mkdir(process.env.TASK_REDIRECT_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: resolve(process.env.TASK_REDIRECT_EVIDENCE_DIR, 'same-conversation-history.png'), animations: 'disabled' })
  }
  await page.reload()
  await verifyContinuousHistory(page)
  expect(new Set(resumes)).toEqual(new Set([sessionId]))
  expect(errors).toEqual([])
})

test('keeps the original corrective draft when a stale request is rejected', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { requests, errors } = await setup(page, true)
  await page.locator('textarea').fill('哦不查贵阳的吧')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requests.length).toBe(1)
  await expect(page.locator('textarea')).toHaveValue('哦不查贵阳的吧')
  await expect(page.locator('textarea')).toHaveAttribute('data-original-composer', 'true')
  await expect(page.getByText(/Task changed; query it again/)).toBeVisible()
  expect(errors).toEqual([])
})

test('keeps the same dialog and unsent draft when the main Bot corrects its task', async ({ page }) => {
  const { correctFromMain, confirmStopAndFinish, resumes, sessionId, requests, errors } = await setup(page)
  await page.locator('textarea').fill('还要看降水概率')
  correctFromMain()
  await expect(page.locator('.task-chat-heading')).toContainText('查询贵阳天气')
  await expect(page.locator('textarea')).toHaveAttribute('data-original-composer', 'true')
  await expect(page.locator('textarea')).toHaveValue('还要看降水概率')
  confirmStopAndFinish()
  await verifyContinuousHistory(page)
  await expect(page.locator('textarea')).toHaveValue('还要看降水概率')
  expect(new Set(resumes)).toEqual(new Set([sessionId]))
  expect(requests).toHaveLength(0)
  expect(errors).toEqual([])
})
