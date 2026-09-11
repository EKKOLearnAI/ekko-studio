import { expect, test } from '@playwright/test'
import { authenticate, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

const now = Math.floor(Date.now() / 1000)
const tasks = Array.from({ length: 12 }, (_, index) => ({
  id: `task-${index + 1}`,
  title: `Canvas task ${index + 1}`,
  body: `Task body ${index + 1}`,
  assignee: 'research',
  status: 'todo',
  priority: 2,
  created_by: null,
  created_at: now + index,
  started_at: null,
  completed_at: null,
  workspace_kind: 'local',
  workspace_path: null,
  tenant: null,
  result: null,
  skills: null,
}))

test('keeps canvas task lists scrollable and task cards clickable', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)

  await page.route(/\/api\/hermes\/kanban(?:\/|\?|$)/, async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const taskMatch = pathname.match(/^\/api\/hermes\/kanban\/(task-\d+)$/)

    if (pathname === '/api/hermes/kanban/boards') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          boards: [{
            slug: 'default',
            name: 'Default',
            description: '',
            icon: '',
            color: '',
            created_at: now,
            archived: false,
            is_current: true,
            counts: { todo: tasks.length },
            total: tasks.length,
          }],
        }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban/capabilities') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: { source: 'hermes-cli', supports: {}, missing: [] } }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban/stats') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          stats: {
            by_status: { todo: tasks.length },
            by_assignee: { research: tasks.length },
            total: tasks.length,
          },
        }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban/assignees') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ assignees: [{ name: 'research', on_disk: true, counts: { todo: tasks.length } }] }),
      })
      return
    }

    if (/^\/api\/hermes\/kanban\/task-\d+\/attachments$/.test(pathname)) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ attachments: [] }),
      })
      return
    }

    if (taskMatch) {
      const task = tasks.find(item => item.id === taskMatch[1])
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          task,
          latest_summary: null,
          comments: [],
          events: [],
          runs: [],
          parents: [],
          children: [],
        }),
      })
      return
    }

    if (pathname === '/api/hermes/kanban') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ tasks }),
      })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: `Unexpected Kanban route: ${request.method()} ${pathname}` }),
    })
  })

  await page.goto('/#/hermes/kanban')

  const taskList = page.locator('.status-todo .task-list')
  await expect(taskList).toBeVisible()
  const dimensions = await taskList.evaluate(element => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight)

  await taskList.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect.poll(() => taskList.evaluate(element => element.scrollTop)).toBeGreaterThan(0)

  const taskCard = page.getByRole('button', { name: 'Canvas task 12' })
  expect(await taskCard.evaluate(element => element.draggable)).toBe(false)
  await taskCard.click()
  await expect(page.locator('.n-drawer').getByText('Canvas task 12', { exact: true })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('approves a codex-tech review card through the existing Kanban entry', async ({ page }) => {
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await page.addInitScript(() => localStorage.setItem('hermes.kanban.selectedBoard', 'codex-tech'))
  let status = 'review'
  let postedBody: Record<string, unknown> | null = null
  const task = () => ({
    id: 'task-review', title: 'Risky approval', body: 'Breaking migration risk', assignee: 'codex-worker',
    status, priority: 3, created_by: null, created_at: now, started_at: now + 1,
    completed_at: status === 'done' ? now + 3 : null, workspace_kind: 'worktree', workspace_path: '/tmp/wt',
    tenant: null, result: status === 'done' ? 'Approved' : null, skills: null, current_run_id: 17,
  })

  await page.route(/\/api\/hermes\/kanban(?:\/|\?|$)/, async (route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    if (pathname === '/api/hermes/kanban/boards') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ boards: [{ slug: 'codex-tech', name: 'Codex Tech', description: '', icon: '', color: '', created_at: now, archived: false, is_current: true, counts: { [status]: 1 }, total: 1 }] }) })
      return
    }
    if (pathname === '/api/hermes/kanban/capabilities') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ capabilities: { source: 'hermes-cli', supports: {}, missing: [] } }) })
      return
    }
    if (pathname === '/api/hermes/kanban/approval/capabilities') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ approval: { can_approve: true, allowed_boards: ['codex-tech'], dingtalk_configured: true } }) })
      return
    }
    if (pathname === '/api/hermes/kanban/stats') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ stats: { by_status: { [status]: 1 }, by_assignee: { 'codex-worker': 1 }, total: 1 } }) })
      return
    }
    if (pathname === '/api/hermes/kanban/assignees') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ assignees: [{ name: 'codex-worker', on_disk: true, counts: { [status]: 1 } }] }) })
      return
    }
    if (pathname === '/api/hermes/kanban/task-review/attachments') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ attachments: [] }) })
      return
    }
    if (pathname === '/api/hermes/kanban/task-review/approve' && request.method() === 'POST') {
      postedBody = request.postDataJSON()
      status = 'done'
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ receipt: { ok: true, duplicate: false, event_id: 'evt-ui', after_status: 'done' } }) })
      return
    }
    if (pathname === '/api/hermes/kanban/task-review') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ task: task(), latest_summary: 'Ready for review', comments: [], events: [{ id: 55, task_id: 'task-review', kind: 'review_requested', payload: {}, created_at: now + 2, run_id: 17 }], runs: [{ id: 17, profile: 'codex-worker', status, started_at: now + 1, ended_at: now + 2 }], parents: [], children: [] }) })
      return
    }
    if (pathname === '/api/hermes/kanban') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tasks: [task()] }) })
      return
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unexpected Kanban route: ${request.method()} ${pathname}` }) })
  })

  await page.goto('/#/hermes/kanban')
  await expect(page.getByRole('heading', { name: 'Kanban Approval Center' })).toBeVisible()
  await page.getByRole('button', { name: 'Risky approval' }).evaluate(element => (element as HTMLButtonElement).click())
  await expect(page.getByTestId('approval-risk')).toBeVisible()
  await expect(page.getByTestId('approval-event-id')).toContainText('55')
  await page.getByTestId('approval-reason').locator('input, textarea').fill('tests and diff verified')
  await page.getByTestId('approval-approve').click()
  await expect(page.getByTestId('approval-archive')).toBeVisible()
  expect(postedBody).toEqual({ reason: 'tests and diff verified' })
  expect(api.unexpectedRequests).toEqual([])
})
