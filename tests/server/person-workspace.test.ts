import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonRuntimePort } from '../../packages/server/src/modules/studio/public/person-runtime'

let root: string, db: DatabaseSync, runtime: PersonRuntimePort
let conversations: typeof import('../../packages/server/src/modules/studio/services/person/conversations')
let store: typeof import('../../packages/server/src/modules/studio/repositories/person-store')
let workspace: typeof import('../../packages/server/src/modules/studio/services/person/workspace')
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bot-workspace-')))
  db = new DatabaseSync(join(root, 'state.db'))
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: root }, getWebUiHome: () => root }))
  vi.doMock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: () => 16000 }))
  vi.doMock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: () => false, disposeSession: vi.fn(async () => {}), clearSessionHistory: vi.fn() }) }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ findUserById: (id: number) => ({ id, status: 'active', role: 'super_admin', username: `user-${id}` }), listUserProfiles: () => [{ profile_name: 'default' }], userCanAccessProfile: () => true }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default', 'other'], getActiveProfileName: () => 'default', readConfigYamlForProfile: async () => ({}) }))
  vi.doMock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ getAgentAvailabilitySnapshot: () => ({ agents: [{ id: 'ekko-agent', installed: true }] }) }))
  vi.doMock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: 'fixture', models: ['test-model'], api_mode: 'chat_completions' }], validateCodingAgentModelEffort: vi.fn(async () => {}) }))
  vi.doMock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: vi.fn() }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  const { createPersonDefaultWorkspace } = await import('../../packages/server/src/bootstrap/person-workspace')
  runtime = {
    createDefaultWorkspace: vi.fn(createPersonDefaultWorkspace),
    modelConfig: vi.fn(async () => ({ default: 'test-model', default_provider: 'fixture', groups: [{ provider: 'fixture', models: ['test-model'], api_mode: 'chat_completions' }] })),
    chatAgent: vi.fn((options: any) => ({ sessionWorkspaceDirectory: () => options.workspace, requestBoundaryInterrupt: vi.fn(), estimateContext: vi.fn(), run: vi.fn() })),
    model: vi.fn(async () => 'unused'), nativeModels: vi.fn(async () => ({ status: 'ready', models: [] })), deliver: vi.fn(async () => {}), execute: vi.fn(async () => ({ ok: true })), answer: vi.fn(async () => true), stop: vi.fn(async () => {}),
  }
  const { configurePersonRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  configurePersonRuntime(runtime)
  conversations = await import('../../packages/server/src/modules/studio/services/person/conversations')
  store = await import('../../packages/server/src/modules/studio/repositories/person-store')
  workspace = await import('../../packages/server/src/modules/studio/services/person/workspace')
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
})
afterEach(async () => {
  const { closePersonMemoryStores } = await import('../../packages/server/src/modules/studio/services/person/memory')
  closePersonMemoryStores(); db.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
})
const create = (input: Record<string, unknown> = {}, title = 'New Bot', owner = 1) => conversations.createPersonConversation(owner, title, input)
const count = () => Number(db.prepare("SELECT COUNT(*) n FROM sessions WHERE id LIKE 'person-main-%'").get()!.n)
const local = (id: string) => JSON.parse(String(db.prepare('SELECT settings_json FROM person_conversation_settings WHERE session_id=?').get(id)!.settings_json))

it.each([undefined, null, '', '  '])('creates and persists a valid single-chat-style default for workspace=%j', async value => {
  const bot = await create(value === undefined ? {} : { workspace: value })
  const expected = join(root, '.ekko', 'workspace', 'default', bot.id)
  expect(bot.workspace).toBe(expected)
  expect(statSync(expected).isDirectory()).toBe(true)
  expect(local(bot.id).workspace).toBe(expected)
  expect(workspace.personTurnWorkspace(1, bot.id)).toBe(expected)
  // Exercise the real single-chat directory manager, including idempotent reuse.
  const { EkkoDirectoryManager } = await import('../../packages/ekko-agent/src/directories')
  writeFileSync(join(expected, 'keep.txt'), 'preserve')
  expect(new EkkoDirectoryManager(root).sessionWorkspaceDirectory('default', bot.id)).toBe(expected)
  expect(readFileSync(join(expected, 'keep.txt'), 'utf8')).toBe('preserve')
})

it('isolates defaults by Bot/session and uses the selected model profile without inheriting a shared account directory', async () => {
  const old = store.personSettings(1)
  store.savePersonSettings(1, { ...old.settings, workspace: root }, old.revision)
  const a = await create({}, 'One'), b = await create({}, 'Two'), c = await create({}, 'Other account', 2)
  expect(new Set([a.workspace, b.workspace, c.workspace]).size).toBe(3)
  expect(store.personSettings(1).settings.workspace).toBe(root)
  const d = await create({ model: { profile: 'other', provider: 'fixture', model: 'test-model' } }, 'Other profile')
  expect(d.workspace).toBe(join(root, '.ekko', 'workspace', 'other', d.id))
  expect(a.workspace).not.toBe(root)
})

it('keeps a manually selected directory, canonicalizes symlinks and never provisions a default for it', async () => {
  const selected = join(root, 'manual'); mkdirSync(selected)
  const alias = join(root, 'alias'); symlinkSync(selected, alias)
  const a = await create({ workspace: ` ${alias} ` })
  const b = await create({ workspace: selected }, 'Shared manual directory')
  expect(a.workspace).toBe(selected); expect(b.workspace).toBe(selected)
  expect(local(a.id).workspace).toBe(selected)
  expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled()
  expect(existsSync(join(root, '.ekko'))).toBe(false)
})

it.each([42, false, {}, [], '/'.repeat(4001), 'relative-folder'])('rejects invalid explicit input without allocating a directory: %j', async value => {
  await expect(create({ workspace: value })).rejects.toMatchObject({ status: 400 })
  expect(count()).toBe(0); expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled()
})

it('does not create missing manual directories or substitute a default for inaccessible selections', async () => {
  const missing = join(root, 'missing')
  writeFileSync(join(root, 'file'), 'file')
  for (const value of [missing, join(root, 'file')]) await expect(create({ workspace: value })).rejects.toMatchObject({ status: 409, code: 'WORKSPACE_UNAVAILABLE' })
  expect(existsSync(missing)).toBe(false)
  expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled(); expect(count()).toBe(0)
})

it.skipIf(process.platform === 'win32')('rejects a manual directory without read/write/traverse permission', async () => {
  const selected = join(root, 'no-permission'); mkdirSync(selected); chmodSync(selected, 0)
  try { await expect(create({ workspace: selected })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' }); expect(count()).toBe(0) }
  finally { chmodSync(selected, 0o700) }
  expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled()
})

it('returns a clear controller error on default provisioning failure, inserts no Bot and allows retry', async () => {
  const { conversationCreate } = await import('../../packages/server/src/modules/studio/controllers/person')
  const blocked = join(root, '.ekko'); writeFileSync(blocked, 'not a directory')
  const ctx: any = { state: { user: { id: 1 } }, request: { body: { title: 'Retry Bot' } }, set() {} }
  await conversationCreate(ctx)
  expect(ctx.status).toBe(409)
  expect(ctx.body).toMatchObject({ code: 'WORKSPACE_UNAVAILABLE', error: expect.stringContaining('Failed to create the default Bot workspace') })
  expect(count()).toBe(0)
  rmSync(blocked)
  const retried = await create({}, 'Retry Bot')
  expect(statSync(retried.workspace!).isDirectory()).toBe(true); expect(count()).toBe(1)
})

it('validates the provisioned directory and reports an unavailable provider rather than silently changing cwd', async () => {
  vi.mocked(runtime.createDefaultWorkspace!).mockReturnValue(join(root, 'not-created'))
  await expect(create()).rejects.toMatchObject({ status: 409, code: 'WORKSPACE_UNAVAILABLE' })
  runtime.createDefaultWorkspace = undefined
  await expect(create()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Default workspace provider is unavailable') })
  expect(count()).toBe(0)
})

it('rejects stale revisions and duplicate names before provisioning another directory', async () => {
  await expect(create({ expected_revision: 99 })).rejects.toMatchObject({ status: 409 })
  expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled()
  await create()
  vi.mocked(runtime.createDefaultWorkspace!).mockClear()
  await expect(create()).rejects.toMatchObject({ code: 'PERSON_BOT_NAME_EXISTS' })
  expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled(); expect(count()).toBe(1)
})

it('rechecks revisions after model resolution before default allocation', async () => {
  const old = store.personSettings(1)
  vi.mocked(runtime.modelConfig).mockImplementationOnce(async () => {
    store.savePersonSettings(1, { ...old.settings, maxSteps: 20 }, old.revision)
    return { default: 'test-model', default_provider: 'fixture', groups: [{ provider: 'fixture', models: ['test-model'] }] }
  })
  await expect(create({ expected_revision: old.revision })).rejects.toMatchObject({ status: 409 })
  expect(runtime.createDefaultWorkspace).not.toHaveBeenCalled(); expect(count()).toBe(0)
})

it('binds the same valid default to chat and tasks and refuses to recreate it after removal', async () => {
  const bot = await create()
  const { createPersonChatAgent } = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
  await createPersonChatAgent(1, bot.id)
  const options = vi.mocked(runtime.chatAgent!).mock.calls[0][0]
  expect(options.workspace).toBe(bot.workspace); expect(() => options.beforeRequest!()).not.toThrow()
  const settings = store.personSettings(1)
  store.savePersonSettings(1, { ...settings.settings, agents: [{ id: 'worker', name: 'Worker', description: 'Test', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'fixture', model: 'test-model', apiMode: 'chat_completions', reasoningEffort: '' } }] }, settings.revision)
  const { applyPersonTask } = await import('../../packages/server/src/modules/studio/services/person/tasks')
  const task = await applyPersonTask(1, { action: 'create', session_id: bot.id, title: 'Later task', goal: 'Keep the bound directory', start: false, idempotency_key: 'workspace-task' })
  expect(task.task.workspace).toBe(bot.workspace)
  rmSync(bot.workspace!, { recursive: true })
  expect(() => options.beforeRequest!()).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNAVAILABLE' }))
  expect(() => workspace.personTurnWorkspace(1, bot.id)).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNAVAILABLE' }))
  expect(existsSync(bot.workspace!)).toBe(false)
})

it('retains default workspace artifacts when the Bot is deleted, matching single-chat file retention', async () => {
  const bot = await create(); const artifact = join(bot.workspace!, 'result.txt'); writeFileSync(artifact, 'user artifact')
  await conversations.deletePersonConversation(1, bot.id, bot.history_revision)
  expect(sessions.getSession(bot.id)).toBeNull()
  expect(readFileSync(artifact, 'utf8')).toBe('user artifact')
})

it('keeps existing Bot settings strict and applies a manual change only to future tasks', async () => {
  const bot = await create(), defaultPath = bot.workspace
  const settings = store.personSettings(1)
  store.savePersonSettings(1, { ...settings.settings, agents: [{ id: 'worker', name: 'Worker', description: 'Test', selection: { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'fixture', model: 'test-model', apiMode: 'chat_completions', reasoningEffort: '' } }] }, settings.revision)
  const { applyPersonTask } = await import('../../packages/server/src/modules/studio/services/person/tasks')
  const task = await applyPersonTask(1, { action: 'create', session_id: bot.id, title: 'Existing task', goal: 'Keep original path', start: false, idempotency_key: 'manual-rebind' })
  const { configurePerson } = await import('../../packages/server/src/modules/studio/services/person/service')
  const current = store.personSettings(1, bot.id)
  await expect(configurePerson(1, { session_id: bot.id, workspace: '', expected_revision: current.revision })).rejects.toMatchObject({ code: 'WORKSPACE_UNAVAILABLE' })
  const manual = join(root, 'new-manual'); mkdirSync(manual)
  await configurePerson(1, { session_id: bot.id, workspace: manual, expected_revision: current.revision })
  expect(workspace.personTurnWorkspace(1, bot.id)).toBe(manual)
  expect(store.getPersonTask(1, task.task.id).workspace).toBe(defaultPath)
  expect(statSync(defaultPath!).isDirectory()).toBe(true)
  expect(runtime.createDefaultWorkspace).toHaveBeenCalledTimes(1)
})

it('preserves legacy/manual bindings and explicit empty settings through migration and new default creation', async () => {
  const settings = store.personSettings(1)
  store.savePersonSettings(1, { ...settings.settings, workspace: root }, settings.revision)
  for (const id of ['person-main-legacy', 'person-main-empty', 'person-main-user-default']) sessions.createSession({ id, studio_user_id: id.endsWith('user-default') ? 2 : 1, user_id: 1, title: id, workspace: id.endsWith('legacy') ? root : '', source: 'builtin_agent', agent: 'ekko-agent', agent_preset: 'person', profile: 'default' })
  db.prepare('INSERT INTO person_conversation_settings VALUES(?,?,?)').run('person-main-empty', 1, JSON.stringify({ workspace: '' }))
  const { initPersonWorkspaceBindings } = await import('../../packages/server/src/modules/studio/infrastructure/database/person-workspace-schema')
  initPersonWorkspaceBindings(db)
  expect(local('person-main-legacy').workspace).toBe(root)
  expect(local('person-main-empty').workspace).toBe('')
  const legacyDefault = join(root, 'person', '2', 'workspace')
  expect(local('person-main-user-default').workspace).toBe(legacyDefault)
  expect(existsSync(legacyDefault)).toBe(false)
  await create()
  expect(workspace.personTurnWorkspace(1, 'person-main-legacy')).toBe(root)
  expect(() => workspace.personTurnWorkspace(1, 'person-main-empty')).toThrow(expect.objectContaining({ code: 'WORKSPACE_UNAVAILABLE' }))
  expect(local('person-main-user-default').workspace).toBe(legacyDefault)
  expect(existsSync(legacyDefault)).toBe(false)
})
