import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

let db: DatabaseSync
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
let migrate: typeof import('../../packages/server/src/modules/studio/infrastructure/database/person-schema').initPersonTables
const indexName = 'idx_person_pending_origin_session'
const session = 'person-main-synthetic'
const suggestedIndex = `CREATE INDEX idx_person_deliveries_pending_origin_session
  ON person_deliveries(json_extract(origin_json,'$.sessionId'),execution_id)
  WHERE state IN ('waiting','pending','queued')`

beforeEach(async () => {
  vi.resetModules()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
    getDb: () => db, getStoragePath: () => ':memory:',
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({
    config: { appHome: '/synthetic-unused' }, getWebUiHome: () => '/synthetic-unused',
  }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.syncTable('session_tasks', schema.SESSION_TASKS_SCHEMA, { primaryKey: 'id' })
  migrate = (await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')).initPersonTables
  migrate(db)
  db.exec(`DROP INDEX IF EXISTS ${indexName}`)
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
})
afterEach(() => { db.close(); vi.restoreAllMocks() })

function delivery(id: string, state = 'waiting', executionState = 'finished', taskState = 'open', revision = 1, origin = JSON.stringify({ sessionId: session })) {
  db.prepare(`INSERT INTO session_tasks(id,session_id,title,status,created_at,updated_at,requirements_revision)
    VALUES (?,?,?, ?,0,0,1)`).run(id, session, id, taskState)
  db.prepare(`INSERT INTO person_executions(id,task_id,owner_user_id,requirements_revision,state,session_id,selection_json,created_at,updated_at)
    VALUES (?,?,1,?,?,?,'{}',0,0)`).run(id, id, revision, executionState, `worker-${id}`)
  db.prepare(`INSERT INTO person_deliveries(execution_id,owner_user_id,origin_json,state,updated_at)
    VALUES (?,1,?,?,0)`).run(id, origin, state)
}

function seed() {
  delivery('waiting')
  delivery('pending', 'pending')
  delivery('queued', 'queued')
  delivery('delivered', 'delivered')
  delivery('cancelled', 'cancelled')
  delivery('interrupted', 'waiting', 'interrupted')
  delivery('stopping', 'waiting', 'stopping')
  delivery('closed', 'waiting', 'finished', 'closed')
  delivery('stale', 'waiting', 'finished', 'open', 2)
  delivery('other', 'waiting', 'finished', 'open', 1, '{"sessionId":"person-main-other"}')
  db.prepare(`INSERT INTO person_deliveries VALUES ('orphan',1,?,'waiting',0,'')`).run(JSON.stringify({ sessionId: session }))
}

function plan() {
  const prepare = vi.spyOn(db, 'prepare')
  store.personBackgroundPendingCount(session)
  const sql = prepare.mock.calls.find(([sql]) => sql.includes('COUNT(*) AS n FROM person_deliveries'))![0]
  prepare.mockRestore()
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(session, '').map(row => String(row.detail))
}

it('migrates an existing delivery table from a scan to an indexed search without changing counts', () => {
  seed()
  expect(store.personBackgroundPendingCount(session)).toBe(3)
  expect(plan().some(detail => /SCAN d\b/.test(detail))).toBe(true)
  migrate(db)
  expect(plan().some(detail => detail.includes(`SEARCH d USING INDEX ${indexName}`))).toBe(true)
  expect(store.personBackgroundPendingCount(session)).toBe(3)
  expect(store.personBackgroundPendingCount(session, 'waiting')).toBe(2)
  expect(store.personBackgroundPendingCount('person-main-other')).toBe(1)
  expect(store.personBackgroundPendingCount('ordinary-session')).toBe(0)
})

it('creates the index on a fresh schema and keeps repeated initialization idempotent', async () => {
  db.close()
  db = new DatabaseSync(':memory:')
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.syncTable('session_tasks', schema.SESSION_TASKS_SCHEMA, { primaryKey: 'id' })
  migrate(db)
  migrate(db)
  expect(db.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE type=\'index\' AND name=?').get(indexName)?.n).toBe(1)
  expect(store.personBackgroundPendingCount(session)).toBe(0)
})

it('keeps the partial expression index in sync when delivery state and origin change', () => {
  seed()
  migrate(db)
  db.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id='waiting'").run()
  expect(store.personBackgroundPendingCount(session)).toBe(2)
  db.prepare("UPDATE person_deliveries SET state='pending',origin_json=? WHERE execution_id='waiting'").run('{"sessionId":"person-main-other"}')
  expect(store.personBackgroundPendingCount(session)).toBe(2)
  expect(store.personBackgroundPendingCount('person-main-other')).toBe(2)
})

it('ignores malformed legacy origins during migration and counting without rewriting their bytes', () => {
  seed()
  for (const [i, origin] of ['', '{broken', 'legacy text'].entries()) delivery(`invalid-${i}`, ['waiting', 'pending', 'queued'][i], 'finished', 'open', 1, origin)
  for (const [i, origin] of ['{}', 'null', '[]', '{"sessionId":null}', '{"sessionId":12}'].entries()) delivery(`shape-${i}`, 'waiting', 'finished', 'open', 1, origin)
  const before = db.prepare('SELECT execution_id,origin_json FROM person_deliveries ORDER BY execution_id').all()
  expect(() => db.exec(suggestedIndex)).toThrow(/malformed JSON/)
  expect(() => migrate(db)).not.toThrow()
  expect(store.personBackgroundPendingCount(session)).toBe(3)
  expect(plan().some(detail => detail.includes(`SEARCH d USING INDEX ${indexName}`))).toBe(true)
  expect(db.prepare('SELECT execution_id,origin_json FROM person_deliveries ORDER BY execution_id').all()).toEqual(before)
})

it('coexists with the issue reporter\'s manually created index', () => {
  seed()
  db.exec(suggestedIndex)
  migrate(db)
  expect(plan().some(detail => detail.includes(`SEARCH d USING INDEX ${indexName}`))).toBe(true)
  expect(store.personBackgroundPendingCount(session)).toBe(3)
})
