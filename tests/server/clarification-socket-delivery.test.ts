import { createServer } from 'node:http'
import { once } from 'node:events'
import { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'
import { expect, it, vi } from 'vitest'
import { acceptanceFixture } from './fixtures/person-acceptance'

function result(socket: Socket, event: string) {
  return once(socket, event, { signal: AbortSignal.timeout(2000) }).then(([payload]) => payload)
}

async function clarificationSocketFixture(authenticate = false) {
  const fixture = await acceptanceFixture()
  const http = createServer()
  const io = new Server(http)
  const runtime = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
  const { respondToEkkoToolApproval } = await import('../../packages/server/src/modules/ekko/services/approvals')
  const { respondToEkkoClarification } = await import('../../packages/server/src/modules/ekko/services/clarifications')
  const notHandled = { handled: false, resolved: false }
  const approvalRespond = vi.fn()
  const clarifyRespond = vi.fn()
  vi.spyOn(runtime, 'createPrimaryAgentBridge').mockReturnValue({
    approvalRespond, clarifyRespond, close: vi.fn(async () => {}),
  } as ReturnType<typeof runtime.createPrimaryAgentBridge>)
  vi.spyOn(runtime, 'respondToChatEkkoToolApproval').mockImplementation(respondToEkkoToolApproval)
  vi.spyOn(runtime, 'respondToChatEkkoClarification').mockImplementation(respondToEkkoClarification)
  vi.spyOn(runtime.chatCodingAgentRunManager, 'resolveApproval').mockReturnValue(notHandled)
  vi.spyOn(runtime.chatCodingAgentRunManager, 'resolveClarification').mockReturnValue(notHandled)
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const chat = new ChatRunSocket(io)
  const namespace = io.of('/chat-run')
  if (authenticate) namespace.use(chat['authMiddleware'].bind(chat))
  namespace.on('connection', socket => {
    if (!authenticate) socket.data.user = { id: 1, role: 'super_admin', status: 'active' }
    chat['onConnection'](socket)
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  const clients: Socket[] = []
  const openClient = (profile: string | null, query: Record<string, string> = {}, token?: string, namespace = '/chat-run') => {
    const socket = connect(`http://127.0.0.1:${address.port}${namespace}`, { forceNew: true, transports: ['websocket'],
      auth: { token }, query: { ...(profile && { profile }), ...query } })
    clients.push(socket)
    return socket
  }
  const client = async (profile: string) => {
    const socket = openClient(profile)
    await result(socket, 'connect')
    return socket
  }
  const close = async () => {
    for (const socket of clients) socket.disconnect()
    await chat.close()
    await io.close()
    await fixture.close('clarification-socket-delivery')
  }
  return { fixture, io, namespace, chat, client, openClient, close, approvalRespond, clarifyRespond }
}

it.each([
  ['conversation', 'clarify'], ['conversation', 'approval'], ['task', 'clarify'], ['task', 'approval'],
] as const)('acknowledges a Bot %s %s while the main conversation is busy', { timeout: 10_000 }, async (surface, kind) => {
  const h = await clarificationSocketFixture()
  const { fixture, chat } = h
  try {
    vi.spyOn(chat, 'isSessionRunning').mockImplementation(id => id === 'person-main-1')
    const client = await h.client('default')
    const { execution } = await fixture.create()
    const approval = kind === 'approval'
    const question = fixture.store.addPersonInteraction(1, execution, 'worker-question', 'Continue?',
      approval ? ['once', 'deny'] : ['A', 'B'], approval ? 'approval' : 'question')
    fixture.store.setPersonExecution(execution, approval ? 'waiting_approval' : 'waiting_user')
    const request = {
      session_id: surface === 'task' ? execution.session_id : 'person-main-1',
      [`${kind}_id`]: surface === 'task' ? 'worker-question' : `person-interaction:${question.id}:${question.revision}`,
    }
    const confirmed = result(client, `${kind}.resolved`)
    client.emit(`${kind}.respond`, { ...request, ...(approval ? { choice: 'deny' } : { response: 'B' }) })
    expect(await confirmed).toMatchObject({ ...request, resolved: true, ...(approval && { choice: 'deny' }) })
    expect(fixture.runtime.answer).toHaveBeenCalledExactlyOnceWith(execution.session_id, 'worker-question', approval ? 'deny' : 'B', approval)
  } finally {
    await h.close()
  }
})

async function sessionSockets(h: Awaited<ReturnType<typeof clarificationSocketFixture>>, runProfile = 'run-profile') {
  const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const sessionId = 'interaction-session'
  createSession({ id: sessionId, source: 'cli', profile: 'default', studio_user_id: 1 })
  const state = { profile: runProfile, source: 'cli', messages: [], events: [], queue: [], isWorking: true, activeRunMarker: 'run' }
  h.chat['sessionMap'].set(sessionId, state)
  const viewer = await h.client(runProfile)
  await h.namespace.sockets.get(viewer.id!)!.join(`session:${sessionId}`)
  const submitter = await h.client('default')
  const emit = (event: string, data: object) => h.chat.emitExternalEvent(sessionId, event, { event, run_id: 'run', ...data })
  return { sessionId, state, viewer, submitter, emit }
}

it.each(['plugin', 'ekko', 'mcp'] as const)('delivers %s runtime confirmations to a submitting socket outside the broadcast rooms', async runtime => {
  const h = await clarificationSocketFixture()
  const controller = new AbortController()
  try {
    const { sessionId, state, viewer, submitter, emit } = await sessionSockets(h)
    const submit = async (kind: 'approval' | 'clarify', start: () => Promise<unknown>, expected: unknown) => {
      const requested = result(viewer, `${kind}.requested`)
      const applied = start()
      const { [`${kind}_id`]: id } = await requested
      const request = { session_id: sessionId, [`${kind}_id`]: id }
      const confirmations = [result(viewer, `${kind}.resolved`), result(submitter, `${kind}.resolved`)]
      submitter.emit(`${kind}.respond`, { ...request, ...(kind === 'approval' ? { choice: 'deny' } : { response: 'B' }) })
      const [outcome, ...receipts] = await Promise.all([applied, ...confirmations])
      expect(outcome).toMatchObject(expected)
      for (const payload of receipts) expect(payload).toMatchObject({ ...request, resolved: true, ...(kind === 'approval' && { choice: 'deny' }) })
    }
    if (runtime === 'plugin') {
      const { agentRunInteractions } = await import('../../packages/server/src/modules/studio/services/agents/interactions')
      const agent = agentRunInteractions({ sessionId, runId: 'run', signal: controller.signal, deadlineAt: Date.now() + 60_000, emit })
      await submit('approval', () => agent.approve({ operationId: 'read', title: 'Read fixture', details: '' }), { outcome: 'denied' })
      await submit('clarify', () => agent.clarify({ question: 'Which option?' }), { outcome: 'answered', text: 'B' })
    } else if (runtime === 'ekko') {
      const { waitForEkkoToolApproval } = await import('../../packages/server/src/modules/ekko/services/approvals')
      const { waitForEkkoClarification } = await import('../../packages/server/src/modules/ekko/services/clarifications')
      const context = { sessionId, runId: 'run', signal: controller.signal }
      const approval = { approvalId: 'ekko-approval', toolName: 'read', key: 'read', command: 'Read', description: '', choices: ['deny' as const], allowPermanent: false, timeoutMs: 60_000 }
      await submit('approval', async () => ({ choice: await waitForEkkoToolApproval(approval, {
        ...context, onRequested: request => emit('approval.requested', { approval_id: request.approvalId }),
        onResolved: choice => emit('approval.resolved', { approval_id: approval.approvalId, resolved: true, choice }),
      }) }), { choice: 'deny' })
      const question = { clarifyId: 'ekko-clarify', question: 'Which option?', timeoutMs: 60_000 }
      await submit('clarify', async () => ({ response: await waitForEkkoClarification(question, {
        ...context, onRequested: request => emit('clarify.requested', { clarify_id: request.clarifyId }),
        onResolved: value => emit('clarify.resolved', { clarify_id: question.clarifyId, resolved: true, reason: value.reason }),
      }) }), { response: 'B' })
    } else {
      h.chat['clarificationRuns'].begin('context', sessionId, state.profile, () => state)
      await submit('clarify', () => h.chat.requestClarification('context', state.profile, { question: 'Which option?' }, controller.signal),
        { reason: 'response', response: 'B' })
    }
    expect(h.approvalRespond).not.toHaveBeenCalled()
    expect(h.clarifyRespond).not.toHaveBeenCalled()
  } finally {
    controller.abort()
    await h.close()
  }
})

it('restores only live and authorized global popups on a new connection without opening their sessions', async () => {
  const h = await clarificationSocketFixture()
  try {
    const { sessionId, state, submitter, emit } = await sessionSockets(h, 'default')
    const old = Date.now() - 90_000
    emit('approval.requested', { approval_id: 'done', requested_at: old, timeout_ms: 300_000 })
    emit('approval.resolved', { approval_id: 'done', resolved: true })
    emit('approval.requested', { approval_id: 'expired', requested_at: old, timeout_ms: 1_000 })
    emit('approval.requested', { approval_id: 'pending', requested_at: old, timeout_ms: 300_000 })
    emit('approval.resolved', { approval_id: 'pending', resolved: false, error: 'Temporary failure' })
    emit('clarify.requested', { clarify_id: 'question', question: 'Which release?', requested_at: old, timeout_ms: 300_000 })
    for (const [id, profile, source, isWorking] of [
      ['other-profile', 'other', 'cli', true], ['group', 'default', 'group_chat', true],
      ['person-task-private', 'default', 'cli', true], ['inactive', 'default', 'cli', false],
    ] as const) {
      h.chat['sessionMap'].set(id, { ...state, profile, source, isWorking })
    }
    // Other output can evict the request from the bounded transcript while the tool still waits.
    for (let index = 0; index < 205; index++) emit('message.delta', { delta: 'x' })
    expect(state.events.some(entry => entry.event === 'approval.requested')).toBe(false)
    const { execution } = await h.fixture.create()
    const botQuestion = h.fixture.store.addPersonInteraction(1, execution, 'bot-input', 'Choose a branch', ['A','B'], 'question')
    h.fixture.store.setPersonExecution(execution, 'waiting_user')
    const snapshot = async () => {
      const socket = h.openClient('default', { pending_interactions: '1' })
      const { events } = await result(socket, 'pending.interactions.snapshot')
      expect([...h.namespace.sockets.get(socket.id!)!.rooms].filter(room => room.startsWith('session:'))).toEqual([])
      socket.disconnect()
      return events
    }
    const events = await snapshot()
    expect(events).toHaveLength(3)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ session_id: sessionId, approval_id: 'pending' }),
      expect.objectContaining({ session_id: sessionId, clarify_id: 'question' }),
      expect.objectContaining({ session_id: 'person-main-1', clarify_id: `person-interaction:${botQuestion.id}:${botQuestion.revision}`, durable: true }),
    ]))
    expect(events.find((item: any) => item.approval_id)?.remaining_timeout_ms).toBeLessThanOrEqual(210_000)
    h.approvalRespond.mockResolvedValue({ resolved: true })
    const confirmed = result(submitter, 'approval.resolved')
    submitter.emit('approval.respond', { session_id: sessionId, approval_id: 'pending', choice: 'deny' })
    expect(await confirmed).toMatchObject({ resolved: true })
    emit('clarify.resolved', { clarify_id: 'question', resolved: true })
    expect(await snapshot()).toHaveLength(1)
  } finally {
    await h.close()
  }
})

it('rejects an unsupported plugin choice, then confirms a valid decision once to the profile inbox', async () => {
  const h = await clarificationSocketFixture()
  const controller = new AbortController()
  try {
    const { sessionId, submitter, emit } = await sessionSockets(h, 'default')
    const { agentRunInteractions } = await import('../../packages/server/src/modules/studio/services/agents/interactions')
    const agent = agentRunInteractions({ sessionId, runId: 'run', signal: controller.signal, deadlineAt: Date.now() + 60_000, emit })
    const requested = result(submitter, 'approval.requested')
    const pending = agent.approve({ operationId: 'read', title: 'Read fixture', details: '' })
    const { approval_id } = await requested
    const request = { session_id: sessionId, approval_id }
    const replies = vi.fn()
    submitter.on('approval.resolved', replies)
    const rejected = result(submitter, 'approval.resolved')
    submitter.emit('approval.respond', { ...request, choice: 'always' })
    const rejection = await rejected
    expect(rejection).toMatchObject({ ...request, resolved: false })
    expect(rejection.stale).not.toBe(true)

    const confirmed = result(submitter, 'approval.resolved')
    submitter.emit('approval.respond', { ...request, choice: 'deny' })
    expect(await pending).toEqual({ outcome: 'denied' })
    expect(await confirmed).toMatchObject({ ...request, resolved: true, choice: 'deny', outcome: 'denied' })
    const flushed = result(submitter, 'test.flushed')
    h.namespace.sockets.get(submitter.id!)!.emit('test.flushed')
    await flushed
    expect(replies).toHaveBeenCalledTimes(2)
  } finally {
    controller.abort()
    await h.close()
  }
})

it.each(['plugin', 'mcp'] as const)('does not confirm delivery if the %s clarification rejects the answer', async runtime => {
  const h = await clarificationSocketFixture()
  const controller = new AbortController()
  try {
    const { sessionId, state, viewer, submitter, emit } = await sessionSockets(h)
    const publish = h.chat.emitExternalEvent.bind(h.chat)
    vi.spyOn(h.chat, 'emitExternalEvent').mockImplementation((sid, event, data) => {
      if (event === 'clarify.resolved') throw new Error('Publication failed')
      publish(sid, event, data)
    })
    const requested = result(viewer, 'clarify.requested')
    let pending: Promise<unknown>
    if (runtime === 'plugin') {
      const { agentRunInteractions } = await import('../../packages/server/src/modules/studio/services/agents/interactions')
      const agent = agentRunInteractions({ sessionId, runId: 'run', signal: controller.signal, deadlineAt: Date.now() + 60_000, emit })
      pending = agent.clarify({ question: 'Which option?' })
    } else {
      h.chat['clarificationRuns'].begin('context', sessionId, state.profile, () => state)
      pending = h.chat.requestClarification('context', state.profile, { question: 'Which option?' }, controller.signal)
    }
    const rejected = expect(pending).rejects.toThrow('Publication failed')
    const request = { session_id: sessionId, clarify_id: (await requested).clarify_id }
    const receipt = result(submitter, 'clarify.resolved')
    submitter.emit('clarify.respond', { ...request, response: 'B' })
    expect(await receipt).toMatchObject({ ...request, resolved: false })
    await rejected
  } finally {
    controller.abort()
    await h.close()
  }
})

it.each(['approval', 'clarify'] as const)('returns a stale receipt for a cancelled plugin %s without dispatching to another runtime', async kind => {
  const h = await clarificationSocketFixture()
  const controller = new AbortController()
  try {
    const { sessionId, viewer, submitter, emit } = await sessionSockets(h)
    const { agentRunInteractions } = await import('../../packages/server/src/modules/studio/services/agents/interactions')
    const agent = agentRunInteractions({ sessionId, runId: 'run', signal: controller.signal, deadlineAt: Date.now() + 60_000, emit })
    const requested = result(viewer, `${kind}.requested`)
    const pending = kind === 'approval' ? agent.approve({ operationId: 'read', title: 'Read fixture', details: '' }) : agent.clarify({ question: 'Which option?' })
    const request = { session_id: sessionId, [`${kind}_id`]: (await requested)[`${kind}_id`] }
    controller.abort()
    expect(await pending).toEqual({ outcome: 'cancelled' })
    const confirmed = result(submitter, `${kind}.resolved`)
    submitter.emit(`${kind}.respond`, { ...request, ...(kind === 'approval' ? { choice: 'once' } : { response: 'B' }) })
    expect(await confirmed).toMatchObject({ ...request, resolved: false, stale: true })
    expect(h.approvalRespond).not.toHaveBeenCalled()
    expect(h.clarifyRespond).not.toHaveBeenCalled()
  } finally {
    controller.abort()
    await h.close()
  }
})

async function hermesSession(h: Awaited<ReturnType<typeof clarificationSocketFixture>>) {
  const { sessionId, viewer, submitter, emit } = await sessionSockets(h)
  const clarifyId = 'hermes-question'
  emit('clarify.requested', { clarify_id: clarifyId, question: 'Which option?', choices: ['A', 'B'] })
  return { other: viewer, submitter, answer: { session_id: sessionId, clarify_id: clarifyId, response: 'B' } }
}

it('returns the Hermes approval confirmation to the replacement connection after applying the decision once', async () => {
  const h = await clarificationSocketFixture()
  try {
    const { sessionId, viewer, submitter } = await sessionSockets(h)
    h.approvalRespond.mockResolvedValue({ resolved: true })
    const answer = { session_id: sessionId, approval_id: 'hermes-approval', choice: 'deny' }
    const confirmations = Promise.all([result(viewer, 'approval.resolved'), result(submitter, 'approval.resolved')])
    submitter.emit('approval.respond', answer)
    for (const receipt of await confirmations) expect(receipt).toMatchObject({ ...answer, resolved: true })
    expect(h.approvalRespond).toHaveBeenCalledExactlyOnceWith(answer.approval_id, answer.choice)
  } finally {
    await h.close()
  }
})

it('returns the Hermes confirmation to a replacement socket outside the occupied session room', async () => {
  const h = await clarificationSocketFixture()
  try {
    h.clarifyRespond.mockResolvedValue({ resolved: true })
    const { other, submitter, answer } = await hermesSession(h)
    const received = Promise.all([result(other, 'clarify.resolved'), result(submitter, 'clarify.resolved')])
    submitter.emit('clarify.respond', answer)
    for (const confirmation of await received) {
      expect(confirmation).toMatchObject({ session_id: answer.session_id, clarify_id: answer.clarify_id, resolved: true })
    }
    expect(h.clarifyRespond).toHaveBeenCalledExactlyOnceWith(answer.clarify_id, 'B')
  } finally {
    await h.close()
  }
})

it('removes the question from replay when a legacy Hermes broker has lost its route', async () => {
  const h = await clarificationSocketFixture()
  try {
    h.clarifyRespond.mockRejectedValue(new Error("'unknown clarify request: hermes-question'"))
    const { other, submitter, answer } = await hermesSession(h)
    const received = result(other, 'clarify.resolved')
    submitter.emit('clarify.respond', answer)
    expect(await received).toMatchObject({
      session_id: answer.session_id, clarify_id: answer.clarify_id, resolved: false, stale: true,
    })
    expect(h.chat['sessionMap'].get(answer.session_id)!.events).toEqual([])
  } finally {
    await h.close()
  }
})

it('keeps the Hermes question pending after a transient Bridge error and accepts a retry', async () => {
  const h = await clarificationSocketFixture()
  try {
    h.clarifyRespond.mockRejectedValueOnce(new Error('Bridge temporarily unavailable')).mockResolvedValueOnce({ resolved: true })
    const { submitter, answer } = await hermesSession(h)
    const first = result(submitter, 'clarify.resolved')
    submitter.emit('clarify.respond', answer)
    expect(await first).toMatchObject({ resolved: false, error: 'Bridge temporarily unavailable' })
    expect(h.chat['sessionMap'].get(answer.session_id)!.events).toHaveLength(1)

    const retry = result(submitter, 'clarify.resolved')
    submitter.emit('clarify.respond', answer)
    expect(await retry).toMatchObject({ clarify_id: answer.clarify_id, resolved: true })
    expect(h.clarifyRespond).toHaveBeenCalledTimes(2)
  } finally {
    await h.close()
  }
})

async function accountFixture() {
  vi.stubEnv('AUTH_JWT_SECRET', 'isolated-account-inbox-test')
  const h = await clarificationSocketFixture(true)
  const users = await import('../../packages/server/src/modules/studio/repositories/users-store')
  const real = await vi.importActual<typeof users>('../../packages/server/src/modules/studio/repositories/users-store')
  vi.spyOn(users, 'findUserById').mockImplementation(real.findUserById)
  vi.spyOn(users, 'listUserProfiles').mockImplementation(real.listUserProfiles)
  vi.spyOn(users, 'userCanAccessProfile').mockImplementation(real.userCanAccessProfile)
  const profiles = await import('../../packages/server/src/modules/studio/public/profile-config')
  vi.spyOn(profiles, 'listProfileNamesFromDisk').mockReturnValue(['default', 'work', 'private'])
  const { issueUserJwt } = await import('../../packages/server/src/modules/studio/middleware/auth')
  const user = real.createUser({ username: 'two-profiles', password: 'fixture', profiles: ['default', 'work'] })!
  const other = real.createUser({ username: 'work-only', password: 'fixture', profiles: ['work'] })!
  const token = await issueUserJwt(user)
  const otherToken = await issueUserJwt(other)
  const inbox = (token: string, namespace = '/chat-run') => h.openClient(null, { pending_interactions: 'account' }, token, namespace)
  const close = async () => { try { await h.close() } finally { vi.unstubAllEnvs() } }
  return { ...h, user, token, other, otherToken, real, inbox, close }
}

it('delivers exactly the linked Profiles and the owner’s private Bot to authenticated account inboxes', async () => {
  const h = await accountFixture()
  try {
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const request = (sid: string, id: string) => h.chat.emitExternalEvent(sid, 'clarify.requested', {
      event: 'clarify.requested', clarify_id: id, question: 'Pick a version', timeout_ms: 300_000,
    })
    for (const profile of ['default', 'work', 'private']) {
      const sid = 'chat-' + profile
      createSession({ id: sid, profile, source: 'cli', studio_user_id: h.user.id })
      h.chat['sessionMap'].set(sid, { profile, source: 'cli', isWorking: true, messages: [], events: [], queue: [] })
      request(sid, 'question-' + profile)
    }
    const first = h.inbox(h.token)
    const snapshot = 'pending.interactions.snapshot'
    const ids = (data: { events: Array<{ session_id: string; profile: string }> }) => [...new Map(data.events.map(e => [e.session_id, e.profile])).entries()].sort()
    expect(ids(await result(first, snapshot))).toEqual([['chat-default', 'default'], ['chat-work', 'work']])
    const second = h.inbox(h.otherToken)
    expect(ids(await result(second, snapshot))).toEqual([['chat-work', 'work']])
    expect(h.namespace.sockets.get(first.id!)!.eventNames()).not.toContain('run')
    expect(h.namespace.sockets.get(first.id!)!.eventNames()).not.toContain('approval.respond')
    expect(await result(h.inbox('invalid'), 'connect_error')).toMatchObject({ message: 'Authentication failed' })
    expect(await result(h.inbox('sst1_guest'), 'connect_error')).toMatchObject({ message: 'An account login is required' })
    expect(await result(h.openClient('default', {}, h.otherToken), 'connect_error')).toMatchObject({ message: 'Profile access denied' })

    const previousConnection = h.openClient('work', {}, h.otherToken)
    await result(previousConnection, 'connect')
    const profileRequests: string[] = []
    previousConnection.on('clarify.requested', e => profileRequests.push(e.clarify_id))
    createSession({ id: 'mixed-ownership', profile: 'private', source: 'cli' })
    h.chat['sessionMap'].set('mixed-ownership', { profile: 'work', source: 'cli', isWorking: true, messages: [], events: [], queue: [] })
    const received: string[] = []
    second.on('pending.interaction', e => received.push(e.clarify_id))
    request('mixed-ownership', 'hidden-session')
    request('chat-private', 'hidden')
    const defaultOnly = result(first, 'pending.interaction')
    request('chat-default', 'also-hidden')
    expect(await defaultOnly).toMatchObject({ clarify_id: 'also-hidden' })
    const ownerBot = result(first, 'pending.interaction')
    request('person-main-' + h.user.id, 'owner-only')
    expect(await ownerBot).toMatchObject({ clarify_id: 'owner-only' })
    const profileVisible = result(previousConnection, 'clarify.requested')
    const visible = result(second, 'pending.interaction')
    request('chat-work', 'allowed')
    expect(await visible).toMatchObject({ session_id: 'chat-work', profile: 'work' })
    expect(received).toEqual(['allowed'])
    await profileVisible
    expect(profileRequests).toEqual(['allowed'])

    const disconnected = result(previousConnection, 'disconnect')
    const changed = result(second, snapshot)
    h.real.replaceUserProfiles(h.other.id, ['default', 'private'])
    expect(ids(await changed)).toEqual([['chat-default', 'default'], ['chat-private', 'private']])
    expect(await disconnected).toBe('io server disconnect')
    request('chat-work', 'revoked')
    const newlyLinked = result(second, 'pending.interaction')
    request('chat-private', 'now-visible')
    expect(await newlyLinked).toMatchObject({ clarify_id: 'now-visible', profile: 'private' })
    expect(received).toEqual(['allowed', 'now-visible'])
  } finally { await h.close() }
})

it('follows workflow approvals created after connection and reconciles them when account grants change', async () => {
  const h = await accountFixture()
  const { WorkflowSocketServer } = await import('../../packages/server/src/modules/studio/sockets/workflow')
  const { getWorkflowManager } = await import('../../packages/server/src/modules/studio/services/workflow/manager')
  const manager = getWorkflowManager()
  const workflow = new WorkflowSocketServer(h.io, manager)
  workflow.init()
  try {
    const socket = h.inbox(h.otherToken, '/workflow')
    const snapshot = 'pending.interactions.snapshot'
    expect(await result(socket, snapshot)).toEqual({ events: [] })
    const records = ['work', 'private'].map(profile => manager.create({ name: profile + ' flow', profile }))
    const { createWorkflowRun } = await import('../../packages/server/src/modules/studio/repositories/workflow-run-store')
    const statuses = records.map(record => ({ ...manager.getRuntimeStatus(record.id),
      runId: createWorkflowRun({ workflow_id: record.id, profile: record.profile, user_id: h.user.id }).id,
      pendingApprovals: [{ nodeId: 'gate', executionId: 'review' }] }))
    vi.spyOn(manager, 'listRuntimeStatuses').mockReturnValue(statuses)
    const received: string[] = []
    socket.on('pending.interaction', e => received.push(e.profile))
    workflow['emitRuntimeStatus'](statuses[1])
    const granted = result(socket, 'pending.interaction')
    workflow['emitRuntimeStatus'](statuses[0])
    expect(await granted).toMatchObject({ workflowId: records[0].id, profile: 'work', title: 'work flow' })
    expect(received).toEqual(['work'])
    const changed = result(socket, snapshot)
    h.real.replaceUserProfiles(h.other.id, ['private'])
    expect((await changed).events).toEqual([expect.objectContaining({ workflowId: records[1].id, profile: 'private' })])
    const resolved = result(socket, 'pending.interaction')
    workflow['emitRuntimeStatus']({ ...statuses[1], pendingApprovals: [] })
    expect(await resolved).toMatchObject({ workflowId: records[1].id, pendingApprovals: [] })
  } finally { workflow.close(); await h.close() }
})
