import { randomUUID } from 'node:crypto'
import type { Questions, SystemOneResult } from '@typesafe-ai/sdk'
import { evaluateJevWithCredentials } from './client'
import { JevError, readJevCredentials, type JevCredentialSettings } from './settings'
import { JevSidecarBudget, JevSidecarDeadlineError, systemMonotonicClock, type MonotonicClock } from './sidecar-budget'
import {
  type JevAuthorityExpectation, type JevScheduleReceipt, type JevSidecarAdapter,
  type JevSidecarDiagnostic, type JevSidecarOutcome, type JevSidecarReason,
  type JevSidecarStatus, type JevSidecarTaskContext, type JevSidecarTaskSpec,
  type JevSnapshotHandle, type TrustedJevRequest,
} from './sidecar-contract'
import { boundedQueueInput, JevSidecarInputError, prepareTrustedJevRequest, validJevAnswers } from './sidecar-payload'
import { JevPhysicalSlots, JevSidecarQueue } from './sidecar-queue'
import { createSidecarSnapshot, destroySidecarSnapshot, sidecarSnapshotSecret, snapshotMatchesCurrent } from './snapshot'

export interface CreateJevSidecarOptions {
  adapters: JevSidecarAdapter<any, any>[]
  readSettings?: (profile: string) => Promise<JevCredentialSettings>
  clock?: MonotonicClock
  wallNow?: () => number
  observe?: (diagnostic: JevSidecarDiagnostic) => void
  instanceId?: string
  queueLimits?: { maxQueued?: number; maxQueuedPerProfile?: number; maxWorkers?: number; maxWorkersPerProfile?: number }
  requestSlots?: { global?: number; perProfile?: number }
  readSlots?: { global?: number; perProfile?: number }
}

const fatalReasons = new Set<JevSidecarReason>([
  'disabled', 'not_configured', 'settings_unavailable', 'configuration_changed', 'queue_full', 'queue_unavailable',
  'object_deleted', 'profile_access_revoked', 'requester_access_revoked', 'requester_unverifiable',
  'authorization_unavailable', 'source_changed', 'superseded', 'input_too_large', 'invalid_input',
  'deadline_exceeded', 'caller_cancelled', 'provider_timeout', 'provider_rate_limited',
  'provider_auth_failed', 'provider_error', 'invalid_result', 'cas_conflict', 'record_write_failed',
])

// Revision generation has its own process-wide physical limit, separate from JEV.
const generationSlots = new JevPhysicalSlots(1, 1)
const GENERATION_BUDGET_MS = 30_000

function providerReason(error: unknown): JevSidecarReason {
  if (error && typeof error === 'object' && 'sidecarReason' in error) return error.sidecarReason as JevSidecarReason
  if (error instanceof JevSidecarDeadlineError) return error.reason
  if (error instanceof JevSidecarInputError) return error.reason
  if (error instanceof JevError) {
    if (error.code === 'jev_timeout') return 'provider_timeout'
    if (error.code === 'jev_rate_limited') return 'provider_rate_limited'
    if (error.code === 'jev_auth_failed') return 'provider_auth_failed'
    if (error.code === 'jev_cancelled') return 'caller_cancelled'
    if (error.code === 'jev_invalid_request') return 'invalid_input'
  }
  return 'provider_error'
}

export function createJevSidecar(options: CreateJevSidecarOptions) {
  const adapters = new Map(options.adapters.map(adapter => [adapter.integrationId, adapter]))
  if (adapters.size !== options.adapters.length) throw new TypeError('Duplicate JEV sidecar integration id.')
  const clock = options.clock ?? systemMonotonicClock
  const wallNow = options.wallNow ?? Date.now
  const readSettings = options.readSettings ?? readJevCredentials
  const queue = new JevSidecarQueue({ maxQueued: options.queueLimits?.maxQueued ?? 64,
    maxQueuedPerProfile: options.queueLimits?.maxQueuedPerProfile ?? 16,
    maxWorkers: options.queueLimits?.maxWorkers ?? 4, maxWorkersPerProfile: options.queueLimits?.maxWorkersPerProfile ?? 1 })
  const requestSlots = new JevPhysicalSlots(options.requestSlots?.global ?? 4, options.requestSlots?.perProfile ?? 1)
  const readSlots = new JevPhysicalSlots(options.readSlots?.global ?? 4, options.readSlots?.perProfile ?? 1)
  const controllers = new Map<string, AbortController>()
  let logicalActive = 0

  const observe = (diagnostic: JevSidecarDiagnostic) => { try { options.observe?.(diagnostic) } catch { /* observers cannot affect work */ } }

  function trySchedule(spec: JevSidecarTaskSpec<any, any>): JevScheduleReceipt {
    const adapter = adapters.get(spec.integrationId)
    if (!adapter) return { status: 'skipped', reason: 'not_eligible' }
    if (!spec.identity.profile.trim() || spec.integrationId !== adapter.integrationId || !spec.attemptId || !spec.sourceKey) {
      return { status: 'skipped', reason: 'invalid_input' }
    }
    let parentRemainingMs: number | undefined
    if (spec.parentDeadlineAt !== undefined) {
      if (!Number.isFinite(spec.parentDeadlineAt)) return { status: 'skipped', reason: 'invalid_input' }
      parentRemainingMs = spec.parentDeadlineAt - wallNow()
      if (parentRemainingMs <= 0) return { status: 'skipped', reason: 'deadline_exceeded' }
    }
    try { boundedQueueInput(spec.input) } catch (error) {
      return { status: 'skipped', reason: error instanceof JevSidecarInputError ? error.reason : 'invalid_input' }
    }
    let eligible: ReturnType<JevSidecarAdapter<any, any>['eligibility']>
    try { eligible = adapter.eligibility(spec.input) } catch { return { status: 'skipped', reason: 'invalid_input' } }
    if (!eligible.eligible) return { status: 'skipped', reason: eligible.reason }
    const key = `${spec.integrationId}\0${spec.identity.profile}\0${spec.sourceKey}\0${spec.attemptId}`
    const controllerKey = `${spec.integrationId}\0${spec.sourceKey}\0${spec.attemptId}`
    const controller = new AbortController()
    const acceptedMono = clock.now()
    const receipt = queue.enqueue({ key, profile: spec.identity.profile,
      run: () => runTask(spec, adapter, acceptedMono, controllerKey, controller, parentRemainingMs) })
    if (receipt === 'accepted') { controllers.set(controllerKey, controller); return { status: 'accepted' } }
    return receipt === 'duplicate' ? { status: 'duplicate' } : { status: 'skipped', reason: receipt }
  }

  async function runTask(
    spec: JevSidecarTaskSpec<any, any>,
    adapter: JevSidecarAdapter<any, any>,
    acceptedMono: number,
    controllerKey: string,
    controller: AbortController,
    parentRemainingMs?: number,
  ): Promise<void> {
    logicalActive += 1
    const signal = spec.signal ? AbortSignal.any([spec.signal, controller.signal]) : controller.signal
    let ceiling = adapter.admissionCeilingMs
    if (parentRemainingMs !== undefined) ceiling = Math.min(ceiling, parentRemainingMs)
    const parentDeadline = parentRemainingMs === undefined ? Infinity : acceptedMono + parentRemainingMs
    const budget = new JevSidecarBudget(ceiling, signal, clock, acceptedMono, parentDeadline)
    let handle: JevSnapshotHandle | undefined
    let terminal: JevSidecarOutcome<any> | undefined
    let jevCalls = 0
    let generationCalls = 0
    let applied = false
    const started = clock.now()
    const diagnostic = (stage: JevSidecarDiagnostic['stage'], reason?: JevSidecarReason, inputBytes?: number): JevSidecarDiagnostic => ({
      integrationId: spec.integrationId, attemptId: spec.attemptId, sourceKey: spec.sourceKey,
      stage, durationMs: Math.max(0, clock.now() - started), ...(reason ? { reason } : {}),
      ...(inputBytes === undefined ? {} : { inputBytes }), ...(handle ? { configHash: handle.configHash } : {}),
    })
    const finish = <T>(outcome: JevSidecarOutcome<T>): JevSidecarOutcome<T> => {
      if ('terminal' in outcome && outcome.terminal) terminal = outcome
      observe(outcome.diagnostic)
      return outcome
    }
    const skip = <T>(stage: JevSidecarDiagnostic['stage'], reason: JevSidecarReason, inputBytes?: number): JevSidecarOutcome<T> =>
      finish({ kind: 'skipped', reason, terminal: fatalReasons.has(reason), diagnostic: diagnostic(stage, reason, inputBytes) })
    const cancelled = <T>(stage: JevSidecarDiagnostic['stage']): JevSidecarOutcome<T> =>
      finish({ kind: 'cancelled', reason: 'caller_cancelled', terminal: true, diagnostic: diagnostic(stage, 'caller_cancelled') })
    const guard = <T>(): JevSidecarOutcome<T> | undefined => terminal as JevSidecarOutcome<T> | undefined

    const boundedRead = async <T>(operation: (readSignal: AbortSignal) => Promise<T>, activeBudget = budget): Promise<T> => {
      activeBudget.check()
      const release = readSlots.tryAcquire(spec.identity.profile)
      if (!release) throw Object.assign(new Error('queue_full'), { sidecarReason: 'queue_full' as JevSidecarReason })
      let handedToPhysical = false
      try {
        const raced = await activeBudget.race(operation)
        handedToPhysical = true
        void raced.physical.finally(release)
        return await raced.logical
      } catch (error) {
        if (!handedToPhysical) release()
        throw error
      }
    }
    const readAuthority = (expected: JevAuthorityExpectation, stage: JevSidecarDiagnostic['stage']) =>
      boundedRead(readSignal => adapter.readAuthority(spec.identity, expected, stage, readSignal))
    const readCurrentSettings = () => boundedRead(() => readSettings(spec.identity.profile))

    const gate = async (expected: JevAuthorityExpectation, stage: JevSidecarDiagnostic['stage'],
      activeBudget = budget, requestSignal = signal, request?: unknown): Promise<JevCredentialSettings> => {
      const fail = (reason: JevSidecarReason): never => { throw Object.assign(new Error(reason), { sidecarReason: reason }) }
      activeBudget.check()
      requestSignal.throwIfAborted()
      if (terminal || !handle) fail('invalid_input')
      let current: JevCredentialSettings
      try { current = await boundedRead(() => readSettings(spec.identity.profile), activeBudget) } catch (error) {
        if (providerReason(error) !== 'provider_error') throw error
        return fail('settings_unavailable')
      }
      const { apiKey: _apiKey, ...nonSecret } = current
      const settings = { ...nonSecret, hasApiKey: Boolean(current.apiKey) }
      let enabled: boolean
      try { enabled = adapter.parsePolicy(settings).enabled && (adapter.isStageEnabled?.(settings, stage, request) ?? true) } catch {
        return fail('settings_unavailable')
      }
      if (!enabled) fail('disabled')
      if (!snapshotMatchesCurrent(handle!, adapter.integrationId, current)) fail('configuration_changed')
      let authority
      try { authority = await boundedRead(readSignal => adapter.readAuthority(spec.identity, expected, stage, readSignal), activeBudget) } catch (error) {
        if (providerReason(error) !== 'provider_error') throw error
        return fail('authorization_unavailable')
      }
      if (!authority.allowed) fail(authority.reason)
      activeBudget.check()
      requestSignal.throwIfAborted()
      if (terminal) fail('invalid_input')
      return current
    }

    const context: JevSidecarTaskContext<any, any> = {
      async snapshot() {
        const done = guard<JevSnapshotHandle>(); if (done) return done
        if (handle) return { kind: 'completed', value: handle, diagnostic: diagnostic('evaluate') }
        try {
          const authority = await readAuthority(spec.expected, 'evaluate')
          if (!authority.allowed) return skip('evaluate', authority.reason)
          const settings = await readCurrentSettings()
          handle = createSidecarSnapshot(spec.identity.profile, settings, adapter) ?? undefined
          if (!handle) return skip('evaluate', settings.apiKey ? 'disabled' : 'not_configured')
          const secret = sidecarSnapshotSecret(handle, adapter.integrationId)!
          budget.tighten(secret.policy.budgetMs)
          budget.check()
          return finish({ kind: 'completed', value: handle, diagnostic: diagnostic('evaluate') })
        } catch (error) {
          const reason = providerReason(error)
          return reason === 'caller_cancelled' ? cancelled('evaluate') : skip('evaluate', reason === 'provider_error' ? 'settings_unavailable' : reason)
        }
      },
      async evaluate<Q extends Questions>(requestedHandle: JevSnapshotHandle, request: TrustedJevRequest<Q>, expected: JevAuthorityExpectation, stage: 'evaluate' | 'reevaluate' = 'evaluate') {
        const done = guard<SystemOneResult<Q>>(); if (done) return done
        if (requestedHandle !== handle || jevCalls >= adapter.maxJevCalls) return skip(stage, 'invalid_input')
        const secret = sidecarSnapshotSecret(requestedHandle, adapter.integrationId)
        if (!secret) return skip(stage, 'invalid_input')
        let prepared: ReturnType<typeof prepareTrustedJevRequest<Q>>
        try { prepared = prepareTrustedJevRequest(request, secret.model) } catch (error) {
          return skip(stage, error instanceof JevSidecarInputError ? error.reason : 'invalid_input')
        }
        const release = requestSlots.tryAcquire(spec.identity.profile)
        if (!release) return skip(stage, 'queue_full', prepared.bytes)
        jevCalls += 1
        let handedToPhysical = false
        try {
          const raced = await budget.race(async requestSignal => {
            const current = await gate(expected, stage, budget, requestSignal)
            return evaluateJevWithCredentials({ ...current, apiKey: secret.apiKey, baseUrl: secret.baseUrl, model: secret.model }, prepared.request, {
              signal: requestSignal,
              timeoutMs: Math.min(secret.providerTimeoutMs, current.timeoutMs, Math.max(1, budget.remaining())),
              beforeFetch: async () => { await gate(expected, stage, budget, requestSignal) },
            })
          })
          handedToPhysical = true
          void raced.physical.finally(release)
          const value = await raced.logical
          if (!validJevAnswers(value, prepared.request.questions)) return skip(stage, 'invalid_result', prepared.bytes)
          const completed = { kind: 'completed' as const, value, diagnostic: diagnostic(stage, undefined, prepared.bytes) }
          observe(completed.diagnostic)
          return completed
        } catch (error: any) {
          if (!handedToPhysical) release()
          const reason = error?.sidecarReason as JevSidecarReason | undefined ?? (error instanceof JevError && error.code === 'jev_configuration_changed' ? 'configuration_changed' : providerReason(error))
          return reason === 'caller_cancelled' ? cancelled(stage) : skip(stage, reason, prepared.bytes)
        }
      },
      async generate<T>(requestedHandle: JevSnapshotHandle, expected: JevAuthorityExpectation,
        operation: (context: import('./sidecar-contract').JevGenerationContext) => Promise<T>) {
        const stage = 'revision_generate' as const
        const done = guard<T>(); if (done) return done
        if (requestedHandle !== handle || !sidecarSnapshotSecret(requestedHandle, adapter.integrationId)
          || generationCalls >= Math.min(1, adapter.maxGenerationCalls)) return skip<T>(stage, 'invalid_input')
        const release = generationSlots.tryAcquire(spec.identity.profile)
        if (!release) return skip<T>(stage, 'queue_full')
        let resume: (() => void) | undefined
        let handedToPhysical = false
        try {
          resume = budget.pause()
          generationCalls += 1
          const generationBudget = new JevSidecarBudget(GENERATION_BUDGET_MS, signal, clock, undefined, parentDeadline)
          const raced = await generationBudget.race(async generationSignal => {
            const beforeDispatch = async () => { await gate(expected, stage, generationBudget, generationSignal) }
            await beforeDispatch()
            return operation({ signal: generationSignal, beforeDispatch })
          })
          handedToPhysical = true
          void raced.physical.finally(release)
          const value = await raced.logical
          return finish({ kind: 'completed', value, diagnostic: diagnostic(stage) })
        } catch (error) {
          const reason = providerReason(error)
          return reason === 'caller_cancelled' ? cancelled<T>(stage) : skip<T>(stage, reason)
        } finally {
          resume?.()
          if (!handedToPhysical) release()
        }
      },
      async apply(expected: JevAuthorityExpectation, request: unknown) {
        const done = guard<any>(); if (done) return done
        if (applied || !adapter.apply) return skip('apply', 'invalid_input')
        try {
          await gate(expected, 'apply', budget, signal, request)
          budget.check()
          const value = adapter.apply(spec.identity, expected, request)
          if (value && typeof (value as any).then === 'function') return skip('apply', 'record_write_failed')
          applied = true
          const completed = { kind: 'completed' as const, value, diagnostic: diagnostic('apply') }
          terminal = completed
          observe(completed.diagnostic)
          return completed
        } catch (error) {
          const reason = providerReason(error)
          return reason === 'caller_cancelled' ? cancelled('apply') : skip('apply', reason === 'provider_error' ? 'record_write_failed' : reason)
        }
      },
    }

    try { await spec.run(context) } catch { if (!terminal) skip('evaluate', 'provider_error') }
    finally {
      if (handle) destroySidecarSnapshot(handle)
      controllers.delete(controllerKey)
      logicalActive -= 1
    }
  }

  return {
    trySchedule,
    cancel(scope: { integrationId?: string; sourceKey?: string; attemptId?: string }) {
      for (const [key, controller] of controllers) {
        const [integrationId, sourceKey, attemptId] = key.split('\0')
        if (scope.integrationId && scope.integrationId !== integrationId) continue
        if (scope.sourceKey && scope.sourceKey !== sourceKey) continue
        if (scope.attemptId && scope.attemptId !== attemptId) continue
        controller.abort()
      }
    },
    close() { queue.close(); for (const controller of controllers.values()) controller.abort() },
    status(): JevSidecarStatus { const state = queue.status(); return { queued: state.queued, logicalActive,
      physicalReads: readSlots.active, physicalRequests: requestSlots.active, physicalGenerations: generationSlots.active, closed: state.closed } },
    instanceId: options.instanceId ?? randomUUID(),
  }
}
