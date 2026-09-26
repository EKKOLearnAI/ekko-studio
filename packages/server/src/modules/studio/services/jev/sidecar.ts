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
import { boundedQueueInput, JevSidecarInputError, prepareTrustedJevRequest } from './sidecar-payload'
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

function providerReason(error: unknown): JevSidecarReason {
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
    const budget = new JevSidecarBudget(ceiling, signal, clock, acceptedMono)
    let handle: JevSnapshotHandle | undefined
    let terminal: JevSidecarOutcome<any> | undefined
    let jevCalls = 0
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

    const boundedRead = async <T>(operation: (readSignal: AbortSignal) => Promise<T>): Promise<T> => {
      budget.check()
      const release = readSlots.tryAcquire(spec.identity.profile)
      if (!release) throw Object.assign(new Error('queue_full'), { sidecarReason: 'queue_full' as JevSidecarReason })
      let handedToPhysical = false
      try {
        const raced = await budget.race(operation)
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

    const context: JevSidecarTaskContext<any, any> = {
      async snapshot() {
        const done = guard<JevSnapshotHandle>(); if (done) return done
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
            const gate = async () => {
              budget.check()
              let current: JevCredentialSettings
              try { current = await readSettings(spec.identity.profile) } catch {
                throw Object.assign(new Error('settings_unavailable'), { sidecarReason: 'settings_unavailable' as JevSidecarReason })
              }
              const { apiKey: _apiKey, ...nonSecret } = current
              let currentPolicy
              try { currentPolicy = adapter.parsePolicy({ ...nonSecret, hasApiKey: Boolean(current.apiKey) }) } catch {
                throw Object.assign(new Error('settings_unavailable'), { sidecarReason: 'settings_unavailable' as JevSidecarReason })
              }
              if (!currentPolicy.enabled) throw Object.assign(new Error('disabled'), { sidecarReason: 'disabled' as JevSidecarReason })
              if (!snapshotMatchesCurrent(requestedHandle, adapter.integrationId, current)) {
                throw Object.assign(new Error('configuration_changed'), { sidecarReason: 'configuration_changed' as JevSidecarReason })
              }
              let authority
              try { authority = await adapter.readAuthority(spec.identity, expected, stage, requestSignal) } catch {
                throw Object.assign(new Error('authorization_unavailable'), { sidecarReason: 'authorization_unavailable' as JevSidecarReason })
              }
              if (!authority.allowed) throw Object.assign(new Error(authority.reason), { sidecarReason: authority.reason })
              budget.check()
              return current
            }
            const current = await gate()
            return evaluateJevWithCredentials({ ...current, apiKey: secret.apiKey, baseUrl: secret.baseUrl, model: secret.model }, prepared.request, {
              signal: requestSignal,
              timeoutMs: Math.min(secret.providerTimeoutMs, current.timeoutMs, Math.max(1, budget.remaining())),
              beforeFetch: async () => { await gate() },
            })
          })
          handedToPhysical = true
          void raced.physical.finally(release)
          const value = await raced.logical
          const completed = { kind: 'completed' as const, value, diagnostic: diagnostic(stage, undefined, prepared.bytes) }
          observe(completed.diagnostic)
          return completed
        } catch (error: any) {
          if (!handedToPhysical) release()
          const reason = error?.sidecarReason as JevSidecarReason | undefined ?? (error instanceof JevError && error.code === 'jev_configuration_changed' ? 'configuration_changed' : providerReason(error))
          return reason === 'caller_cancelled' ? cancelled(stage) : skip(stage, reason, prepared.bytes)
        }
      },
      async apply(expected: JevAuthorityExpectation, request: unknown) {
        const done = guard<any>(); if (done) return done
        if (applied || !adapter.apply) return skip('apply', 'invalid_input')
        try {
          const authority = await readAuthority(expected, 'apply')
          if (!authority.allowed) return skip('apply', authority.reason)
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
      physicalReads: readSlots.active, physicalRequests: requestSlots.active, closed: state.closed } },
    instanceId: options.instanceId ?? randomUUID(),
  }
}
