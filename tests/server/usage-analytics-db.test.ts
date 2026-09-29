import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const profileMock = vi.hoisted(() => ({
  getActiveProfileDir: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/hermes/services/profiles/profile', () => ({
  getActiveProfileDir: profileMock.getActiveProfileDir,
  getProfileDir: vi.fn(),
}))

function createStateDb(withApiCallCount = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-usage-'))
  const db = new DatabaseSync(join(dir, 'state.db'))
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT,
      model TEXT,
      started_at INTEGER,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      actual_cost_usd REAL${withApiCallCount ? ', api_call_count INTEGER DEFAULT 0' : ''}
    )
  `)
  db.close()
  return dir
}

function insertSession(
  dir: string,
  row: {
    id: string
    source?: string
    model?: string | null
    started_at: number
    input_tokens?: number
    output_tokens?: number
    cache_read_tokens?: number
    cache_write_tokens?: number
    reasoning_tokens?: number
    estimated_cost_usd?: number
    actual_cost_usd?: number | null
    api_call_count?: number
  },
  withApiCallCount = true,
) {
  const db = new DatabaseSync(join(dir, 'state.db'))
  const baseParams = {
    id: row.id,
    source: row.source ?? 'cli',
    model: row.model ?? null,
    started_at: row.started_at,
    input_tokens: row.input_tokens ?? 0,
    output_tokens: row.output_tokens ?? 0,
    cache_read_tokens: row.cache_read_tokens ?? 0,
    cache_write_tokens: row.cache_write_tokens ?? 0,
    reasoning_tokens: row.reasoning_tokens ?? 0,
    estimated_cost_usd: row.estimated_cost_usd ?? 0,
    actual_cost_usd: row.actual_cost_usd ?? null,
  }

  if (withApiCallCount) {
    db.prepare(`
      INSERT INTO sessions (
        id, source, model, started_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        estimated_cost_usd, actual_cost_usd, api_call_count
      ) VALUES (
        $id, $source, $model, $started_at, $input_tokens, $output_tokens,
        $cache_read_tokens, $cache_write_tokens, $reasoning_tokens,
        $estimated_cost_usd, $actual_cost_usd, $api_call_count
      )
    `).run({ ...baseParams, api_call_count: row.api_call_count ?? 0 })
  } else {
    db.prepare(`
      INSERT INTO sessions (
        id, source, model, started_at, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, reasoning_tokens,
        estimated_cost_usd, actual_cost_usd
      ) VALUES (
        $id, $source, $model, $started_at, $input_tokens, $output_tokens,
        $cache_read_tokens, $cache_write_tokens, $reasoning_tokens,
        $estimated_cost_usd, $actual_cost_usd
      )
    `).run(baseParams)
  }
  db.close()
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

describe('native-style Hermes usage analytics DB aggregation', () => {
  let profileDir: string | null = null

  beforeEach(() => {
    vi.resetModules()
    profileMock.getActiveProfileDir.mockReset()
  })

  afterEach(() => {
    if (profileDir) rmSync(profileDir, { recursive: true, force: true })
    profileDir = null
  })

  it('sums direct state.db rows in the period', async () => {
    const now = 1_700_000_000
    profileDir = createStateDb(true)
    profileMock.getActiveProfileDir.mockReturnValue(profileDir)

    insertSession(profileDir, {
      id: 'root',
      source: 'cli',
      model: 'gpt-5',
      started_at: now - 60,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      cache_write_tokens: 2,
      reasoning_tokens: 5,
      estimated_cost_usd: 0.02,
      actual_cost_usd: null,
      api_call_count: 1,
    })
    insertSession(profileDir, {
      id: 'tool-child',
      source: 'tool',
      model: 'tool-model',
      started_at: now - 90,
      input_tokens: 30,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_write_tokens: 1,
      reasoning_tokens: 2,
      estimated_cost_usd: 0.01,
      actual_cost_usd: 0.015,
      api_call_count: 2,
    })
    insertSession(profileDir, {
      id: 'compress_1',
      source: 'cli',
      model: 'gpt-5',
      started_at: now - 86400,
      input_tokens: 7,
      output_tokens: 3,
      cache_read_tokens: 1,
      estimated_cost_usd: 0.005,
    })
    insertSession(profileDir, {
      id: 'null-model',
      source: 'cli',
      model: null,
      started_at: now - 120,
      input_tokens: 1,
      output_tokens: 2,
      estimated_cost_usd: 0.003,
    })
    insertSession(profileDir, {
      id: 'web-local-copy',
      source: 'api_server',
      model: 'gpt-5',
      started_at: now - 30,
      input_tokens: 500,
      output_tokens: 500,
      estimated_cost_usd: 5,
      api_call_count: 5,
    })
    insertSession(profileDir, {
      id: 'old',
      source: 'cli',
      model: 'old-model',
      started_at: now - 31 * 86400,
      input_tokens: 999,
      output_tokens: 999,
      estimated_cost_usd: 9,
      api_call_count: 9,
    })

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const result = await mod.getUsageStatsFromDb(30, now)

    expect(result).toMatchObject({
      input_tokens: 638,
      output_tokens: 575,
      cache_read_tokens: 16,
      cache_write_tokens: 3,
      reasoning_tokens: 7,
      sessions: 5,
      total_api_calls: 8,
    })
    expect(result.cost).toBeCloseTo(5.043)
    expect(result.by_model).toEqual([
      { model: 'gpt-5', input_tokens: 607, output_tokens: 553, cache_read_tokens: 11, cache_write_tokens: 2, reasoning_tokens: 5, sessions: 3 },
      { model: 'tool-model', input_tokens: 30, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
    ])
    expect(result.by_day).toHaveLength(2)
    expect(result.by_day[0]).toEqual({
      date: day(now - 86400),
      input_tokens: 7,
      output_tokens: 3,
      cache_read_tokens: 1,
      cache_write_tokens: 0,
      sessions: 1,
      errors: 0,
      cost: 0.005,
      cost_coverage: { reported: 0, estimated: 1, unknown: 0 },
    })
    expect(result.by_day[1]).toMatchObject({
      date: day(now),
      input_tokens: 631,
      output_tokens: 572,
      cache_read_tokens: 15,
      cache_write_tokens: 3,
      sessions: 4,
      errors: 0,
    })
    expect(result.by_day[1].cost).toBeCloseTo(5.038)

    const withoutLocallyRecorded = await mod.getUsageStatsFromDb(
      30,
      now,
      undefined,
      ['root', 'web-local-copy'],
    )
    expect(withoutLocallyRecorded).toMatchObject({
      input_tokens: 38,
      output_tokens: 25,
      cache_read_tokens: 6,
      cache_write_tokens: 1,
      reasoning_tokens: 2,
      sessions: 3,
      total_api_calls: 2,
    })
    expect(withoutLocallyRecorded.cost).toBeCloseTo(0.023)
    expect(withoutLocallyRecorded.by_model).toEqual([
      { model: 'tool-model', input_tokens: 30, output_tokens: 20, cache_read_tokens: 5, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
      { model: 'gpt-5', input_tokens: 7, output_tokens: 3, cache_read_tokens: 1, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
    ])
  })

  it('keeps analytics working against older state.db schemas without api_call_count', async () => {
    const now = 1_700_000_000
    profileDir = createStateDb(false)
    profileMock.getActiveProfileDir.mockReturnValue(profileDir)
    insertSession(profileDir, {
      id: 'legacy',
      model: 'legacy-model',
      started_at: now - 60,
      input_tokens: 4,
      output_tokens: 6,
      estimated_cost_usd: 0.001,
    }, false)

    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const result = await mod.getUsageStatsFromDb(30, now)

    expect(result.input_tokens).toBe(4)
    expect(result.output_tokens).toBe(6)
    expect(result.total_api_calls).toBe(0)
  })
  it('recovers excluded session costs separately and treats legacy default zero as unknown', async () => {
    const now = 1_700_000_000
    profileDir = createStateDb(true)
    profileMock.getActiveProfileDir.mockReturnValue(profileDir)
    insertSession(profileDir, { id: 'local', started_at: now - 10, input_tokens: 100, estimated_cost_usd: 0.12 })
    insertSession(profileDir, { id: 'unknown', started_at: now - 10, input_tokens: 10 })
    insertSession(profileDir, { id: 'free', started_at: now - 10, input_tokens: 20, actual_cost_usd: 0 })
    const mod = await import('../../packages/server/src/modules/hermes/services/history/sessions-db')
    const result = await mod.getUsageStatsFromDb(1, now, undefined, ['local'], ['local'])
    expect(result.input_tokens).toBe(30)
    expect(result.cost).toBe(0)
    expect(result.cost_coverage).toEqual({ reported: 1, estimated: 0, unknown: 1 })
    expect(result.cost_fallbacks).toEqual([{ session_id: 'local', date: day(now), cost: 0.12, source: 'estimated' }])
    expect((await mod.getUsageStatsFromDb(1, now, undefined, ['local'])).cost_fallbacks).toEqual([])
  })

})
