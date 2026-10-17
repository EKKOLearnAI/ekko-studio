import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let db: DatabaseSync

vi.mock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
  isSqliteAvailable: () => true,
  getDb: () => db,
  jsonSet: vi.fn(),
  jsonGet: vi.fn(),
  jsonGetAll: vi.fn(),
  jsonDelete: vi.fn(),
}))

describe('usage store agent breakdown', () => {
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE session_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        account_id TEXT,
        source TEXT NOT NULL DEFAULT '',
        agent TEXT NOT NULL DEFAULT '',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        cost_source TEXT NOT NULL DEFAULT 'unknown',
        api_calls INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL DEFAULT '',
        profile TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL DEFAULT 0
      );
    `)
  })

  afterEach(() => db.close())

  it('groups ledger rows by their explicit agent type', async () => {
    const now = Date.now()
    const insert = db.prepare(`
      INSERT INTO session_usage (
        session_id, source, agent, input_tokens, output_tokens,
        cache_read_tokens, model, profile, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run('new-claude', 'coding_agent', 'claude_code', 100, 10, 40, 'claude-model', 'default', now)
    insert.run('new-codex', 'coding_agent', 'codex', 80, 20, 30, 'codex-model', 'default', now)
    insert.run('hermes-1', 'hermes', 'hermes', 30, 3, 6, 'hermes-model', 'default', now)

    const { getLocalUsageStats } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    expect(getLocalUsageStats('default', 7).by_agent).toEqual([
      { agent: 'claude_code', input_tokens: 100, output_tokens: 10, cache_read_tokens: 40, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
      { agent: 'codex', input_tokens: 80, output_tokens: 20, cache_read_tokens: 30, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
      { agent: 'hermes', input_tokens: 30, output_tokens: 3, cache_read_tokens: 6, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
    ])
  })

  it('intersects profile, period, model and agent before aggregating every metric', async () => {
    const now = Date.now()
    const insert = db.prepare(`INSERT INTO session_usage
      (session_id, agent, model, profile, created_at, input_tokens, output_tokens, cache_read_tokens, cost_usd, cost_source, api_calls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', 1)`)
    insert.run('shared', 'codex', 'same-model', 'default', now, 100, 20, 500, 0.02)
    insert.run('shared', 'codex', 'same-model', 'default', now, 50, 10, 200, 0.01)
    insert.run('shared', 'hermes', 'same-model', 'default', now, 900, 100, 1000, 2)
    insert.run('other-model', 'codex', 'other-model', 'default', now, 300, 30, 600, 3)
    insert.run('other-profile', 'codex', 'same-model', 'research', now, 999, 99, 999, 4)
    insert.run('old', 'codex', 'same-model', 'default', now - 8 * 86_400_000, 800, 80, 800, 5)
    insert.run('unknown', '', '', 'default', now, 1, 2, 3, 0)
    const { getLocalUsageStats } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    const result = getLocalUsageStats('default', 7, { model: 'same-model', agent: 'codex', account: 'unassigned' })
    expect(result).toMatchObject({ input_tokens: 150, output_tokens: 30, cache_read_tokens: 700, sessions: 1, cost: 0.03, total_api_calls: 2 })
    expect(result.by_model).toHaveLength(1)
    expect(result.by_agent).toHaveLength(1)
    expect(result.by_day[0]).toMatchObject({ input_tokens: 150, output_tokens: 30, sessions: 1, cost: 0.03 })
    expect(result.filter_options).toEqual({ models: ['other-model', 'same-model', 'unknown'], agents: ['codex', 'hermes', 'unknown'] })
    expect(getLocalUsageStats('default', 7, { model: 'missing', agent: 'codex' }).sessions).toBe(0)
    expect(getLocalUsageStats('default', 7, { model: 'unknown', agent: 'unknown' }).input_tokens).toBe(1)
  })

  it('counts today from local midnight and combines UTC dates without duplicating sessions', async () => {
    const { getTodayUsageWindow } = await import('../../packages/server/src/modules/studio/services/usage/usage-period')
    const today = getTodayUsageWindow('Asia/Shanghai', Date.parse('2026-10-11T10:00:00Z'))
    const insert = db.prepare(`INSERT INTO session_usage
      (session_id, agent, model, profile, created_at, input_tokens, cost_usd, cost_source)
      VALUES (?, 'codex', 'same-model', 'default', ?, ?, ?, 'reported')`)
    insert.run('shared', today.startMs, 100, 0.02)
    insert.run('shared', Date.parse('2026-10-11T02:00:00Z'), 50, 0.01)
    insert.run('yesterday', today.startMs - 1, 900, 2)
    insert.run('future', today.endMs + 1, 999, 3)
    const { getLocalUsageStats, getUnpricedHermesUsageSessions } = await import('../../packages/server/src/modules/studio/repositories/usage-store')
    const result = getLocalUsageStats('default', 1, { today, account: 'unassigned' })
    expect(result).toMatchObject({ input_tokens: 150, sessions: 1, cost: 0.03 })
    expect(result.by_day).toEqual([expect.objectContaining({ date: '2026-10-11', input_tokens: 150, sessions: 1, cost: 0.03 })])

    const unpriced = db.prepare(`INSERT INTO session_usage (session_id, source, agent, profile, created_at)
      VALUES (?, 'hermes', 'hermes', 'default', ?)`)
    unpriced.run('new', today.startMs)
    unpriced.run('new', Date.parse('2026-10-11T02:00:00Z'))
    unpriced.run('cross-midnight', today.startMs - 1)
    unpriced.run('cross-midnight', today.startMs + 1)
    expect(getUnpricedHermesUsageSessions('default', 1, { today })).toEqual([
      { sessionId: 'new', days: [{ date: '2026-10-11', entries: 2 }] },
    ])
  })
})
