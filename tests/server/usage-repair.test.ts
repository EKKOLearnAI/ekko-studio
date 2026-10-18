import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { USAGE_SCHEMA, USAGE_RUN_INDEX, RUN_USAGE_SCHEMA, RUN_USAGE_INDEXES } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { usageRepairSnapshot, applyUsageRepair, type RepairUsageRow } from '../../packages/server/src/modules/studio/repositories/usage-repair-store'
import { planCodexUsageRepair } from '../../packages/server/src/modules/coding-agents/services/codex/usage-repair'
import type { CodexUsageTurn } from '../../packages/server/src/modules/coding-agents/services/codex/usage'

describe('explicit historical usage repair', () => {
  let db: DatabaseSync, before: RepairUsageRow[]
  const turn: CodexUsageTurn = { id: 'turn', startedAt: 1100, endedAt: 1900, complete: true, rows: [
    { id: 'request', ledgerId: 'codex:thread:request', createdAt: 1500, model: 'm', provider: 'p', scope: 'model_call', apiCalls: 1,
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0, reasoningTokens: 3 } },
  ] }
  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    for (const [table, schema] of [['session_usage', USAGE_SCHEMA], ['run_usage', RUN_USAGE_SCHEMA]] as const) {
      db.exec(`CREATE TABLE ${table} (${Object.entries(schema).map(([k, v]) => `${k} ${v}`).join(',')})`)
    }
    db.exec(USAGE_RUN_INDEX)
    for (const sql of Object.values(RUN_USAGE_INDEXES)) db.exec(sql)
    db.exec(`INSERT INTO session_usage (session_id, run_id, parent_run_id, source, agent, created_at, input_tokens, output_tokens)
      VALUES ('s', 'resp_1000:turn', 'parent', 'coding_agent', 'codex', 2000, 1000, 100)`)
    db.exec(`INSERT INTO run_usage (session_id, run_id, assistant_message_id, completed_at, updated_at, run_duration_seconds)
      VALUES ('s', 'parent', 'assistant', 2000, 2000, 5)`)
    before = usageRepairSnapshot(db, 's')
  })
  afterEach(() => db.close())
  const price = () => ({ costUsd: 0.12, costSource: 'estimated' as const })
  it('previews without writes, atomically replaces counters, preserves dates and refreshes the exact run', () => {
    const plan = planCodexUsageRepair(before, [turn], price)
    expect(plan.replacements).toHaveLength(1)
    expect(usageRepairSnapshot(db, 's')).toEqual(before)
    applyUsageRepair(db, 's', before, plan.replacements)
    const after = usageRepairSnapshot(db, 's')
    expect(after).toMatchObject([{ input_tokens: 20, output_tokens: 5, cache_read_tokens: 10, created_at: 1500, cost_usd: 0.12, api_calls: 1 }])
    expect(db.prepare('SELECT * FROM run_usage').get()).toMatchObject({
      assistant_message_id: 'assistant', input_tokens: 30, output_tokens: 5, cost_usd: 0.12, tokens_per_second: 1,
    })
    expect(planCodexUsageRepair(after, [turn], price).replacements).toEqual([])
  })
  it('refuses changed ledgers and rolls back every deletion on a collision', () => {
    const plan = planCodexUsageRepair(before, [turn], price)
    db.exec('UPDATE session_usage SET input_tokens = 1001')
    expect(() => applyUsageRepair(db, 's', before, plan.replacements)).toThrow('Usage changed')
    db.exec('UPDATE session_usage SET input_tokens = 1000')
    plan.replacements[0].rows.push(plan.replacements[0].rows[0])
    expect(() => applyUsageRepair(db, 's', before, plan.replacements)).toThrow()
    expect(usageRepairSnapshot(db, 's')).toEqual(before)
  })
  it('skips ambiguous, incomplete, active and already reported turns', () => {
    for (const turns of [[turn, { ...turn, id: 'other' }], [{ ...turn, complete: false }], [{ ...turn, endedAt: undefined }]]) {
      expect(planCodexUsageRepair(before, turns, price).replacements).toEqual([])
    }
    expect(planCodexUsageRepair([{ ...before[0], cost_source: 'reported' }], [turn], price).replacements).toEqual([])
    expect(planCodexUsageRepair(before, [turn], () => undefined).replacements[0].rows[0].cost_usd).toBeNull()
  })
})
