import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const width of [1440, 390]) {
  test(`manually changes task status, filters closed tasks and handles failed saves at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    const task = { id: 'task-one', session_id: 'conversation', session_title: 'Task conversation', profile: 'research',
      source: 'coding_agent', agent: 'codex', title: 'Design task list', summary: 'A task maintained across turns',
      status: 'open', updated_at: 123, message_id: 51 }
    let fail = false
    let release: (() => void) | undefined
    const writes: unknown[] = []
    await page.route('**/api/studio/session-tasks?**', route => {
      const status = new URL(route.request().url()).searchParams.get('status')
      const tasks = !status || status === task.status ? [task] : []
      return route.fulfill({ json: { tasks, total: tasks.length, has_more: false } })
    })
    await page.route('**/api/studio/sessions/conversation/tasks/task-one/status?**', async route => {
      expect(route.request().method()).toBe('PATCH')
      expect(new URL(route.request().url()).searchParams.get('profile')).toBe('research')
      const body = route.request().postDataJSON()
      expect(body.expected_updated_at).toBe(task.updated_at)
      writes.push(body)
      if (fail) {
        await new Promise<void>(resolve => { release = resolve })
        return route.fulfill({ status: 409, json: { error: 'Task changed' } })
      }
      task.status = body.status
      task.updated_at++
      return route.fulfill({ json: { session_id: 'conversation', revision: writes.length, tasks: [task] } })
    })
    await page.goto('/#/hermes/chat?tasks=1')
    const row = page.locator('.task-row')
    const button = row.getByRole('button', { name: 'Change task status: Design task list' })
    await expect(row).toHaveCount(1, { timeout: 20_000 })
    await expect(button).toHaveText('Incomplete')
    for (const [label, status] of [['Closed', 'closed'], ['Incomplete', 'open'], ['Completed', 'completed']]) {
      await button.click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
      await expect(page.getByRole('menu')).toHaveCount(0)
      await expect(button).toHaveText(label)
      expect(task.status).toBe(status)
    }
    await button.click()
    await page.getByRole('menuitem', { name: 'Closed', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(button).toHaveText('Closed')
    await page.getByRole('button', { name: 'Filter task status' }).click()
    await page.getByRole('menuitem', { name: 'Closed', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page).toHaveURL(/taskStatus=closed/)
    await expect(row).toHaveCount(1)
    await page.reload()
    await expect(button).toHaveText('Closed')
    await button.click()
    await page.getByRole('menuitem', { name: 'Incomplete', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(row).toHaveCount(0)
    await page.getByRole('button', { name: 'Filter task status' }).click()
    await page.getByRole('menuitem', { name: 'All statuses', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(button).toHaveText('Incomplete')
    fail = true
    await button.click()
    await page.getByRole('menuitem', { name: 'Closed', exact: true }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute('aria-busy', 'true')
    await expect.poll(() => Boolean(release)).toBe(true)
    release!()
    await expect(page.getByText('Could not update task status. Refresh and try again.')).toBeVisible()
    await expect(button).toBeEnabled()
    await expect(button).toHaveText('Incomplete')
    expect(writes).toHaveLength(6)
    await expect(page).toHaveURL(/hermes\/chat\?tasks=1$/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `/tmp/ekko-task-status-${width}.png` })
  })
}
