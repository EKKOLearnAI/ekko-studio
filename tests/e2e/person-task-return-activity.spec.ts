import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

test.beforeEach(async ({page}) => {
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/person-task-return-activity.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__task_return_activity__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="zh"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__task_return_activity__')
})

test('lists an accepted task while its return is pending and opens the original execution', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
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

test('shows only the current verifier and restores both final task cards with separate navigation', async ({ page }) => {
  await page.evaluate(() => (window as any).taskReturnActivityFixture.verifying())
  const capsule=page.getByRole('button',{name:/大厨.*Agent.*1/})
  await capsule.click()
  await expect(page.getByRole('button',{name:'Codex 登录页',exact:true})).toHaveCount(0)
  await expect(page.getByRole('button',{name:'验收：Codex 登录页',exact:true})).toBeVisible()
  if(process.env.TASK_RETURN_EVIDENCE_DIR) {
    await mkdir(process.env.TASK_RETURN_EVIDENCE_DIR,{recursive:true})
    await page.screenshot({path:resolve(process.env.TASK_RETURN_EVIDENCE_DIR,'verification-capsule.png'),animations:'disabled'})
  }
  await page.evaluate(() => (window as any).taskReturnActivityFixture.accepted())
  await expect(capsule).toHaveCount(0)
  for(const restored of [false,true]) {
    if(restored) await page.reload()
    const cards=page.locator('.person-task-return-card')
    await expect(cards).toHaveCount(2)
    await expect(cards.nth(0)).toHaveAttribute('aria-label','Codex 登录页')
    await expect(cards.nth(1)).toHaveAttribute('aria-label','验收：Codex 登录页')
    await cards.nth(0).getByRole('button').click()
    await expect(page.getByRole('status',{name:'打开的任务'})).toHaveText(JSON.stringify({taskId:'original-development',executionId:'development-execution'}))
    await cards.nth(1).getByRole('button').click()
    await expect(page.getByRole('status',{name:'打开的任务'})).toHaveText(JSON.stringify({taskId:'independent-verification',executionId:'verification-execution'}))
  }
  if(process.env.TASK_RETURN_EVIDENCE_DIR) await page.screenshot({path:resolve(process.env.TASK_RETURN_EVIDENCE_DIR,'accepted-task-cards.png'),animations:'disabled'})
})
