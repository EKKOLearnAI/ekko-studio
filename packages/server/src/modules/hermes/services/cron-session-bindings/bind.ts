import {
  authorizeNoticeDestination,
  readCronBindingRevision,
  removeCronSessionBinding,
  writeCronSessionBinding,
  type CronBindingRevision,
} from '../../../studio/public/cron-session-bindings'
import { jobFingerprint, withCronJobCreation, withCronJobLock } from '../cron-jobs/job-lock'
import { readNativeJob } from '../script-reports/native-jobs'
import { defaultCronRunner, nativeJobBusy, parseCreatedJobId, type HermesCronRunner, type JobBusyProbe } from '../script-reports/enrollment'

export class CronBindingError extends Error {
  /** `jobId` names a native job this operation created and left paused. */
  constructor(readonly status: number, readonly code: string, readonly jobId?: string) {
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
  /** Trusted-automation epoch of a policy-created binding. */
  trustedEpoch?: string
  /** Frozen owner of a cross-session target, enforced again at delivery. */
  targetOwner?: number
}

/**
 * Apply an approved agent binding under the job lock: the destination still authorizes, the job
 * still has the approved configuration, and the job is still bound exactly as it was when the user
 * approved (compare-and-set, never last-writer-wins). Records the approving account so the observer
 * stops when that account loses access. Future fires of the job are subscribed; the job itself is
 * not frozen against later native edits.
 */
export function executeAgentBinding(plan: AgentBindingPlan, destination: AgentBindingDestination): Promise<{ profile: string; job_id: string; session_id: string; session_generation: string }> {
  return withCronJobLock(plan.profile, plan.jobId, async () => applyAgentBinding(plan, destination))
}

/** The binding step itself; the caller holds the job lock. */
function applyAgentBinding(plan: AgentBindingPlan, destination: AgentBindingDestination) {
  assertBindingDestination(destination.userId, plan.profile, destination.sessionId, destination.generation)
  destination.recheck?.()
  const job = bindableJob(plan.profile, plan.jobId)
  if (jobFingerprint(job) !== plan.jobFingerprint) throw new CronBindingError(409, 'job_changed')
  const written = writeCronSessionBinding({
    profile: plan.profile, jobId: plan.jobId, sessionId: destination.sessionId, generation: destination.generation,
    storedDeliver: 'local', expectedRevision: plan.prior, accountId: destination.userId, trustedEpoch: destination.trustedEpoch,
    targetOwner: destination.targetOwner,
  })
  if (!written) throw new CronBindingError(409, 'binding_changed')
  return { profile: plan.profile, job_id: plan.jobId, session_id: destination.sessionId, session_generation: destination.generation }
}

/**
 * Create a NEW agent job and bind it: native create paused and local, with the exact id Hermes
 * returns; under that job's lock verify the stored configuration, recheck the destination, bind, then
 * resume and recheck again. Not atomic: a failure after creation leaves the job paused and reports
 * its id; a failure after resume pauses it again.
 */
export function createBoundAgentJob(input: { profile: string; name: string; schedule: string; prompt: string },
  destination: AgentBindingDestination, runner: HermesCronRunner = defaultCronRunner) {
  const { profile, name, schedule, prompt } = input
  const create = async () => {
    // Possibly queued behind another creation: the authority must still hold before this one starts.
    assertBindingDestination(destination.userId, profile, destination.sessionId, destination.generation)
    destination.recheck?.()
    let output: { stdout: string; stderr: string }
    try {
      output = await runner(profile, ['create', '--name', name, '--deliver', 'local', '--paused', '--paused-reason', 'Ekko current-session cron', schedule, prompt])
    } catch {
      throw new CronBindingError(422, 'native_create_rejected')
    }
    const jobId = parseCreatedJobId(`${output.stdout}\n${output.stderr}`)
    if (!jobId) throw new CronBindingError(422, 'native_create_rejected')
    return jobId
  }
  return withCronJobCreation(profile, create, async jobId => {
    // Every failure after creation reports the known job id.
    const failed = (error: unknown): never => {
      if (error instanceof CronBindingError) throw new CronBindingError(error.status, error.code, jobId)
      throw new CronBindingError(502, 'native_read_failed', jobId)
    }
    try {
      const job = readNativeJob(profile, jobId)
      if (!job || job.no_agent === true || job.deliver !== 'local' || job.enabled !== false || job.name !== name || job.prompt !== prompt) {
        throw new CronBindingError(502, 'native_config_mismatch')
      }
      const fingerprint = jobFingerprint(job)
      const binding = applyAgentBinding({ profile, jobId, name, schedule, prompt, jobFingerprint: fingerprint, prior: null }, destination)
      await resumeBound(profile, jobId, fingerprint, destination, runner)
      return { ...binding, resumed: true }
    } catch (error) {
      return failed(error)
    }
  })
}

/**
 * Resume a job this operation just bound, verify it and recheck the destination. From here the job and
 * its binding are this operation's own: a failure reconciles exactly them (binding removed, job paused
 * again by its known id). An unreadable or missing job is an unknown state, never assumed paused.
 */
async function resumeBound(profile: string, jobId: string, fingerprint: string, destination: AgentBindingDestination,
  runner: HermesCronRunner): Promise<void> {
  const read = (): Record<string, any> | null => { try { return readNativeJob(profile, jobId) } catch { return null } }
  const unbind = () => { try { removeCronSessionBinding(profile, jobId, destination.sessionId) } catch { /* reported by the pause outcome */ } }
  const settle = async (code: string, status = 502): Promise<never> => {
    unbind()
    if (read()?.enabled !== false) await runner(profile, ['pause', jobId]).catch(() => undefined)
    const paused = read()?.enabled === false
    throw new CronBindingError(paused ? status : 502, paused ? code : 'native_pause_unverified')
  }
  let acknowledged = true
  await runner(profile, ['resume', jobId]).catch(() => { acknowledged = false })
  const resumed = read()
  if (resumed?.enabled === false) {
    unbind()
    throw new CronBindingError(502, 'native_resume_failed')
  }
  if (!resumed || !acknowledged) await settle('native_resume_uncertain')
  if (jobFingerprint(resumed!) !== fingerprint) await settle('native_config_mismatch')
  try {
    assertBindingDestination(destination.userId, profile, destination.sessionId, destination.generation)
    destination.recheck?.()
  } catch (error) {
    await (error instanceof CronBindingError ? settle(error.code, error.status) : settle('native_resume_uncertain'))
  }
}

/**
 * Trusted adoption of an EXISTING agent job. No execution may straddle the binding: under the job lock
 * the job is paused (when scheduled) and verified unchanged, a claimed or running execution refuses it,
 * the destination is rechecked and the binding written, and only a job that was scheduled is resumed and
 * verified. Failures leave the job paused and unbound, with its id reported. An execution that finished
 * before the adoption is never delivered (observation is prospective) and cannot be undone.
 */
export function adoptAgentJob(plan: AgentBindingPlan, destination: AgentBindingDestination,
  runner: HermesCronRunner = defaultCronRunner, busy?: JobBusyProbe) {
  const { profile, jobId } = plan
  return withCronJobLock(profile, jobId, async () => {
    assertBindingDestination(destination.userId, profile, destination.sessionId, destination.generation)
    destination.recheck?.()
    const before = bindableJob(profile, jobId)
    if (jobFingerprint(before) !== plan.jobFingerprint) throw new CronBindingError(409, 'job_changed')
    const resume = before.enabled !== false
    try {
      if (resume) await runner(profile, ['pause', jobId]).catch(() => { throw new CronBindingError(502, 'native_pause_failed') })
      const paused = readNativeJob(profile, jobId)
      if (!paused || paused.enabled !== false || jobFingerprint(paused) !== plan.jobFingerprint) throw new CronBindingError(409, 'job_changed')
      if (nativeJobBusy(profile, jobId, busy)) throw new CronBindingError(409, 'job_busy')
      const binding = applyAgentBinding(plan, destination)
      if (resume) await resumeBound(profile, jobId, plan.jobFingerprint, destination, runner)
      return { ...binding, resumed: resume }
    } catch (error) {
      if (error instanceof CronBindingError) throw new CronBindingError(error.status, error.code, jobId)
      throw new CronBindingError(502, 'native_read_failed', jobId)
    }
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
