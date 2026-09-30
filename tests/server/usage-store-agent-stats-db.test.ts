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
})
