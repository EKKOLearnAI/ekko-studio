import { studioInstanceId } from './session-notifications'
import { incompleteScriptReports, isScriptReportTarget } from '../services/session-notifications/script-reports'
import { getSession, getSessionGeneration } from '../repositories/session-store'
import { findUserById, userCanAccessProfile } from '../repositories/users-store'
import {
  countScriptReportInvocations,
  getScriptReportBinding,
  insertScriptReportBinding,
  listScriptReportBindings,
  recordScriptReportBindingJob,
  setScriptReportBindingError,
  transitionScriptReportBinding,
  type ScriptReportBinding,
} from '../repositories/script-report-store'

export * from './script-report-paths'
export {
  importScriptReports,
  setScriptReportJobInspector,
  type NativeScriptJob,
  type ScriptReportJobInspector,
} from '../services/session-notifications/script-reports'
export type { ScriptReportBinding }

export type DestinationVerdict = 'ok' | 'forbidden' | 'not_found' | 'unsupported' | 'generation_mismatch'

/**
 * The account may receive passive notices in this session as it exists now, and the caller froze
 * its current generation. Checked before any enrollment write; never refetches a generation.
 */
export function authorizeNoticeDestination(userId: number, profile: string, sessionId: string, expectedGeneration: string): DestinationVerdict {
  const user = findUserById(userId)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile))) return 'forbidden'
  const session = getSession(sessionId)
  if (!session || (session.profile || 'default') !== profile) return 'not_found'
  if (!isScriptReportTarget(session)) return 'unsupported'
  if (getSessionGeneration(sessionId) !== expectedGeneration) return 'generation_mismatch'
  return 'ok'
}

export function beginScriptReportBinding(input: {
  bindingId: string
  userId: number
  profile: string
  sessionId: string
  expectedGeneration: string
  jobName: string
  targetScript: string
  wrapperScript: string
}): ScriptReportBinding {
  return insertScriptReportBinding({
    binding_id: input.bindingId,
    revision: 1,
    namespace: studioInstanceId(),
    profile: input.profile,
    session_id: input.sessionId,
    session_generation: input.expectedGeneration,
    account_id: input.userId,
    job_name: input.jobName,
    target_script: input.targetScript,
    wrapper_script: input.wrapperScript,
  })
}

/** Record the native job id as soon as it exists, whatever the binding's state, so revoke can pause it. */
export function recordScriptReportJob(bindingId: string, jobId: string): void {
  recordScriptReportBindingJob(bindingId, jobId)
}

/** False when the binding left `enrolling` meanwhile (revoked): the caller must not resume. */
export function activateScriptReportBinding(bindingId: string): boolean {
  return transitionScriptReportBinding(bindingId, ['enrolling'], 'active', { error: null })
}

export function failScriptReportBinding(bindingId: string, error: string): boolean {
  return transitionScriptReportBinding(bindingId, ['enrolling'], 'failed', { error })
}

export function noteScriptReportBindingError(bindingId: string, error: string | null): void {
  setScriptReportBindingError(bindingId, error)
}

/** Revocation is final: a revoked binding never becomes active again. */
export function revokeScriptReportBinding(bindingId: string): boolean {
  return transitionScriptReportBinding(bindingId, ['active', 'enrolling', 'failed'], 'revoked')
}

export function findScriptReportBinding(bindingId: string): ScriptReportBinding | null {
  return getScriptReportBinding(bindingId)
}

export interface ScriptReportBindingHealth extends ScriptReportBinding {
  identity_kind: 'wrapper_invocation'
  imported: ReturnType<typeof countScriptReportInvocations>
  /** Started without a final report: still running, or killed. The outcome is unknown. */
  incomplete: Array<{ invocation_id: string; started_at: number | null }>
}

export function listScriptReportBindingHealth(profile: string): ScriptReportBindingHealth[] {
  return listScriptReportBindings(studioInstanceId(), profile).map(binding => ({
    ...binding,
    identity_kind: 'wrapper_invocation',
    imported: countScriptReportInvocations(binding.binding_id),
    incomplete: binding.state === 'active' || binding.state === 'revoked' ? incompleteScriptReports(binding) : [],
  }))
}
