import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
beforeEach(async () => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: '/tmp' }, getWebUiHome: () => '/tmp' }))
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, studio_user_id TEXT, title TEXT, bot_type TEXT);
    CREATE TABLE session_tasks (id TEXT PRIMARY KEY, owner_user_id INTEGER, session_id TEXT, title TEXT, summary TEXT, requirements_json TEXT);
    CREATE TABLE person_schedules (id TEXT PRIMARY KEY, owner_user_id INTEGER, session_id TEXT, task_id TEXT,
      mode TEXT, title TEXT, goal TEXT, expression TEXT, timezone TEXT, next_at INTEGER, state TEXT, created_at INTEGER);
    INSERT INTO sessions VALUES ('person-main-a','1','开发 BOT','shuishui'),('person-main-b','1','备份 BOT','xingxing'),('person-main-other','2','Other account','xiaohe');
  `)
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
})
afterEach(() => { db.close(); vi.restoreAllMocks() })
function schedule(id: string, session = 'person-main-a', owner = 1, taskId: string | null = null, state = 'active') {
  db.prepare('INSERT INTO person_schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, owner, session, taskId, taskId ? 'worker' : 'assistant', id, taskId ? '' : `Full goal for ${id}`, '0 0 * * *', 'Asia/Shanghai', 2000000000000, state, 1)
}
it('lists all BOTs and saved states beyond fifty schedules while retaining optional session filtering', () => {
  for (let i = 0; i < 53; i++) schedule(`schedule-${i}`, i % 2 ? 'person-main-a' : 'person-main-b', 1, null, ['active','paused','cancelled','exhausted'][i % 4])
  schedule('private', 'person-main-other', 2)
  const all = store.listPersonSchedules(1)
  expect(all).toHaveLength(53)
  expect(new Set(all.map(item => item.session_title))).toEqual(new Set(['开发 BOT', '备份 BOT']))
  expect(new Set(all.map(item => item.bot_type))).toEqual(new Set(['shuishui','xingxing']))
  expect(new Set(all.map(item => item.state))).toEqual(new Set(['active','paused','cancelled','exhausted']))
  expect(store.listPersonSchedules(1, 'person-main-a')).toHaveLength(26)
  expect(store.listPersonSchedules(1, 'person-main-other')).toEqual([])
  expect(all.some(item => item.id === 'private')).toBe(false)
})
it('returns full current worker requirements and falls back to the summary for legacy requirements', () => {
  const goal = 'Complete worker instructions\n' + 'Long details. '.repeat(800)
  db.prepare('INSERT INTO session_tasks VALUES (?,?,?,?,?,?)').run('worker', 1, 'person-main-b', 'Worker title', 'Short summary', JSON.stringify({ goal }))
  schedule('worker-schedule', 'person-main-b', 1, 'worker')
  expect(store.listPersonSchedules(1)[0]).toMatchObject({ session_title: '备份 BOT', task_title: 'Worker title', task_goal: goal })
  for (const value of ['{}', 'legacy invalid JSON']) {
    db.prepare("UPDATE session_tasks SET requirements_json=? WHERE id='worker'").run(value)
    expect(store.listPersonSchedules(1)[0].task_goal).toBe('Short summary')
  }
})
it('does not expose another account’s task or BOT metadata through an inconsistent reference', () => {
  db.prepare('INSERT INTO session_tasks VALUES (?,?,?,?,?,?)').run('private-task', 2, 'person-main-other', 'Private task', 'Private summary', '{"goal":"Private goal"}')
  schedule('bad-reference', 'person-main-other', 1, 'private-task')
  expect(store.listPersonSchedules(1)[0]).toMatchObject({ session_title: null, bot_type: null, task_title: null, task_goal: null })
})
it('includes account-wide schedules in snapshots regardless of the selected BOT', async () => {
  schedule('a'); schedule('b', 'person-main-b'); schedule('private', 'person-main-other', 2)
  vi.doMock('../../packages/server/src/modules/studio/services/person/memory', () => ({ personMemories: async () => [] }))
  vi.doMock('../../packages/server/src/modules/studio/services/person/chat-agent', () => ({ readPersonSession: async (_user: number, id: string) => ({ session: { id } }), personChatBusy: () => false }))
  vi.doMock('../../packages/server/src/modules/studio/services/person/catalog', () => ({ personUser: () => {}, effectivePersonSettings: async () => ({ settings: {} }), PERSON_REASONING_EFFORTS: [] }))
  vi.doMock('../../packages/server/src/modules/studio/services/person/agents', () => ({}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/person-history-store', () => ({ personHasPendingWork: () => false }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/person-stage-store', () => ({ listPersonFlows: () => [], personFlowActivity: () => ({}) }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/person-presence-store', () => ({ personBackgroundTaskCount: () => 0 }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/person-store', async importOriginal => ({ ...await importOriginal<typeof store>(), listPersonTasks: () => [], personInteractions: () => [] }))
  const { personSnapshot } = await import('../../packages/server/src/modules/studio/services/person/service')
  for (const selected of ['', 'person-main-a', 'person-main-b']) {
    const snapshot = await personSnapshot(1, selected)
    expect(snapshot.schedules.map(item => item.id).sort()).toEqual(['a', 'b'])
  }
})
