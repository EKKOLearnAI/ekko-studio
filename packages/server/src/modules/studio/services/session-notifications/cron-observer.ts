import {
  acceptSessionNotification,
  cronJobObservationState,
  readCronSessionBindings,
  setCronJobObservationState,
  type CronSessionBinding,
  type SessionNotificationDisposition,
  type SessionNotificationRecord,
} from '../../repositories/session-notification-store'

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
  jobs: Array<{ job_id: string; state: 'present' | 'missing'; name?: string | null; deliver?: string | null }>
}

export interface CronObserverDeps {
  namespace: string
  bindingsPath: string
  observe(profile: string, jobs: Array<{ job_id: string; since: number }>): Promise<CronObservationResponse>
  /** Owner session with its current exact generation (`getSessionGeneration`). */
  getSession(sessionId: string): { profile?: string | null; generation?: string | null } | null
  publish(record: SessionNotificationRecord): void
}

const VISIBLE: ReadonlySet<SessionNotificationDisposition> = new Set(['notified', 'status_only', 'unknown'])

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
    if (execution.silent) return { disposition: 'silent', payload: base }
    if (!answer.trim()) return { disposition: 'no_content', payload: { ...base, success: execution.success === true } }
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
    const response = await deps.observe(profile, profileBindings.map(binding => ({
      job_id: binding.job_id,
      since: binding.bound_at - 1,
    })))
    const byJob = new Map(profileBindings.map(binding => [binding.job_id, binding]))
    const changedTargets = new Set<string>()
    for (const job of response.jobs || []) {
      const binding = byJob.get(job.job_id)
      if (!binding) continue
      if (job.state === 'missing') {
        setCronJobObservationState(deps.namespace, profile, job.job_id, 'stopped')
        continue
      }
      // An out-of-band edit to an explicit target ends Studio observation: no additive mirror.
      if ((job.deliver || 'local') !== (binding.stored_deliver || 'local')) {
        changedTargets.add(job.job_id)
        acceptSessionNotification({
          namespace: deps.namespace, profile, producerKey: `cron-target:${job.job_id}`,
          sessionId: binding.session_id, kind: 'cron', disposition: 'target_changed',
          payload: { job_id: job.job_id, bound_deliver: binding.stored_deliver, current_deliver: job.deliver ?? null },
          attention: false,
        })
        setCronJobObservationState(deps.namespace, profile, job.job_id, 'stopped')
      }
    }
    for (const execution of response.executions || []) {
      const binding = byJob.get(execution.job_id)
      if (!binding || changedTargets.has(execution.job_id) || !isScheduledExecution(execution)) continue
      const current = bindingOwnerCurrent(binding, deps.getSession(binding.session_id))
      const classified = current
        ? classifyCronExecution(execution)
        : { disposition: 'owner_missing' as const, payload: { job_id: execution.job_id, execution_id: execution.execution_id } }
      const record = acceptSessionNotification({
        namespace: deps.namespace,
        profile,
        producerKey: `cron:${execution.job_id}:${execution.execution_id}`,
        sessionId: binding.session_id,
        kind: 'cron',
        disposition: classified.disposition,
        payload: classified.payload,
        attention: VISIBLE.has(classified.disposition),
      })
      if (!record) continue
      accepted.push(record)
      if (VISIBLE.has(record.disposition)) deps.publish(record)
    }
  }
  return accepted
}
