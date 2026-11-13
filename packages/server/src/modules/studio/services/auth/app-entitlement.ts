import { verify as verifySignature, type KeyObject } from 'crypto'

export const APP_ENTITLEMENT_ISSUER = 'hermes-studio-server'
export const APP_ENTITLEMENT_AUDIENCE = 'ekko-studio'
export const APP_ENTITLEMENT_TOKEN_TYPE = 'app_entitlement'
export const APP_ENTITLEMENT_FEATURE = 'lan_access'

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60
const MAX_TOKEN_LENGTH = 16 * 1024
const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzEbiOn5Na+TnLbGGOg9C
bcmoy+WjR912cnoN/XzBHrjuTv4cgR5AjU3A0t5GmHUaV1jZb0A1McN4aai+lwIb
4GXGi0E7xOoUd4GfWkZU70Shxfg2JJJS2H4lyxhc3nbe+D4OjmFbQkTyN8hPfANA
gx+fGjXdOO+H+EJKn7QFxJUw9GrA6BklYWHJmONqkmxjuv4NiLEjbLBDgtHNowx2
62Lcb/Q48lryefVdaCA1OlUmlL0EZ0QNB7Xn9Gkvzg3xK8UZeH1GZK7gBXcVVJTN
qLrZ6o6L2LT0rxHnBCATEZY2ay1pQp6CHAgwY4DfsT+y/WohW4szd7H2UG6aNDDV
vwIDAQAB
-----END PUBLIC KEY-----`

export interface AppEntitlementClaims {
  issuer: string
  audience: string
  userId: number
  deviceCode: string
  features: string[]
  plan: string
  issuedAt: number
  expiresAt: number
  tokenId: string
}

export interface VerifyAppEntitlementOptions {
  publicKey?: string | Buffer | KeyObject
  issuer?: string
  audience?: string
  now?: number
  clockToleranceSeconds?: number
}

export interface AppEntitlementInspection {
  status: 'valid' | 'expired' | 'invalid'
  claims: AppEntitlementClaims | null
}

type JwtHeader = {
  alg?: unknown
  typ?: unknown
}

type JwtClaims = {
  iss?: unknown
  aud?: unknown
  sub?: unknown
  userId?: unknown
  tokenType?: unknown
  deviceCode?: unknown
  features?: unknown
  plan?: unknown
  iat?: unknown
  nbf?: unknown
  exp?: unknown
  jti?: unknown
}

export function getAppEntitlementPublicKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.HERMES_APP_ENTITLEMENT_PUBLIC_KEY?.trim()
  return configured ? configured.replace(/\\n/g, '\n') : DEFAULT_PUBLIC_KEY
}

export function verifyAppEntitlementToken(
  token: string,
  options: VerifyAppEntitlementOptions = {},
): AppEntitlementClaims | null {
  const inspection = inspectAppEntitlementToken(token, options)
  return inspection.status === 'valid' ? inspection.claims : null
}

export function inspectAppEntitlementToken(
  token: string,
  options: VerifyAppEntitlementOptions = {},
): AppEntitlementInspection {
  const normalizedToken = String(token || '').trim()
  if (!normalizedToken || normalizedToken.length > MAX_TOKEN_LENGTH) return invalidInspection()
  const parts = normalizedToken.split('.')
  if (parts.length !== 3 || parts.some(part => !part)) return invalidInspection()

  try {
    const header = parseJwtPart<JwtHeader>(parts[0])
    const claims = parseJwtPart<JwtClaims>(parts[1])
    if (!header || !claims || header.alg !== 'RS256') return invalidInspection()
    if (header.typ != null && header.typ !== 'JWT') return invalidInspection()

    const signature = Buffer.from(parts[2], 'base64url')
    if (!signature.length) return invalidInspection()
    const publicKey = options.publicKey || getAppEntitlementPublicKey()
    const verified = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      signature,
    )
    if (!verified) return invalidInspection()

    const issuer = options.issuer || APP_ENTITLEMENT_ISSUER
    const audience = options.audience || APP_ENTITLEMENT_AUDIENCE
    if (claims.iss !== issuer || !hasAudience(claims.aud, audience)) return invalidInspection()
    if (claims.tokenType !== APP_ENTITLEMENT_TOKEN_TYPE) return invalidInspection()

    const userId = Number(claims.userId)
    const issuedAt = Number(claims.iat)
    const notBefore = claims.nbf == null ? issuedAt : Number(claims.nbf)
    const expiresAt = Number(claims.exp)
    const now = Math.floor((options.now ?? Date.now()) / 1000)
    const tolerance = normalizeTolerance(options.clockToleranceSeconds)
    if (!Number.isSafeInteger(userId) || userId <= 0 || claims.sub !== String(userId)) return invalidInspection()
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(notBefore) || !Number.isSafeInteger(expiresAt)) return invalidInspection()
    if (issuedAt > now + tolerance || notBefore > now + tolerance || expiresAt < issuedAt) return invalidInspection()

    const deviceCode = normalizeIdentifier(claims.deviceCode, 255)
    const tokenId = normalizeIdentifier(claims.jti, 255)
    const plan = normalizeIdentifier(claims.plan, 64)
    if (!deviceCode || !tokenId || !plan) return invalidInspection()
    if (!Array.isArray(claims.features)) return invalidInspection()
    const features = claims.features
      .filter((feature): feature is string => typeof feature === 'string')
      .map(feature => feature.trim())
      .filter(Boolean)
    if (!features.includes(APP_ENTITLEMENT_FEATURE)) return invalidInspection()

    const normalizedClaims: AppEntitlementClaims = {
      issuer,
      audience,
      userId,
      deviceCode,
      features: [...new Set(features)],
      plan,
      issuedAt,
      expiresAt,
      tokenId,
    }
    return {
      status: expiresAt === issuedAt || expiresAt <= now ? 'expired' : 'valid',
      claims: normalizedClaims,
    }
  } catch {
    return invalidInspection()
  }
}

function invalidInspection(): AppEntitlementInspection {
  return { status: 'invalid', claims: null }
}

function parseJwtPart<T>(value: string): T | null {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const parsed = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as T : null
  } catch {
    return null
  }
}

function hasAudience(value: unknown, audience: string): boolean {
  if (typeof value === 'string') return value === audience
  return Array.isArray(value) && value.some(item => item === audience)
}

function normalizeIdentifier(value: unknown, maxLength: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized && normalized.length <= maxLength ? normalized : ''
}

function normalizeTolerance(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CLOCK_TOLERANCE_SECONDS
  return Math.max(0, Math.min(Math.floor(Number(value)), 300))
}
