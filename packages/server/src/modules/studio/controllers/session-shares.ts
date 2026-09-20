import type { Context } from 'koa'
import { inspectAppUserToken } from '../public/auth'
import { publicSessionShare, SessionShareError, type SessionShareAction } from '../contracts/session-shares'
import { sessionShareService } from '../services/session-shares/service'
import { shareAppIdentityVerifier } from '../services/session-shares/app-identity'
import { logger } from '../public/logging'

function bearer(ctx: Context): string {
  const value = ctx.get('Authorization')
  return value.startsWith('Bearer ') ? value.slice(7).trim() : ''
}

function shareToken(ctx: Context): string {
  // Never accept URL query tokens, which leak through logs and referrers.
  return ctx.get('X-Session-Share-Token')
}

function body(ctx: any, keys: string[]): Record<string, unknown> {
  const value = ctx.request.body ?? {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new SessionShareError('share_invalid_request', 400)
  }
  return value
}

async function manageOwner(ctx: Context): Promise<number> {
  const local = await inspectAppUserToken(bearer(ctx))
  if (local?.status !== 'active' || !local.user || local.user.id !== ctx.state.user?.id) {
    throw new SessionShareError('share_app_device_required', 401)
  }
  return local.user.id
}

/** App-provided attribution only; it never grants management or recipient access. */
function sharerMetadata(value: unknown): { id: number; name: string } {
  const actor = value as any
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)
    || Object.keys(actor).some(key => !['id', 'name'].includes(key))
    || !Number.isSafeInteger(actor.id) || actor.id <= 0 || typeof actor.name !== 'string'
    || actor.name.length > 200) throw new SessionShareError('share_invalid_sharer', 400)
  return { id: actor.id, name: actor.name }
}

async function respond(ctx: Context, handler: () => Promise<void>): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  ctx.set('Referrer-Policy', 'no-referrer')
  try { await handler() } catch (error) {
    if (!(error instanceof SessionShareError)) {
      logger.error({ event: 'session-share.request-failed', method: ctx.method, path: ctx.path, err: error }, 'Session share request failed')
      throw error
    }
    logger.warn({ event: 'session-share.request-rejected', method: ctx.method, path: ctx.path, code: error.code, status: error.status }, 'Session share request rejected')
    ctx.status = error.status
    ctx.body = { error: error.code, code: error.code }
  }
}

/** Create a separate 30-day App invitation. Authorized by the existing Studio App device JWT. */
export async function create(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['permissions', 'extraPaths', 'sharer'])
    const ownerId = await manageOwner(ctx)
    const actor = sharerMetadata(input.sharer)
    const result = await sessionShareService.create(ownerId, actor, ctx.params.sessionId, input)
    ctx.status = 201
    ctx.body = { share: publicSessionShare(result.record), token: result.token }
  })
}

/** List this Studio owner's non-revoked invitations for a session. Never returns token plaintext or hashes. */
export async function list(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const ownerId = await manageOwner(ctx)
    ctx.body = { shares: sessionShareService.list(ownerId, ctx.params.sessionId)
      .map(record => ({ ...publicSessionShare(record), extraPaths: record.extra_paths.map(({ path, writable }) => ({ path, writable })) })) }
  })
}

/** Change permissions; creation time, expiry and bound identities cannot be edited. */
export async function update(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['permissions', 'extraPaths'])
    const ownerId = await manageOwner(ctx)
    const share = await sessionShareService.change(ownerId, ctx.params.sessionId, ctx.params.shareId, input)
    ctx.body = { share: publicSessionShare(share) }
  })
}

/** Revoke an invitation while retaining its audit record. */
export async function revoke(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    body(ctx, [])
    const ownerId = await manageOwner(ctx)
    const share = await sessionShareService.change(ownerId, ctx.params.sessionId, ctx.params.shareId, { revoke: true })
    ctx.body = { share: publicSessionShare(share) }
  })
}

/** Explicit first claim. X-App-Access-Token proves cloud identity; X-Session-Share-Token is the invitation. */
export async function claim(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['confirm'])
    if (input.confirm !== true) throw new SessionShareError('share_claim_confirmation_required', 400)
    const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'), shareToken(ctx))
    ctx.body = { share: publicSessionShare(sessionShareService.claim(shareToken(ctx), actor)) }
  })
}

/** Resolve the currently bound session and permissions, without returning account/session internals. */
export async function access(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'), shareToken(ctx))
    const { share } = sessionShareService.authorize(shareToken(ctx), actor, 'read')
    ctx.body = { share: publicSessionShare(share) }
  })
}

/** Permission preflight for App UI. This is NOT a reusable authorization ticket:
 * the business operation must call the same service again with server-resolved resources. */
export async function check(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['action', 'sessionId'])
    if (typeof input.action !== 'string' || typeof input.sessionId !== 'string' || !input.sessionId) {
      throw new SessionShareError('share_invalid_request', 400)
    }
    const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'), shareToken(ctx))
    const { share } = sessionShareService.authorize(shareToken(ctx), actor, input.action as SessionShareAction, input.sessionId)
    ctx.body = { allowed: true, sessionId: share.session_id, policyVersion: share.policy_version, expiresAt: share.expires_at }
  })
}

/** Session-scoped selectors for recipients. Never expose provider configuration or arbitrary host directories. */
export async function models(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    if (!ctx.state.sessionShare) throw new SessionShareError('share_recipient_required')
    const { sessionShareModels } = await import('../services/session-shares/settings')
    ctx.body = { groups: await sessionShareModels(ctx.state.sessionShare) }
  })
}

export async function workspaces(ctx: Context): Promise<void> {
  await respond(ctx, async () => {
    if (!ctx.state.sessionShare) throw new SessionShareError('share_recipient_required')
    const { sessionShareWorkspaces } = await import('../services/session-shares/settings')
    ctx.body = await sessionShareWorkspaces(ctx.state.sessionShare, ctx.query.path)
  })
}
