import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusinessEvent } from '../../packages/server/src/modules/studio/services/webhooks/business-events'
import type { ChatRunWebhookEvent } from '../../packages/server/src/modules/studio/services/webhooks/envelope'

const auth = vi.hoisted(() => ({
  authenticate: vi.fn(),
  profiles: new Set(['default']),
  sessionOwner: '1' as string | null,
  workflowOwner: 1 as number | null,
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: auth.authenticate }))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  userCanAccessProfile: (_id: number, profile: string) => auth.profiles.has(profile),
  listUserProfiles: () => [...auth.profiles].map(profile_name => ({ profile_name })),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: (id: string) => id === 'missing' ? null : ({ id, profile: 'default', user_id: auth.sessionOwner }),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store', () => ({
  getWorkflowRun: () => ({ workflow_id: 'workflow', profile: 'default', user_id: auth.workflowOwner }),
  getWorkflowRunForSession: () => ({ workflow_id: 'workflow', user_id: auth.workflowOwner }),
}))

import { bindMcuWebhookEvents } from '../../packages/server/src/modules/studio/services/global-agent/mcu-webhook-events'
import { CHAT_WEBHOOK_EVENT_TYPES } from '../../packages/server/src/modules/studio/public/chat-webhooks'
import { businessEvents } from '../../packages/server/src/modules/studio/services/webhooks/business-events'
import { buildChatWebhookEnvelope } from '../../packages/server/src/modules/studio/services/webhooks/envelope'
import { registerGroupEventAccess } from '../../packages/server/src/modules/studio/services/webhooks/app-events'

function mockSocket() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const socket = {
    id: Math.random().toString(), emit: vi.fn(), volatile: { emit: vi.fn() },
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    handlers,
  }
  bindMcuWebhookEvents(socket as any)
  return socket
}

function event(type: ChatRunWebhookEvent['type'] = 'chat.run.completed', id: string = type): BusinessEvent {
  const source = type.startsWith('group.') ? 'group_chat' : type.startsWith('workflow.') ? 'workflow' : 'chat'
  const subject = source === 'group_chat' ? { room_id: 'room', session_id: 'session', run_id: 'run' }
    : source === 'workflow' ? { workflow_id: 'workflow', run_id: 'run' } : { session_id: 'session' }
  const chat: ChatRunWebhookEvent = {
    id, type, occurred_at: new Date().toISOString(), profile: 'default', source,
    subject, summary: { status: 'completed' }, content: 'Private content',
    content_role: type === 'chat.message.created' ? 'user' : 'assistant',
  }
  return { schema_version: 1, id, type, occurred_at: chat.occurred_at, profile: chat.profile,
    source, subject, chat, payload: { apiToken: 'secret', user_id: 999, tool_output: 'secret output' } }
}

const sockets: ReturnType<typeof mockSocket>[] = []
const cleanup: Array<() => void> = []
function connection() { const socket = mockSocket(); sockets.push(socket); return socket }
async function subscribe(socket: ReturnType<typeof mockSocket>, input: Record<string, unknown> = {}) {
  const ack = vi.fn()
  await socket.handlers.get('mcu.events.subscribe')!({ schema_version: 1, apiToken: 'subscriber-jwt', ...input }, ack)
  return ack
}
async function flush() { await new Promise(resolve => setImmediate(resolve)) }
function deliveries(socket: ReturnType<typeof mockSocket>) { return socket.volatile.emit.mock.calls.map(([, body]) => body) }

beforeEach(() => {
  auth.authenticate.mockReset().mockImplementation(async token => token === 'subscriber-jwt'
    ? { id: 1, username: 'owner', role: 'admin' } : null)
  auth.profiles = new Set(['default'])
  auth.sessionOwner = '1'
  auth.workflowOwner = 1
})
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.handlers.get('disconnect')!()
  for (const stop of cleanup.splice(0)) stop()
})

describe('MCU Webhook events', () => {
  it('keeps legacy firmware idle until it explicitly subscribes', async () => {
    const socket = connection()
    businessEvents.publish(event())
    await flush()
    expect(socket.emit).not.toHaveBeenCalled()
    expect(socket.volatile.emit).not.toHaveBeenCalled()
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('delivers the entire Webhook catalog without requiring an HTTP endpoint', async () => {
    cleanup.push(registerGroupEventAccess({ canReceive: () => true }))
    const socket = connection()
    const ack = await subscribe(socket)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: true, types: [...CHAT_WEBHOOK_EVENT_TYPES] }))
    const events = CHAT_WEBHOOK_EVENT_TYPES.map(type => event(type))
    events.forEach(item => businessEvents.publish(item))
    await flush()
    expect(deliveries(socket).map(body => body.event.type)).toEqual([...CHAT_WEBHOOK_EVENT_TYPES])
    for (const [index, body] of deliveries(socket).entries()) {
      expect(body).toEqual({ type: 'mcu.webhook.event', schema_version: 1, event: buildChatWebhookEnvelope(events[index].chat!, false) })
      expect(JSON.stringify(body)).not.toMatch(/secret|apiToken|tool_output|user_id/)
    }
  })

  it.each([
    { schema_version: 2 }, { apiToken: '' }, { apiToken: 'invalid' }, { profile: 'denied' },
    { profile: 2 }, { types: ['unsupported'] }, { types: 'chat.run.completed' },
    { session_ids: [''] }, { room_ids: [1] }, { workflow_ids: Array(101).fill('w') },
    { include_content: 'true' },
  ])('rejects invalid or unauthorized subscriptions: %j', async input => {
    const socket = connection()
    const ack = await subscribe(socket, input)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: 'event_subscription_denied' }))
    businessEvents.publish(event())
    await flush()
    expect(deliveries(socket)).toEqual([])
  })

  it('uses the explicitly authenticated subscriber, rather than a relay transport account', async () => {
    const socket = connection()
    await subscribe(socket, { authorization: 'Bearer subscriber-jwt', apiToken: undefined })
    businessEvents.publish(event())
    await flush()
    expect(deliveries(socket)).toHaveLength(1)
    expect(auth.authenticate).toHaveBeenLastCalledWith('subscriber-jwt')
  })

  it('intersects profile, event and resource filters and supports an empty selection', async () => {
    const socket = connection()
    await subscribe(socket, { types: ['chat.run.completed'], session_ids: ['session'] })
    businessEvents.publish(event())
    businessEvents.publish(event('chat.run.failed'))
    const otherSession = event('chat.run.completed', 'other-session')
    otherSession.chat!.subject.session_id = 'other'
    businessEvents.publish(otherSession)
    businessEvents.publish({ ...event('chat.run.completed', 'other-profile'), profile: 'other' })
    await flush()
    expect(deliveries(socket)).toHaveLength(1)
    await subscribe(socket, { types: [] })
    businessEvents.publish(event('chat.run.completed', 'empty'))
    await flush()
    expect(deliveries(socket)).toHaveLength(1)
    await subscribe(socket, { room_ids: ['room'], workflow_ids: ['workflow'] })
    businessEvents.publish(event('workflow.run.completed', 'wrong-resource-kind'))
    await flush()
    expect(deliveries(socket)).toHaveLength(1)
  })

  it('uses the Webhook content switches for messages, task cards and session goals', async () => {
    const socket = connection()
    const task = event('chat.task.created')
    task.chat!.session_task = {
      id: 'task', revision: 1, status: 'open', title: 'Private goal', summary: 'Details', completion_evidence: '',
      source_message_id: null, evidence_message_id: null, created_at: 1, updated_at: 1, completed_at: null,
    }
    const plan = event('chat.plan.updated')
    plan.chat!.task_plan = {
      session_id: 'session', run_id: 'run', plan_id: 'plan', revision: 1, created_at: 1, updated_at: 1,
      execution_state: 'running', explanation: 'Private explanation', plan: [{ id: 'step', status: 'pending', step: 'Private step' }],
      progress: { total: 1, completed: 0, in_progress: 0, pending: 1, percent: 0 },
    }
    const events = [event(), event('chat.message.created'), task, plan]
    for (const options of [{}, { include_user_content: true }, { include_content: true }, { include_content: true, include_user_content: true }]) {
      await subscribe(socket, options)
      socket.volatile.emit.mockClear()
      events.forEach(item => businessEvents.publish(item))
      await flush()
      expect(deliveries(socket).map(body => body.event)).toEqual(events.map(item => buildChatWebhookEnvelope(
        item.chat!, 'include_content' in options && options.include_content === true,
        'include_user_content' in options && options.include_user_content === true,
      )))
    }
  })

  it('rechecks session ownership, JWT validity, profile access and group membership on delivery', async () => {
    const socket = connection()
    let member = true
    cleanup.push(registerGroupEventAccess({ canReceive: () => member }))
    await subscribe(socket)
    auth.sessionOwner = '2'
    businessEvents.publish(event())
    auth.workflowOwner = 2
    businessEvents.publish(event('workflow.run.completed'))
    member = false
    businessEvents.publish(event('group.message.created'))
    await flush()
    expect(deliveries(socket)).toEqual([])
    auth.sessionOwner = '1'
    auth.profiles.clear()
    businessEvents.publish(event('chat.run.completed', 'revoked-profile'))
    await flush()
    auth.profiles.add('default')
    auth.authenticate.mockResolvedValue(null)
    businessEvents.publish(event('chat.run.completed', 'expired'))
    await flush()
    expect(deliveries(socket)).toEqual([])
  })

  it('deduplicates live events and ignores business events outside the Webhook catalog', async () => {
    const socket = connection()
    await subscribe(socket)
    const item = event()
    businessEvents.publish(item)
    businessEvents.publish(item)
    businessEvents.publish({ ...item, id: 'internal', chat: undefined, type: 'chat.session.removed' })
    await flush()
    expect(deliveries(socket)).toHaveLength(1)
  })

  it('cancels pending authorization when unsubscribed, replaced or disconnected', async () => {
    const socket = connection()
    await subscribe(socket)
    let resolveUser!: (user: any) => void
    auth.authenticate.mockImplementationOnce(() => new Promise(resolve => { resolveUser = resolve }))
    businessEvents.publish(event())
    await Promise.resolve()
    socket.handlers.get('mcu.events.unsubscribe')!({ apiToken: 'subscriber-jwt' })
    resolveUser({ id: 1, role: 'admin' })
    await flush()
    expect(deliveries(socket)).toEqual([])
    await subscribe(socket)
    businessEvents.publish(event('chat.run.completed', 'replaced'))
    await subscribe(socket, { types: [] })
    await flush()
    expect(deliveries(socket)).toEqual([])
    await subscribe(socket)
    businessEvents.publish(event('chat.run.completed', 'disconnected'))
    socket.handlers.get('disconnect')!()
    await flush()
    expect(deliveries(socket)).toEqual([])
  })

  it('does not let an invalid unsubscribe token disable a valid subscription', async () => {
    const socket = connection()
    await subscribe(socket)
    const ack = vi.fn()
    socket.handlers.get('mcu.events.unsubscribe')!({ apiToken: 'wrong' }, ack)
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
    businessEvents.publish(event())
    await flush()
    expect(deliveries(socket)).toHaveLength(1)
  })

  it('bounds pending work and isolates delivery failures from other consumers', async () => {
    const socket = connection()
    await subscribe(socket)
    let resolveUser!: (user: any) => void
    auth.authenticate.mockImplementationOnce(() => new Promise(resolve => { resolveUser = resolve }))
    for (let index = 0; index < 120; index++) businessEvents.publish(event('chat.run.completed', String(index)))
    await Promise.resolve()
    resolveUser({ id: 1, role: 'admin' })
    await flush()
    expect(deliveries(socket)).toHaveLength(100)
    const anotherConsumer = vi.fn()
    cleanup.push(businessEvents.subscribe('mcu-test-independent', anotherConsumer))
    socket.volatile.emit.mockImplementationOnce(() => { throw new Error('transport failure') })
    businessEvents.publish(event('chat.run.completed', 'failed-transport'))
    await flush()
    expect(anotherConsumer).toHaveBeenCalledOnce()
  })

  it('serves the subscription over real Socket.IO and requires resubscription after reconnect', async () => {
    const { createServer } = await import('node:http')
    const { Server } = await import('socket.io')
    const { io } = await import('socket.io-client')
    const http = createServer()
    const server = new Server(http)
    server.of('/global-agent').on('connection', bindMcuWebhookEvents)
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address() as { port: number }
    const client = io(`http://127.0.0.1:${address.port}/global-agent`, { transports: ['websocket'], autoConnect: false })
    const received: any[] = []
    client.on('mcu.webhook.event', body => received.push(body))
    const connect = async () => {
      const ready = new Promise<void>(resolve => client.once('connect', resolve))
      client.connect()
      await ready
    }
    const select = () => new Promise<void>((resolve, reject) => client.emit('mcu.events.subscribe',
      { schema_version: 1, apiToken: 'subscriber-jwt' }, (ack: any) => ack.ok ? resolve() : reject(Error('denied'))))
    try {
      await connect()
      await select()
      businessEvents.publish(event())
      await vi.waitFor(() => expect(received).toHaveLength(1))
      client.disconnect()
      await connect()
      businessEvents.publish(event('chat.run.completed', 'not-subscribed'))
      await flush()
      expect(received).toHaveLength(1)
      await select()
      businessEvents.publish(event('chat.run.completed', 'reconnected'))
      await vi.waitFor(() => expect(received).toHaveLength(2))
    } finally {
      client.disconnect()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
