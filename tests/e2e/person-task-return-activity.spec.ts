import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

test('lists an accepted task while its return is pending and opens the original execution', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-task-return-activity.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__task_return_activity__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__task_return_activity__')
  await page.getByRole('button', { name: /大厨.*Agent/ }).click()
  const row = page.getByRole('button', { name: 'Codex 登录页', exact: true })
  await expect(row).toBeVisible()
  await expect.poll(() => row.evaluate(element => {
    const rowBounds = element.getBoundingClientRect()
    const capsule = element.closest('.person-task-island')!.getBoundingClientRect()
    return rowBounds.top >= capsule.top && rowBounds.bottom <= capsule.bottom
  })).toBe(true)
  if (process.env.TASK_RETURN_EVIDENCE_DIR) {
    await mkdir(process.env.TASK_RETURN_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: resolve(process.env.TASK_RETURN_EVIDENCE_DIR, 'pending-task-capsule.png'), animations: 'disabled' })
  }
  await row.click()
  await expect(page.getByRole('status', { name: '打开的任务' })).toHaveText(JSON.stringify({ taskId: 'original-development', executionId: 'development-execution' }))
  await page.evaluate(() => (window as any).taskReturnActivityFixture.delivered())
  await expect(page.getByRole('button', { name: /大厨/ })).toHaveCount(0)
  expect(errors).toEqual([])
})
