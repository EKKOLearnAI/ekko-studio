import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

test('submits approval on its profile and preserves a rejected decision for retry', async ({ page }, testInfo) => {
  const answers: { choice: string; profile: string | null }[] = [], errors: string[] = []
  let accept: (() => void) | undefined
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket('**/socket.io/**', ws => {
    const profile = new URL(ws.url()).searchParams.get('profile')
    const send = (event: string, payload: object) => ws.send('42/chat-run,' + JSON.stringify([event, { event, session_id: 'chat-session', ...payload }]))
    ws.send('0' + JSON.stringify({ sid: 'engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }))
    ws.onMessage(message => {
      const text = String(message)
      if (text.startsWith('40/chat-run,')) {
        ws.send('40/chat-run,' + JSON.stringify({ sid: 'chat-run' }))
        send('approval.requested', { approval_id: 'request', command: 'Execute release check', description: 'Allow this operation?', choices: ['once', 'deny'], timeout_ms: 300000 })
      }
      if (!text.startsWith('42/chat-run,')) return
      const [event, payload] = JSON.parse(text.slice('42/chat-run,'.length))
      if (event !== 'approval.respond') return
      answers.push({ choice: payload.choice, profile })
      if (answers.length === 1) send('approval.resolved', { approval_id: 'request', resolved: false, error: 'temporarily unavailable' })
      else accept = () => send('approval.resolved', { approval_id: 'request', resolved: true, choice: payload.choice })
    })
  })
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }))
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/clarify-delivery.ts').replace(/^\//, '')
  await page.route('**/__approval__*', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__approval__?profile=work')
  await page.getByRole('button', { name: 'Allow once', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Please retry')
  await page.screenshot({ path: testInfo.outputPath('approval-retry.png') })
  await page.getByRole('button', { name: 'Other page', exact: true }).click()
  await page.getByRole('button', { name: 'Return to chat', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect.poll(() => answers.length).toBe(2)
  await expect(page.getByText('Allow this operation?', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeDisabled()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: testInfo.outputPath('approval-pending-narrow.png') })
  accept!()
  await expect(page.getByText('Allow this operation?', { exact: true })).toHaveCount(0)
  expect(answers).toEqual([{ choice: 'once', profile: 'work' }, { choice: 'deny', profile: 'work' }])
  expect(errors).toEqual([])
})
