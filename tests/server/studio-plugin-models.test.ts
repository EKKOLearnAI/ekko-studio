import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginModels } from '../../packages/server/src/modules/studio/services/models/plugin'
import { PluginModelCallStore } from '../../packages/server/src/modules/studio/repositories/plugin-model-call-store'
import { AgentRunStateStore } from '../../packages/server/src/modules/studio/repositories/agent-run-state-store'
import { StudioError, type ExecutionScope, type ModelStreamHandle, type ModelStreamInput } from '../../packages/studio-plugin-sdk/src'
import type { prepareModelResponse } from '../../packages/server/src/modules/studio/services/model-api/service'
import { ModelApiError } from '../../packages/server/src/modules/studio/services/model-api/errors'

const scope: ExecutionScope = { scopeId: 's', principal: { kind: 'user', id: '1' }, profileId: 'one', surface: 'api', traceId: 'trace', runId: 'run' }
const input: ModelStreamInput = { model: 'provider/model', input: 'hello', idempotencyKey: 'key' }
const measured = { isEstimated: false, inputTokens: 12, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 0, reasoningTokens: 1 }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.useRealTimers() })
const collect = async (stream: ModelStreamHandle) => { const result = []; for await (const event of stream.events) result.push(event); return result }
function setup(options: { stalled?: boolean; missingUsage?: boolean; overflow?: boolean; failAccounting?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'), store = new PluginModelCallStore(db), state = new AgentRunStateStore(db)
  const authorize = vi.fn(), accounted = vi.fn(), upstreamEnded = vi.fn()
  const prepare = vi.fn(async (request: Parameters<typeof prepareModelResponse>[0]) => ({ id: request.internal!.id, stream: true, create: async () => null,
    async *events() {
      try {
        yield { type: 'response.output_text.delta', delta: '中文 hello' }
        if (options.stalled) await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }) })
        if (request.signal.aborted) return
        if (options.overflow) for (let n = 0; n < 100; n++) yield { type: 'response.output_text.delta', delta: 'x'.repeat(100_000) }
        yield { type: 'response.reasoning_summary_text.delta', delta: 'reason' }
        const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '中文 hello' }] }
        yield { type: 'response.output_item.done', item }
        yield { type: 'response.completed', response: { output: [item] } }
      } finally {
        accounted(request.internal!.id)
        request.onUsage?.({ ...measured, isEstimated: !!options.missingUsage })
        upstreamEnded()
        if (options.failAccounting) throw new Error('private database failure')
      }
    },
  }))
  const list = vi.fn(async () => ({ object: 'list', data: [{ id: 'provider/model', object: 'model', created: 0, owned_by: 'provider', api_mode: null, responses_supported: true }] }))
  const models = new PluginModels({ store, state, authorize, list, prepare })
  cleanups.push(async () => { await models.close(); db.close() })
  const start = (value = input, caller = scope, signal = new AbortController().signal) => models.stream(caller, value, signal)
  return { db, store, state, authorize, accounted, upstreamEnded, prepare, models, start }
}

it('streams canonical items and commits authoritative usage before the terminal receipt', async () => {
  const f = setup(), stream = await f.start()
  const events = await collect(stream)
  expect(events.map(event => event.type)).toEqual(['text.delta', 'reasoning.delta', 'output.item', 'call.finished'])
  expect(events.at(-1)).toMatchObject({ call: { status: 'completed', usage: { inputTokens: 12, cacheReadTokens: 2 } } })
  expect(f.accounted).toHaveBeenCalledExactlyOnceWith(stream.id)
  expect(f.prepare.mock.calls[0][0]).toMatchObject({ profiles: ['one'], accountId: '1', internal: { id: stream.id, parentRunId: 'run' } })
  expect(f.state.usage('run')).toEqual([expect.objectContaining({ modelCallId: stream.id, source: 'host', final: true, inputTokens: 12 })])
  f.state.project('run', { type: 'usage.reported', producerSequence: 1, modelCallId: stream.id, model: input.model, mode: 'final', revision: 999, inputTokens: 999, outputTokens: 999 })
  f.state.project('other-run', { type: 'usage.reported', producerSequence: 1, modelCallId: stream.id, model: input.model, mode: 'final', revision: 999, inputTokens: 999, outputTokens: 999 })
  expect(f.state.usage('run')[0].inputTokens).toBe(12); expect(f.state.usage('other-run')).toEqual([])
})

it('replays accepted keys without invoking the provider, and rejects changed input or bindings', async () => {
  const f = setup(), first = await f.start()
  await collect(first)
  const replay = await f.start({ idempotencyKey: 'key', input: 'hello', model: 'provider/model' })
  expect(replay.id).toBe(first.id)
  expect(await collect(replay)).toEqual([{ sequence: 0, type: 'call.finished', call: f.models.get(scope, first.id) }])
  expect(f.prepare).toHaveBeenCalledOnce()
  await expect(f.start({ ...input, input: 'different' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.start(input, { ...scope, runId: 'another' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  for (const caller of [{ ...scope, profileId: 'two' }, { ...scope, principal: { kind: 'user' as const, id: '2' } }, { ...scope, runId: 'other' }]) {
    expect(() => f.models.get(caller, first.id)).toThrow('unavailable')
  }
})

it('does not dispatch a second provider request for an active idempotent retry', async () => {
  const f = setup({ stalled: true }), stream = await f.start()
  await expect(f.start()).rejects.toMatchObject({ code: 'REVISION_CONFLICT', retryable: true })
  await stream.cancel()
  expect(f.models.get(scope, stream.id).status).toBe('cancelled')
  expect(f.prepare).toHaveBeenCalledTimes(1)
})

it('cancels abandoned streams and waits for provider cleanup and usage', async () => {
  const f = setup({ stalled: true }), stream = await f.start()
  for await (const event of stream.events) { expect(event.type).toBe('text.delta'); break }
  expect(f.upstreamEnded).toHaveBeenCalledOnce()
  expect(f.models.get(scope, stream.id)).toMatchObject({ status: 'cancelled', usage: { inputTokens: 12 } })
})

it('revokes a stalled call without waiting for another plugin read', async () => {
  const f = setup({ stalled: true }), stream = await f.start()
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce())
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'revoked') })
  await vi.waitFor(() => expect(f.upstreamEnded).toHaveBeenCalledOnce())
  expect(f.store.get(stream.id)).toMatchObject({ status: 'failed', errorCode: 'FORBIDDEN' })
  await expect(collect(stream)).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('records unknown usage explicitly and recovers interrupted admission without dispatch', async () => {
  const f = setup({ missingUsage: true }), stream = await f.start()
  await collect(stream)
  expect(f.models.get(scope, stream.id).usage).toBeNull()
  expect(f.state.usage('run')[0]).toMatchObject({ inputTokens: null, outputTokens: null, final: true })
  const accepted = f.store.accept(scope, { ...input, idempotencyKey: 'crashed' }, record => f.state.claimHostModelCall(record))
  f.store.recover(record => f.state.recordHostModelUsage(record))
  const replay = await f.start({ ...input, idempotencyKey: 'crashed' })
  expect(await collect(replay)).toEqual([{ sequence: 0, type: 'call.finished', call: expect.objectContaining({ id: accepted.id, status: 'interrupted', usage: null }) }])
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.state.usage('run').find(item => item.modelCallId === accepted.id)).toMatchObject({ final: true, inputTokens: null })
})

it('does not publish success when authoritative accounting fails', async () => {
  const f = setup({ failAccounting: true }), stream = await f.start()
  expect((await collect(stream)).at(-1)).toMatchObject({ call: { status: 'failed', errorCode: 'RUNTIME_UNAVAILABLE' } })
})

it('reports unsupported or missing models with safe SDK errors and no fabricated usage', async () => {
  const f = setup()
  f.prepare.mockRejectedValue(new ModelApiError('private upstream configuration', 501))
  const stream = await f.start()
  const events = await collect(stream)
  expect(events.at(-1)).toMatchObject({ call: { status: 'failed', errorCode: 'CAPABILITY_UNSUPPORTED', usage: null } })
  expect(JSON.stringify(events)).not.toContain('private upstream configuration')
  expect(f.accounted).not.toHaveBeenCalled()
})

it('rolls back a terminal receipt when its parent Run projection cannot commit', async () => {
  const f = setup()
  const call = f.store.accept(scope, input, record => f.state.claimHostModelCall(record))
  expect(() => f.store.update(call.id, { status: 'completed' }, () => { throw new Error('projection failed') })).toThrow('projection failed')
  expect(f.store.get(call.id)).toEqual(call)
  expect(f.state.usage('run')[0].final).toBe(false)
})

it('bounds streamed output and aborts before accepting more provider data', async () => {
  const f = setup({ overflow: true }), stream = await f.start()
  expect((await collect(stream)).at(-1)).toMatchObject({ call: { status: 'failed', errorCode: 'RESOURCE_EXHAUSTED' } })
  expect(f.upstreamEnded).toHaveBeenCalledOnce()
})

it('can cancel a finished provider whose terminal receipt is blocked by an unread stream', async () => {
  const f = setup()
  f.prepare.mockImplementation(async request => ({ id: request.internal!.id, stream: true, create: async () => null,
    async *events() {
      for (let n = 0; n < 32; n++) yield { type: 'response.output_text.delta', delta: 'chunk' }
      yield { type: 'response.completed', response: { output: [] } }
      f.accounted()
    },
  }))
  const stream = await f.start()
  await vi.waitFor(() => expect(f.accounted).toHaveBeenCalledOnce())
  await stream.cancel()
  expect(f.models.get(scope, stream.id).status).toBe('completed')
})

it('enforces scope abort, deadline and strict input before provider dispatch', async () => {
  const f = setup({ stalled: true }), abort = new AbortController()
  abort.abort()
  await expect(f.start(input, scope, abort.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  await expect(f.start({ ...input, profileId: 'foreign' } as ModelStreamInput)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.prepare).not.toHaveBeenCalled()
  const timed = await f.start({ ...input, timeoutMs: 100 })
  await collect(timed)
  expect(f.models.get(scope, timed.id)).toMatchObject({ status: 'failed', errorCode: 'DEADLINE_EXCEEDED' })
})
