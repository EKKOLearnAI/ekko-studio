import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ getWebUiHome: () => '/state' }))
import { initPersonWorkspaceBindings } from '../../packages/server/src/modules/studio/infrastructure/database/person-workspace-schema'

let db: DatabaseSync
afterEach(() => db?.close())

function legacyDatabase() {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE sessions(id TEXT,studio_user_id TEXT,workspace TEXT);
    CREATE TABLE person_accounts(user_id INTEGER,settings_json TEXT);
    CREATE TABLE person_conversation_settings(session_id TEXT PRIMARY KEY,owner_user_id INTEGER,settings_json TEXT);
    CREATE TABLE session_tasks(id TEXT,workspace TEXT);
    CREATE TABLE person_executions(id TEXT,session_id TEXT,task_id TEXT);
    CREATE TABLE person_flows(id TEXT,creator_session_id TEXT);
    INSERT INTO sessions VALUES('person-main-a','1','/legacy/session'),('person-main-b','1',''),('person-main-c','2',''),('person-task-old','1','/historical/execution');
    INSERT INTO person_accounts VALUES(1,'{"workspace":"/legacy/account"}');
    INSERT INTO person_conversation_settings VALUES('person-main-a',1,'{"model":{"model":"m"},"reasoningEffort":"high"}');
    INSERT INTO session_tasks VALUES('task','/legacy/task');
    INSERT INTO person_executions VALUES('one','person-task-old','task'),('two','deleted-child','task');
    INSERT INTO person_flows VALUES('flow','person-main-b');`)
}

it('preserves legacy Bot settings and historical execution roots without moving files, idempotently', () => {
  legacyDatabase()
  initPersonWorkspaceBindings(db)
  const local = (id: string) => JSON.parse(String(db.prepare('SELECT settings_json FROM person_conversation_settings WHERE session_id=?').get(id)!.settings_json))
  expect(local('person-main-a')).toEqual({ model: { model: 'm' }, reasoningEffort: 'high', workspace: '/legacy/session' })
  expect(local('person-main-b').workspace).toBe('/legacy/account')
  expect(local('person-main-c').workspace).toBe(join('/state', 'person', '2', 'workspace'))
  expect(db.prepare('SELECT workspace FROM person_executions ORDER BY id').all()).toEqual([{ workspace: '/historical/execution' }, { workspace: '/legacy/task' }])
  expect(db.prepare('SELECT workspace FROM person_flows').get()).toEqual({ workspace: '/legacy/account' })
  db.prepare('UPDATE sessions SET workspace=? WHERE id=?').run('/temporary/cooperation', 'person-main-a')
  db.prepare('UPDATE person_conversation_settings SET settings_json=? WHERE session_id=?').run('{"workspace":""}', 'person-main-b')
  initPersonWorkspaceBindings(db)
  expect(local('person-main-a').workspace).toBe('/legacy/session')
  expect(local('person-main-b').workspace).toBe('')
  expect(db.prepare('SELECT workspace FROM person_flows').get()).toEqual({ workspace: '/legacy/account' })
})

it('rolls back the entire binding migration when legacy data cannot be read', () => {
  legacyDatabase()
  db.exec('DROP TABLE person_flows')
  expect(() => initPersonWorkspaceBindings(db)).toThrow()
  expect(db.prepare('PRAGMA table_info(person_executions)').all().some(row => row.name === 'workspace')).toBe(false)
  expect(db.prepare('SELECT count(*) AS n FROM person_conversation_settings').get()).toEqual({ n: 1 })
})
