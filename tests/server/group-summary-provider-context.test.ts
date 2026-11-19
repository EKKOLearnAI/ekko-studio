import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { USERS_SCHEMA, USER_PROFILES_SCHEMA } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'

const fixture = vi.hoisted(() => ({ db: null as any, calls: [] as Array<[string, number]> }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => fixture.db }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { appHome: '/unused-summary-test' } }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({ countTokens: (text: string) => Math.ceil(text.length / 4) }))

import { configureGroupChatAgentRuntime } from '../../packages/server/src/modules/studio/public/group-chat-agent-runtime'
import { providerAccountId, withProviderAccount, withoutProviderAccount } from '../../packages/server/src/modules/studio/public/provider-account'
import { GroupRoomSummaryService, type GroupRoomSummary, type GroupRoomSummaryStorage } from '../../packages/server/src/modules/studio/services/group-chat/room-summary'

beforeEach(() => {
  fixture.calls = []
  fixture.db = new DatabaseSync(':memory:')
  for (const [table, schema] of [['users', USERS_SCHEMA], ['user_profiles', USER_PROFILES_SCHEMA]] as const) {
    fixture.db.exec(`CREATE TABLE ${table} (${Object.entries(schema).map(([key, type]) => `${key} ${type}`).join(', ')})`)
  }
  configureGroupChatAgentRuntime({
    resolveEkkoProviderRuntimeConfig: async ({ profile }: any) => {
      fixture.calls.push(['resolve', providerAccountId(profile)])
      return { provider: 'fixture', baseUrl: 'https://unused.invalid', apiKey: 'synthetic', apiMode: 'chat_completions' }
    },
    resolveEkkoModelProviderConfigs: () => ({ providerConfig: {} }),
    createEkkoAuthorizedProviderFetch: () => { fixture.calls.push(['fetch', providerAccountId('default')]); return async () => new Response('unused') },
    createEkkoModelClient: () => ({}),
    getEkkoAgent: () => ({ runIsolated: async () => {
      await Promise.resolve()
      fixture.calls.push(['model', providerAccountId('default')])
      return { output: { content: 'Synthetic summary', finishReason: 'stop' } }
    } }),
  } as any)
})
afterEach(() => fixture.db.close())

function user(id: number, role = 'super_admin', status = 'active', profile?: string) {
  fixture.db.prepare('INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)').run(id, `user${id}`, '', role, status)
  if (profile) fixture.db.prepare('INSERT INTO user_profiles (user_id, profile_name, is_default, created_at) VALUES (?, ?, 1, 1)').run(id, profile)
}

function setup(ownerAuthUserId?: number | null, roomId = 'room') {
  let summary: GroupRoomSummary | null = null
  let token = ''
  const storage: GroupRoomSummaryStorage = {
    getRoom: id => id === roomId ? ({ id: roomId, summaryProfile: 'default', summaryProvider: 'fixture', summaryModel: 'fixture-model', summaryApiMode: 'chat_completions', summaryEveryTurns: 2, ownerAuthUserId }) : undefined,
    getMessagesForContext: () => [1, 2].map(index => ({ id: `m${index}`, timestamp: index, role: index === 1 ? 'user' : 'assistant', content: 'Synthetic room message' })),
    getRoomSummary: () => summary,
    saveRoomSummary: next => { summary = next },
    saveRoomSummaryIfCurrent: next => { summary = next; return true },
    claimRoomSummaryRun: (_room, previous, nextToken) => { token = nextToken; summary = { ...previous, status: 'summarizing' }; return true },
    renewRoomSummaryRun: () => true,
    commitRoomSummaryRun: (_room, runToken, next) => { if (runToken !== token) return false; summary = next; return true },
    invalidateRoomSummaryRun: () => {},
    recoverExpiredRoomSummaryRun: () => false,
  }
  return new GroupRoomSummaryService(storage)
}

it('runs a background summary for the persisted super-admin owner with no profile mappings', async () => {
  user(1)
  const service = setup(1)
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room')).toMatchObject({ status: 'success', summary: 'Synthetic summary' })
  expect(fixture.calls).toEqual([['resolve', 1], ['fetch', 1], ['model', 1]])
  expect(() => providerAccountId()).toThrow('Studio user context')
})

it('uses the explicit room owner in a multi-account installation instead of choosing the first administrator', async () => {
  user(1); user(2)
  const service = setup(2)
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room').status).toBe('success')
  expect(fixture.calls.every(([, id]) => id === 2)).toBe(true)
})

it('keeps an existing explicit caller context rather than replacing it with the room owner', async () => {
  user(1); user(9, 'admin', 'active', 'default')
  const service = setup(1)
  await withProviderAccount(9, async () => {
    await service.prepareForMessage('room')
    expect(providerAccountId()).toBe(9)
  }, 'default')
  expect(service.getState('room').status).toBe('success')
  expect(fixture.calls).toEqual([['resolve', 9], ['fetch', 9], ['model', 9]])
})

it('does not fall back to another mapped account when the room owner lacks profile access', async () => {
  user(1, 'admin'); user(2, 'admin', 'active', 'default')
  const service = setup(1)
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room').status).toBe('failed')
  expect(fixture.calls).toEqual([])
})

it('allows an active ordinary owner with an explicit profile grant', async () => {
  user(7, 'admin', 'active', 'default')
  const service = setup(7)
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room').status).toBe('success')
  expect(fixture.calls).toEqual([['resolve', 7], ['fetch', 7], ['model', 7]])
})

it.each([undefined, null, 0, 42])('does not select a global administrator for unknown owner %s', async owner => {
  user(1); user(2)
  const service = setup(owner)
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room').status).toBe('failed')
  expect(fixture.calls).toEqual([])
})

it('rejects a disabled persisted owner before resolving a provider', async () => {
  user(1, 'super_admin', 'disabled')
  const service = setup(1)
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room').status).toBe('failed')
  expect(fixture.calls).toEqual([])
})

it('keeps a single empty-mapping administrator unavailable when room ownership is unknown', async () => {
  user(1)
  const service = setup()
  await withoutProviderAccount(() => service.prepareForMessage('room'))
  expect(service.getState('room').status).toBe('failed')
  expect(fixture.calls).toEqual([])
})

it('isolates account scopes when two owners summarize concurrently', async () => {
  user(1); user(2)
  const first = setup(1, 'room-1'), second = setup(2, 'room-2')
  await withoutProviderAccount(() => Promise.all([first.prepareForMessage('room-1'), second.prepareForMessage('room-2')]))
  expect(first.getState('room-1').status).toBe('success')
  expect(second.getState('room-2').status).toBe('success')
  for (const phase of ['resolve', 'fetch', 'model']) {
    expect(fixture.calls.filter(([name]) => name === phase).map(([, id]) => id).sort()).toEqual([1, 2])
  }
})
