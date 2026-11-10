import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { getChatRunServer } from '../../studio/public/chat-run'
import { consentAccountAllowed } from '../../studio/public/cron-consent'
import { listTrustedScriptReportBindings } from '../../studio/public/script-reports'
import {
  claimTrustedCronCapability,
  issueTrustedCronCapability,
  revokeTrustedCronCapability,
  trustedCronPolicy,
  trustedCronSessionRefusal,
  updateTrustedCronPolicy,
  type TrustedCronPolicy,
} from '../../studio/public/trusted-cron'
import { logger } from '../../studio/public/logging'
import { ConsentError } from '../services/cron-consent/consent'
import { admitCurrentSessionCron, refuseCronOverrides } from '../services/cron-consent/current-session'
import { stopScriptReportCapture } from '../services/script-reports/enrollment'
import { loginUser, requestProfile, sendError } from './cron-consent'

/** A dispatch keeps its admission authority until it finishes, at most this long. */
const DISPATCH_DEADLINE_MS = 120_000
const OPERATION_FIELDS = ['kind', 'mode', 'job_id', 'name', 'schedule', 'script', 'workdir', 'interpreter', 'paused', 'prompt', 'target_session_id']

const policyView = (profile: string, policy: TrustedCronPolicy) =>
  ({ profile, enabled: policy.enabled, revision: policy.revision, updated_at: policy.updated_at })

/** GET /api/hermes/cron/trusted-automation?profile= — login only. */
export async function getPolicy(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const profile = String(ctx.query.profile ?? '')
  if (!profile) { ctx.status = 400; ctx.body = { error: 'invalid_profile', message: 'profile is required' }; return }
  if (!consentAccountAllowed(user.id, profile)) { ctx.status = 403; ctx.body = { error: 'profile_access_denied' }; return }
  ctx.body = policyView(profile, trustedCronPolicy(user.id, profile))
}

/** PUT /api/hermes/cron/trusted-automation — login only, compare-and-set on `expected_revision`. */
export async function putPolicy(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const raw = ctx.request.body as { profile: string; enabled: boolean; expected_revision: number } | undefined
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}

  const profile = requestProfile(ctx, input.profile)
  if (!profile) return
  if (!consentAccountAllowed(user.id, profile)) { ctx.status = 403; ctx.body = { error: 'profile_access_denied' }; return }
  if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expected_revision) || Number(input.expected_revision) < 0) {
    ctx.status = 400; ctx.body = { error: 'invalid_policy_update' }; return
  }
  const written = updateTrustedCronPolicy(user.id, profile, input.enabled, Number(input.expected_revision))
  if (!written) { ctx.status = 409; ctx.body = { error: 'policy_revision_conflict' }; return }
  if (written.previousEpoch) {
    // Routing of the old epoch is already refused at import; also stop capture, without pausing jobs.
    const bindings = listTrustedScriptReportBindings(user.id, profile, written.previousEpoch)
    void Promise.all(bindings.map(binding => stopScriptReportCapture(binding.binding_id)))
      .catch(error => logger.warn(error, '[trusted-cron] failed to stop policy script capture'))
  }
  ctx.body = policyView(profile, written.policy)
}

/** POST /api/hermes/cron/current-session — the trusted admission credential only. */
export async function admit(ctx: Context) {
  const authority = ctx.state.cronAdmission as ({ accountId: number; profile: string; sessionId: string; generation: string; epoch: string; token: string; isActive: () => boolean }) | undefined
  if (!authority) { ctx.status = 403; ctx.body = { error: 'trusted_capability_required' }; return }
  const raw = ctx.request.body as { profile: string; kind: string; mode?: string; job_id?: string; name?: string; schedule?: string; script?: string; workdir?: string
    interpreter?: string; paused?: boolean; prompt?: string; target_session_id?: string } | undefined
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  if (!requestProfile(ctx, input.profile)) return
  try {
    ctx.body = await admitCurrentSessionCron({ ...authority, claim: () => claimTrustedCronCapability(authority.token) }, input)
    ctx.status = 201
  } catch (error) {
    sendError(ctx, error)
  }
}

/**
 * POST /api/hermes/cron/current-session/dispatch — login only. Freezes a single-use admission scope
 * for the selected session and runs the fixed admission once through the Studio Bridge and the
 * managed MCP, without any model; the scope is revoked when that run ends.
 */
export async function dispatch(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const raw = ctx.request.body as { profile: string; session_id: string; kind: string; mode?: string; job_id?: string; name?: string; schedule?: string; script?: string; workdir?: string
    interpreter?: string; paused?: boolean; prompt?: string; target_session_id?: string } | undefined
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const profile = requestProfile(ctx, input.profile)
  if (!profile) return
  try {
    const { session_id: selected, ...operation } = input
    refuseCronOverrides(operation)
    const sessionId = typeof selected === 'string' ? selected : ''
    if (!trustedCronPolicy(user.id, profile).enabled) throw new ConsentError(403, 'trusted_policy_disabled')
    const refused = trustedCronSessionRefusal(user.id, profile, sessionId)
    if (refused) throw new ConsentError(refused.status, refused.code)
    const server = getChatRunServer()
    if (!server?.dispatchCurrentSessionCron) throw new ConsentError(503, 'dispatch_unavailable')
    const contextId = `cron-dispatch:${randomUUID()}`
    const deadline = Date.now() + DISPATCH_DEADLINE_MS
    const capability = issueTrustedCronCapability({ accountId: user.id, profile, sessionId, contextId, singleUse: true, isActive: () => Date.now() < deadline })
    if (!capability) throw new ConsentError(403, 'trusted_policy_disabled')
    const fixed = Object.fromEntries([['profile', profile], ...OPERATION_FIELDS.filter(key => operation[key] !== undefined).map(key => [key, operation[key]])])
    try {
      const result = await server.dispatchCurrentSessionCron({
        profile, sessionId, capability,
        arguments: { method: 'POST', path: '/api/hermes/cron/current-session', body: fixed },
      }) as { status: number; body: unknown }
      ctx.status = result.status
      ctx.body = result.body
    } finally {
      revokeTrustedCronCapability(sessionId, contextId)
    }
  } catch (error) {
    sendError(ctx, error)
  }
}
