import {
  authorizeNoticeDestination,
  readCronBindingRevision,
  writeCronSessionBinding,
  type CronBindingRevision,
} from '../../../studio/public/cron-session-bindings'
import { jobFingerprint, withCronJobLock } from '../cron-jobs/job-lock'
import { readNativeJob } from '../script-reports/native-jobs'

export class CronBindingError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
  }
}

const REFUSED = {
  forbidden: [403, 'profile_access_denied'],
  not_found: [404, 'session_not_found'],
  unsupported: [422, 'unsupported_notification_target'],
  generation_mismatch: [409, 'session_generation_mismatch'],
} as const

export function assertBindingDestination(userId: number, profile: string, sessionId: string, generation: string): void {
  const verdict = authorizeNoticeDestination(userId, profile, sessionId, generation)
  if (verdict !== 'ok') {
    const [status, code] = REFUSED[verdict]
    throw new CronBindingError(status, code)
  }
}

/** Only an agent-backed job that keeps its results local can be mirrored into a session. */
function bindableJob(profile: string, jobId: string): Record<string, any> {
  const job = jobId ? readNativeJob(profile, jobId) : null
  if (!job) throw new CronBindingError(404, 'job_not_found')
  if (job.no_agent === true) throw new CronBindingError(422, 'script_job_requires_script_report')
  if (String(job.deliver || '') !== 'local') throw new CronBindingError(422, 'explicit_delivery_target')
  return job
}

/** A frozen agent binding: the approved job configuration and the binding it replaces. */
export interface AgentBindingPlan {
  profile: string
  jobId: string
  name: string
  schedule: string
  prompt: string
  jobFingerprint: string
  prior: CronBindingRevision | null
}

export function prepareAgentBinding(profile: string, jobId: string): AgentBindingPlan {
  const job = bindableJob(profile, jobId)
  return {
    profile, jobId, name: String(job.name || jobId),
    schedule: String(job.schedule_display || job.schedule?.display || ''),
    prompt: typeof job.prompt === 'string' ? job.prompt : '',
    jobFingerprint: jobFingerprint(job), prior: readCronBindingRevision(profile, jobId),
  }
}

export interface AgentBindingDestination {
  userId: number
  sessionId: string
  generation: string
  /** Consent policy checked after the job lock is held. */
  recheck?: () => void
}

/**
 * Apply an approved agent binding under the job lock: the destination still authorizes, the job
 * still has the approved configuration, and the job is still bound exactly as it was when the user
 * approved (compare-and-set, never last-writer-wins). Records the approving account so the observer
 * stops when that account loses access. Future fires of the job are subscribed; the job itself is
 * not frozen against later native edits.
 */
export function executeAgentBinding(plan: AgentBindingPlan, destination: AgentBindingDestination): Promise<{ profile: string; job_id: string; session_id: string; session_generation: string }> {
  return withCronJobLock(plan.profile, plan.jobId, async () => {
    assertBindingDestination(destination.userId, plan.profile, destination.sessionId, destination.generation)
    destination.recheck?.()
    const job = bindableJob(plan.profile, plan.jobId)
    if (jobFingerprint(job) !== plan.jobFingerprint) throw new CronBindingError(409, 'job_changed')
    const written = writeCronSessionBinding({
      profile: plan.profile, jobId: plan.jobId, sessionId: destination.sessionId, generation: destination.generation,
      storedDeliver: 'local', expectedRevision: plan.prior, accountId: destination.userId,
    })
    if (!written) throw new CronBindingError(409, 'binding_changed')
    return { profile: plan.profile, job_id: plan.jobId, session_id: destination.sessionId, session_generation: destination.generation }
  })
}

/** The direct login binding: profile-shared semantics, unconditional (re)binding, no account fence. */
export function bindDirect(userId: number, profile: string, jobId: string, sessionId: string, generation: string): Promise<void> {
  assertBindingDestination(userId, profile, sessionId, generation)
  bindableJob(profile, jobId)
  return withCronJobLock(profile, jobId, async () => {
    // Access may have changed while this request waited for the lock: authorize again, then persist.
    assertBindingDestination(userId, profile, sessionId, generation)
    bindableJob(profile, jobId)
    writeCronSessionBinding({ profile, jobId, sessionId, generation, storedDeliver: 'local' })
  })
}
