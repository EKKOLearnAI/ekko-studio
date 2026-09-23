import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime, EkkoDatabaseManager, EkkoJevClient, MemoryService, SqliteMemoryStore,
  type EkkoJevOverrides, type MemoryWriteInput, type ModelClient,
} from '../../packages/ekko-agent/src'

const identity = { sessionId: 's1', profileId: 'default' }
const upstream = vi.fn<typeof fetch>()
let service: MemoryService
let store: SqliteMemoryStore
let routedKinds: string[]
let reviewDecision: string
let confidence: number
let routingProbability: number

function evaluator(overrides: EkkoJevOverrides = {}) {
  return new EkkoJevClient({ enabled: true, apiKey: 'test-key', memoryEnabled: true,
    memoryKindRoutingEnabled: true, memoryRerankEnabled: true, memoryWriteReviewEnabled: true,
    ...(overrides || {}) })
}

function reply(request: any) {
  const state = typeof request.state === 'string' ? JSON.parse(request.state) : request.state
  return { model: 'test', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(
    Object.entries(request.questions).map(([key, question]: [string, any]) => [key,
      question.type === 'noul' ? { type: 'noul', noul: routedKinds.includes(key) ? routingProbability : 0.01 }
        : question.type === 'score' ? { type: 'score', score: state.cards[Number(key.slice(5))].content.includes('second') ? 2 : 0,
          confidence, legend: { 0: 'Unrelated', 1: 'Helpful', 2: 'Essential' }, probabilities: { 0: 0.5, 1: 0, 2: 0.5 } }
          : { type: 'choice', choice: reviewDecision, confidence, probabilities: { accept: 0.01, unsupported: 0.97, transient: 0.01, wrong_kind: 0.01 } },
    ]),
  ) }
}

beforeEach(() => {
  store = new SqliteMemoryStore(new EkkoDatabaseManager({ databasePath: ':memory:' }))
  service = new MemoryService({ store })
  routedKinds = []
  reviewDecision = 'accept'
  confidence = 0.99
  routingProbability = 0.99
  upstream.mockReset().mockImplementation(async (_url, init) => Response.json(reply(JSON.parse(init!.body as string))))
  vi.stubGlobal('fetch', upstream)
})
afterEach(() => { service.close(); vi.unstubAllGlobals(); vi.useRealTimers() })

async function card(itemKey: string, content: string, profileId = 'default') {
  return (await service.write({ operation: 'create', kind: 'general_preference', itemKey, identity: { ...identity, profileId },
    reason: 'user stated', node: { title: content, content, valueJson: content } })).node!
}

async function draft(itemKey = 'new'): Promise<MemoryWriteInput> {
  const [id] = await service.captureMessages(identity, [{ role: 'user', content: '请记住我喜欢简短回复。', id: 'evidence' }])
  return { operation: 'create', kind: 'general_preference', itemKey, reason: 'user stated', identity,
    node: { title: 'Short answers', content: 'The user prefers short answers.', valueJson: 'short', sourceMessageIds: [id] } }
}

describe('optional memory JEV', () => {
  it('recalls the lodging preference from a paraphrase using actual card evidence and an independent recall threshold', async () => {
    const node = await card('lodging_preferences', '挑选旅馆时的长期偏好：最在意隔音，其次是床垫舒适度；对窗外景色没有要求。')
    const query = '这次出差怎么选住处？只根据已有上下文回答，不调用记忆工具，也不新增记忆。'
    const baseline = await service.retrieve(identity, query)
    expect(baseline.usedMemoryIds).toEqual([])
    routedKinds = ['general_preference']
    routingProbability = 0.52
    const diagnostics = vi.fn()
    const result = await evaluator().runScoped(undefined, () => service.retrieve(identity, query), diagnostics)
    expect(result.usedMemoryIds).toEqual([node.id])
    expect(result.relevantNodes).toEqual([node])
    expect(Object.keys(result).sort()).toEqual(Object.keys(baseline).sort())
    const request = JSON.parse(upstream.mock.calls[0][1]!.body as string)
    expect(JSON.parse(request.state)).toMatchObject({ request: query, cards: [{ kind: 'general_preference', content: node.content }] })
    expect(Object.keys(request.questions)).toEqual(['general_preference'])
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'routing', reason: 'matched',
      threshold: 0.5, selectedCount: 1, kindProbabilities: { general_preference: 0.52 } }))
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/挑选旅馆|test-key/)
    expect(await evaluator({ memoryRecallMinConfidence: 0.8 }).runScoped(undefined, () => service.retrieve(identity, query))).toEqual(baseline)
    routedKinds = []
    expect((await evaluator().runScoped(undefined, () => service.retrieve(identity, 'JavaScript closures'))).usedMemoryIds).toEqual([])
  })

  it('keeps write review conservative independently of recall and records uncertain reviews', async () => {
    const input = await draft()
    reviewDecision = 'unsupported'
    confidence = 0.6
    const diagnostics = vi.fn()
    expect(await evaluator({ memoryRecallMinConfidence: 0.5 }).runScoped(undefined, () => service.write(input), diagnostics))
      .toMatchObject({ accepted: true })
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'write_review', status: 'fallback', reason: 'review_below_threshold' }))
    expect(await evaluator({ memoryRecallMinConfidence: 0.9, memoryMinConfidence: 0.55 })
      .runScoped(undefined, () => service.write({ ...input, itemKey: 'other' }))).toMatchObject({ accepted: false })
  })

  it('skips empty or ineligible candidate sets without contacting JEV', async () => {
    const diagnostics = vi.fn()
    await evaluator().runScoped(undefined, () => service.retrieve(identity, 'where should I stay'), diagnostics)
    const deleted = await card('deleted', 'deleted private evidence')
    await service.delete(deleted.id, { identity, expectedRevision: deleted.revision, reason: 'forget' })
    await service.write({ operation: 'create', kind: 'general_preference', itemKey: 'expired', identity, reason: 'test',
      node: { title: 'Expired', content: 'expired evidence', valueJson: 'expired', expiresAt: '2000-01-01T00:00:00Z' } })
    await evaluator().runScoped(undefined, () => service.retrieve(identity, 'where should I stay'), diagnostics)
    expect(upstream).not.toHaveBeenCalled()
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'routing', status: 'skipped', reason: 'no_candidates' }))
  })

  it.each(['deleted', 'edited'])('does not add a candidate %s while JEV is evaluating it', async change => {
    const node = await card('lodging', 'Prefer quiet hotels')
    routedKinds = ['general_preference']
    upstream.mockImplementation(async (_url, init) => {
      if (change === 'deleted') await service.delete(node.id, { identity, expectedRevision: node.revision, reason: 'forget' })
      else await store.applyMutations([{ type: 'upsert', node: { ...node, revision: node.revision + 1, content: 'Changed preference' } }])
      return Response.json(reply(JSON.parse(init!.body as string)))
    })
    const result = await evaluator().runScoped(undefined, () => service.retrieve(identity, '这次出差怎么选住处？'))
    expect(result.usedMemoryIds).toEqual([])
  })

  it('reports provider failures without logging provider bodies and ignores diagnostic failures', async () => {
    await card('preference', 'Prefer quiet lodging')
    const baseline = await service.retrieve(identity, 'where should I stay')
    const diagnostics = vi.fn()
    upstream.mockImplementation(async () => Response.json({ private: 'secret provider payload' }, { status: 503 }))
    expect(await evaluator().runScoped(undefined, () => service.retrieve(identity, 'where should I stay'), diagnostics)).toEqual(baseline)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'recall', status: 'fallback', reason: 'jev_provider_error' }))
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/secret provider|Prefer quiet|test-key/)
    expect(await evaluator().runScoped(undefined, () => service.retrieve(identity, 'where should I stay'), () => { throw new Error('log failed') })).toEqual(baseline)
  })

  it.each([
    { enabled: false }, { apiKey: '' }, { memoryEnabled: false },
    { memoryKindRoutingEnabled: false, memoryRerankEnabled: false, memoryWriteReviewEnabled: false },
  ])('preserves original recall and write behavior with no provider requests: %j', async overrides => {
    await card('first', 'trip first')
    await card('second', 'trip second')
    const baseline = await service.retrieve(identity, 'trip')
    const input = await draft()
    const client = evaluator(overrides)
    expect(await client.runScoped(undefined, () => service.retrieve(identity, 'trip'))).toEqual({ ...baseline,
      recentMessages: await store.listRecentMessages({ sessionId: identity.sessionId, limit: 20 }) })
    expect(await client.runScoped(undefined, () => service.write(input))).toMatchObject({ accepted: true, action: 'created' })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('adds semantically selected kinds without widening authorized profile or scopes', async () => {
    await card('local', 'Short answers')
    await card('foreign', 'Foreign secret', 'other')
    await service.write({ operation: 'create', kind: 'general_preference', itemKey: 'private',
      identity: { ...identity, writeScopes: [{ type: 'context', namespace: 'private', id: 'x' }] },
      scope: { type: 'context', namespace: 'private', id: 'x' }, reason: 'test',
      node: { title: 'Private', content: 'Private secret', valueJson: 'private' } })
    expect((await service.retrieve(identity, '交流方式')).usedMemoryIds).toEqual([])
    routedKinds = ['general_preference', 'workflow_preference']
    const result = await evaluator().runScoped(undefined, () => service.retrieve(identity, '交流方式'))
    expect(result.relevantNodes.map(node => node.content)).toEqual(['Short answers'])
    expect(Object.keys(result).sort()).toEqual(Object.keys(await service.retrieve(identity)).sort())
    expect(JSON.stringify(upstream.mock.calls)).not.toMatch(/Foreign secret|Private secret/)
  })

  it('reranks before token selection without modifying stored cards or exact constraints', async () => {
    await card('first', 'trip first')
    const second = await card('second', 'trip second')
    const constraint = await service.write({ operation: 'create', kind: 'hard_constraint', itemKey: 'must', reason: 'test', identity,
      node: { title: 'Always', content: 'Always retain this constraint.', valueJson: 'must' } })
    const before = await service.list()
    const result = await evaluator({ memoryKindRoutingEnabled: false }).runScoped(undefined, () => service.retrieve(identity, 'trip'))
    expect(result.usedMemoryIds.slice(0, 2)).toEqual([constraint.nodeId, second.id])
    expect(result.diagnostics.usedTokens).toBeLessThanOrEqual(result.diagnostics.tokenBudget!)
    expect(result.usedMemoryIds).toEqual(result.relevantNodes.map(node => node.id))
    expect(await service.list()).toEqual(before)
    expect(result.relevantNodes.find(node => node.id === second.id)).toEqual(second)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('uses recall confidence for ranking and restores baseline when that threshold is not met', async () => {
    const second = await card('second', 'trip second')
    await card('first', 'trip first')
    confidence = 0.6
    const baseline = await service.retrieve(identity, 'trip')
    const result = await evaluator({ memoryKindRoutingEnabled: false }).runScoped(undefined, () => service.retrieve(identity, 'trip'))
    expect(result.usedMemoryIds[0]).toBe(second.id)
    const diagnostics = vi.fn()
    expect(await evaluator({ memoryKindRoutingEnabled: false, memoryRecallMinConfidence: 0.8 })
      .runScoped(undefined, () => service.retrieve(identity, 'trip'), diagnostics)).toEqual(baseline)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'recall', status: 'fallback', reason: 'ranking_below_threshold' }))
  })

  it('never sends exact search, get or list-all operations to JEV', async () => {
    const node = await card('first', 'trip first')
    await evaluator().runScoped(undefined, async () => {
      await service.search(identity, { kinds: ['general_preference'] })
      await service.search(identity, {})
      await service.get(node.id, identity)
      await service.retrieve(identity, 'trip', { key: node.key })
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('caps rerank payloads and retains the caller recall limit after semantic expansion', async () => {
    for (let index = 0; index < 5; index++) await card(`card${index}`, `trip ${index}`)
    routedKinds = ['general_preference']
    const client = evaluator({ memoryCandidateLimit: 2 })
    const result = await client.runScoped(undefined, () => service.retrieve(identity, 'trip', { limit: 1 }))
    expect(result.usedMemoryIds).toHaveLength(1)
    const ranking = upstream.mock.calls.map(([, init]) => JSON.parse(init!.body as string)).find(request => request.questions.card_0)
    expect(Object.keys(ranking.questions)).toHaveLength(2)
    expect(JSON.parse(ranking.state).cards).toHaveLength(2)
    const routing = upstream.mock.calls.map(([, init]) => JSON.parse(init!.body as string)).find(request => request.questions.general_preference)
    expect(JSON.parse(routing.state).cards).toHaveLength(2)
  })

  it.each(['wrong_kind', 'transient'])('returns corrective feedback for a reliable %s review', async decision => {
    const input = await draft()
    reviewDecision = decision
    expect(await evaluator().runScoped(undefined, () => service.write(input)))
      .toMatchObject({ accepted: false, reason: expect.stringContaining(decision) })
    expect(await service.list()).toEqual([])
  })

  it('does not submit a partial batch when a reviewed update becomes stale', async () => {
    const old = await card('existing', 'old')
    const input = await draft()
    upstream.mockImplementation(async (_url, init) => {
      await service.delete(old.id, { identity, expectedRevision: old.revision, reason: 'concurrent forget' })
      return Response.json(reply(JSON.parse(init!.body as string)))
    })
    const result = await evaluator().runScoped(undefined, () => service.applyBatch({ identity, operations: [input, {
      operation: 'update', targetId: old.id, expectedRevision: old.revision, reason: 'update',
      node: { title: 'Short', content: 'The user prefers short answers.', valueJson: 'short', sourceMessageIds: input.node.sourceMessageIds },
    }] }))
    expect(result).toMatchObject({ accepted: false, done: true, results: [] })
    expect(await service.list()).toEqual([])
  })

  it('uses one cumulative deadline across routing and reranking', async () => {
    await card('first', 'trip first')
    await card('second', 'trip second')
    const baseline = await service.retrieve(identity, 'trip')
    vi.useFakeTimers()
    upstream.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init!.body as string)
      if (request.questions.card_0) return new Promise<Response>(() => {})
      await new Promise(resolve => setTimeout(resolve, 70))
      return Response.json(reply(request))
    })
    const pending = evaluator({ memoryTimeoutMs: 100 }).runScoped(undefined, () => service.retrieve(identity, 'trip'))
    await vi.advanceTimersByTimeAsync(71)
    expect(upstream).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30)
    expect(await pending).toEqual(baseline)
  })

  it.each(['network', 'invalid', 'confidence'])('restores the complete baseline after a %s failure in the second stage', async failure => {
    await card('first', 'trip first')
    await card('second', 'trip second')
    await card('extra', 'No overlapping words')
    const baseline = await service.retrieve(identity, 'trip')
    routedKinds = ['general_preference']
    upstream.mockImplementation(async (_url, init) => {
      const request = JSON.parse(init!.body as string)
      if (request.questions.card_0) {
        if (failure === 'network') throw new Error('private provider diagnostic')
        if (failure === 'invalid') return Response.json({ answers: {} })
        confidence = 0.2
      }
      return Response.json(reply(request))
    })
    expect(await evaluator().runScoped(undefined, () => service.retrieve(identity, 'trip'))).toEqual(baseline)
  })

  it('bounds the combined recall deadline even when the provider ignores abort', async () => {
    await card('first', 'trip first')
    await card('second', 'trip second')
    const baseline = await service.retrieve(identity, 'trip')
    vi.useFakeTimers()
    upstream.mockImplementation(async () => new Promise<Response>(() => {}))
    const diagnostics = vi.fn()
    const pending = evaluator({ memoryTimeoutMs: 100 }).runScoped(undefined, () => service.retrieve(identity, 'trip'), diagnostics)
    await vi.advanceTimersByTimeAsync(101)
    expect(await pending).toEqual(baseline)
    expect(upstream).toHaveBeenCalledTimes(1)
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ stage: 'recall', status: 'fallback', reason: 'timeout', durationMs: 100 }))
  })

  it('propagates caller cancellation instead of turning it into empty recall or a write', async () => {
    const input = await draft()
    const existing = await card('existing', 'Earlier preference')
    upstream.mockImplementation(async () => new Promise<Response>(() => {}))
    for (const operation of [() => service.retrieve(identity, 'question'), () => service.write(input)]) {
      const controller = new AbortController()
      const pending = evaluator().runScoped(controller.signal, operation)
      const rejected = expect(pending).rejects.toThrow('caller stopped')
      await vi.waitFor(() => expect(upstream).toHaveBeenCalled())
      controller.abort(new Error('caller stopped'))
      await rejected
      upstream.mockClear()
    }
    expect((await service.list()).map(node => node.id)).toEqual([existing.id])
  })

  it('reviews a whole batch before committing and returns the original failure shape', async () => {
    const first = await draft('one')
    const second = await draft('two')
    reviewDecision = 'unsupported'
    const result = await evaluator().runScoped(undefined, () => service.applyBatch({ operations: [first, second], identity }))
    expect(result).toMatchObject({ accepted: false, done: true, results: [], failedOperationIndex: 0, reason: expect.stringContaining('unsupported') })
    expect(await service.list()).toEqual([])
    expect(await service.listAuditEvents()).toEqual([])
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it.each(['accept', 'unavailable', 'malformed', 'uncertain', 'timeout'])('retains normal atomic writes when review is %s', async mode => {
    const input = await draft()
    if (mode === 'unavailable') upstream.mockRejectedValue(new Error('provider failed'))
    if (mode === 'malformed') upstream.mockResolvedValue(Response.json({ answers: {} }))
    if (mode === 'uncertain') { reviewDecision = 'unsupported'; confidence = 0.2 }
    if (mode === 'timeout') upstream.mockImplementation(async () => new Promise<Response>(() => {}))
    const result = await evaluator({ memoryTimeoutMs: 100 }).runScoped(undefined, () => service.applyBatch({ operations: [input], identity }))
    expect(result).toMatchObject({ accepted: true, done: true, results: [{ action: 'created' }] })
    expect(await service.list()).toHaveLength(1)
    expect(await service.listAuditEvents()).toHaveLength(1)
  })

  it('preserves deterministic rejection and deletion without calling JEV', async () => {
    const node = await card('first', 'trip first')
    await evaluator().runScoped(undefined, async () => {
      expect(await service.applyBatch({ operations: [{ operation: 'update', targetId: node.id, expectedRevision: 999, reason: 'test', node: {} }], identity }))
        .toMatchObject({ accepted: false })
      expect(await service.delete(node.id, { expectedRevision: node.revision, reason: 'explicit forget', identity }))
        .toMatchObject({ deletedIds: [node.id] })
    })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('falls back without truncating oversized UTF-8 user evidence', async () => {
    const input = await draft()
    const [sourceId] = await service.captureMessages(identity, [{ role: 'user', id: 'large-evidence', content: '中'.repeat(24_000) }])
    input.node.sourceMessageIds = [sourceId]
    expect(await evaluator().runScoped(undefined, () => service.write(input))).toMatchObject({ accepted: true })
    expect(upstream).not.toHaveBeenCalled()
  })

  it('ignores the entire review when a later answer is invalid, even after a negative answer', async () => {
    const first = await draft('one')
    const second = await draft('two')
    reviewDecision = 'unsupported'
    upstream.mockImplementation(async (_url, init) => {
      const result = reply(JSON.parse(init!.body as string))
      delete result.answers.write_1
      return Response.json(result)
    })
    expect(await evaluator().runScoped(undefined, () => service.applyBatch({ operations: [first, second], identity })))
      .toMatchObject({ accepted: true, done: true })
    expect(await service.list()).toHaveLength(2)
    expect(await service.listAuditEvents()).toHaveLength(2)
  })

  it('keeps overlapping run snapshots isolated from subsequent configuration changes', async () => {
    const input = await draft()
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve })
    const client = evaluator({ apiKey: 'first-key' })
    const first = client.runScoped(undefined, async () => { await gate; return service.write(input) })
    client.configure({ enabled: true, apiKey: 'second-key', memoryEnabled: false })
    const other = { ...input, itemKey: 'other', identity: { ...identity, profileId: 'other' } }
    expect(await client.runScoped(undefined, () => service.write(other))).toMatchObject({ accepted: true })
    expect(upstream).not.toHaveBeenCalled()
    resume()
    await first
    expect(new Headers(upstream.mock.calls[0][1]!.headers).get('authorization')).toBe('Bearer first-key')
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('activates the policy inside a standalone runtime and its foreground memory tools', async () => {
    await card('existing', 'Earlier preference')
    routedKinds = ['general_preference']
    let calls = 0
    const model: ModelClient = { provider: 'test', requestStyle: 'custom-runtime',
      capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true }, stream: vi.fn(),
      create: vi.fn(async () => ++calls === 1
        ? { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'write', name: 'memory_write', arguments: {
          operation: 'create', kind: 'general_preference', itemKey: 'short', reason: 'explicit user statement',
          node: { title: 'Short', content: 'The user prefers short answers.', valueJson: 'short' },
        } }] }
        : { content: 'done', finishReason: 'stop' }),
    }
    const writeLog = vi.fn(() => true)
    const runtime = new AgentRuntime({ modelClient: model, memory: service, logWriter: { write: writeLog },
      jev: { enabled: true, apiKey: 'standalone', memoryEnabled: true, memoryKindRoutingEnabled: true, memoryWriteReviewEnabled: true } })
    const result = await runtime.run({ messages: ['Remember I prefer short answers.'], contextKey: identity.sessionId, toolContext: identity })
    expect(result.output.content).toBe('done')
    expect(JSON.stringify(vi.mocked(model.create).mock.calls[0][0].messages)).toContain('Earlier preference')
    expect(await service.list()).toHaveLength(2)
    expect(writeLog).toHaveBeenCalledWith(expect.objectContaining({ category: 'memory', event: 'memory.jev',
      sessionId: identity.sessionId, runId: expect.any(String), data: expect.objectContaining({ stage: 'routing', reason: 'matched' }) }))
    expect(upstream.mock.calls.some(([, init]) => JSON.parse(init!.body as string).questions.write_0)).toBe(true)
    expect(upstream.mock.calls.some(([, init]) => JSON.parse(init!.body as string).questions.general_preference)).toBe(true)
    await service.drain()
  })
})
