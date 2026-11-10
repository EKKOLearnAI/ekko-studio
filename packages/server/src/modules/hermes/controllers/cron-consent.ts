import type { Context } from 'koa'
import { authenticateLoginUserToken, type AuthenticatedUser } from '../../studio/public/auth'
import { getChatRunServer } from '../../studio/public/chat-run'
import { writeModelRunProfileToken } from '../../studio/public/runtime-credentials'
import {
  ConsentError,
  cronConsentStore,
  decideConsent,
  listConsents,
  prepareConsentContext,
  requestConsent,
  type ConsentDeps,
} from '../services/cron-consent/consent'
import { CronBindingError } from '../services/cron-session-bindings/bind'
import { EnrollmentError } from '../services/script-reports/enrollment'

const deps: ConsentDeps = {
  turnAuthority: (contextId, profile) => {
    const server = getChatRunServer()
    if (!server?.cronConsentTurnAuthority) throw new Error('chat run service unavailable')
    return server.cronConsentTurnAuthority(contextId, profile)
  },
  publish: sessionId => getChatRunServer()?.publishCronConsentUpdate?.(sessionId),
  issueRuntimeCredential: (user, profile) => writeModelRunProfileToken(user, profile),
}

/** Approval surfaces need an interactive login credential: never a runtime, App, share or server one. */
export async function loginUser(ctx: Context): Promise<AuthenticatedUser | null> {
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1]
  if (!token) { ctx.status = 401; ctx.body = { error: 'login_token_required' }; return null }
  const user = ctx.state.sessionShare ? null : await authenticateLoginUserToken(token)
  if (!user) { ctx.status = 403; ctx.body = { error: 'login_token_required' }; return null }
  return user
}

export function body(ctx: Context): Record<string, unknown> {
  const value = ctx.request.body
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** The explicit profile must match any header or query selector. */
export function requestProfile(ctx: Context, value: unknown): string | null {
  const profile = typeof value === 'string' ? value : ''
  const selectors = [ctx.get('x-hermes-profile'), ctx.query.profile].filter(item => item !== undefined && item !== '')
  if (!profile || selectors.some(item => item !== profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return null }
  return profile
}

export function sendError(ctx: Context, error: unknown): void {
  if (error instanceof ConsentError || error instanceof CronBindingError) {
    ctx.status = error.status
    ctx.body = { error: error.code, ...(error instanceof CronBindingError && error.jobId ? { job_id: error.jobId } : {}) }
    return
  }
  if (error instanceof EnrollmentError) {
    ctx.status = error.status
    ctx.body = { error: error.code, ...(error.jobId ? { job_id: error.jobId } : {}), ...(error.nativeState ? { native_state: error.nativeState } : {}) }
    return
  }
  throw error
}

/** POST /api/hermes/cron/consent-contexts — login: open a setup context for one selected session. */
export async function prepare(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const input = body(ctx)
  if (!requestProfile(ctx, input.profile)) return
  try {
    ctx.status = 201
    ctx.body = await prepareConsentContext(deps, cronConsentStore, user, input)
  } catch (error) {
    sendError(ctx, error)
  }
}

/** POST /api/hermes/cron/consent-requests — runtime credential: propose one operation for approval. */
export async function request(ctx: Context) {
  const user = ctx.state.sessionShare ? undefined : ctx.state.user
  if (!user) { ctx.status = 403; ctx.body = { error: 'credential_not_permitted' }; return }
  // The accepted fields, typed so the generated API catalog lists them; the service validates every value.
  const raw = ctx.request.body as {
    profile: string; context_id: string; kind: string; job_id?: string; mode?: string; name?: string; schedule?: string
    script?: string; workdir?: string; interpreter?: string; paused?: boolean; target_session_id?: string
  } | undefined
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (!requestProfile(ctx, input.profile)) return
  try {
    ctx.status = 202
    ctx.body = requestConsent(deps, cronConsentStore, user, ctx.state.credentialKind, input)
  } catch (error) {
    sendError(ctx, error)
  }
}

/** GET /api/hermes/cron/consent-requests?profile=&session_id= — login: own pending requests. */
export async function list(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const profile = typeof ctx.query.profile === 'string' ? ctx.query.profile : ''
  const sessionId = typeof ctx.query.session_id === 'string' ? ctx.query.session_id : ''
  if (!profile || !sessionId) { ctx.status = 400; ctx.body = { error: 'profile_and_session_required' }; return }
  ctx.body = { requests: listConsents(cronConsentStore, user, profile, sessionId) }
}

async function decide(ctx: Context, decision: 'approve' | 'deny') {
  const user = await loginUser(ctx)
  if (!user) return
  const profile = requestProfile(ctx, body(ctx).profile)
  if (!profile) return
  try {
    ctx.body = await decideConsent(deps, cronConsentStore, user, String(ctx.params.id), profile, decision)
  } catch (error) {
    sendError(ctx, error)
  }
}

/** POST /api/hermes/cron/consent-requests/:id/approve — login: execute the frozen plan once. */
export const approve = (ctx: Context) => decide(ctx, 'approve')
/** POST /api/hermes/cron/consent-requests/:id/deny — login: discard the request. */
export const deny = (ctx: Context) => decide(ctx, 'deny')
