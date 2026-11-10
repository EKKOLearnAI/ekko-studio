import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { containPage } from './fixtures/contained-page'

// Mounts the real message component with i18n and global styles. Every request outside Vite's own modules is
// blocked before navigation (see fixtures/contained-page.ts); /api is answered locally and never proxied.
async function openNotices(page: Page) {
  await page.addInitScript(() => { localStorage.setItem('hermes_locale', 'en'); (window as any).__APP_VERSION__ = 'test' })
  const guard = await containPage(page)
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/session-notice.ts').replaceAll('\\', '/').replace(/^\//, '')
  await page.route('**/__session_notice__', route => route.fulfill({ contentType: 'text/html',
    body: `<!doctype html><html><body><div id="app"></div><script type="module" src="${entry}"></script></body></html>` }))
  await page.goto('/__session_notice__')
  await page.waitForFunction(() => !!(window as any).sessionNoticeFixture)
  return guard
}

test('renders a script invocation report as passive Markdown with its wrapper provenance', async ({ page }) => {
  const downloads: string[] = []
  page.on('request', request => { if (request.url().includes('/files/download')) downloads.push(request.url()) })
  await openNotices(page)
  const content = [
    '**3 new items** <b>raw</b>',
    '',
    '| Item | Link |',
    '| --- | --- |',
    '| First | [#1](https://example.invalid/items/1) |',
    '',
    '![pixel](https://external.example/pixel.png)',
    '',
    '[clip](/tmp/report.mp4) [audio](/tmp/report.mp3)',
  ].join('\n')
  await page.evaluate(content => {
    const sid = (window as any).sessionNoticeFixture.sid
    // Raw server event, delivered through the real socket listener.
    ;(window as any).sessionNoticeFixture.deliver({
      event: 'session.notice', session_id: sid, attention: true,
      message: {
        id: 'studio-notice-4', session_id: sid, role: 'system', display_role: 'system', content,
        timestamp: Math.floor(Date.now() / 1000) + 1,
        studio_notice: { kind: 'script_report', notification_id: 4, disposition: 'notified', identity_kind: 'wrapper_invocation',
          job_id: 'job1', job_name: 'Daily digest', invocation_id: '00000000-0000-4000-8000-000000000004', outcome: 'output',
          exit_code: 0, signal: null, reason: null, truncated: false },
      },
    })
  }, content)
  const header = page.locator('.studio-notice-header').filter({ hasText: 'Daily digest' })
  await expect(header.locator('.studio-notice-title')).toHaveText('Script “Daily digest” reported')
  await expect(header.locator('.studio-notice-detail')).toContainText('not a native Hermes execution receipt')
  const body = page.locator('.markdown-body').filter({ hasText: '3 new items' })
  await expect(body.locator('strong')).toHaveText('3 new items')
  await expect(body).toContainText('<b>raw</b>')
  await expect(body.locator('table th')).toHaveText(['Item', 'Link'])
  await expect(body.getByRole('link', { name: '#1' })).toHaveAttribute('href', 'https://example.invalid/items/1')
  await expect(page.locator('.markdown-body b, img')).toHaveCount(0)
  await expect(body.locator('a.markdown-media-link')).toHaveCount(2)
  await expect(page.locator('video, audio')).toHaveCount(0)
  expect(downloads).toEqual([])
  // A notice is display-only: it is the only message, and no turn was added for it.
  await expect(page.locator('.message')).toHaveCount(1)
})
