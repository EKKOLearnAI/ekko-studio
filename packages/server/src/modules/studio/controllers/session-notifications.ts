import type { Context } from 'koa'
import { authenticateLoginUserToken } from '../public/auth'
import { getChatRunServer } from '../services/chat-run/server-registry'
import { acceptExternalNotice, parseExternalNotice } from '../services/session-notifications/external'
import {
  isNoticePublisherToken,
  issueNoticePublisher,
  listNoticePublishers,
  parseIssueRequest,
  publisherScopeRefusal,
  revokeNoticePublisher,
  touchNoticePublisher,
  type SessionNoticePublisherRecord,
} from '../services/session-notifications/publishers'

const REFUSED = {
  forbidden: [403, 'profile_access_denied'],
  owner_required: [403, 'session_owner_required'],
  not_found: [404, 'Session not found'],
  unsupported: [422, 'unsupported_notification_target'],
  generation_mismatch: [409, 'session_generation_mismatch'],
  conflict: [409, 'notification_conflict'],
} as const

/** Interactive-login user for owner actions; any other credential (including a publisher grant) is refused. */
async function loginUser(ctx: Context) {
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1]
  if (!token) { ctx.status = 401; ctx.body = { error: 'login_token_required' }; return null }
  const user = ctx.state.sessionShare || isNoticePublisherToken(token) ? null : await authenticateLoginUserToken(token)
  if (!user) { ctx.status = 403; ctx.body = { error: 'login_token_required' }; return null }
  return user
}

function profileSelectorsMatch(ctx: Context, profile: string): boolean {
  const selectors = [ctx.get('x-hermes-profile'), ctx.query.profile].filter(value => value !== undefined && value !== '')
  return !selectors.some(value => value !== profile)
}

/**
 * POST /api/studio/sessions/:id/notifications — append a passive notice from an external service.
 * It is shown and marked unread; it never starts or queues a model turn.
 *
 * Authorized by an interactive Studio login token, or by a notice publisher grant scoped to this
 * session, profile and session generation (and an allow-list of producer sources). The auth
 * middleware admits a grant on this route only; model-run, App, share, server, model-key and
 * run-scoped credentials are refused.
 */
export async function create(ctx: Context) {
  const grant = ctx.state.noticePublisher as SessionNoticePublisherRecord | undefined
  let userId: number
  if (grant) {
    userId = grant.owner_user_id
  } else {
    const user = await loginUser(ctx)
    if (!user) return
    userId = user.id
  }
  const notice = parseExternalNotice(ctx.request.body)
  if ('invalid' in notice) { ctx.status = 400; ctx.body = { error: 'invalid_notification', field: notice.invalid }; return }
  if (!profileSelectorsMatch(ctx, notice.profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return }
  if (grant) {
    const refusal = publisherScopeRefusal(grant, String(ctx.params.id), notice)
    if (refusal) { ctx.status = 403; ctx.body = { error: refusal }; return }
  }

  const result = acceptExternalNotice(userId, String(ctx.params.id), notice)
  if (result.status !== 'accepted' && result.status !== 'duplicate') {
    const [status, error] = REFUSED[result.status]
    ctx.status = status
    ctx.body = { error }
    return
  }
  const { record } = result
  if (grant) touchNoticePublisher(grant.id)
  // Only a new acceptance is published; an identical retry has no further effects.
  if (result.status === 'accepted') getChatRunServer()?.publishSessionNotice?.(record)
  ctx.status = result.status === 'accepted' ? 201 : 200
  ctx.body = { ok: true, notification_id: record.id, session_id: record.session_id, profile: record.profile,
    session_generation: record.session_generation, duplicate: result.status === 'duplicate' }
}

/**
 * POST /api/studio/sessions/:id/notification-publishers — the session owner issues a publisher grant
 * for the session's current generation (a legacy session without an owner: a super admin only). The secret is in this response only; Studio stores its hash.
 */
export async function issuePublisher(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  const request = parseIssueRequest(ctx.request.body)
  if ('invalid' in request) { ctx.status = 400; ctx.body = { error: 'invalid_publisher_request', field: request.invalid }; return }
  if (!profileSelectorsMatch(ctx, request.profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return }
  const result = issueNoticePublisher(user.id, String(ctx.params.id), request)
  if (result.status !== 'issued') {
    const [status, error] = REFUSED[result.status]
    ctx.status = status
    ctx.body = { error }
    return
  }
  ctx.set('Cache-Control', 'no-store')
  ctx.status = 201
  ctx.body = { ok: true, token: result.token, publisher: result.publisher }
}

/** GET /api/studio/sessions/:id/notification-publishers — the caller's grants for this session, without secrets. */
export async function listPublishers(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  ctx.body = { publishers: listNoticePublishers(user.id, String(ctx.params.id)) }
}

/** DELETE /api/studio/sessions/:id/notification-publishers/:publisherId — revoke one of the caller's grants. */
export async function revokePublisher(ctx: Context) {
  const user = await loginUser(ctx)
  if (!user) return
  if (!revokeNoticePublisher(user.id, String(ctx.params.id), String(ctx.params.publisherId))) {
    ctx.status = 404
    ctx.body = { error: 'publisher_not_found' }
    return
  }
  ctx.body = { ok: true, revoked: true }
}
