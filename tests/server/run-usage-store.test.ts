import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({
  getDb: () => state.db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:',
}))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { completeRunUsage, withRunUsage, onRunUsageUpdated } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { updateUsage, fillMissingUsageCost, deleteUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { buildAppResumeMessagePage, buildResumeMessagePage } from '../../packages/server/src/modules/studio/services/chat-run/resume-payload'

function call(run: string, id: string, output: number, seconds?: number, cost?: number, session = 's') {
  return updateUsage(session, { runId: id, parentRunId: run, source: 'hermes', usageScope: 'model_call',
    inputTokens: 100, outputTokens: output, cacheReadTokens: 40, cacheWriteTokens: 10,
    apiDuration: seconds, costUsd: cost, costSource: 'estimated' })!
}
beforeEach(() => {
  state.db = new DatabaseSync(':memory:')
  initAllHermesTables()
})
afterEach(() => state.db.close())

describe('completed run usage', () => {
  it('publishes late tokens and prices for the exact completed run without replaying duplicates', () => {
    const updates = vi.fn()
    const off = onRunUsageUpdated(updates)
    try {
      call('r', 'a', 20, 2)
      expect(updates).not.toHaveBeenCalled()
      completeRunUsage('s', 'r', 'assistant-1')
      const late = call('r', 'late', 10, 1)
      expect(updates).toHaveBeenLastCalledWith('s', expect.objectContaining({ runId: 'r', assistantMessageId: 'assistant-1', outputTokens: 30, tokensPerSecond: 10 }))
      const count = updates.mock.calls.length
      call('r', 'late', 10, 1)
      expect(updates).toHaveBeenCalledTimes(count)
      fillMissingUsageCost(late, { costUsd: 0.2, costSource: 'estimated' })
      expect(updates).toHaveBeenCalledTimes(count + 1)
      call('next', 'another', 100)
      expect(updates).toHaveBeenCalledTimes(count + 1)
    } finally { off() }
  })

  it('isolates update subscribers from ledger persistence', () => {
    const off = onRunUsageUpdated(() => { throw new Error('disconnected client') })
    try {
      completeRunUsage('s', 'r', 'assistant-1')
      expect(() => call('r', 'late', 5)).not.toThrow()
      expect(withRunUsage('s', [{ id: 'assistant-1', role: 'assistant' }])[0]).toHaveProperty('run_usage.outputTokens', 5)
    } finally { off() }
  })

  it('restores missing run indexes through the real startup path, then persists and resumes usage', () => {
    state.db.exec('DROP INDEX idx_run_usage_session_run; DROP INDEX idx_run_usage_assistant')
    initAllHermesTables()
    initAllHermesTables() // startup stays idempotent
    expect(state.db.prepare('PRAGMA index_list(run_usage)').all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_run_usage_session_run', unique: 1 }),
      expect.objectContaining({ name: 'idx_run_usage_assistant' }),
    ]))
    call('r', 'a', 20, 2, 0.01)
    const summary = completeRunUsage('s', 'r', '1')
    expect(summary).toMatchObject({ inputTokens: 150, outputTokens: 20, cacheReadTokens: 40, costUsd: 0.01, tokensPerSecond: 10 })
    const resumed = withRunUsage('s', [{ id: '1', role: 'assistant', content: 'Done' }])
    expect(resumed[0]).toHaveProperty('run_usage', summary)
  })
  it('sums only this run, counts cache input once, and uses the weighted model duration', () => {
    call('first', 'a', 200, 2, 0.01)
    call('first', 'b', 300, 6, 0.02)
    call('first', 'b', 300, 6, 0.02) // replay must not duplicate
    call('next', 'c', 900, 1, 10)
    call('first', 'a', 999, 1, 10, 'other-session')
    expect(completeRunUsage('s', 'first', '11')).toEqual({
      runId: 'first', assistantMessageId: '11', inputTokens: 300, outputTokens: 500,
      cacheReadTokens: 80, cacheHitRate: 80 / 300, costUsd: 0.03, tokensPerSecond: 62.5, speedSource: 'model', isEstimated: false,
    })
    expect(withRunUsage('s', [{ id: '11', role: 'assistant' }])[0]).toHaveProperty('run_usage.outputTokens', 500)
  })
  it('keeps partial prices and incomplete timing unknown, preserving measured zero', () => {
    call('r', 'a', 0, 1, 0)
    expect(completeRunUsage('s', 'r', '1')).toMatchObject({ outputTokens: 0, tokensPerSecond: 0, costUsd: 0 })
    call('r', 'b', 100)
    expect(completeRunUsage('s', 'r', '1')).toMatchObject({ outputTokens: 100, costUsd: null, tokensPerSecond: null })
  })
  it('persists whole-run average speed when model time is incomplete, including resume and late pricing', () => {
    const first = call('r', 'a', 20, 2)
    const second = call('r', 'b', 60)
    expect(completeRunUsage('s', 'r', '1', 10)).toMatchObject({ outputTokens: 80, tokensPerSecond: 8, speedSource: 'run', isEstimated: false })
    fillMissingUsageCost(first, { costUsd: 0.1, costSource: 'estimated' })
    fillMissingUsageCost(second, { costUsd: 0.2, costSource: 'estimated' })
    expect(withRunUsage('s', [{ id: '1', role: 'assistant' }])[0]).toHaveProperty('run_usage.tokensPerSecond', 8)
    expect(completeRunUsage('s', 'r', '1', 500)).toMatchObject({ tokensPerSecond: 8, speedSource: 'run' })
    call('r', 'late', 20)
    expect(withRunUsage('s', [{ id: '1', role: 'assistant' }])[0]).toHaveProperty('run_usage.tokensPerSecond', 10)
    expect(state.db.prepare('SELECT run_duration_seconds, model_duration_seconds FROM run_usage').get()).toMatchObject({ run_duration_seconds: 10, model_duration_seconds: null })
  })
  it('prefers model request time over whole-run time, without borrowing another turn', () => {
    call('r', 'a', 80, 2)
    expect(completeRunUsage('s', 'r', '1', 40, 20)).toMatchObject({ tokensPerSecond: 40, speedSource: 'model' })
    call('next', 'b', 10)
    expect(completeRunUsage('s', 'next', '2', 5)).toMatchObject({ tokensPerSecond: 2, speedSource: 'run' })
  })
  it('persists the tool-excluded estimate through late usage, prices, replay and resume', () => {
    const first = call('r', 'a', 20)
    expect(completeRunUsage('s', 'r', '1', 10, 5)).toMatchObject({ tokensPerSecond: 4, speedSource: 'estimated' })
    expect(state.db.prepare('SELECT run_duration_seconds, tool_duration_seconds FROM run_usage').get())
      .toMatchObject({ run_duration_seconds: 10, tool_duration_seconds: 5 })
    fillMissingUsageCost(first, { costUsd: 0.1, costSource: 'estimated' })
    expect(completeRunUsage('s', 'r', '1', 100, 90)).toMatchObject({ tokensPerSecond: 4, speedSource: 'estimated' })
    call('r', 'late', 10)
    const resumed = withRunUsage('s', [{ id: '1', role: 'assistant' }])[0]
    expect(resumed).toHaveProperty('run_usage.tokensPerSecond', 6)
    expect(resumed).toHaveProperty('run_usage.speedSource', 'estimated')
  })
  it('does not divide by zero when tools occupy the whole run, or confuse no tools with missing timing', () => {
    call('r', 'a', 20)
    expect(completeRunUsage('s', 'r', '1', 10, 10)).toMatchObject({ tokensPerSecond: null, speedSource: null })
    call('no-tools', 'b', 20)
    expect(completeRunUsage('s', 'no-tools', '2', 10, 0)).toMatchObject({ tokensPerSecond: 2, speedSource: 'estimated' })
    call('missing', 'c', 20)
    expect(completeRunUsage('s', 'missing', '3', 10)).toMatchObject({ tokensPerSecond: 2, speedSource: 'run' })
  })
  it('does not invent output or timing, while preserving a measured zero output', () => {
    expect(completeRunUsage('s', 'empty', '1', 10)).toMatchObject({ tokensPerSecond: null, speedSource: null })
    call('zero', 'a', 0)
    expect(completeRunUsage('s', 'zero', '2', 10)).toMatchObject({ tokensPerSecond: 0, speedSource: 'run' })
    call('unknown', 'b', 100)
    for (const seconds of [undefined, 0, -1, NaN, Infinity]) {
      expect(completeRunUsage('s', 'unknown', '3', seconds)).toMatchObject({ tokensPerSecond: null, speedSource: null })
    }
  })
  it('attaches only to the exact assistant and supports pagination, reload and late pricing', () => {
    const row = call('r', 'a', 20, 2)
    const history = [{ id: '1', role: 'assistant' }, { id: '2', role: 'assistant' }]
    expect(withRunUsage('s', history)).toEqual(history) // not completed
    completeRunUsage('s', 'r', '1')
    fillMissingUsageCost(row, { costUsd: 0.5, costSource: 'estimated' })
    expect(withRunUsage('s', history)[0]).toHaveProperty('run_usage.costUsd', 0.5)
    expect(withRunUsage('s', history)[1]).not.toHaveProperty('run_usage')
    expect(withRunUsage('other', history)).toEqual(history)
    expect(withRunUsage('s', history.slice(1))).toEqual(history.slice(1))
    deleteUsage('s')
    expect(withRunUsage('s', history)).toEqual(history)
  })
  it('persists an unknown summary when no provider usage was available', () => {
    expect(completeRunUsage('s', 'empty', '9')).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadTokens: null, costUsd: null, tokensPerSecond: null })
    expect(withRunUsage('s', [{ id: '9', role: 'assistant' }])[0]).toHaveProperty('run_usage.runId', 'empty')
  })
  it('invalidates the App resume cache when stored usage or a late price changes', () => {
    const history = [{ id: '1', role: 'assistant', content: '', timestamp: 1 }]
    const resumePage = () => buildResumeMessagePage(withRunUsage('s', history))
    const before = buildAppResumeMessagePage(resumePage(), '')
    const row = call('r', 'a', 20, 2)
    completeRunUsage('s', 'r', '1')
    const restored = buildAppResumeMessagePage(resumePage(), before.id)
    expect(restored.messagesCached).toBe(false)
    expect(restored.id).not.toBe(before.id)
    expect(restored.messages?.[0]).toHaveProperty('run_usage.outputTokens', 20)
    expect(buildAppResumeMessagePage(resumePage(), restored.id)).toMatchObject({ messagesCached: true })

    fillMissingUsageCost(row, { costUsd: 0.01, costSource: 'estimated' })
    const priced = buildAppResumeMessagePage(resumePage(), restored.id)
    expect(priced.messagesCached).toBe(false)
    expect(priced.messages?.[0]).toHaveProperty('run_usage.costUsd', 0.01)
    expect(buildAppResumeMessagePage(resumePage(), priced.id)).toMatchObject({ messagesCached: true })
  })
  it('stores a single independent snapshot and never reads the ledger to display it', () => {
    call('r', 'a', 20, 2, 0.01)
    expect(state.db.prepare('SELECT * FROM run_usage').all()).toHaveLength(0)
    completeRunUsage('s', 'r', '1')
    const saved = state.db.prepare('SELECT * FROM run_usage').get()
    expect(saved).toMatchObject({ session_id: 's', run_id: 'r', assistant_message_id: '1', input_tokens: 150,
      output_tokens: 20, cache_read_tokens: 40, cache_write_tokens: 10, cache_hit_rate: 40 / 150,
      cost_usd: 0.01, model_duration_seconds: 2, tokens_per_second: 10, completed_at: expect.any(Number), updated_at: expect.any(Number) })
    completeRunUsage('s', 'r') // a replay without a message ID must preserve attribution
    expect(state.db.prepare('SELECT * FROM run_usage').all()).toHaveLength(1)
    expect(state.db.prepare('SELECT completed_at, assistant_message_id FROM run_usage').get()).toMatchObject({ completed_at: saved.completed_at, assistant_message_id: '1' })
    state.db.exec('DROP TABLE session_usage')
    expect(withRunUsage('s', [{ id: '1', role: 'assistant' }])[0]).toHaveProperty('run_usage.cacheHitRate', 40 / 150)
  })
  it('weights cache hits by all input including cache writes, not request percentages', () => {
    updateUsage('s', { runId: 'a', parentRunId: 'weighted', inputTokens: 10, cacheReadTokens: 90, outputTokens: 1 })
    updateUsage('s', { runId: 'b', parentRunId: 'weighted', inputTokens: 710, cacheReadTokens: 90, cacheWriteTokens: 100, outputTokens: 99 })
    expect(completeRunUsage('s', 'weighted', '1')).toMatchObject({ inputTokens: 1000, cacheReadTokens: 180, cacheHitRate: 0.18 })
  })
  it.each([
    { input: 0, cache: 0, write: 0, expected: null },
    { input: 100, cache: 0, write: 0, expected: 0 },
    { input: 0, cache: 100, write: 0, expected: 1 },
    { input: 0, cache: 0, write: 100, expected: 0 },
  ])('handles zero, no-hit and full-hit input: $input/$cache/$write', ({ input, cache, write, expected }) => {
    updateUsage('s', { runId: 'a', parentRunId: 'r', inputTokens: input, cacheReadTokens: cache, cacheWriteTokens: write, outputTokens: 900 })
    expect(completeRunUsage('s', 'r', '1').cacheHitRate).toBe(expected)
  })
  it('updates only the completed run when usage or prices arrive late', () => {
    const first = call('r', 'a', 20, 2)
    completeRunUsage('s', 'r', '1')
    call('other', 'other-a', 100, 5, 1)
    completeRunUsage('s', 'other', '2')
    const other = state.db.prepare("SELECT * FROM run_usage WHERE run_id = 'other'").get()
    const second = call('r', 'b', 60, 2)
    expect(withRunUsage('s', [{ id: '1', role: 'assistant' }])[0]).toHaveProperty('run_usage.outputTokens', 80)
    fillMissingUsageCost(first, { costUsd: 0.2, costSource: 'estimated' })
    expect(state.db.prepare("SELECT cost_usd FROM run_usage WHERE run_id = 'r'").get().cost_usd).toBeNull()
    fillMissingUsageCost(second, { costUsd: 0.3, costSource: 'estimated' })
    expect(state.db.prepare("SELECT * FROM run_usage WHERE run_id = 'r'").get()).toMatchObject({ cost_usd: 0.5, tokens_per_second: 20 })
    expect(state.db.prepare("SELECT * FROM run_usage WHERE run_id = 'other'").get()).toEqual(other)
    fillMissingUsageCost(second, { costUsd: 999, costSource: 'estimated' })
    expect(state.db.prepare("SELECT cost_usd FROM run_usage WHERE run_id = 'r'").get().cost_usd).toBe(0.5)
  })
  it('records runs without assistant messages, without attaching them to unrelated replies', () => {
    call('r', 'a', 20, 2, 0.01)
    expect(completeRunUsage('s', 'r')).toMatchObject({ assistantMessageId: '', outputTokens: 20 })
    expect(state.db.prepare('SELECT * FROM run_usage').all()).toHaveLength(1)
    expect(withRunUsage('s', [{ id: '1', role: 'assistant' }])[0]).not.toHaveProperty('run_usage')
  })

})
