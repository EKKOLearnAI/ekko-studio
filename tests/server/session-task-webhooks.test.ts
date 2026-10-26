import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { ChatRunWebhookEvent } from '../../packages/server/src/modules/studio/services/webhooks/envelope'

let db: DatabaseSync
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
let tasks: typeof import('../../packages/server/src/modules/studio/services/session-tasks')
let webhooks: typeof import('../../packages/server/src/modules/studio/services/webhooks')
let events: ChatRunWebhookEvent[]
const dispatchers: Array<{ stop: () => void }> = []

beforeEach(async () => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
    getDb: () => db, getStoragePath: () => ':memory:', isSqliteAvailable: () => true,
  }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  tasks = await import('../../packages/server/src/modules/studio/services/session-tasks')
  webhooks = await import('../../packages/server/src/modules/studio/services/webhooks')
  sessions.createSession({ id: 'task-session', profile: 'research', source: 'coding_agent' })
  sessions.addMessage({ session_id: 'task-session', role: 'user', content: 'Build export and search', timestamp: Date.now() })
  events = []
  vi.spyOn(webhooks.getChatWebhookDispatcher(), 'enqueue').mockImplementation(event => {
    events.push(event)
    return true
  })
})

afterEach(() => {
  for (const dispatcher of dispatchers.splice(0)) dispatcher.stop()
  webhooks.stopChatWebhookDispatcher()
  vi.restoreAllMocks()
  db.close()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
})

const goal = (patch = {}) => ({ title: 'Export', summary: 'Export requested', status: 'open', ...patch })
const write = (changes: unknown[], revision = tasks.getSessionTasks('task-session').revision) =>
  tasks.updateSessionTasks('task-session', 'research', { revision, changes })

describe('session-task lifecycle webhooks', () => {
  it('emits manual completion once and never reports closing as completion', () => {
    let task = write([goal()]).tasks[0]
    const change = (status: 'open' | 'completed' | 'closed') => {
      task = tasks.setSessionTaskStatus('task-session', 'research', task.id, { status, expected_updated_at: task.updated_at }).tasks[0]
    }
    change('closed')
    expect(events.map(event => event.type)).toEqual(['chat.task.created'])
    change('completed')
    change('completed')
    expect(events.map(event => event.type)).toEqual(['chat.task.created', 'chat.task.completed'])
    expect(events[1].session_task).toMatchObject({ completion_evidence: 'Manually marked completed by the user.' })
    change('closed')
    expect(events).toHaveLength(2)
  })

  it('publishes each created task after commit, then only the task that becomes completed', () => {
    const dispatcher = webhooks.getChatWebhookDispatcher()
    const enqueue = vi.mocked(dispatcher.enqueue)
    enqueue.mockImplementation(event => {
      expect(tasks.getSessionTasks('task-session').tasks.find(task => task.id === event.subject.task_id))
        .toMatchObject({ id: event.subject.task_id, status: event.session_task!.status })
      events.push(event)
      return true
    })
    const first = write([goal(), goal({ title: 'Search' })])
    expect(events.map(event => event.type)).toEqual(['chat.task.created', 'chat.task.created'])
    expect(new Set(events.map(event => event.id)).size).toBe(2)
    expect(events[0]).toMatchObject({ profile: 'research', source: 'coding_agent', summary: { status: 'created' },
      subject: { session_id: 'task-session', task_id: first.tasks[0].id }, session_task: { revision: 1 } })
    tasks.getSessionTasks('task-session')
    const task = first.tasks.find(task => task.title === 'Export')!
    write([goal({ id: task.id, summary: 'Export ready', status: 'completed', completion_evidence: 'Export tests passed' })])
    expect(events.map(event => event.type)).toEqual(['chat.task.created', 'chat.task.created', 'chat.task.completed'])
    expect(events[2]).toMatchObject({ subject: { task_id: task.id }, summary: { status: 'completed' },
      session_task: { id: task.id, status: 'completed', revision: 2, completion_evidence: 'Export tests passed' } })
    expect(tasks.getSessionTasks('task-session').tasks).toHaveLength(2)
  })

  it('ignores edits, repeated statuses and reopening; a later completion has a new event identity', () => {
    const first = write([goal()])
    const id = first.tasks[0].id
    write([goal({ title: ' EXPORT ', summary: 'In progress' })])
    expect(events).toHaveLength(1)
    const completed = goal({ id, status: 'completed', completion_evidence: 'Checks passed' })
    write([completed])
    const initialCompletion = events[1]
    write([completed])
    write([goal({ id, title: 'CSV export', summary: 'Updated evidence', status: 'completed', completion_evidence: 'More checks passed' })])
    expect(events).toHaveLength(2)
    write([goal({ id })])
    expect(events).toHaveLength(2)
    write([completed])
    expect(events).toHaveLength(3)
    expect(events[2].type).toBe('chat.task.completed')
    expect(events[2].id).not.toBe(initialCompletion.id)
  })

  it('emits creation and completion when a new goal is first saved as completed', () => {
    write([goal({ status: 'completed', completion_evidence: 'Delivered and verified' })])
    expect(events.map(event => event.type)).toEqual(['chat.task.created', 'chat.task.completed'])
    expect(events[0].subject).toEqual(events[1].subject)
    expect(events[0].id).not.toBe(events[1].id)
    expect(events.map(event => event.session_task!.revision)).toEqual([1, 1])
  })

  it('does not publish failed batches, stale writes, foreign profiles or reads', () => {
    const first = write([goal()])
    expect(() => write([goal()], 0)).toThrow('changed')
    expect(() => tasks.updateSessionTasks('task-session', 'other', { revision: 1, changes: [goal()] })).toThrow('unavailable')
    expect(() => write([goal({ title: 'Must roll back' }), goal({ id: 'unknown' })])).toThrow('Unknown')
    expect(() => write([goal({ id: first.tasks[0].id, status: 'completed' })])).toThrow('completion_evidence')
    expect(tasks.getSessionTasks('task-session')).toEqual(first)
    expect(events).toHaveLength(1)
  })

  it('does not fail committed writes when the event hub throws', async () => {
    const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
    const { logger } = await import('../../packages/server/src/modules/studio/public/logging')
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    vi.spyOn(businessEvents, 'publish').mockImplementation(() => { throw new Error('Consumer unavailable') })
    expect(() => write([goal()])).not.toThrow()
    expect(tasks.getSessionTasks('task-session').tasks).toHaveLength(1)
  })

  it('projects allowlisted task metadata and gates all task text behind include_content', () => {
    write([goal({ title: 'Private title', summary: 'Private summary', status: 'completed', completion_evidence: 'Private evidence' })])
    const event = events[1]
    Object.assign(event.session_task!, { token: 'SECRET', context_id: 'SECRET', command: 'SECRET' })
    const hidden = webhooks.buildChatWebhookEnvelope(event, false, true)
    expect(hidden.session_task).toMatchObject({ id: event.subject.task_id, status: 'completed', revision: 1,
      source_message_id: expect.any(Number), evidence_message_id: expect.any(Number), completed_at: expect.any(Number) })
    expect(JSON.stringify(hidden)).not.toMatch(/Private|SECRET|context_id|command/)
    expect(hidden).not.toHaveProperty('message')
    const visible = webhooks.buildChatWebhookEnvelope(event, true)
    expect(visible.session_task).toMatchObject({ title: 'Private title', summary: 'Private summary', completion_evidence: 'Private evidence' })
    expect(JSON.stringify(visible)).not.toContain('SECRET')
  })

  it('delivers signed lifecycle events with profile/type filtering and stable identity on retry', async () => {
    const controller = await import('../../packages/server/src/modules/studio/controllers/chat-webhooks')
    const { createChatWebhookEndpoint } = await import('../../packages/server/src/modules/studio/repositories/chat-webhook-store')
    const ctx = { request: { body: { name: 'Tasks', url: 'https://93.184.216.34/tasks', secret: 'task-secret',
      event_types: ['chat.task.created', 'chat.task.completed'], profiles: ['research'], max_retries: 1 } } } as any
    await controller.createEndpoint(ctx)
    expect(ctx.status).toBe(201)
    expect(ctx.body.endpoint.event_types).toEqual(['chat.task.created', 'chat.task.completed'])
    createChatWebhookEndpoint({ ...ctx.request.body, name: 'Other profile', url: 'https://93.184.216.35/other', profiles: ['other'] })
    createChatWebhookEndpoint({ ...ctx.request.body, name: 'Other type', url: 'https://93.184.216.36/other', event_types: ['chat.run.completed'] })
    const first = write([goal()])
    write([goal({ id: first.tasks[0].id, status: 'completed', completion_evidence: 'Tests passed' })])
    const calls: Array<{ url: string; body: any; headers: Record<string, string>; raw: string }> = []
    const dispatcher = new webhooks.ChatWebhookDispatcher({ retryBaseMs: 1, retryMaxMs: 1, random: () => 0,
      fetchImpl: vi.fn(async (url, init) => {
        const raw = String(init?.body)
        calls.push({ url: String(url), body: JSON.parse(raw), headers: init?.headers as Record<string, string>, raw })
        return new Response(null, { status: calls.length === 1 ? 503 : 204 })
      }) as typeof fetch })
    dispatchers.push(dispatcher)
    dispatcher.start()
    for (const event of events) dispatcher.enqueue(event)
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.map(call => call.url)).toEqual(Array(3).fill('https://93.184.216.34/tasks'))
    expect(calls.map(call => call.body.type)).toEqual(['chat.task.created', 'chat.task.created', 'chat.task.completed'])
    expect(calls[0].body.id).toBe(calls[1].body.id)
    for (const { body, headers, raw } of calls) {
      expect(headers[webhooks.EVENT_HEADER]).toBe(body.type)
      expect(headers[webhooks.SIGNATURE_HEADER]).toBe(webhooks.signChatWebhookPayload('task-secret', headers[webhooks.TIMESTAMP_HEADER], raw))
      expect(body.session_task).not.toHaveProperty('title')
    }
  })
})
