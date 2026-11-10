import type { Context } from 'koa'
import { authenticateLoginUserToken, type AuthenticatedUser } from '../../studio/public/auth'
import { findScriptReportBinding, listScriptReportBindingHealth } from '../../studio/public/script-reports'
import { EnrollmentError, enrollScriptReport, revokeScriptReport } from '../services/script-reports/enrollment'

/**
 * Explicit opt-in surfaces. Every mutation needs an interactive Studio login token (signed
 * `purpose: "login"`) as a bearer header: not a model-run, App, share or server credential, so a
 * model turn cannot enroll or revoke on its own.
 */
async function loginUser(ctx: Context): Promise<AuthenticatedUser | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1]
  if (!token) { ctx.status = 401; ctx.body = { error: 'login_token_required' }; return null }
  const user = ctx.state.sessionShare ? null : await authenticateLoginUserToken(token)
  if (!user) { ctx.status = 403; ctx.body = { error: 'login_token_required', hint: 'request_user_consent', consent_path: '/api/hermes/cron/consent-requests' }; return null }
  return user
}

function body(ctx: Context): Record<string, unknown> {
  const value = ctx.request.body
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** The explicit body profile, matching any header or query selector. */
function requestProfile(ctx: Context, value: unknown): string | null {
  const profile = typeof value === 'string' ? value : ''
  const selectors = [ctx.get('x-hermes-profile'), ctx.query.profile].filter(item => item !== undefined && item !== '')
  if (!profile || selectors.some(item => item !== profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return null }
  return profile
}

function sendError(ctx: Context, error: unknown): void {
  if (error instanceof EnrollmentError) {
    ctx.status = error.status
    ctx.body = { error: error.code, ...(error.jobId ? { job_id: error.jobId } : {}), ...(error.nativeState ? { native_state: error.nativeState } : {}) }
    return
  }
  ctx.status = 500
  ctx.body = { error: 'script_report_enrollment_failed' }
}

function canManage(user: AuthenticatedUser, accountId: number): boolean {
  return user.role === 'super_admin' || user.id === accountId
}

/** POST /api/hermes/script-reports/enrollments — create a NEW reporting no_agent job. */
export async function enroll(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const input = body(ctx)
  const profile = requestProfile(ctx, input.profile)
  if (!profile) return
  const generation = typeof input.expected_session_generation === 'string' ? input.expected_session_generation : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  if (!generation || !sessionId) { ctx.status = 400; ctx.body = { error: 'invalid_destination' }; return }
  try {
    const result = await enrollScriptReport({
      userId: user.id, profile, sessionId, expectedGeneration: generation,
      name: String(input.name ?? ''), schedule: String(input.schedule ?? ''), script: String(input.script ?? ''),
      workdir: input.workdir as string | null | undefined, interpreter: input.interpreter as string | null | undefined,
      paused: input.paused === true,
    })
    ctx.status = 201
    ctx.body = { binding: { ...result.binding, identity_kind: 'wrapper_invocation' }, job: result.job, resumed: result.resumed,
      ...(result.nativeState ? { native_state: result.nativeState } : {}) }
  } catch (error) {
    sendError(ctx, error)
  }
}

/** GET /api/hermes/script-reports/enrollments?profile= — bindings with import health. */
export async function list(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const profile = typeof ctx.query.profile === 'string' ? ctx.query.profile : ''
  if (!profile) { ctx.status = 400; ctx.body = { error: 'profile_required' }; return }
  ctx.body = { bindings: listScriptReportBindingHealth(profile).filter(binding => canManage(user, binding.account_id)) }
}

/** POST /api/hermes/script-reports/enrollments/:id/revoke — final; re-enroll to report again. */
export async function revoke(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const binding = findScriptReportBinding(String(ctx.params.id))
  if (!binding || !canManage(user, binding.account_id)) { ctx.status = 404; ctx.body = { error: 'binding_not_found' }; return }
  const result = await revokeScriptReport(binding)
  ctx.body = { binding: findScriptReportBinding(binding.binding_id), native_job_paused: result.paused }
}
