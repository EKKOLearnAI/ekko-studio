import { createHash } from 'node:crypto'
import { SessionShareError, SESSION_SHARE_CACHE_MS, type SessionShareAppUser } from '../../contracts/session-shares'
import { appRelayUrlForRoute, getAppRelayRoute } from '../app-relay/route'

export interface VerifiedShareAppIdentity extends SessionShareAppUser { validUntil: number }

/** App account IDs are cloud identities, not client-supplied IDs or local Studio users. */
export class ShareAppIdentityVerifier {
  private cache = new Map<string, VerifiedShareAppIdentity>()
  constructor(
    private readonly origin: () => Promise<string> = async () => appRelayUrlForRoute(await getAppRelayRoute()),
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(token: string, shareToken?: string): Promise<VerifiedShareAppIdentity> {
    if (!token || token.length > 16_384 || /[\s\x00-\x1f]/.test(token)) throw new SessionShareError('share_app_login_required', 401)
    const proof = token.startsWith('ssp1_')
    if (proof && !shareToken) throw new SessionShareError('share_app_login_required', 401)
    const shareHash = shareToken ? createHash('sha256').update(shareToken).digest('hex') : ''
    // The host is configured by Studio, never accepted from the request.
    const origin = new URL(await this.origin())
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
      throw new SessionShareError('share_identity_unavailable', 503)
    }
    const key = createHash('sha256').update(origin.origin).update('\0').update(token).update('\0').update(shareHash).digest('hex')
    const cached = this.cache.get(key)
    if (cached && cached.validUntil > this.now()) return { ...cached }
    this.cache.delete(key)
    let response: Response
    try {
      response = await this.fetcher(new URL(proof ? '/api/app/auth/session-share-identity' : '/api/app/auth/me', origin), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(proof ? { 'X-Session-Share-Hash': shareHash } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(5000),
      })
    } catch { throw new SessionShareError('share_identity_unavailable', 503) }
    if ([401, 403, 404].includes(response.status)) throw new SessionShareError('share_app_login_required', 401)
    if (!response.ok) throw new SessionShareError('share_identity_unavailable', 503)
    const body = await response.json().catch(() => null) as any
    if (body?.ok !== true || !Number.isSafeInteger(body?.user?.id) || body.user.id <= 0
      || typeof body.user.displayName !== 'string') throw new SessionShareError('share_identity_unavailable', 503)
    // Device admission owns entitlement checks. Sharing only verifies identity.
    // /me verified the signature and session; decoding only shortens the cache
    // lifetime, it never establishes identity.
    let tokenExpiry = this.now() + SESSION_SHARE_CACHE_MS
    if (proof) {
      if (!Number.isFinite(body.expiresAt) || body.expiresAt <= this.now()) throw new SessionShareError('share_app_login_required', 401)
      tokenExpiry = Math.min(tokenExpiry, body.expiresAt)
    }
    try {
      const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp
      if (Number.isFinite(exp)) tokenExpiry = Math.min(tokenExpiry, exp * 1000)
    } catch { /* opaque access tokens are still verified by /me */ }
    if (tokenExpiry <= this.now()) throw new SessionShareError('share_app_login_required', 401)
    const identity = { id: body.user.id, name: body.user.displayName.slice(0, 200), validUntil: tokenExpiry }
    if (this.cache.size >= 1024) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key, identity)
    return { ...identity }
  }
}

export const shareAppIdentityVerifier = new ShareAppIdentityVerifier()
