import { describe, expect, it } from 'vitest'
import { json, validateSchema } from '../../packages/server/src/modules/studio/services/plugins/schema'
import { agentStatus, agentModels, agentSettings, agentUpdate, agentUpgrade, agentCheckpoint, agentResult, agentEvent, toolResult } from '../../packages/server/src/modules/studio/services/plugins/agent-contracts'

describe('plugin JSON boundaries', () => {
  it('preserves valid JSON and repeated references while rejecting values serialization would alter', () => {
    const shared = { text: 'hello', count: 1 }
    expect(json({ first: shared, second: shared, empty: null })).toEqual({ first: shared, second: shared, empty: null })
    const cyclic: any = {}; cyclic.self = cyclic
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('getter must not execute') } })
    for (const value of [undefined, NaN, Infinity, { field: undefined }, { field: () => {} }, [NaN], [undefined], BigInt(1), cyclic, new Date(), new Uint8Array([1]), new Array(2), getter]) {
      expect(() => json(value)).toThrow()
    }
    expect(() => json('a'.repeat(2_000_000))).toThrow(/size limit/)
  })
  it('rejects impossible schema limits and wrongly typed defaults at registration', () => {
    for (const field of [{ type: 'string', maxLength: -1 }, { type: 'number', minimum: 10, maximum: 1 }, { type: 'string', default: false }, { type: 'string', enum: [] }, { type: 'string', maxItems: 2 }]) {
      expect(() => validateSchema({ type: 'object', properties: { field: field as any } })).toThrow()
    }
    expect(() => validateSchema({ type: 'object', properties: { field: { type: 'string', description: 'Name', minLength: 1, maxLength: 20, default: 'Hello' } } })).not.toThrow()
  })
})

describe('plugin management contracts', () => {
  it('rejects malformed optional fields, model metadata and catalog enums', () => {
    expect(agentStatus({ installed: false, version: '', error: 'Install the engine' })).toMatchObject({ installed: false })
    expect(() => agentStatus({ installed: true, version: '1', source: 123 })).toThrow(/source/)
    const model = { id: 'native', name: 'Native', contextWindow: 128_000, reasoningEfforts: ['low', 'high'] }
    const catalog = { status: 'ready', source: 'native-config', scope: 'configured', models: [model] }
    expect(agentModels(catalog)).toEqual(catalog)
    for (const invalid of [{ ...catalog, status: 'unknown' }, { ...catalog, source: 123 }, { ...catalog, scope: 'unknown' }, { ...catalog, models: [{ ...model, hidden: 'yes' }] }, { ...catalog, models: [{ ...model, contextWindow: -1 }] }]) expect(() => agentModels(invalid)).toThrow()
    expect(() => agentSettings({ viewId: 'settings', query: { tab: 1 } })).toThrow()
    expect(() => agentUpdate({ currentVersion: '1', latestVersion: '2', updateAvailable: 'yes' })).toThrow()
    expect(() => agentUpgrade({ installedVersion: '', message: 'done' })).toThrow()
  })
})

describe('plugin run return contracts', () => {
  it('validates final attachments, nullable usage, checkpoint data and unknown fields', () => {
    const result = { content: [{ type: 'text', text: 'complete' }], finishReason: 'stop', usage: { inputTokens: null, outputTokens: 2, isEstimated: true }, checkpoint: { schemaVersion: 1, data: null } }
    expect(agentResult(result)).toEqual(result)
    for (const invalid of [
      { ...result, content: [{ type: 'image' }] },
      { ...result, usage: { outputTokens: 2, isEstimated: true } },
      { ...result, usage: { inputTokens: -1, outputTokens: 2, isEstimated: false } },
      { ...result, usage: { inputTokens: 1.5, outputTokens: 2, isEstimated: false } },
      { ...result, finishReason: 'success' },
      { ...result, checkpoint: { schemaVersion: 1 } },
      { ...result, privateField: 'not part of the protocol' },
    ]) expect(() => agentResult(invalid)).toThrow()
    expect(() => agentCheckpoint({ schemaVersion: 0, data: {} })).toThrow()
    expect(() => agentCheckpoint({ schemaVersion: 1, data: null, unknown: true })).toThrow()
    expect(agentResult({ content: [{ type: 'file', assetId: 'asset-1', name: 'file.txt', mediaType: 'text/plain' }], finishReason: 'stop' }).content).toHaveLength(1)
  })
  it('validates every stream event variant and the tool envelope before delivery', () => {
    expect(agentEvent({ type: 'tool.completed', callId: 'call-1', result: null })).toEqual({ type: 'tool.completed', callId: 'call-1', result: null })
    for (const event of [{ type: 'status', phase: 'finished' }, { type: 'reasoning.summary.delta', text: 1 }, { type: 'tool.completed', callId: 'call-1' }, { type: 'tool.started', callId: '', name: 'read', input: {} }, { type: 'tool.started', callId: 'call-1', name: 'read', input: [] }, { type: 'tool.failed', callId: 'call-1', error: 1 }, { type: 'invented' }]) expect(() => agentEvent(event)).toThrow()
    expect(toolResult({ ok: true, content: 'saved', data: { id: '1' } })).toMatchObject({ ok: true })
    for (const value of [{ content: 'saved' }, { ok: 'true', content: 'saved' }, { ok: false, content: 'failed', error: {} }]) expect(() => toolResult(value)).toThrow()
  })
})
