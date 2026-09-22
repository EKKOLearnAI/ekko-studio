import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import {
  ORCAROUTER_EXCHANGE_PATH,
  ORCAROUTER_PKCE_CHALLENGE_METHOD,
  OrcaRouterPkceError,
  assertOrcaRouterScopeGranted,
  buildOrcaRouterAuthorizeUrl,
  codeChallengeFor,
  createCodeVerifier,
  createState,
  exchangeOrcaRouterCode,
  startOrcaRouterPkceAttempt,
  statesMatch,
} from '../../packages/server/src/modules/hermes/services/providers/orcarouter-pkce'
import {
  ORCAROUTER_DEFAULT_API_BASE,
  ORCAROUTER_DEFAULT_AUTH_BASE,
  resolveOrcaRouterOrigins,
} from '../../packages/server/src/modules/studio/public/orcarouter-catalog'

const FAKE_KEY = 'sk-orca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('OrcaRouter PKCE primitives', () => {
  it('mints a fresh verifier and state from a cryptographic RNG on every attempt', () => {
    const verifiers = new Set<string>()
    const states = new Set<string>()
    for (let i = 0; i < 64; i += 1) {
      const verifier = createCodeVerifier()
      const state = createState()
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/)
      verifiers.add(verifier)
      states.add(state)
    }
    expect(verifiers.size).toBe(64)
    expect(states.size).toBe(64)
  })

  it('derives the challenge as unpadded base64url(sha256(verifier))', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(codeChallengeFor(verifier)).toBe(expected)
    expect(codeChallengeFor(verifier)).not.toContain('=')
  })

  it('compares state in constant time and rejects empty or mismatched values', () => {
    expect(statesMatch('abc', 'abc')).toBe(true)
    expect(statesMatch('abc', 'abd')).toBe(false)
    expect(statesMatch('abc', 'abcd')).toBe(false)
    expect(statesMatch('abc', '')).toBe(false)
    expect(statesMatch('', 'abc')).toBe(false)
    expect(statesMatch('abc', null)).toBe(false)
    expect(statesMatch('abc', { toString: () => 'abc' })).toBe(true)
  })

  it('builds the authorize URL against /auth on the auth origin with S256', () => {
    const url = new URL(buildOrcaRouterAuthorizeUrl({
      authBase: ORCAROUTER_DEFAULT_AUTH_BASE,
      callbackUrl: 'http://127.0.0.1:51733/cb',
      challenge: 'challenge-value',
      state: 'state-value',
      appName: 'Ekko Studio',
    }))
    expect(url.origin).toBe('https://www.orcarouter.ai')
    expect(url.pathname).toBe('/auth')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe(ORCAROUTER_PKCE_CHALLENGE_METHOD)
    expect(url.searchParams.get('state')).toBe('state-value')
    expect(url.searchParams.get('callback_url')).toBe('http://127.0.0.1:51733/cb')
    expect(url.searchParams.get('app_name')).toBe('Ekko Studio')
  })

  it('never puts the verifier in the authorize URL', () => {
    const attempt = startOrcaRouterPkceAttempt({
      callbackMode: 'loopback',
      callbackUrl: 'http://127.0.0.1:51733/cb',
    })
    expect(attempt.authorizeUrl).not.toContain(attempt.verifier)
    expect(attempt.verifier.length).toBeGreaterThanOrEqual(43)
    expect(attempt.challenge).not.toBe(attempt.verifier)
  })

  it('uses the oob callback for the out-of-band flow', () => {
    const attempt = startOrcaRouterPkceAttempt({ callbackMode: 'oob' })
    expect(new URL(attempt.authorizeUrl).searchParams.get('callback_url')).toBe('oob')
  })

  it('keeps auth and inference on separate origins and never derives one from the other', () => {
    const attempt = startOrcaRouterPkceAttempt({
      callbackMode: 'loopback',
      callbackUrl: 'http://127.0.0.1:51733/cb',
    })
    expect(attempt.authBase).toBe(ORCAROUTER_DEFAULT_AUTH_BASE)
    expect(attempt.apiBase).toBe(ORCAROUTER_DEFAULT_API_BASE)
    expect(attempt.exchangeUrl).toBe(`https://www.orcarouter.ai${ORCAROUTER_EXCHANGE_PATH}`)
    expect(attempt.exchangeUrl).not.toContain('api.orcarouter.ai')
    // The documented anti-pattern: the exchange must not live under the
    // inference origin's `/v1` prefix.
    expect(attempt.exchangeUrl.startsWith('https://api.orcarouter.ai/v1')).toBe(false)
    expect(ORCAROUTER_EXCHANGE_PATH.startsWith('/v1/')).toBe(false)
  })

  it('honours explicit per-origin overrides and rejects plain HTTP on remote hosts', () => {
    const origins = resolveOrcaRouterOrigins({
      ORCA_BASE_URL: 'https://self-hosted.example.com',
      ORCA_AUTH_BASE_URL: 'https://auth.example.com',
      ORCA_API_BASE_URL: 'https://inference.example.com',
    } as NodeJS.ProcessEnv)
    expect(origins).toEqual({
      authBase: 'https://auth.example.com',
      apiBase: 'https://inference.example.com',
    })
    const shared = resolveOrcaRouterOrigins({ ORCA_BASE_URL: 'https://shared.example.com' } as NodeJS.ProcessEnv)
    expect(shared).toEqual({
      authBase: 'https://shared.example.com',
      apiBase: 'https://shared.example.com',
    })
    const loopback = resolveOrcaRouterOrigins({ ORCA_BASE_URL: 'http://127.0.0.1:9000' } as NodeJS.ProcessEnv)
    expect(loopback.apiBase).toBe('http://127.0.0.1:9000')
    expect(() => resolveOrcaRouterOrigins({ ORCA_BASE_URL: 'http://orcarouter.ai' } as NodeJS.ProcessEnv))
      .toThrow(/HTTPS/)
    expect(() => resolveOrcaRouterOrigins({ ORCA_API_BASE_URL: 'https://u:p@api.orcarouter.ai' } as NodeJS.ProcessEnv))
      .toThrow(/credentials/)
  })
})

describe('OrcaRouter code exchange', () => {
  it('POSTs the code and verifier to /api/v1/auth/keys on the auth origin', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ key: FAKE_KEY, scope: 'api', user_id: 'user-1' }))
    const result = await exchangeOrcaRouterCode({
      exchangeUrl: `https://www.orcarouter.ai${ORCAROUTER_EXCHANGE_PATH}`,
      code: 'auth-code',
      verifier: 'verifier-value',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://www.orcarouter.ai/api/v1/auth/keys')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      code: 'auth-code',
      code_verifier: 'verifier-value',
      code_challenge_method: 'S256',
    })
    expect(result).toEqual({ apiKey: FAKE_KEY, scope: 'api', userId: 'user-1' })
  })

  it('reads back the granted scope rather than assuming the requested one', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ key: FAKE_KEY, scope: 'api read:models', user_id: 'u' }))
    const result = await exchangeOrcaRouterCode({
      exchangeUrl: 'https://www.orcarouter.ai/api/v1/auth/keys',
      code: 'c',
      verifier: 'v',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.scope).toBe('api read:models')
  })

  it('classifies 400 as a challenge rejection, 403 as a spent code, and 429 as retryable', async () => {
    const cases: Array<[number, string, boolean]> = [
      [400, 'ORCAROUTER_EXCHANGE_CHALLENGE_REJECTED', false],
      [403, 'ORCAROUTER_EXCHANGE_CODE_REJECTED', false],
      [429, 'ORCAROUTER_EXCHANGE_RATE_LIMITED', true],
      [500, 'ORCAROUTER_EXCHANGE_FAILED', true],
    ]
    for (const [status, code, retryable] of cases) {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, status))
      await expect(exchangeOrcaRouterCode({
        exchangeUrl: 'https://www.orcarouter.ai/api/v1/auth/keys',
        code: 'spent-code',
        verifier: 'verifier-value',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })).rejects.toMatchObject({ code, retryable, status })
    }
  })

  it('reports a network failure as retryable and never leaks the verifier in the message', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    let caught: unknown
    try {
      await exchangeOrcaRouterCode({
        exchangeUrl: 'https://www.orcarouter.ai/api/v1/auth/keys',
        code: 'auth-code',
        verifier: 'super-secret-verifier',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(OrcaRouterPkceError)
    expect(caught).toMatchObject({ code: 'ORCAROUTER_EXCHANGE_NETWORK', retryable: true })
    expect((caught as Error).message).not.toContain('super-secret-verifier')
    expect((caught as Error).message).not.toContain('auth-code')
  })

  it('does not echo a credential-shaped value from a failed exchange body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error_description: 'bad code' }, 403))
    let caught: Error | null = null
    try {
      await exchangeOrcaRouterCode({
        exchangeUrl: 'https://www.orcarouter.ai/api/v1/auth/keys',
        code: 'auth-code',
        verifier: 'verifier-value',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    } catch (err) {
      caught = err as Error
    }
    expect(caught?.message).toContain('bad code')
    expect(caught?.message).not.toContain('verifier-value')
  })

  it('fails closed when the exchange returns no key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ scope: 'api' }))
    await expect(exchangeOrcaRouterCode({
      exchangeUrl: 'https://www.orcarouter.ai/api/v1/auth/keys',
      code: 'auth-code',
      verifier: 'verifier-value',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'ORCAROUTER_EXCHANGE_EMPTY_KEY' })
  })

  it('rejects a scope downgrade instead of treating the requested scope as granted', () => {
    expect(() => assertOrcaRouterScopeGranted('api')).not.toThrow()
    expect(() => assertOrcaRouterScopeGranted('read:models api')).not.toThrow()
    expect(() => assertOrcaRouterScopeGranted('read:models')).toThrow(/does not include/)
    expect(() => assertOrcaRouterScopeGranted('')).toThrow(/does not include/)
    try {
      assertOrcaRouterScopeGranted('')
    } catch (err) {
      expect(err).toMatchObject({ code: 'ORCAROUTER_SCOPE_DOWNGRADED' })
    }
  })
})
