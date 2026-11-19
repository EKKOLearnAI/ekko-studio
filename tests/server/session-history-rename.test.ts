import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { SESSIONS_SCHEMA, MESSAGES_SCHEMA, SESSION_CATEGORIES_SCHEMA, syncTable } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'

const fixture = vi.hoisted(() => ({ db: null as any, native: [] as any[], available: true }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => fixture.db, isSqliteAvailable: () => true }))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ getRecordedSessionTokensBatch: () => ({}) }))
vi.mock('../../packages/server/src/modules/studio/public/sessions', async () => await import('../../packages/server/src/modules/studio/repositories/session-store'))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
  listHermesSessionSummaries: async () => fixture.native,
  listHermesSessionSummaryGroups: async () => ({ groups: [{ source: 'api_server', sessions: fixture.native, hasMore: false }], included: fixture.native }),
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ getActiveProfileName: () => 'default' }))
vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ isHermesAgentAvailable: () => fixture.available }))
vi.mock('../../packages/server/src/modules/studio/public/users', () => ({ listUserProfiles: () => [{ profile_name: 'default' }] }))
vi.mock('../../packages/server/src/modules/studio/controllers/group-chat', () => ({ getGroupChatServer: () => null }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/person-display', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/person/flow-conversation', () => ({}))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/person/service', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/business-events', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/notifications/session-removal', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/usage/usage-pricing', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/usage/usage-stats', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/usage/usage-period', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/webhooks/business-consumers', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/access', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/session-shares/service', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/task-plans', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/session-tasks', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor/export-compressor', () => ({ ExportCompressor: class {} }))
vi.mock('../../packages/server/src/modules/studio/services/files/path', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/files/workspace-path', () => ({}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/workspace/directory', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/workspace/manager', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/server-registry', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/files/file-policy', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/files/file-operations', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/files/file-preview', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/files/workspace-git-status', () => ({}))

import * as controller from '../../packages/server/src/modules/studio/controllers/sessions'
import * as sessions from '../../packages/server/src/modules/studio/repositories/session-store'

const context = (query = {}) => ({ params: { id: 'renamed' }, request: { body: { title: '  New title  ' } }, query, state: {}, body: undefined as any })
beforeEach(() => {
  fixture.db = new DatabaseSync(':memory:')
  for (const [table, schema] of [['sessions', SESSIONS_SCHEMA], ['messages', MESSAGES_SCHEMA], ['session_categories', SESSION_CATEGORIES_SCHEMA]] as const) {
    fixture.db.exec(`CREATE TABLE ${table} (${Object.entries(schema).map(([key, type]) => `${key} ${type}`).join(', ')})`)
  }
  fixture.db.prepare('INSERT INTO sessions (id, profile, source, title, started_at, last_active) VALUES (?, ?, ?, ?, ?, ?)').run('renamed', 'default', 'api_server', 'Old title', 1, 1)
  fixture.native = [{ id: 'renamed', profile: 'default', source: 'api_server', title: 'Old native title', model: 'native-model', message_count: 7, last_active: 2 }]
  fixture.available = true
})
afterEach(() => fixture.db.close())

it.each(['groups', 'included', 'page', 'legacy'])('returns the persisted rename in history %s while preserving native metadata', async surface => {
  const rename = context()
  await controller.rename(rename)
  expect(rename.body).toEqual({ ok: true })
  expect(sessions.getSession('renamed')?.title).toBe('New title')
  const ctx = context(surface === 'legacy' ? {} : { agent_groups: '1', include: 'renamed', ...(surface === 'page' ? { source: 'api_server', limit: '1' } : {}) })
  if (surface === 'groups' || surface === 'included') await controller.listHermesSessionGroups(ctx)
  else await controller.listHermesSessions(ctx)
  const row = surface === 'groups' ? ctx.body.groups[0].sessions[0] : surface === 'included' ? ctx.body.included[0] : ctx.body.sessions[0]
  expect(row).toMatchObject({ title: 'New title', model: 'native-model', message_count: 7, webui_imported: true })
  expect(fixture.native[0].title).toBe('Old native title')
})

it('keeps native titles when the local title is only a preview fallback', async () => {
  fixture.db.prepare('UPDATE sessions SET title = NULL, preview = ? WHERE id = ?').run('Old local preview', 'renamed')
  const ctx = context()
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions[0].title).toBe('Old native title')
})

it('retains native-only and local-only sessions and preserves local titles without Hermes', async () => {
  fixture.native.push({ id: 'native-only', source: 'cli', title: 'Native only' })
  fixture.db.prepare('INSERT INTO sessions (id, source, title, started_at, last_active) VALUES (?, ?, ?, ?, ?)').run('local-only', 'coding_agent', 'Local only', 1, 1)
  const ctx = context()
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions.find((s: any) => s.id === 'native-only').title).toBe('Native only')
  expect(ctx.body.sessions.find((s: any) => s.id === 'local-only').title).toBe('Local only')
  fixture.available = false
  await controller.rename(context())
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions.find((s: any) => s.id === 'renamed').title).toBe('New title')
})

it('does not apply a local title to a native summary from another profile', async () => {
  await controller.rename(context())
  expect(sessions.getSession('renamed')?.title).toBe('New title')
  fixture.native[0].profile = 'other'
  const ctx = context()
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions[0].title).toBe('Old native title')
})

it('keeps profile access filtering after merging titles', async () => {
  const ctx = { ...context(), state: { user: { id: 1, role: 'user' } } }
  fixture.native.push({ id: 'private', profile: 'private', source: 'cli', title: 'Private' })
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions.map((s: any) => s.id)).toEqual(['renamed'])
})

it('keeps newer native titles ahead of stale imported or generated local titles', async () => {
  const ctx = context()
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions[0].title).toBe('Old native title')
  expect(sessions.getStoredSessionTitles(['renamed']).size).toBe(0)
  await controller.rename(context())
  await controller.listHermesSessions(ctx)
  expect(ctx.body.sessions[0].title).toBe('New title')
})

it('adds the optional rename override to an existing schema without inferring old titles', async () => {
  fixture.db.exec('ALTER TABLE sessions DROP COLUMN title_origin')
  syncTable('sessions', SESSIONS_SCHEMA)
  syncTable('sessions', SESSIONS_SCHEMA)
  expect(sessions.getStoredSessionTitles(['renamed']).size).toBe(0)
  expect(sessions.getSession('renamed')?.title).toBe('Old title')
  await controller.rename(context())
  expect(sessions.getStoredSessionTitles(['renamed']).get('renamed')).toBe('New title')
})

it('bounds title queries for histories larger than one parameter batch', () => {
  const insert = fixture.db.prepare('INSERT INTO sessions (id, title, title_origin, started_at, last_active) VALUES (?, ?, ?, 1, 1)')
  const ids = Array.from({ length: 1001 }, (_, index) => `large-${index}`)
  for (const id of ids) insert.run(id, `Title ${id}`, 'manual')
  expect(sessions.getStoredSessionTitles(ids).size).toBe(1001)
  expect(sessions.getStoredSessionTitles([]).size).toBe(0)
})
