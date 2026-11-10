import {
  acceptFencedSessionNotification,
  cronJobObservationState,
  cronJobObserveCursor,
  isVisibleNoticeDisposition,
  setCronJobObserveCursor,
  setCronJobObservationState,
  type SessionNotificationDisposition,
  type SessionNotificationRecord,
} from '../../repositories/session-notification-store'
import { readCronSessionBindings, type CronSessionBinding } from '../../public/cron-session-bindings'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { getSession } from '../../repositories/session-store'
import { studioSessionAccount } from '../../contracts/runs/usage'

/** Exact answers are stored whole up to this bound; longer answers are clipped and flagged. */
export const CRON_NOTICE_MAX_CHARS = 100_000

export interface CronObservedExecution {
  job_id: string
  job_name?: string | null
  execution_id: string
  source?: string | null
  scheduled_instant?: string | null
  status: string
  finished_at?: string | null
  error?: string | null
  delivery_outcome?: string | null
  no_agent: boolean
  receipt: 'exact' | 'unavailable'
  success?: boolean
  answer?: string
  result_error?: string | null
  silent?: boolean
}

export interface CronObservationResponse {
  executions: CronObservedExecution[]
  jobs: Array<{ job_id: string; state: 'present' | 'missing'; name?: string | null; deliver?: string | null; older_before?: string | null }>
}

export interface CronObserverDeps {
  namespace: string
  bindingsPath: string
  observe(profile: string, jobs: Array<{ job_id: string; since: number; before?: string }>): Promise<CronObservationResponse>
  /** Owner session with its current exact generation (`getSessionGeneration`). */
  getSession(sessionId: string): { profile?: string | null; generation?: string | null } | null
  publish(record: SessionNotificationRecord): void
}

/** The exact bound session still exists in the profile it was bound from, as the same generation. */
export function bindingOwnerCurrent(binding: CronSessionBinding, session: { profile?: string | null; generation?: string | null } | null): boolean {
  if (!session || !binding.session_generation || !session.generation) return false
  if ((session.profile || 'default') !== binding.profile) return false
  return session.generation === binding.session_generation
}

/** Scheduled fires only; a chat `run` already returns through its own async-delegation result. */
export function isScheduledExecution(execution: CronObservedExecution): boolean {
  return execution.source === 'builtin' || Boolean(execution.scheduled_instant)
}

export function classifyCronExecution(execution: CronObservedExecution): {
  disposition: SessionNotificationDisposition
  payload: Record<string, unknown>
} {
  const base: Record<string, unknown> = {
    job_id: execution.job_id,
    job_name: execution.job_name || execution.job_id,
    execution_id: execution.execution_id,
    status: execution.status,
    finished_at: execution.finished_at || null,
    scheduled_instant: execution.scheduled_instant || null,
    delivery_outcome: execution.delivery_outcome || null,
  }
  if (execution.status === 'unknown') {
    return { disposition: 'unknown', payload: { ...base, reason: 'execution_unknown', error: execution.error || null } }
  }
  if (execution.receipt === 'exact') {
    const answer = String(execution.answer || '')
    // A known failure is reported even with no answer text; silence/emptiness only suppress successes.
    if (execution.success === false) {
      const truncated = answer.length > CRON_NOTICE_MAX_CHARS
      return {
        disposition: 'notified',
        payload: {
          ...base,
          success: false,
          content: truncated ? answer.slice(0, CRON_NOTICE_MAX_CHARS) : answer,
          truncated,
          error: execution.result_error || execution.error || null,
        },
      }
    }
    if (execution.silent) return { disposition: 'silent', payload: base }
    // An empty answer is recorded once but, like silence, never shown.
    if (!answer.trim()) return { disposition: 'silent', payload: { ...base, success: execution.success === true, reason: 'no_content' } }
    const truncated = answer.length > CRON_NOTICE_MAX_CHARS
    return {
      disposition: 'notified',
      payload: {
        ...base,
        success: execution.success === true,
        content: truncated ? answer.slice(0, CRON_NOTICE_MAX_CHARS) : answer,
        truncated,
        error: execution.success === true ? null : execution.result_error || execution.error || null,
      },
    }
  }
  return {
    disposition: 'status_only',
    payload: {
      ...base,
      reason: execution.no_agent ? 'output_unavailable_for_runtime' : 'receipt_unavailable',
      error: execution.error || null,
    },
  }
}

/** The same binding row as observed earlier; every (re)binding writes a strictly later `bound_at`. */
function sameBindingRevision(observed: CronSessionBinding, current: CronSessionBinding | undefined): boolean {
  return Boolean(current)
    && current!.bound_at === observed.bound_at
    && current!.session_id === observed.session_id
    && current!.session_generation === observed.session_generation
    && current!.stored_deliver === observed.stored_deliver
}

function bindingAccountCurrent(binding: CronSessionBinding): boolean {
  if (binding.account_id === null) return true
  const user = findUserById(binding.account_id)
  return !!user && user.status === 'active' && (user.role === 'super_admin' || userCanAccessProfile(user.id, binding.profile))
}

/** A target bound to a specific account stays current only while its session still belongs to that account. */
export function targetOwnerCurrent(targetOwner: number | null, sessionId: string): boolean {
  if (targetOwner === null) return true
  const session = getSession(sessionId)
  return !!session && Number(studioSessionAccount(session as any)) === targetOwner
}

/** One observation pass over every active binding of this Studio instance. */
export async function observeCronBindings(deps: CronObserverDeps): Promise<SessionNotificationRecord[]> {
  const bindings = readCronSessionBindings(deps.bindingsPath, deps.namespace)
    .filter(binding => cronJobObservationState(deps.namespace, binding.profile, binding.job_id) !== 'stopped')
  const byProfile = new Map<string, CronSessionBinding[]>()
  for (const binding of bindings) {
    const list = byProfile.get(binding.profile) || []
    list.push(binding)
    byProfile.set(binding.profile, list)
  }
  const accepted: SessionNotificationRecord[] = []
  for (const [profile, profileBindings] of byProfile) {
    const response = await deps.observe(profile, profileBindings.map(binding => {
      const before = cronJobObserveCursor(deps.namespace, profile, binding.job_id)
      // The binding time itself is the cutoff: a fire claimed before it belongs to the previous binding.
      return { job_id: binding.job_id, since: binding.bound_at, ...(before ? { before } : {}) }
    }))
    // A binding replaced while Hermes answered owns the job now: drop this stale answer for it.
    const live = new Map(readCronSessionBindings(deps.bindingsPath, deps.namespace)
      .filter(binding => binding.profile === profile)
      .map(binding => [binding.job_id, binding]))
    const byJob = new Map(profileBindings
      .filter(binding => sameBindingRevision(binding, live.get(binding.job_id)))
      .map(binding => [binding.job_id, binding]))
    const changedTargets = new Set<string>()
    for (const job of response.jobs || []) {
      const binding = byJob.get(job.job_id)
      if (!binding) continue
      if (job.state === 'missing') {
        setCronJobObservationState(deps.namespace, profile, job.job_id, 'stopped')
        continue
      }
      // Older retained executions still to recover; acceptance below is idempotent per execution.
      setCronJobObserveCursor(deps.namespace, profile, job.job_id, job.older_before ?? null)
      // An out-of-band edit to an explicit target ends Studio observation: no additive mirror.
      if ((job.deliver || 'local') !== (binding.stored_deliver || 'local')) {
        changedTargets.add(job.job_id)
        setCronJobObservationState(deps.namespace, profile, job.job_id, 'stopped')
      }
    }
    for (const execution of response.executions || []) {
      const binding = byJob.get(execution.job_id)
      if (!binding || changedTargets.has(execution.job_id) || !isScheduledExecution(execution)) continue
      // A reset, deleted or re-profiled owner never receives the result, and nothing is rerouted.
      if (!bindingOwnerCurrent(binding, deps.getSession(binding.session_id))) continue
      // A consent binding stops delivering once its approving account loses access: the execution is
      // recorded as owner_missing and never shown or rerouted.
      const classified = bindingAccountCurrent(binding)
        ? classifyCronExecution(execution)
        : { disposition: 'owner_missing' as const, payload: { job_id: execution.job_id, execution_id: execution.execution_id } }
      // Fenced to the binding's frozen generation; a replayed execution is a duplicate with no effects.
      const result = acceptFencedSessionNotification({
        namespace: deps.namespace,
        profile,
        producerKey: `cron:${execution.job_id}:${execution.execution_id}`,
        sessionId: binding.session_id,
        expectedGeneration: binding.session_generation!,
        kind: 'cron',
        disposition: classified.disposition,
        payload: classified.payload,
      })
      if (result.status !== 'accepted') continue
      accepted.push(result.record)
      if (isVisibleNoticeDisposition(result.record.disposition)) deps.publish(result.record)
    }
  }
  return accepted
}
