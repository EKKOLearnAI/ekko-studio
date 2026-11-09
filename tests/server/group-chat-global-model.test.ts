import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
let db: DatabaseSync
let root: string
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => db }))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({}))
vi.mock('../../packages/server/src/modules/studio/services/group-chat/agent-clients', () => ({ AgentClients: class {} }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { get appHome() { return root } }, getWebUiHome: () => root }))
let storage: import('../../packages/server/src/modules/studio/sockets/group-chat').ChatStorage
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gc-model-'))
  db = new DatabaseSync(join(root, 'test.sqlite'))
  const { GC_ROOM_AGENTS_SCHEMA } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  db.exec(`CREATE TABLE gc_room_agents (${Object.entries(GC_ROOM_AGENTS_SCHEMA).map(([key,value]) => `${key} ${value}`).join(',')})`)
  const { ChatStorage } = await import('../../packages/server/src/modules/studio/sockets/group-chat')
  storage = new ChatStorage()
  vi.spyOn(storage, 'getRoomMembers').mockReturnValue([])
})
afterEach(async () => { db.close(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it.each(['antigravity', 'codex', 'dsh'] as const)('%s global model and effort survive add, edit, and database reopen', agent => {
  const added = storage.addRoomAgent('room', 'runtime', 'default', 'Synthetic', '', 0, { agent, agentMode: 'global', model: 'model-a', reasoningEffort: 'high', provider: 'ignored' })
  expect(added).toMatchObject({ model: 'model-a', reasoningEffort: 'high', provider: '', apiMode: '' })
  const updated = storage.updateRoomAgent('room', added.id, 'default', 'Synthetic', 'edited', { agent, agentMode: 'global', model: 'model-b', reasoningEffort: 'low' })
  expect(updated).toMatchObject({ model: 'model-b', reasoningEffort: 'low' })
  db.close(); db = new DatabaseSync(join(root, 'test.sqlite'))
  expect(storage.getRoomAgent('room', added.id)).toMatchObject({ model: 'model-b', reasoningEffort: 'low' })
  expect(storage.getHandoffTargetSnapshot('room', 'runtime')).toMatchObject({ model: 'model-b', reasoningEffort: 'low' })
  expect(storage.updateRoomAgent('room', added.id, 'default', 'Synthetic', '', { agent, agentMode: 'global', model: '', reasoningEffort: '' })).toMatchObject({ model: '', reasoningEffort: '' })
})
it('keeps scoped model, provider, API mode and reasoning settings', () => {
  const added = storage.addRoomAgent('room', 'runtime', 'default', 'Synthetic', '', 0, { agent: 'antigravity', agentMode: 'scoped', provider: 'p', model: 'm', apiMode: 'chat_completions', reasoningEffort: 'high' })
  expect(storage.getRoomAgent('room', added.id)).toMatchObject({ provider: 'p', model: 'm', apiMode: 'chat_completions', reasoningEffort: 'high' })
})
