import { expect, it } from 'vitest'
import { projectPluginBusinessEvent } from '../../packages/server/src/modules/studio/services/events/plugin-business-events'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { DatabaseSync } from 'node:sqlite'
import { authorizePluginEvent } from '../../packages/server/src/modules/studio/services/events/plugin-event-access'

it('projects existing run events without internal payload or notification targets', () => {
  const projected = projectPluginBusinessEvent({ schema_version: 1, id: 'event', type: 'chat.run.completed', occurred_at: '2026-10-23T00:00:00Z', profile: 'private', source: 'chat',
    subject: { session_id: 'session', run_id: 'run' }, payload: { token: 'secret', content: 'private text', actor: 'admin' }, push_target_id: 'private-target' }, 2)
  expect(projected).toMatchObject({ type: 'run.completed', subject: { profileId: 'private', sessionId: 'session', runId: 'run' }, data: { runId: 'run' }, sequence: 2 })
  expect(JSON.stringify(projected)).not.toMatch(/secret|private text|private-target|admin/)
})

it('does not turn unknown business events into a public plugin payload', () => {
  expect(projectPluginBusinessEvent({ schema_version: 1, id: 'event', type: 'internal.secret', occurred_at: '2026-10-23T00:00:00Z', profile: 'private', source: 'chat', subject: {}, payload: { token: 'secret' } }, 1)).toBeNull()
})

it('publishes deletion callbacks for deletion only, never for archive notifications', () => {
  const event = { schema_version: 1 as const, id: 'event', type: 'chat.session.removed', occurred_at: '2026-10-23T00:00:00Z', profile: 'default', source: 'chat', subject: { session_id: 'session' }, payload: { reason: 'archived' } }
  expect(projectPluginBusinessEvent(event, 1)).toBeNull()
  expect(projectPluginBusinessEvent({ ...event, payload: { reason: 'deleted' } }, 1)).toMatchObject({ type: 'session.deleted', data: { sessionId: 'session' } })
})

it('persists public events once with partition sequence and profile isolation', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new PluginEventStore(db)
    const first = { schemaVersion: 1 as const, id: 'one', type: 'plugin.ready', occurredAt: 1, partitionKey: 'profile:plugin', sequence: 0, subject: { profileId: 'profile' }, data: {}, correlationId: 'trace' }
    expect(store.append([first, { ...first, id: 'two' }]).map(event => event.sequence)).toEqual([1, 2])
    expect(store.append([first])).toEqual([])
    expect(store.read('other')).toEqual([])
    expect(new PluginEventStore(db).read('profile')).toHaveLength(2)
  } finally { db.close() }
})

it('keeps ownership separate from public payloads and deduplicates post-commit notification', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new PluginEventStore(db)
    const event = { schemaVersion: 1 as const, id: 'event', type: 'session.deleted', occurredAt: 1, partitionKey: 'one:session', sequence: 0, subject: { profileId: 'one', sessionId: 'session' }, data: { sessionId: 'session' }, correlationId: 'trace' }
    store.append([event], 'owner')
    expect(store.append([event], 'forged')).toEqual([])
    expect(store.owner('event')).toBe('owner')
    expect(store.claimNotification('event')).toMatchObject({ id: 'event', sequence: 1 })
    expect(store.claimNotification('event')).toBeNull()
    expect(store.claimNotification('missing')).toBeNull()
    expect(JSON.stringify(store.read('one'))).not.toContain('owner')
    store.prune(2)
    expect(store.owner('event')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_plugin_event_notifications').get()).toMatchObject({ n: 0 })
  } finally { db.close() }
})

it('checks current resource ownership and captured deletion visibility without trusting event actor data', () => {
  const owner = { profileId: 'one', ownerId: '1' }
  const event = { schemaVersion: 1 as const, id: 'event', type: 'session.deleted', occurredAt: 1, partitionKey: 'one:session', sequence: 1, subject: { profileId: 'one', sessionId: 'session' }, data: { actor: '1', ownerId: '1' }, correlationId: 'trace' }
  const missing = { recordedOwner: null, run: null, session: null }
  expect(() => authorizePluginEvent(owner, event, missing)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => authorizePluginEvent(owner, event, { ...missing, recordedOwner: '1' })).not.toThrow()
  for (const resources of [
    { ...missing, recordedOwner: '2' },
    { ...missing, recordedOwner: '1', session: { profile: 'one', studio_user_id: '2' } },
    { ...missing, session: { profile: 'two', studio_user_id: '1' } },
    { ...missing, session: { profile: 'one', user_id: '1', source: 'cli' } },
    { ...missing, run: { profileId: 'one', ownerId: '2' } },
  ]) expect(() => authorizePluginEvent(owner, event, resources)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => authorizePluginEvent(owner, event, { ...missing, session: { profile: 'one', studio_user_id: '1' } })).not.toThrow()
  expect(() => authorizePluginEvent(owner, { ...event, subject: { profileId: 'two' } }, missing)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }))
  expect(() => authorizePluginEvent(owner, { ...event, subject: { profileId: 'one' }, type: 'plugin.ready' }, missing)).not.toThrow()
})

it('rebuilds a missing partition head from retained events and keeps schema migration transactional', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const store = new PluginEventStore(db)
    const event = { schemaVersion: 1 as const, id: 'one', type: 'plugin.ready', occurredAt: 1, partitionKey: 'one:plugin', sequence: 0, subject: { profileId: 'one' }, data: {}, correlationId: 'trace' }
    store.append([event]); db.exec('DELETE FROM studio_plugin_event_partitions')
    expect(new PluginEventStore(db).append([{ ...event, id: 'two' }])[0].sequence).toBe(2)
    db.exec('DROP TABLE studio_plugin_event_partitions')
    expect(new PluginEventStore(db).append([{ ...event, id: 'three' }])[0].sequence).toBe(3)
  } finally { db.close() }
})
