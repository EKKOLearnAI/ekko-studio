import { afterEach, describe, expect, it, vi } from 'vitest'
import { choice } from '@typesafe-ai/sdk'
import { createJevSidecar } from '../../packages/server/src/modules/studio/services/jev/sidecar'
import type {
  JevAuthorityExpectation, JevSidecarAdapter, JevSidecarOutcome, JevSnapshotHandle,
} from '../../packages/server/src/modules/studio/services/jev/sidecar-contract'
import type { JevCredentialSettings } from '../../packages/server/src/modules/studio/services/jev/settings'

const expectation: JevAuthorityExpectation = { sourceKey: 'source-1', sourceHash: 'hash-1' }
const identity = { actor: { type: 'user', id: '7' }, authority: { type: 'profile', id: 'work' },
  profile: 'work', object: { type: 'test', id: 'source-1' } }
const question = { route: choice('Select only one supplied id.', { selected: null, none: null }) }
const response = { model: 'jev-test', usage: {}, answers: {
  route: { type: 'choice', choice: 'selected', confidence: 0.9, probabilities: { selected: 0.9, none: 0.1 } },
} } as any

function settings(patch: Partial<JevCredentialSettings> = {}): JevCredentialSettings {
  return {
    ekkoSkillsEnabled: false, ekkoSkillsCandidateLimit: 20, ekkoSkillsMinConfidence: 0.8, ekkoSkillsTimeoutMs: 3000,
    ekkoMemoryEnabled: false, ekkoMemoryKindRoutingEnabled: true, ekkoMemoryRelevanceFilterEnabled: true,
    ekkoMemoryRerankEnabled: true, ekkoMemoryWriteReviewEnabled: true, ekkoMemoryCandidateLimit: 20,
    ekkoMemoryRecallMinConfidence: 0.5, ekkoMemoryFilterMinConfidence: 0.8, ekkoMemoryMinConfidence: 0.8,
    ekkoMemoryTimeoutMs: 3000, baseUrl: 'https://jev.example.test', model: 'jev-latest', timeoutMs: 1000,
    apiKey: 'key', ...patch,
  }
}

function adapter(overrides: Partial<JevSidecarAdapter<any, any>> = {}): JevSidecarAdapter<any, any> {
  return {
    integrationId: 'test-review', policyVersion: '1', admissionCeilingMs: 5000, maxJevCalls: 2, maxGenerationCalls: 0,
    parsePolicy: () => ({ enabled: true, budgetMs: 1000, policy: { threshold: 0.8 } }),
    eligibility: () => ({ eligible: true }), readAuthority: async () => ({ allowed: true }), apply: (_ref, _expected, request) => request,
    ...overrides,
  }
}

async function waitFor(check: () => boolean, timeout = 2000) {
  const end = Date.now() + timeout
  while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

afterEach(() => vi.unstubAllGlobals())

describe('JEV sidecar', () => {
  it.each(['disabled', 'removed-key', 'rotated-key', 'provider-changed', 'settings-error'])('blocks apply after %s and keeps the task terminal', async change => {
    let current = settings({ groupSummaryReviewEnabled: true })
    let settingsError = false
    const apply = vi.fn(() => true)
    const sidecar = createJevSidecar({ adapters: [adapter({
      parsePolicy: value => ({ enabled: value.groupSummaryReviewEnabled, budgetMs: 1000, policy: {} }), apply,
    })], readSettings: async () => { if (settingsError) throw Error('unavailable'); return current } })
    const outcomes: JevSidecarOutcome<any>[] = []
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source', attemptId: change,
      createdAt: Date.now(), input: {}, async run(ctx) {
        const snapshot = await ctx.snapshot(); if (snapshot.kind !== 'completed') return
        if (change === 'disabled') current = { ...current, groupSummaryReviewEnabled: false }
        if (change === 'removed-key') current = { ...current, apiKey: '' }
        if (change === 'rotated-key') current = { ...current, apiKey: 'new-key' }
        if (change === 'provider-changed') current = { ...current, baseUrl: 'https://other.example.test' }
        if (change === 'settings-error') settingsError = true
        outcomes.push(await ctx.apply(expectation, {}))
        settingsError = false; current = settings({ groupSummaryReviewEnabled: true })
        outcomes.push(await ctx.apply(expectation, {}))
      } })
    await waitFor(() => outcomes.length === 2)
    expect(outcomes[0]).toMatchObject({ kind: 'skipped', terminal: true })
    expect(outcomes[1]).toEqual(outcomes[0])
    expect(apply).not.toHaveBeenCalled()
    sidecar.close()
  })

  it('keeps the remaining JEV allowance across a separately bounded generation', async () => {
    let mono = 0
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
    const apply = vi.fn(() => true)
    const sidecar = createJevSidecar({ adapters: [adapter({ maxGenerationCalls: 1, apply })],
      readSettings: async () => settings(), clock: { now: () => mono } })
    let outcome: JevSidecarOutcome<any> | undefined
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source', attemptId: 'generation',
      createdAt: Date.now(), input: {}, async run(ctx) {
        const snapshot = await ctx.snapshot(); if (snapshot.kind !== 'completed') return
        mono = 200
        await ctx.evaluate(snapshot.value, { state: {}, questions: question }, expectation)
        await ctx.generate(snapshot.value, expectation, async context => {
          mono += 20_000; await context.beforeDispatch(); return 'revision'
        })
        mono += 100
        await ctx.evaluate(snapshot.value, { state: {}, questions: question }, expectation, 'reevaluate')
        outcome = await ctx.apply(expectation, {})
      } })
    await waitFor(() => outcome !== undefined)
    expect(outcome).toMatchObject({ kind: 'completed', value: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)
    sidecar.close()
  })

  it.each(['cancel', 'timeout'])('bounds a hung generation on %s while retaining its physical slot', async event => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const sidecar = createJevSidecar({ adapters: [adapter({ maxGenerationCalls: 1, apply })], readSettings: async () => settings() })
    let finishGeneration!: (value: string) => void
    let generationSignal: AbortSignal | undefined
    let outcome: JevSidecarOutcome<any> | undefined
    try {
      sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source', attemptId: event,
        createdAt: Date.now(), input: {}, async run(ctx) {
          const snapshot = await ctx.snapshot(); if (snapshot.kind !== 'completed') return
          outcome = await ctx.generate(snapshot.value, expectation, context => {
            generationSignal = context.signal
            return new Promise<string>(resolve => { finishGeneration = resolve })
          })
          await ctx.apply(expectation, {})
        } })
      await vi.waitFor(() => expect(generationSignal).toBeDefined())
      if (event === 'cancel') sidecar.cancel({ sourceKey: 'source' })
      else await vi.advanceTimersByTimeAsync(30_001)
      await vi.waitFor(() => expect(outcome).toBeDefined())
      expect(outcome).toMatchObject({ kind: event === 'cancel' ? 'cancelled' : 'skipped',
        reason: event === 'cancel' ? 'caller_cancelled' : 'deadline_exceeded' })
      expect(generationSignal?.aborted).toBe(true)
      expect(sidecar.status().physicalGenerations).toBe(1)
      expect(apply).not.toHaveBeenCalled()
      finishGeneration('late revision')
      await vi.waitFor(() => expect(sidecar.status().physicalGenerations).toBe(0))
      expect(apply).not.toHaveBeenCalled()
    } finally { finishGeneration?.('cleanup'); sidecar.close(); vi.useRealTimers() }
  })

  it('does not extend the parent deadline during generation', async () => {
    let mono = 0
    const apply = vi.fn()
    const sidecar = createJevSidecar({ adapters: [adapter({ maxGenerationCalls: 1, apply })],
      readSettings: async () => settings(), clock: { now: () => mono }, wallNow: () => 0 })
    let outcome: JevSidecarOutcome<any> | undefined
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source', attemptId: 'parent-generation',
      createdAt: 0, parentDeadlineAt: 500, input: {}, async run(ctx) {
        const snapshot = await ctx.snapshot(); if (snapshot.kind !== 'completed') return
        await ctx.generate(snapshot.value, expectation, async () => { mono = 501; return 'late' })
        outcome = await ctx.apply(expectation, {})
      } })
    await waitFor(() => outcome !== undefined)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'deadline_exceeded' })
    expect(apply).not.toHaveBeenCalled()
    sidecar.close()
  })

  it('snapshots policy without serializing credentials and applies through the typed adapter port', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
    let captured: JevSnapshotHandle | undefined
    let applied: JevSidecarOutcome<any> | undefined
    const sidecar = createJevSidecar({ adapters: [adapter()], readSettings: async () => settings() })
    expect(sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1',
      attemptId: 'attempt-1', createdAt: Date.now(), input: { bounded: true }, async run(ctx) {
        const snapshot = await ctx.snapshot(); expect(snapshot.kind).toBe('completed')
        if (snapshot.kind !== 'completed') return
        captured = snapshot.value
        expect(() => JSON.stringify(snapshot.value)).toThrow()
        const evaluated = await ctx.evaluate(snapshot.value, { state: { candidate: 'selected' }, questions: question }, expectation)
        expect(evaluated.kind).toBe('completed')
        applied = await ctx.apply(expectation, { accepted: true })
      },
    })).toEqual({ status: 'accepted' })
    await waitFor(() => applied !== undefined)
    expect(captured?.configHash).toMatch(/^[a-f0-9]{64}$/)
    expect(applied).toMatchObject({ kind: 'completed', value: { accepted: true } })
  })

  it('rechecks authority immediately before fetch and sends nothing after revocation', async () => {
    const fetch = vi.fn(async () => Response.json(response)); vi.stubGlobal('fetch', fetch)
    let checks = 0
    const denied = adapter({ readAuthority: async () => (++checks === 1 ? { allowed: true } : { allowed: false, reason: 'requester_access_revoked' }) })
    let outcome: JevSidecarOutcome<any> | undefined
    const sidecar = createJevSidecar({ adapters: [denied], readSettings: async () => settings() })
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'attempt-2',
      createdAt: Date.now(), input: {}, async run(ctx) { const snap = await ctx.snapshot(); if (snap.kind === 'completed') outcome = await ctx.evaluate(snap.value, { state: {}, questions: question }, expectation) } })
    await waitFor(() => outcome !== undefined)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'requester_access_revoked', terminal: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('detects credential rotation without persisting a credential hash', async () => {
    const fetch = vi.fn(async () => Response.json(response)); vi.stubGlobal('fetch', fetch)
    let reads = 0
    let outcome: JevSidecarOutcome<any> | undefined
    const sidecar = createJevSidecar({ adapters: [adapter()], readSettings: async () => settings({ apiKey: ++reads >= 3 ? 'rotated' : 'key' }) })
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'attempt-3',
      createdAt: Date.now(), input: {}, async run(ctx) { const snap = await ctx.snapshot(); if (snap.kind === 'completed') outcome = await ctx.evaluate(snap.value, { state: {}, questions: question }, expectation) } })
    await waitFor(() => outcome !== undefined)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'configuration_changed' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns logically at the cumulative deadline while a hung fetch retains its physical slot', async () => {
    let settle!: () => void
    const hung = new Promise<Response>(resolve => { settle = () => resolve(Response.json(response)) })
    vi.stubGlobal('fetch', vi.fn(async () => hung))
    const short = adapter({ admissionCeilingMs: 200, parsePolicy: () => ({ enabled: true, budgetMs: 100, policy: {} }) })
    let outcome: JevSidecarOutcome<any> | undefined
    const sidecar = createJevSidecar({ adapters: [short], readSettings: async () => settings({ timeoutMs: 1000 }) })
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'hung',
      createdAt: Date.now(), input: {}, async run(ctx) { const snap = await ctx.snapshot(); if (snap.kind === 'completed') outcome = await ctx.evaluate(snap.value, { state: {}, questions: question }, expectation) } })
    await waitFor(() => outcome !== undefined)
    expect(outcome).toMatchObject({ kind: 'skipped', reason: 'deadline_exceeded', terminal: true })
    expect(sidecar.status().physicalRequests).toBe(1)
    settle(); await waitFor(() => sidecar.status().physicalRequests === 0)
  })

  it('counts queue wait once when converting a parent wall deadline to monotonic time', async () => {
    let wall = 1_000
    let mono = 0
    const clock = { now: () => mono }
    let releaseFirst!: () => void
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve })
    const sidecar = createJevSidecar({ adapters: [adapter()], readSettings: async () => settings(), wallNow: () => wall, clock,
      queueLimits: { maxWorkers: 1, maxWorkersPerProfile: 1 } })
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'block', attemptId: 'block',
      createdAt: wall, input: {}, run: async () => blocked })
    let remainingOutcome: JevSidecarOutcome<any> | undefined
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'parent', attemptId: 'parent',
      createdAt: wall, parentDeadlineAt: 2_000, input: {}, async run(ctx) { remainingOutcome = await ctx.snapshot() } })
    await waitFor(() => sidecar.status().logicalActive === 1)
    wall += 400; mono += 400; releaseFirst()
    await waitFor(() => remainingOutcome !== undefined)
    expect(remainingOutcome?.kind).toBe('completed')
    mono = 1_001
    // The parent deadline was accepted as a 1000ms monotonic bound, not 600ms minus the wait a second time.
    sidecar.close()
  })

  it('never throws from synchronous scheduling when eligibility rejects malformed input', () => {
    const sidecar = createJevSidecar({ adapters: [adapter({ eligibility: () => { throw new Error('bad input') } })], readSettings: async () => settings() })
    expect(() => sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'bad',
      createdAt: Date.now(), input: {}, run: async () => {} })).not.toThrow()
    expect(sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-2', attemptId: 'bad-2',
      createdAt: Date.now(), input: {}, run: async () => {} })).toEqual({ status: 'skipped', reason: 'invalid_input' })
  })

  it('cancels a queued task before it can read settings or authority', async () => {
    let releaseFirst!: () => void
    const blocked = new Promise<void>(resolve => { releaseFirst = resolve })
    let settingsReads = 0
    let secondRan = false
    const sidecar = createJevSidecar({ adapters: [adapter()], readSettings: async () => { settingsReads += 1; return settings() },
      queueLimits: { maxWorkers: 1, maxWorkersPerProfile: 1 } })
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'block', attemptId: 'block',
      createdAt: Date.now(), input: {}, run: async () => blocked })
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'queued', attemptId: 'queued',
      createdAt: Date.now(), input: {}, async run(ctx) { secondRan = true; await ctx.snapshot() } })
    sidecar.cancel({ sourceKey: 'queued' })
    releaseFirst()
    await waitFor(() => sidecar.status().queued === 0 && sidecar.status().logicalActive === 0)
    expect(secondRan).toBe(true)
    expect(settingsReads).toBe(0)
  })

  it('rejects duplicate, expired and oversized tasks synchronously', () => {
    const sidecar = createJevSidecar({ adapters: [adapter()], readSettings: async () => settings() })
    const task = { integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'same',
      createdAt: Date.now(), input: {}, run: async () => new Promise<void>(() => {}) }
    expect(sidecar.trySchedule(task)).toEqual({ status: 'accepted' })
    expect(sidecar.trySchedule(task)).toEqual({ status: 'duplicate' })
    expect(sidecar.trySchedule({ ...task, attemptId: 'expired', parentDeadlineAt: Date.now() - 1 })).toEqual({ status: 'skipped', reason: 'deadline_exceeded' })
    expect(sidecar.trySchedule({ ...task, attemptId: 'large', input: { text: 'x'.repeat(270_000) } })).toEqual({ status: 'skipped', reason: 'input_too_large' })
    sidecar.close()
  })

  it('makes a successful apply terminal for every later operation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)))
    const sidecar = createJevSidecar({ adapters: [adapter()], readSettings: async () => settings() })
    const outcomes: JevSidecarOutcome<any>[] = []
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'terminal-apply',
      createdAt: Date.now(), input: {}, async run(ctx) { const snap = await ctx.snapshot(); if (snap.kind === 'completed') {
        outcomes.push(await ctx.apply(expectation, { done: true }))
        outcomes.push(await ctx.evaluate(snap.value, { state: {}, questions: question }, expectation))
      } } })
    await waitFor(() => outcomes.length === 2)
    expect(outcomes[0]).toMatchObject({ kind: 'completed', value: { done: true } })
    expect(outcomes[1]).toEqual(outcomes[0])
  })

  it('rejects async apply ports at runtime and prevents a second apply', async () => {
    const sidecar = createJevSidecar({ adapters: [adapter({ apply: (() => Promise.resolve('bad')) as any })], readSettings: async () => settings() })
    const outcomes: JevSidecarOutcome<any>[] = []
    sidecar.trySchedule({ integrationId: 'test-review', identity, expected: expectation, sourceKey: 'source-1', attemptId: 'attempt-4',
      createdAt: Date.now(), input: {}, async run(ctx) { const snap = await ctx.snapshot(); if (snap.kind === 'completed') {
        outcomes.push(await ctx.apply(expectation, {})); outcomes.push(await ctx.apply(expectation, {}))
      } } })
    await waitFor(() => outcomes.length === 2)
    expect(outcomes[0]).toMatchObject({ kind: 'skipped', reason: 'record_write_failed', terminal: true })
    expect(outcomes[1]).toEqual(outcomes[0])
  })
})
