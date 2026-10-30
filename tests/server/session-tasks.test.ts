import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
let service: typeof import('../../packages/server/src/modules/studio/services/session-tasks')
beforeEach(async () => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  service = await import('../../packages/server/src/modules/studio/services/session-tasks')
  sessions.createSession({ id: 's1', profile: 'research', source: 'coding_agent' })
})
afterEach(async () => {
  const { stopChatWebhookDispatcher } = await import('../../packages/server/src/modules/studio/services/webhooks/dispatcher')
  stopChatWebhookDispatcher()
  db.close()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
})
function message(role: string, content: string, sessionId = 's1') {
  return Number(sessions.addMessage({ session_id: sessionId, role, content, timestamp: Date.now() }))
}
const goal = (overrides = {}) => ({ title: 'Add data export', summary: 'Requested; implementation pending', status: 'open', ...overrides })
const write = (changes: unknown[], revision = service.getSessionTasks('s1').revision) => service.updateSessionTasks('s1', 'research', { revision, changes })

describe('conversation-maintained session goals', () => {
  it('creates multiple goals before execution, completes only verified outcomes, and retains omitted tasks across turns', () => {
    const source = message('user', 'Add data export and fix login')
    const first = write([goal(), goal({ title: 'Fix login' })])
    const exportGoal = first.tasks.find(task => task.title === 'Add data export')!
    expect(first.tasks.every(task => task.status === 'open')).toBe(true)
    expect(exportGoal.source_message_id).toBe(source)
    message('tool', 'CSV export integration tests pass')
    const second = write([goal({ id: exportGoal.id, summary: 'CSV export delivered', status: 'completed', completion_evidence: 'CSV integration tests passed' })])
    expect(second.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: exportGoal.id, status: 'completed', completed_at: expect.any(Number) }),
      expect.objectContaining({ title: 'Fix login', status: 'open' }),
    ]))
    message('assistant', 'CSV export delivered; login is still pending')
    message('user', 'Large export files still fail; please fix that')
    const third = write([goal({ id: exportGoal.id, summary: 'Large exports fail; investigating' })])
    expect(third.tasks.find(task => task.id === exportGoal.id)).toMatchObject({ status: 'open', source_message_id: source, completed_at: null, completion_evidence: '' })
    expect(third.tasks).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_plans').get()).toMatchObject({ n: 0 })
  })

  it('reuses ids for repeated titles and survives service reloads without a separate model', async () => {
    message('user', 'Add data export')
    const first = write([goal()])
    message('user', 'Continue export')
    const nextService = await import('../../packages/server/src/modules/studio/services/session-tasks')
    const next = nextService.updateSessionTasks('s1', 'research', { revision: first.revision, changes: [goal({ title: 'Add Data Export', summary: 'Continuing' })] })
    expect(next.tasks).toHaveLength(1)
    expect(next.tasks[0].id).toBe(first.tasks[0].id)
    expect(next.tasks[0].source_message_id).toBe(first.tasks[0].source_message_id)
  })

  it('keeps tasks open when a turn ends or is interrupted without an explicit verified completion', () => {
    message('user', 'Add export')
    const first = write([goal()])
    message('assistant', 'I will implement it next')
    expect(service.getSessionTasks('s1')).toEqual(first)
    expect(() => write([goal({ id: first.tasks[0].id, status: 'completed' })])).toThrow('completion_evidence')
    expect(service.getSessionTasks('s1')).toEqual(first)
  })

  it('rejects stale revisions, another profile, foreign ids and mixed invalid batches atomically', () => {
    message('user', 'Add export')
    const first = write([goal()])
    expect(() => write([goal()], 0)).toThrow('changed')
    expect(() => service.updateSessionTasks('s1', 'other', { revision: 1, changes: [goal()] })).toThrow('unavailable')
    sessions.createSession({ id: 's2', profile: 'research', source: 'coding_agent' })
    message('user', 'Do another task', 's2')
    const foreign = service.updateSessionTasks('s2', 'research', { revision: 0, changes: [goal()] }).tasks[0]
    expect(() => write([goal({ summary: 'Should roll back' }), goal({ id: foreign.id, title: 'Other task' })])).toThrow('Unknown')
    expect(service.getSessionTasks('s1')).toEqual(first)
  })

  it('rejects history changes even when the caller supplies the latest task revision', () => {
    message('user', 'Add export')
    write([goal()])
    sessions.clearSessionMessages('s1')
    message('user', 'New task')
    expect(() => service.updateSessionTasks('s1', 'research', { revision: service.getSessionTasks('s1').revision, changes: [goal()] }, 0)).toThrow('history changed')
  })

  it('reopens goals when completion anchors are deleted and removes goals when their request anchors are deleted', async () => {
    const source = message('user', 'Add export')
    const first = write([goal()])
    const evidence = message('tool', 'CSV tests passed')
    write([goal({ id: first.tasks[0].id, status: 'completed', completion_evidence: 'CSV checks passed' })])
    const { deleteSessionMessageGroups } = await import('../../packages/server/src/modules/studio/repositories/session-message-deletion')
    deleteSessionMessageGroups('s1', [evidence], 0)
    expect(service.getSessionTasks('s1').tasks[0]).toMatchObject({ status: 'open', completed_at: null, evidence_message_id: null })
    deleteSessionMessageGroups('s1', [source], 1)
    expect(service.getSessionTasks('s1').tasks).toEqual([])
  })

  it.each(['clearSessionMessages', 'deleteSession'] as const)('cleans up goals with %s and rejects old revisions', method => {
    message('user', 'Add export')
    write([goal()])
    sessions[method]('s1')
    expect(service.getSessionTasks('s1').tasks).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_tasks WHERE session_id = ?').get('s1')).toMatchObject({ n: 0 })
    expect(() => write([goal()], 1)).toThrow()
  })

  it.each(['group_chat', 'workflow', 'global_agent'])('rejects writes from %s sessions', source => {
    db.prepare('UPDATE sessions SET source = ? WHERE id = ?').run(source, 's1')
    message('user', 'Do work')
    expect(() => write([goal()])).toThrow('unavailable')
  })

  it.each([{ revision: -1, changes: [goal()] }, { revision: 0, changes: [] }, { revision: 0, changes: [goal({ status: 'pending' })] },
    { revision: 0, changes: [goal()], session_id: 'other' }, { revision: 0, changes: [goal({ source_message_id: 123 })] }])('rejects malformed or caller-selected scope: %j', input => {
    message('user', 'Do work')
    expect(() => service.updateSessionTasks('s1', 'research', input)).toThrow()
    expect(service.getSessionTasks('s1').tasks).toEqual([])
  })
})

describe('manual task status', () => {
  it('closes tasks, protects them from model writes and permits a manual reopening', () => {
    message('user', 'Add export and fix login')
    const first = write([goal(), goal({ title: 'Fix login' })])
    const task = first.tasks.find(item => item.title === 'Add data export')!
    const closed = service.setSessionTaskStatus('s1', 'research', task.id, { status: 'closed', expected_updated_at: task.updated_at })
    expect(closed.revision).toBe(first.revision + 1)
    const saved = closed.tasks.find(item => item.id === task.id)!
    expect(saved).toMatchObject({ status: 'closed', completed_at: null, evidence_message_id: null, completion_evidence: '' })
    expect(saved.updated_at).toBeGreaterThan(task.updated_at)
    expect(() => write([goal({ title: 'Fix login', summary: 'Must roll back' }), goal({ id: task.id })])).toThrow('closed by the user')
    expect(() => write([goal({ status: 'completed', completion_evidence: 'Model says done' })])).toThrow('closed by the user')
    expect(service.getSessionTasks('s1')).toEqual(closed)
    const reopened = service.setSessionTaskStatus('s1', 'research', task.id, { status: 'open', expected_updated_at: saved.updated_at })
    expect(reopened.tasks.find(item => item.id === task.id)?.status).toBe('open')
    expect(write([goal({ id: task.id, status: 'completed', completion_evidence: 'Export checks passed' })]).tasks.find(item => item.id === task.id)?.status).toBe('completed')
  })

  it('records manual completion honestly without anchoring it to an unrelated conversation turn', () => {
    const source = message('user', 'Add export')
    const first = write([goal()])
    const task = first.tasks[0]
    message('user', 'Discuss another topic')
    const completed = service.setSessionTaskStatus('s1', 'research', task.id, { status: 'completed', expected_updated_at: task.updated_at })
    expect(completed.tasks[0]).toMatchObject({ status: 'completed', completion_evidence: 'Manually marked completed by the user.', evidence_message_id: source })
    expect(completed.tasks[0].completed_at).toBeGreaterThan(0)
    const unchanged = service.setSessionTaskStatus('s1', 'research', task.id, { status: 'completed', expected_updated_at: completed.tasks[0].updated_at })
    expect(unchanged).toEqual(completed)
    expect(() => write([goal()], first.revision)).toThrow('changed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_plans').get()).toMatchObject({ n: 0 })
  })

  it('rejects stale rows, foreign profiles and task ids without changing any tasks', () => {
    message('user', 'Add export')
    const first = write([goal()])
    const task = first.tasks[0]
    const latest = write([goal({ id: task.id, summary: 'Implementation in progress' })])
    expect(() => service.setSessionTaskStatus('s1', 'research', task.id, { status: 'closed', expected_updated_at: task.updated_at })).toThrow('changed')
    expect(() => service.setSessionTaskStatus('s1', 'other', task.id, { status: 'closed', expected_updated_at: latest.tasks[0].updated_at })).toThrow('unavailable')
    expect(() => service.setSessionTaskStatus('s1', 'research', 'foreign-task', { status: 'closed', expected_updated_at: latest.tasks[0].updated_at })).toThrow('not found')
    expect(service.getSessionTasks('s1')).toEqual(latest)
  })

  it.each([{ status: 'pending', expected_updated_at: 0 }, { status: 'closed' }, { status: 'closed', expected_updated_at: -1 },
    { status: 'closed', expected_updated_at: '1' }, { status: 'closed', expected_updated_at: 1, profile: 'other' }])('rejects invalid manual status input %j', input => {
    expect(() => service.setSessionTaskStatus('s1', 'research', 'task', input)).toThrow('required')
  })

  it.each(['group_chat', 'workflow', 'global_agent'])('rejects manual changes in %s sessions', source => {
    message('user', 'Add export')
    const task = write([goal()]).tasks[0]
    db.prepare('UPDATE sessions SET source = ? WHERE id = ?').run(source, 's1')
    expect(() => service.setSessionTaskStatus('s1', 'research', task.id, { status: 'closed', expected_updated_at: task.updated_at })).toThrow('unavailable')
  })

  it('lists recently closed tasks first, filters them and preserves the request link', () => {
    const source = message('user', 'Add export')
    const first = write([goal(), goal({ title: 'Other task' }), goal({ title: 'Done task', status: 'completed', completion_evidence: 'Checked' })])
    const task = first.tasks.find(item => item.title === 'Add data export')!
    service.setSessionTaskStatus('s1', 'research', task.id, { status: 'closed', expected_updated_at: task.updated_at })
    const query = { profiles: ['research'], order: 'newest' as const, offset: 0, limit: 50 }
    expect(service.listSessionTaskItems(query).tasks[0]).toMatchObject({ id: task.id, status: 'closed' })
    const filtered = service.listSessionTaskItems({ ...query, status: 'closed' })
    expect(filtered.total).toBe(1)
    expect(filtered.tasks[0]).toMatchObject({ id: task.id, status: 'closed', message_id: source })
  })
})

describe('task list pages', () => {
  const query = (overrides = {}) => ({ profiles: ['research'], order: 'newest' as const, offset: 0, limit: 50, ...overrides })

  it.each([
    { order: 'newest', expected: ['a-completed', 'b-open', 'c-closed', 'd-open'] },
    { order: 'oldest', expected: ['d-open', 'c-closed', 'a-completed', 'b-open'] },
  ])('paginates by update time regardless of status with $order first', ({ order, expected }) => {
    const source = message('user', 'Several goals')
    const insert = db.prepare('INSERT INTO session_tasks (id, session_id, title, summary, status, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [id, status, createdAt, updatedAt] of [
      ['d-open', 'open', 4, 10],
      ['c-closed', 'closed', 3, 30],
      ['b-open', 'open', 2, 40],
      ['a-completed', 'completed', 1, 40],
    ] as const) insert.run(id, 's1', id, '', status, source, createdAt, updatedAt)

    const first = service.listSessionTaskItems(query({ order, limit: 2 }))
    const second = service.listSessionTaskItems(query({ order, limit: 2, offset: 2 }))
    expect(first).toMatchObject({ total: 4, has_more: true })
    expect(second).toMatchObject({ total: 4, has_more: false })
    expect([...first.tasks, ...second.tasks].map(task => task.id)).toEqual(expected)
    expect(service.listSessionTaskItems(query({ order, status: 'open' })).tasks.map(task => task.id))
      .toEqual(expected.filter(id => id.endsWith('-open')))
  })

  it('uses the same first-message session name as the conversation list without persisting a title', () => {
    message('assistant', 'An assistant greeting is not the session name')
    const firstMessage = '首条用户消息\n用于展示会话名称，保留与会话列表相同的截断规则。'.repeat(3)
    message('user', firstMessage)
    message('user', 'This later request must not become the name')
    write([goal()])
    const task = service.listSessionTaskItems(query()).tasks[0]
    const session = sessions.listSessions('research')[0]
    expect(task.session_title).toBe(session.title)
    expect(task.session_title).toBe(firstMessage.replace(/\n/g, ' ').slice(0, 40) + '...')
    expect(task).not.toHaveProperty('session_preview')
    expect(db.prepare('SELECT title FROM sessions WHERE id = ?').get('s1')).toMatchObject({ title: null })
    expect(service.listSessionTaskItems(query({ search: '首条用户消息' })).total).toBe(1)
    expect(service.listSessionTaskItems(query({ search: 'later request' })).total).toBe(0)
  })

  it('prefers a custom session title, then the stored preview, and keeps genuinely unnamed sessions empty', () => {
    message('user', '首条消息')
    write([goal()])
    sessions.updateSession('s1', { preview: '缓存的首条会话消息' })
    expect(service.listSessionTaskItems(query()).tasks[0].session_title).toBe(sessions.listSessions('research')[0].title)
    expect(service.listSessionTaskItems(query()).tasks[0].session_title).toBe('缓存的首条会话消息')
    sessions.renameSession('s1', '自定义会话标题')
    expect(service.listSessionTaskItems(query()).tasks[0].session_title).toBe('自定义会话标题')
    sessions.renameSession('s1', '')
    sessions.updateSession('s1', { preview: '' })
    db.prepare('DELETE FROM messages WHERE session_id = ?').run('s1')
    expect(service.listSessionTaskItems(query()).tasks[0].session_title).toBeNull()
  })

  it('caps the accessible list at 100 across pages without deleting stored goals', () => {
    const id = message('user', 'Many tasks')
    const insert = db.prepare('INSERT INTO session_tasks (id, session_id, title, summary, status, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (let i = 1; i <= 125; i++) insert.run(`task-${i}`, 's1', `Task ${i}`, '', 'open', id, i, i)
    const first = service.listSessionTaskItems(query())
    const second = service.listSessionTaskItems(query({ offset: 50 }))
    expect(first).toMatchObject({ total: 100, has_more: true })
    expect(second).toMatchObject({ total: 100, has_more: false })
    expect(new Set([...first.tasks, ...second.tasks].map(task => task.id)).size).toBe(100)
    expect(first.tasks[0].title).toBe('Task 125')
    expect(second.tasks.at(-1)?.title).toBe('Task 26')
    expect(service.listSessionTaskItems(query({ offset: 95, limit: 100 })).tasks).toHaveLength(5)
    expect(service.listSessionTaskItems(query({ offset: 100 }))).toEqual({ tasks: [], total: 100, has_more: false })
    expect(service.listSessionTaskItems(query({ offset: 150 }))).toEqual({ tasks: [], total: 100, has_more: false })
    expect(service.listSessionTaskItems(query({ search: 'Task 1' })).total).toBe(37)
    expect(service.getSessionTasks('s1').tasks).toHaveLength(125)
  })

  it('deleting multiple sessions removes their task rows while retaining other sessions', () => {
    for (const id of ['s1', 's2', 'kept']) {
      if (id !== 's1') sessions.createSession({ id, profile: 'research', source: 'coding_agent' })
      message('user', 'Task request', id)
      service.updateSessionTasks(id, 'research', { revision: 0, changes: [goal({ title: id })] })
    }
    for (const id of ['s1', 's2']) expect(sessions.deleteSession(id)).toBe(true)
    expect(db.prepare('SELECT session_id FROM session_tasks').all()).toEqual([{ session_id: 'kept' }])
    expect(service.listSessionTaskItems(query()).tasks.map(task => task.session_id)).toEqual(['kept'])
  })

  it('resolves visible request and completion turns rather than hidden tool messages', () => {
    const source = message('user', 'Add export')
    const first = write([goal()])
    expect(service.listSessionTaskItems(query()).tasks[0]).toMatchObject({ message_id: source, source_message_id: source, profile: 'research', session_id: 's1' })
    message('assistant', 'Initial implementation')
    const completionTurn = message('user', 'Finish and test export')
    const tool = message('tool', 'All tests passed')
    write([goal({ id: first.tasks[0].id, status: 'completed', completion_evidence: 'Tests passed' })])
    expect(service.listSessionTaskItems(query()).tasks[0]).toMatchObject({ message_id: completionTurn, evidence_message_id: tool })
  })

  it('filters profiles before counts and pagination, hides pending deletions and unsupported surfaces', () => {
    message('user', 'Research goal')
    write([goal()])
    for (const [id, profile, source] of [['other', 'other', 'cli'], ['group', 'research', 'group_chat'], ['workflow', 'research', 'workflow'], ['global', 'research', 'global_agent']]) {
      sessions.createSession({ id, profile, source })
      db.prepare('INSERT INTO session_tasks (id, session_id, title, summary, status, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`task-${id}`, id, id, '', 'open', 1, 1, 1)
    }
    expect(service.listSessionTaskItems(query())).toMatchObject({ total: 1, has_more: false, tasks: [expect.objectContaining({ session_id: 's1' })] })
    expect(service.listSessionTaskItems(query({ profiles: [] }))).toEqual({ tasks: [], total: 0, has_more: false })
    expect(service.listSessionTaskItems(query({ excludeSessionIds: ['s1'] })).total).toBe(0)
    expect(service.listSessionTaskItems(query({ profiles: ['other'] })).tasks[0].session_id).toBe('other')
  })

  it('searches task and session text literally, sorts stably and paginates all tasks', () => {
    message('user', 'Several goals')
    write([goal({ title: 'Export 100%' }), goal({ title: 'Fix login' }), goal({ title: 'Deploy' })])
    const tasks = service.getSessionTasks('s1').tasks
    for (const [i, task] of tasks.entries()) db.prepare('UPDATE session_tasks SET updated_at = ? WHERE id = ?').run(i + 1, task.id)
    const first = service.listSessionTaskItems(query({ limit: 2 }))
    const second = service.listSessionTaskItems(query({ limit: 2, offset: 2 }))
    expect(first.total).toBe(3)
    expect(first.has_more).toBe(true)
    expect(second.has_more).toBe(false)
    expect(new Set([...first.tasks, ...second.tasks].map(t => t.id)).size).toBe(3)
    expect(service.listSessionTaskItems(query({ order: 'oldest' })).tasks.map(t => t.id)).toEqual(service.listSessionTaskItems(query()).tasks.map(t => t.id).reverse())
    expect(service.listSessionTaskItems(query({ search: '%' })).tasks.map(t => t.title)).toEqual(['Export 100%'])
    expect(service.listSessionTaskItems(query({ search: '_' })).total).toBe(0)
    sessions.renameSession('s1', 'Release checklist')
    expect(service.listSessionTaskItems(query({ search: 'checklist' })).total).toBe(3)
    expect(service.listSessionTaskItems(query({ status: 'completed' })).total).toBe(0)
    write([goal({ id: tasks[0].id, title: tasks[0].title, status: 'completed', completion_evidence: 'Delivered and checked' })])
    const page = service.listSessionTaskItems(query())
    expect(page.tasks[0].status).toBe('completed')
    expect(service.listSessionTaskItems(query({ status: 'completed' })).total).toBe(1)
  })
})
