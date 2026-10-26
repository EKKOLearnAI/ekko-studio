import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { USAGE_SCHEMA, USAGE_RUN_INDEX } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'

let db: DatabaseSync
vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: () => true, getDb: () => db,
  jsonSet: vi.fn(), jsonGet: vi.fn(), jsonGetAll: vi.fn(), jsonDelete: vi.fn(),
}))

import { getSessionUsageAccounts, getUsageAccountOptions } from '../../packages/server/src/modules/studio/repositories/usage-accounts'
import { updateUsage, getLocalUsageStats, getUnpricedHermesUsageSessions } from '../../packages/server/src/modules/studio/repositories/usage-store'

describe('Studio usage account attribution', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE session_usage (${Object.entries(USAGE_SCHEMA).map(([key, sql]) => `${key} ${sql}`).join(',')});
      CREATE TABLE sessions (id TEXT PRIMARY KEY, profile TEXT, user_id TEXT, studio_user_id TEXT, source TEXT DEFAULT 'coding_agent');
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
      INSERT INTO users VALUES (1, 'ekko', 'secret'), (2, 'alice', 'secret'), (3, 'private-user', 'secret');
      INSERT INTO sessions (id, profile, user_id) VALUES ('new', 'default', '1'), ('alice', 'default', '2'),
        ('research', 'research', '2'), ('private', 'private', '3'), ('unknown', 'default', NULL); ${USAGE_RUN_INDEX}`)
  })
  afterEach(() => db.close())

  it('keeps internal and external records separate even for the same physical model call', () => {
    const usage = { profile: 'default', model: 'model-a', provider: 'glm', inputTokens: 100, outputTokens: 20,
      apiCalls: 1, costUsd: 0.02, costSource: 'reported' as const, runId: 'same-call' }
    updateUsage('new', { ...usage, source: 'ekko_agent', agent: 'ekko_agent' })
    const external = { ...usage, source: 'model_api', agent: 'model_api', origin: 'external' as const, accountId: '1' }
    updateUsage('', external)
    updateUsage('', external) // terminal usage delivered twice: one ledger row
    updateUsage('', { ...external, runId: 'other-account', accountId: '2', inputTokens: 900 })
    updateUsage('', { ...external, runId: 'other-profile', profile: 'research', inputTokens: 800 })
    expect(getLocalUsageStats('default', 7)).toMatchObject({ input_tokens: 100, sessions: 1, total_api_calls: 1, cost: 0.02 })
    const result = getLocalUsageStats('default', 7, { origin: 'external', account: '1', model: 'model-a', agent: 'model_api' })
    expect(result).toMatchObject({ input_tokens: 100, output_tokens: 20, sessions: 0, total_api_calls: 1, cost: 0.02 })
    expect(result.by_day).toEqual([expect.objectContaining({ input_tokens: 100, sessions: 0, cost: 0.02 })])
    expect(result.by_agent).toEqual([expect.objectContaining({ agent: 'model_api', input_tokens: 100 })])
    expect(db.prepare('SELECT count(*) AS n FROM session_usage').get()).toMatchObject({ n: 4 })
  })

  it('lists a newly created session owner before tokens arrive, scoped to accessible Profiles', () => {
    expect(getLocalUsageStats('default', 30).sessions).toBe(0)
    expect(getUsageAccountOptions(['default'])).toEqual([{ id: '1', username: 'ekko' }, { id: '2', username: 'alice' }])
    expect(getUsageAccountOptions(['research'])).toEqual([{ id: '2', username: 'alice' }])
    expect(getUsageAccountOptions([])).toEqual([])
  })

  it('snapshots the session owner through the shared recording entrypoint and retains it after deletion', () => {
    updateUsage('new', { profile: 'default', inputTokens: 100, outputTokens: 20, agent: 'codex' })
    expect(db.prepare('SELECT account_id FROM session_usage').get()).toMatchObject({ account_id: '1' })
    db.exec("DELETE FROM sessions WHERE id = 'new'; DELETE FROM users WHERE id = 1;")
    expect(getLocalUsageStats('default', 7, { account: '1' })).toMatchObject({ input_tokens: 100, output_tokens: 20, sessions: 1 })
    expect(getUsageAccountOptions(['default'])).toContainEqual({ id: '1', username: '#1' })
    expect(getLocalUsageStats('default', 7, { account: 'unassigned' }).sessions).toBe(0)
  })

  it('does not confuse a legacy CLI import with a Studio user, but accepts explicit authenticated ownership', () => {
    db.exec("INSERT INTO sessions (id, profile, user_id, source) VALUES ('cli-import', 'default', '1', 'cli');")
    updateUsage('cli-import', { profile: 'default', inputTokens: 100, outputTokens: 20 })
    expect(getLocalUsageStats('default', 7, { account: '1' }).sessions).toBe(0)
    expect(getLocalUsageStats('default', 7, { account: 'unassigned' }).sessions).toBe(1)
    db.exec("UPDATE sessions SET studio_user_id = '2' WHERE id = 'cli-import';")
    updateUsage('cli-import', { profile: 'default', inputTokens: 200, outputTokens: 20 })
    expect(getLocalUsageStats('default', 7, { account: '2' }).input_tokens).toBe(300)
  })

  it('intersects account, Profile and time across tokens, costs, API calls and charts, including historical ownership', () => {
    const now = Date.now()
    const insert = db.prepare(`INSERT INTO session_usage
      (session_id, profile, account_id, created_at, agent, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, reasoning_tokens, api_calls, cost_usd, cost_source)
      VALUES (?, ?, ?, ?, 'hermes', 'model-a', ?, 20, 300, 5, 7, 2, 0.25, 'reported')`)
    insert.run('new', 'default', null, now, 100) // old ledger row: exact Studio session owner
    insert.run('new', 'default', null, now, 50)
    insert.run('alice', 'default', '2', now, 900)
    insert.run('new', 'default', '1', now - 8 * 86_400_000, 800)
    insert.run('new', 'research', null, now, 700) // same session ID, different Profile: no attribution
    insert.run('research', 'research', '2', now, 600)
    insert.run('gone', 'default', null, now, 400)

    const own = getLocalUsageStats('default', 7, { account: '1' })
    expect(own).toMatchObject({ input_tokens: 150, output_tokens: 40, cache_read_tokens: 600, cache_write_tokens: 10,
      reasoning_tokens: 14, total_api_calls: 4, sessions: 1, cost: 0.5, cost_coverage: { reported: 2, estimated: 0, unknown: 0 } })
    expect(own.by_model).toEqual([expect.objectContaining({ model: 'model-a', input_tokens: 150, sessions: 1 })])
    expect(own.by_agent).toEqual([expect.objectContaining({ agent: 'hermes', input_tokens: 150, sessions: 1 })])
    expect(own.by_day).toEqual([expect.objectContaining({ input_tokens: 150, sessions: 1, cost: 0.5 })])
    expect(getLocalUsageStats('default', 7, { account: '2' }).input_tokens).toBe(900)
    expect(getLocalUsageStats('default', 7, { account: 'unassigned' }).input_tokens).toBe(400)
    expect(getLocalUsageStats('research', 7, { account: '1' }).sessions).toBe(0)
    expect(getLocalUsageStats('research', 7, { account: 'unassigned' }).input_tokens).toBe(700)
    const partition = ['1', '2', 'unassigned'].map(account => getLocalUsageStats('default', 7, { account }).input_tokens)
    expect(partition.reduce((a, b) => a + b, 0)).toBe(getLocalUsageStats('default', 7).input_tokens)
    expect(getLocalUsageStats('default', 7, { account: '1', model: 'missing' }).sessions).toBe(0)
  })

  it('only supplements a whole Hermes bill when every row belongs to the selected account', () => {
    const insert = db.prepare(`INSERT INTO session_usage (session_id, profile, account_id, source, created_at)
      VALUES (?, 'default', ?, 'hermes', ?)`)
    insert.run('new', null, Date.now())
    insert.run('alice', '2', Date.now())
    insert.run('mixed', '1', Date.now())
    insert.run('mixed', '2', Date.now())
    expect(getUnpricedHermesUsageSessions('default', 7, { account: '1' }).map(row => row.sessionId)).toEqual(['new'])
    expect(getUnpricedHermesUsageSessions('default', 7, { account: '2' }).map(row => row.sessionId)).toEqual(['alice'])
    expect(getSessionUsageAccounts('research')).toEqual({ research: '2' })
  })
})
