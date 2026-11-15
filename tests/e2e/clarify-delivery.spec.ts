import { expect, test } from '@playwright/test'
import { resolve } from 'node:path'

for (const bot of [false, true]) test(`keeps an unconfirmed answer retryable across navigation (${bot ? 'BOT' : 'chat'})`, async ({ page }, testInfo) => {
  const sid = bot ? 'person-main-bot' : 'chat-session'
  const answers: string[] = [], errors: string[] = []
  let accept: (() => void) | undefined
  page.on('pageerror', error => errors.push(error.message))
  await page.routeWebSocket('**/socket.io/**', ws => {
    const send = (event: string, payload: object) => ws.send('42/chat-run,' + JSON.stringify([event, { event, session_id: sid, ...payload }]))
    ws.send('0' + JSON.stringify({ sid: 'engine', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 }))
    ws.onMessage(message => {
      const text = String(message)
      if (text.startsWith('40/chat-run,')) {
        ws.send('40/chat-run,' + JSON.stringify({ sid: 'chat-run' }))
        send('clarify.requested', { clarify_id: 'question', question: 'Which release?', choices: ['A', 'B'], timeout_ms: 300000 })
      }
      if (!text.startsWith('42/chat-run,')) return
      const [event, payload] = JSON.parse(text.slice('42/chat-run,'.length))
      if (event !== 'clarify.respond') return
      answers.push(payload.response)
      if (answers.length === 1) send('clarify.resolved', { clarify_id: 'question', resolved: false, error: 'temporarily unavailable' })
      else accept = () => send(bot ? 'person.clarification.resolved' : 'clarify.resolved', { clarify_id: 'question', resolved: true, reason: 'response' })
    })
  })
  await page.route(url => url.pathname.startsWith('/api/'), route => route.fulfill({ json: {} }))
  const entry = '/@fs/' + resolve('tests/e2e/fixtures/clarify-delivery.ts').replace(/^\//, '')
  await page.route('**/__clarify__*', route => route.fulfill({ contentType: 'text/html', body: `<div id="app"></div><script type="module" src="${entry}"></script>` }))
  await page.goto('/__clarify__' + (bot ? '?bot=1' : ''))
  await expect(page.getByText('Which release?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'B', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Please retry')
  await expect(page.getByPlaceholder('Type your answer...')).toHaveValue('B')
  if (!bot) await page.screenshot({ path: testInfo.outputPath('retry-state.png') })
  await page.getByRole('button', { name: 'Other page', exact: true }).click()
  await page.getByRole('button', { name: 'Return to chat', exact: true }).click()
  await expect(page.getByPlaceholder('Type your answer...')).toHaveValue('B')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Reply', exact: true }).click()
  await expect.poll(() => answers.length).toBe(2)
  await expect(page.getByText('Which release?', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'B', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Other page', exact: true }).click()
  accept!()
  await page.getByRole('button', { name: 'Return to chat', exact: true }).click()
  await expect(page.getByText('Which release?', { exact: true })).toHaveCount(0)
  expect(answers).toEqual(['B', 'B'])
  expect(errors).toEqual([])
})
