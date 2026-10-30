import type { Context } from 'koa'
import { authenticateLoginUserToken } from '../public/auth'
import { getChatRunServer } from '../services/chat-run/server-registry'
import { acceptExternalNotice, parseExternalNotice } from '../services/session-notifications/external'

const REFUSED = {
  forbidden: [403, 'profile_access_denied'],
  not_found: [404, 'Session not found'],
  unsupported: [422, 'unsupported_notification_target'],
  generation_mismatch: [409, 'session_generation_mismatch'],
  conflict: [409, 'notification_conflict'],
} as const

/**
 * POST /api/studio/sessions/:id/notifications — append a passive notice from an external service.
 * It is shown and marked unread; it never starts or queues a model turn.
 */
export async function create(ctx: Context) {
  // Only a token from an interactive Studio login, sent as a bearer header, authorizes this
  // mutation: not a model-run, App, share, server, model-key or run-scoped credential.
  const token = /^Bearer\s+(\S+)$/i.exec(ctx.get('authorization'))?.[1]
  if (!token) { ctx.status = 401; ctx.body = { error: 'login_token_required' }; return }
  const user = ctx.state.sessionShare ? null : await authenticateLoginUserToken(token)
  if (!user) { ctx.status = 403; ctx.body = { error: 'login_token_required' }; return }
  const notice = parseExternalNotice(ctx.request.body)
  if ('invalid' in notice) { ctx.status = 400; ctx.body = { error: 'invalid_notification', field: notice.invalid }; return }
  const selectors = [ctx.get('x-hermes-profile'), ctx.query.profile].filter(value => value !== undefined && value !== '')
  if (selectors.some(value => value !== notice.profile)) { ctx.status = 400; ctx.body = { error: 'profile_mismatch' }; return }

  const result = acceptExternalNotice(user.id, String(ctx.params.id), notice)
  if (result.status !== 'accepted' && result.status !== 'duplicate') {
    const [status, error] = REFUSED[result.status]
    ctx.status = status
    ctx.body = { error }
    return
  }
  const { record } = result
  // Only a new acceptance is published; an identical retry has no further effects.
  if (result.status === 'accepted') getChatRunServer()?.publishSessionNotice?.(record)
  ctx.status = result.status === 'accepted' ? 201 : 200
  ctx.body = { ok: true, notification_id: record.id, session_id: record.session_id, profile: record.profile,
    session_generation: record.session_generation, duplicate: result.status === 'duplicate' }
}
