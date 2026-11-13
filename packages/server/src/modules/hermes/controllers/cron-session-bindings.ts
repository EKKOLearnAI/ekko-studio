import type { Context } from 'koa'
import { authenticateLoginUserToken } from '../../studio/public/auth'
import { bindDirect, CronBindingError } from '../services/cron-session-bindings/bind'

/**
 * POST /api/hermes/cron/session-bindings — explicitly bind an existing agent-backed native job whose
 * stored `deliver` is `local` to a session's frozen generation. Needs an interactive login token
 * (signed `purpose: "login"`), so a model run cannot bind on its own; a model run asks the user
 * through `POST /api/hermes/cron/consent-requests` instead. Script-only jobs and explicit delivery
 * targets are refused; native job configuration is never changed.
 */
export async function bind(ctx: Context) {
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1]
  if (!token) { ctx.status = 401; ctx.body = { error: 'login_token_required' }; return }
  const user = ctx.state.sessionShare ? null : await authenticateLoginUserToken(token)
  if (!user) { ctx.status = 403; ctx.body = { error: 'login_token_required', hint: 'request_user_consent', consent_path: '/api/hermes/cron/consent-requests' }; return }
  const input = (ctx.request.body && typeof ctx.request.body === 'object' ? ctx.request.body : {}) as Record<string, unknown>
  const profile = typeof input.profile === 'string' ? input.profile : ''
  const selectors = [ctx.get('x-hermes-profile'), ctx.query.profile].filter(item => item !== undefined && item !== '')
  if (!profile || selectors.some(item => item !== profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return }
  const jobId = typeof input.job_id === 'string' ? input.job_id : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const generation = typeof input.expected_session_generation === 'string' ? input.expected_session_generation : ''
  if (!jobId || !sessionId || !generation) { ctx.status = 400; ctx.body = { error: 'invalid_binding' }; return }
  try {
    await bindDirect(user.id, profile, jobId, sessionId, generation)
  } catch (error) {
    if (!(error instanceof CronBindingError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.code }
    return
  }
  ctx.status = 201
  ctx.body = { ok: true, profile, job_id: jobId, session_id: sessionId, session_generation: generation }
}
