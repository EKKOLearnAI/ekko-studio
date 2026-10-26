import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

const task = { id: 'one', session_id: 'task-chat', session_title: 'Studio 会话任务', profile: 'research', source: 'coding_agent', agent: 'codex',
  title: '设计任务展示页面', summary: '接入会话任务，完善桌面与手机列表', status: 'open', updated_at: Date.now(), message_id: 1 }

test('caps the task list at two pages and refreshes task status on focus', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  const offsets: number[] = []
  let completed = false
  await page.route('**/api/studio/session-tasks?**', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'))
    offsets.push(offset)
    return route.fulfill({ json: { tasks: Array.from({ length: 50 }, (_, i) => ({ ...task, id: `t${offset+i}`, title: `Task ${offset+i}`, status: completed && i === 0 ? 'completed' : 'open' })), total: 125, has_more: true } })
  })
  await page.goto('/#/hermes/tasks')
  await expect(page.locator('.task-row')).toHaveCount(50)
  await expect(page.locator('.n-pagination-item').filter({ hasText: /^3$/ })).toHaveCount(0)
  await page.locator('.n-pagination-item').filter({ hasText: /^2$/ }).click()
  await expect(page.locator('.task-title').first()).toHaveText('Task 50')
  await expect(page.locator('.task-row')).toHaveCount(50)
  await expect(page.locator('.n-pagination-item').filter({ hasText: /^3$/ })).toHaveCount(0)
  expect(offsets).toEqual([0, 50])
  completed = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.locator('.task-row--completed')).toHaveCount(1)
  expect(offsets).toEqual([0, 50, 50])
})

test('paginates with stable filters and ignores an older search response', async ({ page }) => {
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let staleStarted = false
  await page.route('**/api/studio/session-tasks?**', async route => {
    const query = new URL(route.request().url()).searchParams
    if (query.get('search') === 'older') { staleStarted = true; await gate }
    const offset = Number(query.get('offset'))
    const title = query.get('search') === 'newer' ? 'Newest result' : query.get('search') === 'older' ? 'Stale result' : `Page ${offset / 50 + 1}`
    return route.fulfill({ json: { tasks: [{ ...task, title }], total: 51, has_more: offset === 0 } })
  })
  await page.goto('/#/hermes/tasks?status=open&page=2')
  await expect(page.locator('.task-row')).toContainText('Page 2')
  await page.locator('.n-pagination-item').filter({ hasText: /^1$/ }).click()
  await expect(page).toHaveURL(/taskStatus=open&taskPage=1/)
  await expect(page.locator('.task-row')).toContainText('Page 1')
  await page.getByRole('button', { name: 'Search tasks or conversations' }).click()
  const input = page.getByRole('textbox', { name: 'Search tasks or conversations' })
  await input.fill('older')
  await expect.poll(() => staleStarted).toBe(true)
  await input.fill('newer')
  await expect(page.locator('.task-row')).toContainText('Newest result')
  release()
  await expect(page.locator('.task-row')).toContainText('Newest result')
  await expect(page).not.toHaveURL(/taskPage=/)
})
