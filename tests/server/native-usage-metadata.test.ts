import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readCodexTurnModel, readOpenCodeMessageModel } from '../../packages/server/src/modules/coding-agents/services/runtime/native-model'
import { NativeTurnUsage } from '../../packages/server/src/modules/coding-agents/services/runtime/native-usage'

describe('native model metadata', () => {
  let root: string
  const startedAt = Date.parse('2026-09-11T01:00:00Z')
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'native-model-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))
  function rollout(id: string, events: unknown[]) {
    const dir = join(root, 'sessions', '2026', '09', '10')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `rollout-test-${id}.jsonl`), events.map(row => JSON.stringify(row)).join('\n'))
  }
  const context = (model: string, timestamp = '2026-09-11T01:00:01Z') => ({ type: 'turn_context', timestamp, payload: { model } })
  it('finds a resumed thread in an older directory without borrowing its previous model', async () => {
    rollout('wanted', [{ type: 'session_meta', payload: { id: 'wanted', model_provider: 'native-provider' } }, context('old', '2026-09-10T01:00:01Z'), context('actual')])
    rollout('another', [{ type: 'session_meta', payload: { id: 'another' } }, context('wrong')])
    expect(await readCodexTurnModel(root, 'wanted', startedAt)).toEqual({ model: 'actual', provider: 'native-provider' })
  })
  it('does not attribute failed-before-start turns to a previous model', async () => {
    rollout('wanted', [{ type: 'session_meta', payload: { id: 'wanted' } }, context('old', '2026-09-10T01:00:01Z')])
    expect(await readCodexTurnModel(root, 'wanted', startedAt)).toBeUndefined()
    expect(await readCodexTurnModel(root, '../wanted', startedAt)).toBeUndefined()
    expect(await readCodexTurnModel(root, 'missing', startedAt)).toBeUndefined()
  })
  it('rejects a mismatched header and ambiguous multi-model turn', async () => {
    rollout('wanted', [{ type: 'session_meta', payload: { id: 'another' } }, context('wrong')])
    expect(await readCodexTurnModel(root, 'wanted', startedAt)).toBeUndefined()
    rollout('wanted', [{ type: 'session_meta', payload: { id: 'wanted' } }, context('first'), context('second')])
    expect(await readCodexTurnModel(root, 'wanted', startedAt)).toBeUndefined()
  })
  it('does not read an OpenCode user message or a different native session', () => {
    const file = join(root, 'opencode.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)')
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('id', 'session', JSON.stringify({ role: 'user', modelID: 'selection-only' }))
    db.close()
    expect(readOpenCodeMessageModel(file, 'session', 'id')).toBeUndefined()
    expect(readOpenCodeMessageModel(file, 'other', 'id')).toBeUndefined()
    expect(readOpenCodeMessageModel(join(root, 'missing'), 'session', 'id')).toBeUndefined()
  })
})

describe('native usage normalization', () => {
  it('uses native model request milliseconds and never substitutes total tool-inclusive time', () => {
    const tracker = new NativeTurnUsage()
    tracker.observeClaude({ type: 'result', duration_api_ms: 2500, duration_ms: 30000, usage: { input_tokens: 10, output_tokens: 25 } })
    expect(tracker.rows('claude-code', undefined)[0].apiDuration).toBe(2.5)
    expect(new NativeTurnUsage().rows('cursor', { inputTokens: 10, outputTokens: 25, duration_api_ms: 2000, duration_ms: 20000 })[0].apiDuration).toBe(2)
    expect(new NativeTurnUsage().rows('cursor', { inputTokens: 10, outputTokens: 25, duration_ms: 20000 })[0].apiDuration).toBeUndefined()
  })
  it('does not duplicate an aggregate API duration across several models', () => {
    const tracker = new NativeTurnUsage()
    tracker.observeClaude({ type: 'result', duration_api_ms: 2500, usage: { input_tokens: 30, output_tokens: 5 }, modelUsage: {
      first: { inputTokens: 10, outputTokens: 2 }, second: { inputTokens: 20, outputTokens: 3 },
    } })
    const rows = tracker.rows('claude-code', undefined)
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.apiDuration == null)).toBe(true)
  })
  it('separates all Codex input buckets and preserves native reasoning output', () => {
    const tracker = new NativeTurnUsage()
    expect(tracker.rows('codex', { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 15 })[0].usage).toMatchObject({
      inputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 10, outputTokens: 20, reasoningTokens: 15,
    })
  })
  it('does not invent usage for an authentication error', () => {
    expect(new NativeTurnUsage().rows('codex', undefined)).toEqual([])
    expect(new NativeTurnUsage().rows('grok', undefined)).toEqual([])
  })
  it('does not replace Claude authoritative usage with a larger auxiliary-work summary', () => {
    const tracker = new NativeTurnUsage()
    tracker.observeClaude({ type: 'result', usage: { input_tokens: 10, output_tokens: 2 }, modelUsage: { actual: { inputTokens: 500, outputTokens: 20 } } })
    const rows = tracker.rows('claude-code', undefined)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: 'actual', usage: { inputTokens: 10, outputTokens: 2 } })
  })
  it('retains completed Claude calls on a later API failure', () => {
    const tracker = new NativeTurnUsage()
    tracker.observeClaude({ type: 'assistant', message: { id: 'message', model: 'actual', usage: { input_tokens: 10, output_tokens: 2 } } })
    tracker.observeClaude({ type: 'assistant', isApiErrorMessage: true, message: { id: 'error', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } })
    expect(tracker.rows('claude-code', undefined)).toMatchObject([{ model: 'actual', usage: { inputTokens: 10, outputTokens: 2 } }])
  })
  it('uses Grok final error aggregate instead of adding preceding response counters', () => {
    const tracker = new NativeTurnUsage()
    tracker.observeGrok({ type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } })
    tracker.observeGrok({ type: 'error', usage: { input_tokens: 30, output_tokens: 5 }, modelUsage: { actual: { inputTokens: 30, outputTokens: 5, modelCalls: 2 } } })
    expect(tracker.rows('grok', { input_tokens: 10, output_tokens: 2 })).toMatchObject([{ model: 'actual', apiCalls: 2, usage: { inputTokens: 30, outputTokens: 5 } }])
  })
})
