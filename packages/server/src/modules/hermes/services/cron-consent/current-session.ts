import { authorizeNoticeDestination } from '../../../studio/public/script-reports'
import { trustedCronPolicyCurrent, trustedCronSessionRefusal } from '../../../studio/public/trusted-cron'
import { CronBindingError, adoptAgentJob, createBoundAgentJob, prepareAgentBinding } from '../cron-session-bindings/bind'
import { readNativeJob } from '../script-reports/native-jobs'
import {
  defaultCronRunner,
  EnrollmentError,
  executeAdoption,
  executeNewEnrollment,
  prepareAdoption,
  prepareNewEnrollment,
  type HermesCronRunner,
} from '../script-reports/enrollment'
import { ConsentError, resolveTarget, targetVerdict, type ConsentAuthority, type ConsentTarget } from './consent'

/**
 * Trusted Cron admission: with the account's trusted-automation policy enabled, an issuer-scoped
 * admission credential (a live chat turn, or a login dispatch) creates, enrolls or binds a job without
 * a per-job approval. The origin session, account, profile, generation and policy epoch all come from
 * the credential. Results go to that session, or to an explicit `target_session_id`: another session of
 * the same account and profile, frozen with its generation and owner exactly as for a consent request.
 */
export interface CronAdmissionAuthority {
  accountId: number
  profile: string
  sessionId: string
  generation: string
  epoch: string
  /** Consumes a single-use scope; a chat turn's scope may admit several jobs. */
  claim: () => boolean
  /** The issuing turn or dispatch is still live (not ended, expired or revoked); separate from the claim. */
  isActive: () => boolean
}

/** Fields that would choose a destination or authority (`target_session_id` is validated, not chosen freely). */
const OVERRIDES = ['session_id', 'sessionId', 'context_id', 'account_id', 'user_id',
  'expected_session_generation', 'session_generation', 'deliver']

export function refuseCronOverrides(input: Record<string, unknown>): void {
  if (OVERRIDES.some(key => input[key] !== undefined)) throw new ConsentError(400, 'destination_override_refused')
}

const origin = (authority: CronAdmissionAuthority): ConsentAuthority => ({ accountId: authority.accountId, profile: authority.profile,
  sessionId: authority.sessionId, generation: authority.generation, contextKind: 'turn' })

/**
 * Why the captured authority no longer admits, or null: the origin (live execution, policy epoch,
 * session and generation) and any frozen target (same attributed owner, profile and generation).
 * Checked again after every native await.
 */
function refusal(authority: CronAdmissionAuthority, target: ConsentTarget | null): { status: number; code: string } | null {
  const { accountId, profile, sessionId, generation, epoch } = authority
  if (!authority.isActive()) return { status: 409, code: 'execution_ended' }
  if (!trustedCronPolicyCurrent(accountId, profile, epoch)) return { status: 403, code: 'trusted_policy_changed' }
  const session = trustedCronSessionRefusal(accountId, profile, sessionId)
  if (session) return session
  const verdict = authorizeNoticeDestination(accountId, profile, sessionId, generation)
  if (verdict === 'generation_mismatch') return { status: 409, code: 'session_generation_mismatch' }
  if (verdict === 'unsupported') return { status: 422, code: 'unsupported_notification_target' }
  if (verdict === 'not_found') return { status: 404, code: 'session_not_found' }
  if (verdict !== 'ok') return { status: 403, code: 'profile_access_denied' }
  return target ? targetVerdict(origin(authority), target) : null
}

/** An adopted job must keep every result local: an external failure lane would deliver outside the session. */
function refuseExternalFailureLane(profile: string, jobId: string): void {
  const lane = readNativeJob(profile, jobId)?.failure_deliver
  if (lane !== undefined && lane !== null && lane !== '' && lane !== 'local') throw new ConsentError(422, 'explicit_delivery_target')
}

function field(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ConsentError(400, code)
  return value.trim()
}

export async function admitCurrentSessionCron(authority: CronAdmissionAuthority, input: Record<string, unknown>,
  runner: HermesCronRunner = defaultCronRunner): Promise<Record<string, unknown>> {
  refuseCronOverrides(input)
  const now = refusal(authority, null)
  if (now) throw new ConsentError(now.status, now.code)
  const { accountId, profile, sessionId, epoch } = authority
  // Frozen before any await or claim; naming the origin itself keeps the same-session contract.
  const target = resolveTarget(origin(authority), input.target_session_id)
  const destination = target
    ? { sessionId: target.sessionId, generation: target.generation, targetOwner: accountId }
    : { sessionId, generation: authority.generation }
  const recheck = (Refusal: typeof EnrollmentError | typeof CronBindingError) => () => {
    const refused = refusal(authority, target)
    if (refused) throw new Refusal(refused.status, refused.code)
  }
  const agentDestination = { userId: accountId, ...destination, trustedEpoch: epoch, recheck: recheck(CronBindingError) }
  const kind = input.kind
  // Validate and freeze first: an invalid operation never consumes a single-use scope.
  let run: () => Promise<{ job_id: string | null; resumed?: boolean; native_state?: 'unknown' }>
  if (kind === 'script_report_enrollment') {
    const scriptDestination = { userId: accountId, profile, sessionId: destination.sessionId, expectedGeneration: destination.generation,
      targetOwner: destination.targetOwner, trustedEpoch: epoch, recheck: recheck(EnrollmentError) }
    const mode = input.mode === undefined ? 'new' : input.mode
    if (mode === 'existing') {
      const plan = prepareAdoption(profile, String(input.job_id ?? ''))
      refuseExternalFailureLane(profile, plan.jobId)
      run = async () => { const result = await executeAdoption(plan, scriptDestination, { runner }); return { job_id: result.binding.job_id, resumed: result.resumed, ...(result.nativeState ? { native_state: result.nativeState } : {}) } }
    } else if (mode === 'new') {
      const plan = prepareNewEnrollment({
        profile, name: String(input.name ?? ''), schedule: String(input.schedule ?? ''), script: String(input.script ?? ''),
        workdir: input.workdir as string | null | undefined, interpreter: input.interpreter as string | null | undefined, paused: input.paused === true,
      })
      run = async () => { const result = await executeNewEnrollment(plan, scriptDestination, runner); return { job_id: result.binding.job_id, resumed: result.resumed, ...(result.nativeState ? { native_state: result.nativeState } : {}) } }
    } else {
      throw new ConsentError(400, 'invalid_mode')
    }
  } else if (kind === 'cron_session_binding') {
    const plan = prepareAgentBinding(profile, String(input.job_id ?? ''))
    // Never take over another session's binding or relabel an approved one as policy-created.
    if (plan.prior) throw new CronBindingError(409, 'job_already_bound')
    refuseExternalFailureLane(profile, plan.jobId)
    // An existing job is paused and quiescent before it is bound, then resumed only if it was scheduled.
    run = async () => { const result = await adoptAgentJob(plan, agentDestination, runner); return { job_id: result.job_id, resumed: result.resumed } }
  } else if (kind === 'cron_job') {
    const job = { profile, name: field(input.name, 'invalid_name', 200), schedule: field(input.schedule, 'invalid_schedule', 200), prompt: field(input.prompt, 'invalid_prompt', 20_000) }
    run = async () => { const result = await createBoundAgentJob(job, agentDestination, runner); return { job_id: result.job_id, resumed: result.resumed } }
  } else {
    throw new ConsentError(400, 'invalid_kind')
  }
  if (!authority.claim()) throw new ConsentError(409, 'capability_claimed')
  const result = await run()
  return { status: 'admitted', kind, profile, session_id: sessionId, ...(target ? { target_session_id: target.sessionId } : {}), ...result }
}
