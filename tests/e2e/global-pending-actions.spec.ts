import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, test, type Page } from '@playwright/test'
import { Server } from 'socket.io'

const approval = { profile: 'work', event: 'approval.requested', session_id: 'background-chat', approval_id: 'approval-1', command: 'Read the release notes', choices: ['once', 'deny'], timeout_ms: 300_000 }
const question = { profile: 'work', event: 'clarify.requested', session_id: 'background-chat', clarify_id: 'question-1', question: 'Which release should I review?', choices: ['Alpha', 'Beta'], timeout_ms: 300_000 }

async function studio(page: Page) {
  const http = createServer()
  const io = new Server(http, { cors: { origin: true } })
  const chat = io.of('/chat-run'), group = io.of('/group-chat')
  const pending = new Map<string, typeof approval | typeof question>()
  const groupQuestions = [{ roomId: 'release-room', clarify_id: 'room-question', question: 'Which team owns this release?', choices: ['Build team'], remaining_timeout_ms: 60_000 }]
  const answers: object[] = []
  const linked = new Set(['default', 'work'])
  const workflow = { workflowId: 'release', runId: 'run-1', title: 'Release review', profile: 'work', pendingApprovals: [{ nodeId: 'gate', executionId: 'step-1' }] }
  const workflowSocket = io.of('/workflow')
  let inboxConnections = 0
  chat.on('connection', socket => {
    const profile = socket.handshake.query.profile
    if (socket.handshake.query.pending_interactions === 'account') {
      const snapshot = () => socket.emit('pending.interactions.snapshot', { events: [...pending.values()].filter(item => linked.has(item.profile)) })
      inboxConnections++
      socket.join('account')
      snapshot()
      return
    }
    if (typeof profile !== 'string' || !linked.has(profile)) return
    const resolve = (event: string, data: Record<string, unknown>) => {
      socket.emit(event, { ...data, event, resolved: true })
      chat.to('account').emit('pending.interaction', { ...data, event, profile, resolved: true })
    }
    socket.on('approval.respond', data => {
      answers.push({ profile, ...data })
      if (pending.get(data.approval_id)?.profile !== profile) return
      pending.delete(data.approval_id)
      resolve('approval.resolved', data)
    })
    socket.on('clarify.respond', data => {
      answers.push({ profile, ...data })
      if (pending.get(data.clarify_id)?.profile !== profile) return
      if (data.response === 'Not yet') {
        socket.emit('clarify.resolved', { event: 'clarify.resolved', ...data, resolved: false, error: 'temporary failure' })
        return
      }
      pending.delete(data.clarify_id)
      resolve('clarify.resolved', data)
    })
  })
  group.on('connection', socket => {
    socket.on('load_pending_approvals', (_, ack) => ack({ pendingApprovals: [], pendingClarifies: groupQuestions }))
    socket.on('clarify.respond', (data, ack) => { answers.push(data); groupQuestions.length = 0; ack({ resolved: true }) })
  })
  workflowSocket.on('connection', socket => {
    if (socket.handshake.query.pending_interactions === 'account') {
      const snapshot = () => socket.emit('pending.interactions.snapshot', { events: workflow.pendingApprovals.length ? [workflow] : [] })
      snapshot()
      return
    }
    socket.on('workflows.list', (_, ack) => ack({ ok: true, data: { workflows: [] } }))
    socket.on('workflow.status.subscribe', (_, ack) => ack({ ok: true, data: { statuses: [] } }))
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  await page.addInitScript(({ server, token }) => {
    localStorage.setItem('hermes_api_key', token)
    localStorage.setItem('hermes_active_profile_name', 'default')
    localStorage.setItem('hermes_locale', 'en')
    localStorage.setItem('hermes_server_url', server)
  }, { server: `http://127.0.0.1:${address.port}`, token: `fixture.${Buffer.from(JSON.stringify({ sub: '1', role: 'super_admin' })).toString('base64url')}.fixture` })
  await page.route(url => url.pathname.startsWith('/api/') || url.pathname === '/health', route => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, object> = {
      '/health': { status: 'ok' }, '/api/auth/status': { hasPasswordLogin: true, hasUsers: true },
      '/api/auth/me': { user: { id: 1, username: 'Tester', role: 'super_admin' } },
      '/api/auth/locked-ips': { locks: [] }, '/api/auth/avatar': { avatar: '' },
      '/api/hermes/profiles': { profiles: [...linked].map(name => ({ name, active: name === 'default' })) },
      '/api/hermes/available-models': { groups: [{ provider: 'fixture', models: ['local-model'], has_api_key: true }], allProviders: [], default: 'local-model', default_provider: 'fixture' },
      '/api/navigation': { items: ['chat', 'history', 'studioPlugins'] },
      '/api/studio/plugins': { revision: 1, plugins: [] }, '/api/studio/plugins/events': { generation: 'test', cursor: 0, events: [] },
      '/api/studio/sessions': { sessions: [] }, '/api/studio/person/conversations': { sessions: [] },
    }
    if (path === '/api/studio/workflows/release/runs/run-1/nodes/gate/approval') {
      answers.push({ profile: route.request().headers()['x-hermes-profile'], ...route.request().postDataJSON() })
      workflow.pendingApprovals = []
      workflowSocket.emit('pending.interaction', workflow)
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ json: responses[path] || {} })
  })
  return { io, chat, pending, answers, groupQuestions, workflow, inboxCount: () => inboxConnections }
}

test('shows live and missed chat requests outside chat, and submits from the Studio popup', async ({ page }, testInfo) => {
  const f = await studio(page)
  f.groupQuestions.length = 0
  f.workflow.pendingApprovals = []
  try {
    await page.goto('/#/studio/plugins')
    await expect.poll(f.inboxCount).toBe(1)
    const activeSocket = () => [...f.chat.sockets.values()].find(socket => socket.handshake.query.profile === 'default')?.id
    await expect.poll(activeSocket).toBeTruthy()
    const original = activeSocket()
    const localQuestion = { ...question, profile: 'default', session_id: 'local-chat', clarify_id: 'local-question', question: 'Which local build?' }
    f.pending.set('local-question', localQuestion)
    f.chat.to('account').emit('pending.interaction', localQuestion)
    f.pending.set('approval-1', approval)
    f.chat.to('account').emit('pending.interaction', approval)
    const card = page.locator('.n-notification').filter({ hasText: approval.command })
    await expect(card).toHaveCount(1)
    await expect(card.locator('.global-pending-title')).toContainText('work ·')
    const localCard = page.locator('.n-notification').filter({ hasText: localQuestion.question })
    await expect(localCard.locator('.global-pending-title')).toContainText('default ·')
    await page.evaluate(() => { location.hash = '/hermes/settings' })
    await card.getByRole('button', { name: 'Deny', exact: true }).click()
    await expect(card).toHaveCount(0)

    expect(activeSocket()).toBe(original)
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
    await expect(localCard).toHaveCount(1)
    await localCard.getByRole('button', { name: 'Alpha', exact: true }).click()
    await localCard.getByRole('button', { name: 'Reply', exact: true }).click()
    await expect(localCard).toHaveCount(0)
    const answeredElsewhere = { ...approval, command: 'Already handled in another window', approval_id: 'approval-2' }
    f.pending.set('approval-2', answeredElsewhere)
    f.chat.to('account').emit('pending.interaction', answeredElsewhere)
    const oldCard = page.locator('.n-notification').filter({ hasText: answeredElsewhere.command })
    await expect(oldCard).toHaveCount(1)
    const before = f.inboxCount()
    for (const socket of f.chat.sockets.values()) socket.conn.close()
    f.pending.delete('approval-2')
    f.pending.set('question-1', question)
    const popup = page.locator('.n-notification').filter({ hasText: question.question })
    await expect(popup).toHaveCount(1)
    await expect.poll(() => f.inboxCount()).toBeGreaterThan(before)
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
      { profile: 'work', session_id: approval.session_id, approval_id: 'approval-1', choice: 'deny' },
      { profile: 'default', session_id: 'local-chat', clarify_id: 'local-question', response: 'Alpha' },
      { profile: 'work', session_id: question.session_id, clarify_id: 'question-1', response: 'Not yet' },
      { profile: 'work', session_id: question.session_id, clarify_id: 'question-1', response: 'Beta' },
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

test('restores a workflow gate from work and submits it while viewing default', async ({ page }) => {
  const f = await studio(page)
  try {
    await page.goto('/#/hermes/settings')
    const card = page.locator('.n-notification').filter({ hasText: 'Release review' })
    await expect(card.locator('.global-pending-title')).toContainText('work ·')
    await page.reload()
    await card.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(card).toHaveCount(0)
    expect(f.answers).toEqual([{ profile: 'work', approved: true, executionId: 'step-1' }])
    await expect(page).toHaveURL(/hermes\/settings/)
    expect(await page.evaluate(() => localStorage.getItem('hermes_active_profile_name'))).toBe('default')
  } finally { await f.io.close() }
})
