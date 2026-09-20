import type { Context } from 'koa'
import { inspectAppUserToken } from '../public/auth'
import { publicSessionShare, SessionShareError, type SessionShareAction } from '../contracts/session-shares'
import { sessionShareService } from '../services/session-shares/service'
import { shareAppIdentityVerifier } from '../services/session-shares/app-identity'

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

async function manageIdentity(ctx: Context) {
  const token = bearer(ctx)
  let local = await inspectAppUserToken(token)
  if (local?.status !== 'active' || !local.user || local.user.id !== ctx.state.user?.id) {
    throw new SessionShareError('share_app_device_required', 401)
  }
  const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'))
  local = await inspectAppUserToken(token)
  if (local?.status !== 'active' || !local.user || local.user.id !== ctx.state.user?.id) {
    throw new SessionShareError('share_app_device_required', 401)
  }
  return { ownerId: local.user.id, actor }
}

async function respond(ctx: Context, handler: () => Promise<void>): Promise<void> {
  ctx.set('Cache-Control', 'no-store')
  ctx.set('Referrer-Policy', 'no-referrer')
  try { await handler() } catch (error) {
    if (!(error instanceof SessionShareError)) throw error
    ctx.status = error.status
    ctx.body = { error: error.code, code: error.code }
  }
}

/** Create a separate 30-day App invitation. Requires Studio App JWT and X-App-Access-Token. */
export async function create(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['permissions', 'extraPaths'])
    const { ownerId, actor } = await manageIdentity(ctx)
    const result = await sessionShareService.create(ownerId, actor, ctx.params.sessionId, input)
    ctx.status = 201
    ctx.body = { share: publicSessionShare(result.record), token: result.token }
  })
}

/** List this App account's invitations for a session. Never returns token plaintext or hashes. */
export async function list(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const { ownerId, actor } = await manageIdentity(ctx)
    ctx.body = { shares: sessionShareService.list(ownerId, actor, ctx.params.sessionId)
      .map(record => ({ ...publicSessionShare(record), extraPaths: record.extra_paths.map(({ path, writable }) => ({ path, writable })) })) }
  })
}

/** Change permissions; creation time, expiry and bound identities cannot be edited. */
export async function update(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['permissions', 'extraPaths'])
    const { ownerId, actor } = await manageIdentity(ctx)
    const share = await sessionShareService.change(ownerId, actor, ctx.params.sessionId, ctx.params.shareId, input)
    ctx.body = { share: publicSessionShare(share) }
  })
}

/** Revoke an invitation while retaining its audit record. */
export async function revoke(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    body(ctx, [])
    const { ownerId, actor } = await manageIdentity(ctx)
    const share = await sessionShareService.change(ownerId, actor, ctx.params.sessionId, ctx.params.shareId, { revoke: true })
    ctx.body = { share: publicSessionShare(share) }
  })
}

/** Explicit first claim. X-App-Access-Token proves cloud identity; X-Session-Share-Token is the invitation. */
export async function claim(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const input = body(ctx, ['confirm'])
    if (input.confirm !== true) throw new SessionShareError('share_claim_confirmation_required', 400)
    const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'))
    ctx.body = { share: publicSessionShare(sessionShareService.claim(shareToken(ctx), actor)) }
  })
}

/** Resolve the currently bound session and permissions, without returning account/session internals. */
export async function access(ctx: any): Promise<void> {
  await respond(ctx, async () => {
    const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'))
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
    const actor = await shareAppIdentityVerifier.verify(ctx.get('X-App-Access-Token'))
    const { share } = sessionShareService.authorize(shareToken(ctx), actor, input.action as SessionShareAction, input.sessionId)
    ctx.body = { allowed: true, sessionId: share.session_id, policyVersion: share.policy_version, expiresAt: share.expires_at }
  })
}
