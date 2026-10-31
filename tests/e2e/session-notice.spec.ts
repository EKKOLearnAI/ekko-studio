import { expect, test } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi } from './fixtures'

for (const viewport of [{ name: 'desktop', width: 1280, height: 800 }, { name: 'narrow', width: 390, height: 844 }]) {
  test(`renders a passive scheduled-task notice in its own session (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    await authenticate(page)
    await mockHermesApi(page)
    await mockChatSocket(page)
    await page.goto('/#/hermes/chat')
    await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Schedule a brief')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.some((entry: any) => entry.event === 'run'))
    await page.evaluate(() => {
      const state = (window as any).__PW_CHAT_SOCKET__
      const sid = state.emitted.find((entry: any) => entry.event === 'run').payload.session_id
      state.latest.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'notice-run' })
      state.latest.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'notice-run', output: 'Scheduled.' })
      state.latest.__trigger('session.notice', {
        event: 'session.notice', session_id: sid, attention: true,
        message: {
          id: 'studio-notice-1', session_id: sid, role: 'system', display_role: 'system',
          content: 'Synthetic brief result', timestamp: Math.floor(Date.now() / 1000) + 1,
          studio_notice: {
            kind: 'cron', notification_id: 1, disposition: 'notified', job_id: 'job-1', job_name: 'Daily brief',
            execution_id: 'exec-1', status: 'completed', success: true, reason: null, error: null,
            truncated: false, finished_at: null,
          },
        },
      })
      // A known failure with an empty answer is shown with its error, not hidden.
      state.latest.__trigger('session.notice', {
        event: 'session.notice', session_id: sid, attention: true,
        message: {
          id: 'studio-notice-2', session_id: sid, role: 'system', display_role: 'system',
          content: '', timestamp: Math.floor(Date.now() / 1000) + 2,
          studio_notice: {
            kind: 'cron', notification_id: 2, disposition: 'notified', job_id: 'job-2', job_name: 'Nightly sync',
            execution_id: 'exec-2', status: 'failed', success: false, reason: null, error: 'Synthetic provider failure',
            truncated: false, finished_at: null,
          },
        },
      })
    })
    const header = page.locator('.studio-notice-header').filter({ hasText: 'Daily brief' })
    await expect(header).toContainText('Scheduled task “Daily brief” finished')
    await expect(page.locator('.markdown-body').filter({ hasText: 'Synthetic brief result' })).toBeVisible()
    const failed = page.locator('.studio-notice-header').filter({ hasText: 'Nightly sync' })
    await expect(failed.locator('.studio-notice-detail')).toHaveText('Synthetic provider failure')
    const box = await header.first().boundingBox()
    expect(box && box.x + box.width).toBeLessThanOrEqual(viewport.width)
  })
}

test('renders an external notice as inert plain text with a click-only link', async ({ page }) => {
  const remote: string[] = []
  page.on('request', request => { if (request.url().includes('external.example')) remote.push(request.url()) })
  await authenticate(page)
  await mockHermesApi(page)
  await mockChatSocket(page)
  await page.goto('/#/hermes/chat')
  await page.getByPlaceholder('Type a message... (Enter to send, Shift+Enter for new line)').fill('Watch the review')
  await page.getByRole('button', { name: 'Send' }).click()
  await page.waitForFunction(() => (window as any).__PW_CHAT_SOCKET__?.emitted?.some((entry: any) => entry.event === 'run'))
  const content = '**not bold** ![pixel](https://external.example/pixel.png) <img src="https://external.example/img.png"> [file](/etc/hosts)'
  await page.evaluate(content => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const sid = state.emitted.find((entry: any) => entry.event === 'run').payload.session_id
    state.latest.__trigger('run.started', { event: 'run.started', session_id: sid, run_id: 'external-run' })
    state.latest.__trigger('run.completed', { event: 'run.completed', session_id: sid, run_id: 'external-run', output: 'Watching.' })
    state.latest.__trigger('session.notice', {
      event: 'session.notice', session_id: sid, attention: true,
      message: {
        id: 'studio-notice-3', session_id: sid, role: 'system', display_role: 'system', content,
        timestamp: Math.floor(Date.now() / 1000) + 1,
        studio_notice: { kind: 'external', notification_id: 3, source: 'validator-review', event_id: 'review-3',
          title: '<b>Validation</b> complete', url: 'https://external.example/reviews/3' },
      },
    })
  }, content)
  const header = page.locator('.studio-notice-header').filter({ hasText: 'Validation' })
  await expect(header.locator('.studio-notice-title')).toHaveText('<b>Validation</b> complete')
  await expect(header.locator('.studio-notice-detail')).toContainText('validator-review')
  await expect(page.locator('.studio-notice-text')).toHaveText(content)
  await expect(page.locator('img[src*="external.example"], .markdown-body strong')).toHaveCount(0)
  const link = page.getByRole('link', { name: 'https://external.example/reviews/3' })
  await expect(link).toHaveAttribute('rel', /noopener/)
  await expect(link).toHaveAttribute('target', '_blank')
  expect(remote).toEqual([])
})
