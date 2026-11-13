import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Koa from 'koa'
import Router from '@koa/router'
import { bodyParser } from '@koa/bodyparser'
import { once } from 'node:events'
import { Server } from 'socket.io'
import { createHostApi } from '../../packages/plugin-sdk/src'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, any>(), abort: vi.fn(), working: true, user: { id: 7, role: 'admin', profiles: ['work'] } as any,
  room: { id: 'room', ownerAuthUserId: 7 }, shared: false,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: (id: string) => mocks.sessions.get(id),
  createSession: (session: any) => { mocks.sessions.set(session.id, session); return session },
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ userCanAccessProfile: (_id: number, profile: string) => profile === 'work' }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => mocks.working, abortSession: mocks.abort }) }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 1 } }))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/access', () => ({ prepareSessionShareRun: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/agent-availability', () => ({ resolveAgentStatusId: (agent: unknown) => ['hermes', 'ekko-agent', 'cursor'].includes(String(agent)) ? agent : null }))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/runtime', () => ({ getGroupChatRuntimeServer: () => ({ getStorage: () => ({
  getRoom: (id: string) => id === 'room' ? mocks.room : undefined,
  getMemberByAuthUserId: (_room: string, id: number) => id === 8 ? {} : undefined,
  getRecentMessagesForUI: () => [{ id: 'm', content: 'history' }], getMessageCount: () => 1,
}) }) }))
import * as sessions from '../../packages/server/src/modules/studio/controllers/session-control'
import * as groups from '../../packages/server/src/modules/studio/controllers/group-chat-control'
import { runOnce } from '../../packages/server/src/modules/studio/controllers/chat-run'
import { groupChatOperation } from '../../packages/server/src/modules/studio/services/group-chat/control'
import { businessEvents } from '../../packages/server/src/modules/studio/services/webhooks/business-events'

beforeEach(() => { vi.clearAllMocks(); mocks.sessions.clear(); mocks.working = true; mocks.shared = false; mocks.user = { id: 7, role: 'admin', profiles: ['work'] } })
afterEach(() => vi.unstubAllEnvs())

async function withServer(test: (api: ReturnType<typeof createHostApi>, io: Server, calls: any[], base: string) => Promise<void>) {
  const app = new Koa(), router = new Router(), calls: any[] = []
  app.use(bodyParser()); app.use(async (ctx, next) => { ctx.state.user = mocks.user; ctx.state.profile = { name: 'work' }; ctx.state.sessionShare = mocks.shared; await next() })
  router.post('/api/studio/sessions', sessions.create).post('/api/studio/sessions/:id/stop', sessions.stop)
    .post('/api/studio/chat-run/runs', runOnce).get('/api/studio/group-chat/rooms/:roomId/messages', groups.messages)
    .post('/api/studio/group-chat/rooms/:roomId/messages', groups.send).post('/api/studio/group-chat/rooms/:roomId/stop', groups.stop)
  app.use(router.routes()); const http = app.listen(0, '127.0.0.1'); await once(http, 'listening')
  const base = `http://127.0.0.1:${(http.address() as any).port}`, io = new Server(http)
  vi.stubEnv('HERMES_WEB_UI_URL', base)
  io.of('/chat-run').on('connection', socket => socket.on('run', data => {
    calls.push({ event: 'run', data, token: socket.handshake.auth.token })
    const runId = data.input === 'queue' ? undefined : 'run-1'
    socket.emit(data.input === 'queue' ? 'run.queued' : 'run.started', { session_id: data.session_id, run_id: runId, queue_id: 'queue-1' })
    if (data.input === 'complete') socket.emit('run.completed', { run_id: runId, output: 'done' })
  }))
  io.of('/group-chat').on('connection', socket => {
    socket.on('join', (data, ack) => { calls.push({ event: 'join', data, token: socket.handshake.auth.token }); ack(data.roomId === 'denied' ? { error: 'Access denied' } : { ok: true }) })
    socket.on('message', (data, ack) => { calls.push({ event: 'message', data }); ack({ ok: true, id: 'message-1' }) })
    socket.on('interrupt_agent', (data, ack) => { calls.push({ event: 'interrupt_agent', data }); ack(socket.handshake.auth.token === 'denied' ? { error: 'Access denied' } : { ok: true }) })
  })
  const api = createHostApi(async (path, options = {}) => {
    const url = new URL(path, base)
    for (const [key, value] of Object.entries(options.query || {})) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await fetch(url, { method: options.method, headers: { Authorization: 'Bearer test-user', 'Content-Type': 'application/json' }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status })
    return result
  })
  try { await test(api, io, calls, base) }
  finally { await new Promise<void>(done => io.close(() => done())); http.closeAllConnections(); http.close() }
}

it('creates an empty session, starts asynchronously, waits on request, queues, and stops only authorized sessions', async () => {
  const events: any[] = [], unsubscribe = businessEvents.subscribe('controls-test', event => events.push(event))
  try { await withServer(async (api, _io, calls) => {
    const result: any = await api.sessions.create({ title: 'Created by plugin' })
    expect(result.session).toMatchObject({ user_id: 7, profile: 'work', agent: 'ekko-agent', source: 'builtin_agent' })
    expect(calls).toHaveLength(0)
    expect(events[0]).toMatchObject({ type: 'chat.session.created', subject: { session_id: result.session.id } })
    const model = { provider: 'custom:test', model: 'demo', apiMode: 'chat_completions' }
    const started: any = await api.sessions.run(result.session.id, 'start', model)
    expect(started).toMatchObject({ status: 'running', run_id: 'run-1', session_id: result.session.id })
    expect(calls[0]).toMatchObject({ token: 'test-user', data: { agent_id: 'ekko-agent', source: 'builtin_agent', profile: 'work', ...model } })
    expect(calls[0].data).not.toHaveProperty('wait')
    expect(await api.sessions.run(result.session.id, 'complete', { ...model, wait: true })).toMatchObject({ status: 'completed', output: 'done' })
    expect(await api.sessions.run(result.session.id, 'queue', model)).toMatchObject({ status: 'queued' })
    expect(await api.sessions.stop(result.session.id)).toMatchObject({ stopped: true })
    expect(mocks.abort).toHaveBeenCalledWith(result.session.id, 'Stopped by user')
    mocks.working = false; expect(await api.sessions.stop(result.session.id)).toMatchObject({ stopped: false })
    expect(mocks.abort).toHaveBeenCalledTimes(1)
    mocks.sessions.set('foreign', { id: 'foreign', profile: 'private', agent: 'hermes' })
    mocks.sessions.set('legacy', { id: 'legacy', profile: 'work', source: 'api_server', agent: '' })
    expect(await api.sessions.run('legacy', 'start')).toMatchObject({ status: 'running' })
    expect(calls.at(-1).data).not.toHaveProperty('agent_id')
    await expect(api.sessions.stop('foreign')).rejects.toMatchObject({ status: 403 })
    await expect(api.sessions.run('foreign', 'no')).rejects.toMatchObject({ status: 403 })
    await expect(api.sessions.stop('person-task-hidden')).rejects.toMatchObject({ status: 404 })
    mocks.sessions.set('workflow-node', { id: 'workflow-node', profile: 'work', source: 'workflow' })
    await expect(api.sessions.stop('workflow-node')).rejects.toMatchObject({ status: 409 })
  }) } finally { unsubscribe() }
})

it('validates session creation and rejects unauthenticated and shared access', async () => {
  await withServer(async api => {
    await expect(api.sessions.create({ agent: 'unknown' })).rejects.toMatchObject({ status: 400 })
    expect(await api.sessions.create({ agent: 'cursor' })).toMatchObject({ session: { agent_mode: 'global' } })
    mocks.user = undefined; await expect(api.sessions.create()).rejects.toMatchObject({ status: 401 })
    mocks.shared = true; await expect(api.sessions.create()).rejects.toMatchObject({ status: 403 })
  })
})

it('sends and interrupts through authenticated group transport, strips forged identity and checks room history access', async () => {
  await withServer(async (api, _io, calls) => {
    expect(await api.groupChats.send('room', 'hello', [{ type: 'agent', name: 'Writer' }])).toMatchObject({ id: 'message-1' })
    expect(calls[0]).toMatchObject({ event: 'join', token: 'test-user' })
    expect(calls[1]).toMatchObject({ event: 'message', data: { roomId: 'room', content: 'hello', mentions: [{ type: 'agent', name: 'Writer' }] } })
    await api.request('/api/studio/group-chat/rooms/room/messages', { method: 'POST', body: { content: 'hello', senderId: 'admin', role: 'assistant', agentSessionId: 'forged' } })
    expect(calls.at(-1).data).toEqual({ content: 'hello', roomId: 'room' })
    expect(await api.groupChats.stop('room', 'Writer')).toEqual({ ok: true })
    expect(calls.at(-1)).toEqual({ event: 'interrupt_agent', data: { roomId: 'room', agentName: 'Writer' } })
    mocks.user.id = 8; expect(await api.groupChats.messages('room')).toMatchObject({ total: 1, hasMore: false })
    mocks.user.id = 9; await expect(api.groupChats.send('room', 'forbidden')).rejects.toMatchObject({ status: 403 })
    await expect(api.groupChats.messages('room')).rejects.toMatchObject({ status: 403 })
    await expect(api.groupChats.messages('missing')).rejects.toMatchObject({ status: 404 })
  })
})

it('does not mutate after a denied join or canceled request and preserves interrupt permission errors', async () => {
  await withServer(async (_api, _io, calls) => {
    const controller = new AbortController()
    await expect(groupChatOperation('test', 'denied', 'message', { content: 'no' }, controller.signal)).rejects.toMatchObject({ status: 403 })
    expect(calls.filter(call => call.event === 'message')).toHaveLength(0)
    await expect(groupChatOperation('denied', 'room', 'interrupt_agent', { agentName: 'Writer' }, controller.signal)).rejects.toMatchObject({ status: 403 })
    controller.abort()
    await expect(groupChatOperation('test', 'room', 'message', { content: 'no' }, controller.signal)).rejects.toThrow()
    expect(calls.filter(call => call.event === 'message')).toHaveLength(0)
  })
})
