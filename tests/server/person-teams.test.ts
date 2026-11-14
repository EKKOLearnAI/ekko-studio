import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string, db: DatabaseSync
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
let teams: typeof import('../../packages/server/src/modules/studio/services/person/teams')
let memory: typeof import('../../packages/server/src/modules/studio/services/person/memory')
let personSchema: typeof import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')

function seedLegacyAccount(userId: number, agents: unknown[]) {
  db.prepare('INSERT OR REPLACE INTO person_accounts VALUES (?,?,?)')
    .run(userId, JSON.stringify({ agents, workspace: '', timezone: 'Asia/Shanghai' }), 1)
  // The migration turns the account-wide agents into one default team.
  personSchema.initPersonTables(db)
}
function addConversation(id: string, userId: number, teamId?: string) {
  db.prepare("INSERT INTO sessions (id,title,last_active) VALUES (?,?,?)").run(id, `Chat ${id}`, 1)
  db.prepare('INSERT INTO person_conversation_settings VALUES (?,?,?)')
    .run(id, userId, JSON.stringify({ model: null, reasoningEffort: '', workspace: '', ...(teamId ? { teamId } : {}) }))
}
function teamOfConversation(id: string) {
  const row = db.prepare('SELECT settings_json FROM person_conversation_settings WHERE session_id=?').get(id) as { settings_json: string }
  return JSON.parse(row.settings_json).teamId
}

beforeEach(async () => {
  vi.resetModules()
  root = mkdtempSync(join(tmpdir(), 'person-teams-'))
  db = new DatabaseSync(join(root, 'state.db'))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root }, getWebUiHome: () => root }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
    findUserById: (id: number) => ({ id, status: 'active', role: 'super_admin', username: `user-${id}` }),
    listUserProfiles: () => [{ profile_name: 'default' }], userCanAccessProfile: () => true,
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
    listProfileNamesFromDisk: () => ['default'], getActiveProfileName: () => 'default', readConfigYamlForProfile: async () => ({}),
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
    getSessionAvailableModelGroups: async () => [{ provider: 'p', models: ['m'], api_mode: 'chat_completions' }],
  }))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, last_active INTEGER);')
  db.exec('CREATE TABLE session_tasks (id TEXT PRIMARY KEY, owner_user_id INTEGER, bot_id TEXT, session_id TEXT, updated_at INTEGER);')
  personSchema = await import('../../packages/server/src/modules/studio/infrastructure/database/person-schema')
  personSchema.initPersonTables(db)
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  teams = await import('../../packages/server/src/modules/studio/services/person/teams')
  memory = await import('../../packages/server/src/modules/studio/services/person/memory')
})
afterEach(() => {
  memory?.closePersonMemoryStores?.()
  db?.close()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('seeds one default team from the legacy account agents and keeps it idempotent', async () => {
  const agent = { id: 'a1', name: 'Builder', description: 'writes code', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'p', model: 'm', reasoningEffort: '' } }
  seedLegacyAccount(1, [agent])
  const seeded = store.listPersonTeams(1)
  expect(seeded).toHaveLength(1)
  expect(seeded[0]).toMatchObject({ id: 'team-default', name: 'Default' })
  expect(seeded[0].agents.map(item => item.id)).toEqual(['a1'])
  expect(store.personSettings(1).settings.teamId).toBe('team-default')
  expect(store.personSettings(1).settings.agents.map(item => item.id)).toEqual(['a1'])
  // Re-running the migration must not create a second team.
  personSchema.initPersonTables(db)
  expect(store.listPersonTeams(1)).toHaveLength(1)
})

it('gives a brand new account a default team so its first Agent has a home', async () => {
  // initPersonTables seeds a team only for accounts that already had agents.
  expect(store.listPersonTeams(1)).toHaveLength(0)
  const listed = teams.personTeams(1)
  expect(listed).toEqual([expect.objectContaining({ id: 'team-default', name: 'Default', agents: [] })])
  // Reading again must not create a second row, and the default drives the fallback.
  expect(teams.personTeams(1)).toHaveLength(1)
  expect(store.defaultPersonTeamId(1)).toBe('team-default')
})

it('creates, renames and rejects duplicate team names case-insensitively', async () => {
  seedLegacyAccount(1, [])
  const created = await teams.applyPersonTeam(1, { action: 'create', name: 'Project Alpha', idempotency_key: 'k1' })
  expect(created.teams.map(team => team.name)).toEqual(['Default', 'Project Alpha'])
  await expect(teams.applyPersonTeam(1, { action: 'create', name: '  project alpha ', idempotency_key: 'k2' }))
    .rejects.toThrow(/already exists/i)
  const target = created.teams.find(team => team.name === 'Project Alpha')!
  const renamed = await teams.applyPersonTeam(1, { action: 'rename', team_id: target.id, name: 'Project Beta', expected_revision: target.revision, idempotency_key: 'k3' })
  expect(renamed.team?.name).toBe('Project Beta')
  // A repeated key returns the stored result instead of creating a second team.
  const replay = await teams.applyPersonTeam(1, { action: 'create', name: 'Project Alpha', idempotency_key: 'k1' })
  expect(replay.teams).toHaveLength(2)
})

it('saves agents per team without touching another team', async () => {
  seedLegacyAccount(1, [])
  const created = await teams.applyPersonTeam(1, { action: 'create', name: 'Team B', idempotency_key: 'c1' })
  const teamB = created.teams.find(team => team.name === 'Team B')!
  const saved = await teams.applyPersonTeam(1, { action: 'save', team_id: teamB.id, expected_revision: teamB.revision, idempotency_key: 'c2',
    agents: [{ id: 'b1', name: 'Reviewer', description: 'reviews', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'p', model: 'm', reasoningEffort: '' } }] })
  expect(saved.team?.agents.map(agent => agent.id)).toEqual(['b1'])
  expect(store.requirePersonTeam(1, 'team-default').agents).toEqual([])
})

it('previews the conversations still bound to a team before deletion', async () => {
  seedLegacyAccount(1, [])
  const created = await teams.applyPersonTeam(1, { action: 'create', name: 'Team C', idempotency_key: 'u1' })
  const team = created.teams.find(item => item.name === 'Team C')!
  for (let index = 0; index < 13; index++) addConversation(`conv-${index}`, 1, team.id)
  addConversation('legacy-conv', 1)
  const usage = teams.personTeamUsageView(1, team.id)
  expect(usage.total).toBe(13)
  expect(usage.conversations).toHaveLength(10)
  expect(usage.conversations.every(item => item.title.startsWith('Chat conv-'))).toBe(true)
  // Conversations without a team belong to the default team, not to this one.
  expect(teams.personTeamUsageView(1, 'team-default').total).toBe(1)
})

it('moves conversations to the default team on delete and never deletes the default team', async () => {
  seedLegacyAccount(1, [])
  const created = await teams.applyPersonTeam(1, { action: 'create', name: 'Team D', idempotency_key: 'd1' })
  const team = created.teams.find(item => item.name === 'Team D')!
  addConversation('conv-d', 1, team.id)
  const result = await teams.applyPersonTeam(1, { action: 'delete', team_id: team.id, expected_revision: team.revision, idempotency_key: 'd2' })
  expect(result.conversations_moved).toBe(1)
  expect(teamOfConversation('conv-d')).toBe('team-default')
  expect(store.listPersonTeams(1).map(item => item.id)).toEqual(['team-default'])
  const fallback = store.requirePersonTeam(1, 'team-default')
  await expect(teams.applyPersonTeam(1, { action: 'delete', team_id: fallback.id, expected_revision: fallback.revision, idempotency_key: 'd3' }))
    .rejects.toThrow(/default team cannot be deleted/i)
})

it('keeps one memory store per team and copies the legacy store into the default team', async () => {
  seedLegacyAccount(1, [])
  const created = await teams.applyPersonTeam(1, { action: 'create', name: 'Team E', idempotency_key: 'm1' })
  const team = created.teams.find(item => item.name === 'Team E')!
  const first = memory.personMemory(1, 'person-main-1', team.id)
  const second = memory.personMemory(1, 'person-main-1', 'team-default')
  expect(first.identity.profileId).toBe(`person:1:${team.id}`)
  expect(second.identity.profileId).toBe('person:1:team-default')
  expect(first.identity.profileId).not.toBe(second.identity.profileId)
  // Each team gets its own directory under person/<uid>/teams/<teamId>.
  const teamDirs = readdirSync(join(root, 'person', '1', 'teams'))
  expect(new Set(teamDirs).size).toBeGreaterThanOrEqual(2)
})
