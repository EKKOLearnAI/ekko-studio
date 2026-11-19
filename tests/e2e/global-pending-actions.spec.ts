import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, test, type Page } from '@playwright/test'
import { Server } from 'socket.io'

const approval = { event: 'approval.requested', session_id: 'background-chat', approval_id: 'approval-1', command: 'Read the release notes', choices: ['once', 'deny'], timeout_ms: 300_000 }
const question = { event: 'clarify.requested', session_id: 'background-chat', clarify_id: 'question-1', question: 'Which release should I review?', choices: ['Alpha', 'Beta'], timeout_ms: 300_000 }

async function studio(page: Page) {
  const http = createServer()
  const io = new Server(http, { cors: { origin: true } })
  const chat = io.of('/chat-run'), group = io.of('/group-chat')
  const pending = new Map<string, typeof approval | typeof question>()
  const groupQuestions = [{ roomId: 'release-room', clarify_id: 'room-question', question: 'Which team owns this release?', choices: ['Build team'], remaining_timeout_ms: 60_000 }]
  const answers: object[] = []
  const seenProfiles: string[] = []
  chat.on('connection', socket => {
    const profile = socket.handshake.query.profile
    if (profile !== 'work') return
    socket.join('work')
    if (socket.handshake.query.pending_interactions === '1') {
      seenProfiles.push(profile)
      socket.emit('pending.interactions.snapshot', { events: [...pending.values()] })
    }
    socket.on('approval.respond', data => {
      answers.push(data)
      pending.delete(data.approval_id)
      chat.to('work').emit('approval.resolved', { event: 'approval.resolved', ...data, resolved: true })
    })
    socket.on('clarify.respond', data => {
      answers.push(data)
      if (data.response === 'Not yet') {
        socket.emit('clarify.resolved', { event: 'clarify.resolved', ...data, resolved: false, error: 'temporary failure' })
        return
      }
      pending.delete(data.clarify_id)
      chat.to('work').emit('clarify.resolved', { event: 'clarify.resolved', ...data, resolved: true })
    })
  })
  group.on('connection', socket => {
    socket.on('load_pending_approvals', (_, ack) => ack({ pendingApprovals: [], pendingClarifies: groupQuestions }))
    socket.on('clarify.respond', (data, ack) => { answers.push(data); groupQuestions.length = 0; ack({ resolved: true }) })
  })
  io.of('/workflow').on('connection', socket => {
    socket.on('workflows.list', (_, ack) => ack({ ok: true, data: { workflows: [] } }))
    socket.on('workflow.status.subscribe', (_, ack) => ack({ ok: true, data: { statuses: [] } }))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  await page.addInitScript(({ server, token }) => {
    localStorage.setItem('hermes_api_key', token)
    localStorage.setItem('hermes_active_profile_name', 'work')
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_server_url', server)
  }, { server: `http://127.0.0.1:${address.port}`, token: `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture` })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', route => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, object> = {
      '/health': { status: 'ok' }, '/api/auth/status': { hasPasswordLogin: true, hasUsers: true },
      '/api/auth/me': { user: { id: 1, username: 'Tester', role: 'super_admin' } },
      '/api/auth/locked-ips': { locks: [] }, '/api/auth/avatar': { avatar: '' },
      '/api/hermes/profiles': { profiles: [{ name: 'work', active: true }] },
      '/api/hermes/available-models': { groups: [{ provider: 'fixture', models: ['local-model'], has_api_key: true }], allProviders: [], default: 'local-model', default_provider: 'fixture' },
      '/api/navigation': { items: ['chat', 'history', 'studioPlugins'] },
      '/api/studio/plugins': { revision: 1, plugins: [] }, '/api/studio/plugins/events': { generation: 'test', cursor: 0, events: [] },
      '/api/studio/sessions': { sessions: [] }, '/api/studio/person/conversations': { sessions: [] },
    }
    return route.fulfill({ json: responses[path] || {} })
  })
  return { io, chat, pending, answers, seenProfiles, groupQuestions }
}

test('shows live and missed chat requests outside chat, and submits from the Studio popup', async ({ page }, testInfo) => {
  const f = await studio(page)
  f.groupQuestions.length = 0
  try {
    await page.goto('/#/studio/plugins')
    await expect.poll(() => [...f.chat.sockets.values()].map(socket => socket.handshake.query.profile || 'default')).toContain('work')
    f.pending.set('approval-1', approval)
    f.chat.to('work').emit(approval.event, approval)
    const card = page.locator('.n-notification').filter({ hasText: approval.command })
    await expect(card).toHaveCount(1)
    await page.evaluate(() => { location.hash = '/hermes/settings' })
    await card.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(card).toHaveCount(0)

    const answeredElsewhere = { ...approval, command: 'Already handled in another window', approval_id: 'approval-2' }
    f.pending.set('approval-2', answeredElsewhere)
    f.chat.to('work').emit(approval.event, answeredElsewhere)
    const oldCard = page.locator('.n-notification').filter({ hasText: answeredElsewhere.command })
    await expect(oldCard).toHaveCount(1)
    const before = f.seenProfiles.length
    for (const socket of f.chat.sockets.values()) socket.conn.close()
    f.pending.delete('approval-2')
    f.pending.set('question-1', question)
    const popup = page.locator('.n-notification').filter({ hasText: question.question })
    await expect(popup).toHaveCount(1)
    await expect.poll(() => f.seenProfiles.length).toBeGreaterThan(before)
    await expect(oldCard).toHaveCount(0)
    await expect(card).toHaveCount(0)
    await page.reload()
    await expect(popup).toHaveCount(1)
    await popup.getByRole('textbox').fill('Not yet')
    await popup.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(page.getByText(/response was not confirmed|answer.*not.*confirmed/i).first()).toBeVisible()
    await expect(popup.getByRole('textbox')).toHaveValue('Not yet')
    await popup.getByRole('button', { name: 'Beta', exact: true }).click()
    await popup.screenshot({ path: testInfo.outputPath('studio-global-clarification.png') })
    await popup.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(popup).toHaveCount(0)
    expect(f.answers).toEqual([
      { session_id: approval.session_id, approval_id: 'approval-1', choice: 'deny' },
      { session_id: question.session_id, clarify_id: 'question-1', response: 'Not yet' },
      { session_id: question.session_id, clarify_id: 'question-1', response: 'Beta' },
    ])
  } finally { await f.io.close() }
})

test('restores and answers a pending group clarification on the Studio settings page', async ({ page }) => {
  const f = await studio(page)
  try {
    await page.goto('/#/hermes/settings')
    const popup = page.locator('.n-notification').filter({ hasText: 'Which team owns this release?' })
    await expect(popup).toHaveCount(1)
    await popup.getByRole('button', { name: 'Build team', exact: true }).click()
    await popup.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(popup).toHaveCount(0)
    expect(f.answers).toEqual([{ roomId: 'release-room', clarify_id: 'room-question', response: 'Build team' }])
  } finally { await f.io.close() }
})
