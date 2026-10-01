import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCodexUsageFile, readCodexTurnUsage } from '../../packages/server/src/modules/coding-agents/services/runtime/codex-usage'
import { NativeTurnUsage } from '../../packages/server/src/modules/coding-agents/services/runtime/native-usage'
import { estimateCatalogUsageCost } from '../../packages/server/src/modules/studio/services/usage/catalog-pricing'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const at = Date.now() - 10000
const event = (type: string, payload: any, offset = 0) => ({ type, payload, timestamp: new Date(at + offset).toISOString() })
const usage = (input: number, output = 10, cache = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cache })
const header = event('session_meta', { id: 'thread', model_provider: 'openai' })
const start = (id: string, offset = 0) => event('event_msg', { type: 'task_started', turn_id: id }, offset)
const model = (name = 'm') => event('turn_context', { model: name })
const call = (turn: string, id: string, u: any, total = u) => event('token_usage_record', {
  thread_id: 'thread', turn_id: turn, response_id: id, usage: u, turn_token_usage: total,
})
async function read(events: any[]) {
  const root = mkdtempSync(join(tmpdir(), 'codex-ledger-')); roots.push(root)
  const path = join(root, 'rollout-thread.jsonl')
  writeFileSync(path, events.map(e => typeof e === 'string' ? e : JSON.stringify(e)).join('\n'))
  return readCodexUsageFile(path, 'thread')
}

describe('Codex native request accounting', () => {
  it('keeps resumed turns separate, includes compaction, deduplicates requests and prices each context', async () => {
    const old = usage(150000, 20, 100000), next = usage(150000, 30, 120000)
    const turns = await read([header, start('one'), model(), call('one', 'first', old),
      start('two', 1000), model(), call('two', 'next', next), call('two', 'next', next),
      call('two', 'compaction', usage(150000, 50, 100000), usage(300000, 80, 220000)),
      call('two', 'next', next),
      event('event_msg', { type: 'token_count', info: { total_token_usage: usage(450000, 100, 320000), last_token_usage: usage(150000, 50, 100000) } }),
    ])
    expect(turns?.map(t => t.rows.length)).toEqual([1, 2])
    expect(turns?.every(t => t.complete)).toBe(true)
    const tracker = new NativeTurnUsage(); tracker.codexResumed = true; tracker.codexRows = turns![1].rows
    const rows = tracker.rows('codex', usage(450000, 100, 320000))
    expect(rows.reduce((sum, r) => sum + r.usage.inputTokens + r.usage.cacheReadTokens, 0)).toBe(300000)
    expect(rows.reduce((sum, r) => sum + r.usage.outputTokens, 0)).toBe(80)
    const snapshot = { version: 'v', fetchedAt: 1, data: { openai: { models: { m: { cost: {
      input: 10, output: 50, cache_read: 1, tiers: [{ tier: { type: 'context', size: 272000 }, input: 20 }],
    } } } } } } as any
    const costs = rows.map(r => estimateCatalogUsageCost(snapshot, r.provider!, r.model, r.usage, r.scope, r.apiCalls)?.costUsd)
    expect(costs[0]).toBeCloseTo(0.4215)
    expect(costs[1]).toBeCloseTo(0.6025)
  })

  it('retains actual per-call model identities and does not borrow a different thread', async () => {
    const turns = await read([header, start('one'), model('a'), call('one', 'a', usage(10)),
      model('b'), call('one', 'b', usage(20), usage(30, 20)),
      event('token_usage_record', { thread_id: 'child', turn_id: 'one', response_id: 'child', usage: usage(9999) }),
    ])
    expect(turns?.[0].rows.map(r => r.model)).toEqual(['a', 'b'])
    expect(turns?.[0].complete).toBe(true)
    expect(await read([event('session_meta', { id: 'wrong' }), start('one'), model(), call('one', 'a', usage(10))])).toBeUndefined()
  })

  it('supports older token_count records without counting repeated cumulative notifications', async () => {
    const count = (total: any, last: any) => event('event_msg', { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } })
    const turns = await read([header, start('one'), model(), count(usage(100), usage(100)),
      start('two', 1000), model(), count(usage(300, 30), usage(200, 20)), count(usage(300, 30), usage(200, 20))])
    expect(turns?.map(t => t.rows[0].usage.inputTokens)).toEqual([100, 200])
    expect(turns?.map(t => t.rows.length)).toEqual([1, 1])
  })

  it('uses the verified request ledger even when legacy usage is malformed', async () => {
    const turns = await read([header, start('one'), model(),
      event('event_msg', { type: 'token_count', info: { total_token_usage: usage(100), last_token_usage: {} } }),
      call('one', 'actual', usage(10)),
    ])
    expect(turns?.[0]).toMatchObject({ complete: true, rows: [{ usage: { inputTokens: 10 } }] })
  })

  it.each([
    [call('one', 'a', usage(-1))],
    [call('one', 'a', usage(10), usage(100))],
    [call('one', 'a', usage(10)), call('one', 'a', usage(11))],
    [call('one', 'a', usage(10)), '{broken'],
  ])('refuses incomplete or conflicting ledgers', async (...events) => {
    const turns = await read([header, start('one'), model(), ...events])
    expect(turns?.[0].complete).toBe(false)
  })

  it('preserves measured calls on cancellation even without task_complete', async () => {
    const turns = await read([header, start('one'), model(), call('one', 'a', usage(10))])
    expect(turns?.[0]).toMatchObject({ complete: true, endedAt: undefined })
    expect(turns?.[0].rows).toHaveLength(1)
  })

  it('never charges an unverified resumed thread total', () => {
    const tracker = new NativeTurnUsage(); tracker.codexResumed = true
    expect(tracker.rows('codex', usage(1000))).toEqual([])
    tracker.codexRows = []
    expect(tracker.rows('codex', usage(1000))).toEqual([])
  })
  it('bounds file lookup to an identified native session', async () => {
    expect(await readCodexTurnUsage('/missing', '../thread', at)).toBeUndefined()
    expect(await readCodexTurnUsage('/missing', 'thread', at)).toBeUndefined()
  })
})
