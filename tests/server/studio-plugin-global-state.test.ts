import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { PluginStore } from '../../packages/server/src/modules/studio/repositories/plugin-store'
import { PluginConsumerStore } from '../../packages/server/src/modules/studio/repositories/plugin-consumer-store'
import { pluginEventExecutionScope } from '../../packages/server/src/modules/studio/services/events/plugin-event-access'
import type { EventEnvelope } from '../../packages/studio-plugin-sdk/src'

const databases: DatabaseSync[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function legacy() {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  db.exec(`CREATE TABLE studio_plugin_profiles (plugin_id TEXT NOT NULL, profile_id TEXT NOT NULL, enabled INTEGER NOT NULL,
    owner_id TEXT NOT NULL, config_json TEXT NOT NULL, grants_json TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(plugin_id, profile_id));`)
  const row = (plugin: string, profile: string, owner: string, enabled = true, config = '{}', grants = '["agents.register"]', revision = 1) => {
    db.prepare('INSERT INTO studio_plugin_profiles VALUES(?,?,?,?,?,?,?)').run(plugin, profile, Number(enabled), owner, config, grants, revision)
  }
  return { db, row }
}

it('migrates matching legacy configurations to one global state without retaining account ownership', () => {
  const { db, row } = legacy()
  row('test.global', 'one', 'account-one'); row('test.global', 'two', 'account-two', true, '{}', '["agents.register"]', 3)
  const store = new PluginStore(db)
  expect(store.state('test.global')).toEqual({ pluginId: 'test.global', enabled: true, config: {}, grants: ['agents.register'], revision: 3 })
  expect(store.profile('test.global', 'new-profile')).toEqual(store.state('test.global'))
  expect(db.prepare('SELECT count(*) AS n FROM studio_plugin_profiles').get()?.n).toBe(2)
  expect(new PluginStore(db).state('test.global')).toEqual(store.state('test.global'))
})

it('retains conflicting legacy data and reports a blocked global state instead of choosing an account', () => {
  const { db, row } = legacy()
  row('test.conflict', 'one', 'one', true, '{"setting":"one"}')
  row('test.conflict', 'two', 'two', true, '{"setting":"two"}')
  const store = new PluginStore(db)
  expect(store.state('test.conflict')).toEqual({ pluginId: 'test.conflict', enabled: false, config: {}, grants: [], revision: 1 })
  expect(store.diagnostic('test.conflict')).toMatchObject({ state: 'blocked', errorCode: 'REVISION_CONFLICT' })
  expect(db.prepare('SELECT config_json FROM studio_plugin_profiles ORDER BY profile_id').all()).toEqual([
    { config_json: '{"setting":"one"}' }, { config_json: '{"setting":"two"}' },
  ])
})

const event = (subject: EventEnvelope['subject']): EventEnvelope => ({ schemaVersion: 1, id: 'event', type: 'run.completed',
  occurredAt: 1, partitionKey: 'run', sequence: 1, subject, data: {}, correlationId: 'trace' })

it('derives each global plugin callback authority from persisted event resources', () => {
  for (const [profileId, ownerId] of [['one', 'account-one'], ['two', 'account-two']]) {
    const scope = pluginEventExecutionScope(event({ profileId, runId: 'run' }), { recordedOwner: ownerId, run: { profileId, ownerId }, session: null })
    expect(scope).toMatchObject({ profileId, principal: { kind: 'user', id: ownerId }, runId: 'run' })
  }
  expect(() => pluginEventExecutionScope(event({ profileId: 'one', runId: 'run' }), {
    recordedOwner: 'different-account', run: { ownerId: 'owner', profileId: 'one' }, session: null,
  })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => pluginEventExecutionScope(event({ profileId: 'one', sessionId: 'deleted' }), {
    recordedOwner: null, run: null, session: null,
  })).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
})

it('issues no account or profile authority for global lifecycle notifications', () => {
  const scope = pluginEventExecutionScope(event({ pluginId: 'test.global' }), { recordedOwner: null, run: null, session: null })
  expect(scope).toMatchObject({ principal: { kind: 'service', id: 'studio.plugins' }, profileId: '', surface: 'event' })
})

it('merges legacy consumer cursors and pending work without replaying acknowledged events', () => {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const store = new PluginConsumerStore(db), spec = { types: ['run.completed'], start: 'earliest' as const, resume: 'continue' as const }
  const first = store.register({ pluginId: 'test.global', profileId: 'one', ownerId: 'one', name: 'history' }, spec)
  const second = store.register({ pluginId: 'test.global', profileId: 'two', ownerId: 'two', name: 'history' }, spec)
  store.events.append([{ ...event({ profileId: 'one' }), id: 'acknowledged' }])
  store.fill(first.id); const delivered = store.claim(first.id, 0)!
  store.ack(delivered)
  store.events.append([{ ...event({ profileId: 'one' }), id: 'pending' }, { ...event({ profileId: 'two' }), id: 'unscanned' }])
  store.fill(first.id)
  const global = store.register({ pluginId: 'test.global', name: 'history' }, spec)
  expect(global.profileId).toBeUndefined(); expect(global.ownerId).toBeUndefined()
  const pending = store.claim(global.id, 0)!
  expect(pending.event.id).toBe('pending')
  store.ack(pending)
  expect(store.claim(global.id, 0)?.event.id).toBe('unscanned')
  expect(store.claim(global.id, 0)).toBeNull()
  expect(store.get(second.id)).not.toBeNull()
  expect(store.register({ pluginId: 'test.global', name: 'history' }, spec).id).toBe(global.id)
})
