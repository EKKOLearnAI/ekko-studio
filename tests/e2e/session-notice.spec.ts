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
