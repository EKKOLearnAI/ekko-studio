import type { Context } from 'koa'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { authenticateLoginUserToken } from '../../studio/public/auth'
import { authorizeNoticeDestination, writeCronSessionBinding } from '../../studio/public/cron-session-bindings'
import { getHermesBaseDir, getProfileDir } from '../services/profiles/profile'

const REFUSED = {
  forbidden: [403, 'profile_access_denied'],
  not_found: [404, 'session_not_found'],
  unsupported: [422, 'unsupported_notification_target'],
  generation_mismatch: [409, 'session_generation_mismatch'],
} as const

function readJob(profile: string, jobId: string): Record<string, any> | null {
  const home = getProfileDir(profile)
  // An unknown profile resolves to the base home; never read another profile's jobs.
  if (profile !== 'default' && home === getHermesBaseDir()) return null
  const path = join(home, 'cron', 'jobs.json')
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf-8'))
  const jobs = Array.isArray(parsed) ? parsed : parsed?.jobs
  return (Array.isArray(jobs) ? jobs : []).find((job: any) => job?.id === jobId || job?.job_id === jobId) ?? null
}

/**
 * POST /api/hermes/cron/session-bindings — explicitly bind an existing agent-backed native job whose
 * stored `deliver` is `local` to a session's frozen generation. Needs an interactive login token
 * (signed `purpose: "login"`), so a model run cannot bind on its own. Script-only jobs and explicit
 * delivery targets are refused; native job configuration is never changed.
 */
export async function bind(ctx: Context) {
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1]
  if (!token) { ctx.status = 401; ctx.body = { error: 'login_token_required' }; return }
  const user = ctx.state.sessionShare ? null : await authenticateLoginUserToken(token)
  if (!user) { ctx.status = 403; ctx.body = { error: 'login_token_required' }; return }
  const input = (ctx.request.body && typeof ctx.request.body === 'object' ? ctx.request.body : {}) as Record<string, unknown>
  const profile = typeof input.profile === 'string' ? input.profile : ''
  const selectors = [ctx.get('x-hermes-profile'), ctx.query.profile].filter(item => item !== undefined && item !== '')
  if (!profile || selectors.some(item => item !== profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return }
  const jobId = typeof input.job_id === 'string' ? input.job_id : ''
  const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
  const generation = typeof input.expected_session_generation === 'string' ? input.expected_session_generation : ''
  if (!jobId || !sessionId || !generation) { ctx.status = 400; ctx.body = { error: 'invalid_binding' }; return }
  const verdict = authorizeNoticeDestination(user.id, profile, sessionId, generation)
  if (verdict !== 'ok') {
    const [status, error] = REFUSED[verdict]
    ctx.status = status
    ctx.body = { error }
    return
  }
  const job = readJob(profile, jobId)
  if (!job) { ctx.status = 404; ctx.body = { error: 'job_not_found' }; return }
  if (job.no_agent === true) { ctx.status = 422; ctx.body = { error: 'script_job_requires_script_report' }; return }
  if (String(job.deliver || '') !== 'local') { ctx.status = 422; ctx.body = { error: 'explicit_delivery_target' }; return }
  writeCronSessionBinding({ profile, jobId, sessionId, generation, storedDeliver: 'local' })
  ctx.status = 201
  ctx.body = { ok: true, profile, job_id: jobId, session_id: sessionId, session_generation: generation }
}
