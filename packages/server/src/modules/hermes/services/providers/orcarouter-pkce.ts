import { createHash, randomBytes } from 'crypto'

import {
  ORCAROUTER_APP_NAME,
  ORCAROUTER_AUTHORIZE_PATH,
  ORCAROUTER_EXCHANGE_PATH,
  ORCAROUTER_SCOPE,
  orcaRouterExchangeUrl,
  resolveOrcaRouterOrigins,
} from '../../../studio/public/orcarouter-catalog'

/**
 * OAuth 2.0 authorization-code flow with PKCE for OrcaRouter.
 *
 * There is no client secret and no redirect URI to pre-register. The verifier
 * is the only thing that binds an intercepted auth code to this process, so it
 * is generated fresh from a cryptographic RNG for every attempt and never
 * leaves the process until the exchange.
 */

export const ORCAROUTER_PKCE_CHALLENGE_METHOD = 'S256'
/** Loopback callback for Flow A. `oob` selects Flow B (out-of-band code). */
export const ORCAROUTER_OOB_CALLBACK = 'oob'

export type OrcaRouterCallbackMode = 'loopback' | 'oob'

export interface OrcaRouterPkceAttempt {
  verifier: string
  challenge: string
  state: string
  authorizeUrl: string
  authBase: string
  apiBase: string
  exchangeUrl: string
  callbackMode: OrcaRouterCallbackMode
  callbackUrl: string
}

export class OrcaRouterPkceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'OrcaRouterPkceError'
  }
}

function base64Url(input: Buffer): string {
  return input.toString('base64url')
}

/** `base64url(sha256(verifier))`, no padding. */
export function codeChallengeFor(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

export function createState(): string {
  return base64Url(randomBytes(16))
}

/**
 * Constant-time comparison so a `state` probe cannot be timed.
 */
export function statesMatch(expected: string, received: unknown): boolean {
  const actual = String(received ?? '')
  if (!expected || !actual) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) return false
  return createHash('sha256').update(a).digest().equals(createHash('sha256').update(b).digest())
}

export function buildOrcaRouterAuthorizeUrl(input: {
  authBase: string
  callbackUrl: string
  challenge: string
  state: string
  appName?: string
  scope?: string
}): string {
  const url = new URL(ORCAROUTER_AUTHORIZE_PATH, `${input.authBase.replace(/\/+$/, '')}/`)
  url.searchParams.set('callback_url', input.callbackUrl)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', ORCAROUTER_PKCE_CHALLENGE_METHOD)
  url.searchParams.set('state', input.state)
  url.searchParams.set('app_name', input.appName || ORCAROUTER_APP_NAME)
  url.searchParams.set('scope', input.scope || ORCAROUTER_SCOPE)
  return url.toString()
}

/**
 * Start one attempt. A fresh verifier and state are minted every call; the
 * verifier is returned only to the caller and is never placed in a URL.
 */
export function startOrcaRouterPkceAttempt(input: {
  callbackMode: OrcaRouterCallbackMode
  callbackUrl?: string
  appName?: string
  env?: NodeJS.ProcessEnv
}): OrcaRouterPkceAttempt {
  const { authBase, apiBase } = resolveOrcaRouterOrigins(input.env)
  const callbackUrl = input.callbackMode === 'oob'
    ? ORCAROUTER_OOB_CALLBACK
    : String(input.callbackUrl || '').trim()
  if (!callbackUrl) {
    throw new OrcaRouterPkceError('A loopback callback URL is required for the redirect flow', 'ORCAROUTER_CALLBACK_MISSING')
  }
  const verifier = createCodeVerifier()
  const challenge = codeChallengeFor(verifier)
  const state = createState()
  return {
    verifier,
    challenge,
    state,
    authorizeUrl: buildOrcaRouterAuthorizeUrl({
      authBase,
      callbackUrl,
      challenge,
      state,
      appName: input.appName,
    }),
    authBase,
    apiBase,
    exchangeUrl: orcaRouterExchangeUrl(authBase),
    callbackMode: input.callbackMode,
    callbackUrl,
  }
}

export interface OrcaRouterExchangeResult {
  apiKey: string
  scope: string
  userId: string
}

function exchangeErrorMessage(status: number, payload: Record<string, unknown>): { message: string; code: string; retryable: boolean } {
  const detail = String(
    payload.error_description ??
    (payload.error && typeof payload.error === 'object'
      ? (payload.error as Record<string, unknown>).message
      : payload.error) ??
    payload.message ??
    '',
  ).trim()
  if (status === 400) {
    return {
      message: `OrcaRouter rejected the PKCE challenge method${detail ? `: ${detail}` : ''}`,
      code: 'ORCAROUTER_EXCHANGE_CHALLENGE_REJECTED',
      retryable: false,
    }
  }
  if (status === 403) {
    return {
      message: `OrcaRouter refused this authorization code (unknown, expired, or already used)${detail ? `: ${detail}` : ''}`,
      code: 'ORCAROUTER_EXCHANGE_CODE_REJECTED',
      retryable: false,
    }
  }
  if (status === 429) {
    return {
      message: 'OrcaRouter is rate limiting new authorizations; reuse the stored key or retry later',
      code: 'ORCAROUTER_EXCHANGE_RATE_LIMITED',
      retryable: true,
    }
  }
  return {
    message: `OrcaRouter key exchange failed (${status})${detail ? `: ${detail}` : ''}`,
    code: 'ORCAROUTER_EXCHANGE_FAILED',
    retryable: status >= 500,
  }
}

/**
 * Redeem an auth code. Auth codes are single-use with a 10 minute TTL, so a
 * 403 is terminal rather than something to retry.
 */
export async function exchangeOrcaRouterCode(input: {
  exchangeUrl: string
  code: string
  verifier: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<OrcaRouterExchangeResult> {
  const fetcher = input.fetchImpl || fetch
  let response: Response
  try {
    response = await fetcher(input.exchangeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.verifier,
        code_challenge_method: ORCAROUTER_PKCE_CHALLENGE_METHOD,
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    })
  } catch (err) {
    throw new OrcaRouterPkceError(
      `Could not reach OrcaRouter to exchange the authorization code: ${err instanceof Error ? err.message : String(err)}`,
      'ORCAROUTER_EXCHANGE_NETWORK',
      0,
      true,
    )
  }
  const text = await response.text().catch(() => '')
  let payload: Record<string, unknown> = {}
  try {
    const parsed = text ? JSON.parse(text) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {
    payload = {}
  }
  if (!response.ok) {
    const failure = exchangeErrorMessage(response.status, payload)
    throw new OrcaRouterPkceError(failure.message, failure.code, response.status, failure.retryable)
  }
  const apiKey = String(payload.key ?? '').trim()
  if (!apiKey) {
    throw new OrcaRouterPkceError(
      'OrcaRouter returned no key for this authorization code',
      'ORCAROUTER_EXCHANGE_EMPTY_KEY',
      response.status,
      false,
    )
  }
  return {
    apiKey,
    // Read back what was granted, not what was requested: the workspace role
    // may not permit the wider grant.
    scope: String(payload.scope ?? '').trim(),
    userId: String(payload.user_id ?? '').trim(),
  }
}

/**
 * Reject a grant that does not cover the inference scope this integration
 * needs. The requested scope is never treated as the granted scope.
 */
export function assertOrcaRouterScopeGranted(scope: string): void {
  const granted = new Set(scope.split(/\s+/).map(item => item.trim()).filter(Boolean))
  if (!granted.has(ORCAROUTER_SCOPE)) {
    throw new OrcaRouterPkceError(
      `OrcaRouter granted scope "${scope || '(none)'}", which does not include "${ORCAROUTER_SCOPE}"`,
      'ORCAROUTER_SCOPE_DOWNGRADED',
      0,
      false,
    )
  }
}

export { ORCAROUTER_AUTHORIZE_PATH, ORCAROUTER_EXCHANGE_PATH }
