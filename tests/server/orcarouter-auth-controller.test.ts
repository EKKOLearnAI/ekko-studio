import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const FAKE_KEY = 'sk-orca-controller-fixture-0000000000'
const CALLBACK_BIND = '127.0.0.1'

let hermesHome = ''
let controller: { resetOrcaRouterSessions: () => void } | null = null
const originalHermesHome = process.env.HERMES_HOME
const originalBind = process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_BIND_HOST
const originalPort = process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_PORT

function profileDir(profile: string): string {
  return profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
}

function makeCtx(body: Record<string, unknown> = {}, params: Record<string, unknown> = {}): any {
  return {
    params,
    query: {},
    request: { body },
    state: { profile: { name: 'default' } },
    get: () => '',
    set: () => {},
    status: 200,
    body: undefined,
  }
}

async function loadController() {
  await import('../../packages/server/src/bootstrap/agent-profile-adapter')
  const mod = await import('../../packages/server/src/modules/hermes/controllers/orcarouter-auth')
  // Track the instance so afterEach can close this test's loopback listeners;
  // a leaked listener would answer the *next* test's callback.
  controller = mod
  return mod
}

/**
 * Minimal fake OrcaRouter authorization server. It records the exact request it
 * receives so the test can assert the exchange never carries the verifier and
 * always targets the documented auth-origin path.
 */
function fakeAuthServer(options: { status?: number; body?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; body: any; headers: any }> = []
  const realFetch = globalThis.fetch
  const impl = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input)
    // Only the exchange goes to OrcaRouter. The loopback callback is a local
    // HTTP request and must reach the real listener, not this stub.
    if (!url.startsWith('https://www.orcarouter.ai')) return realFetch(input, init)
    calls.push({ url, body: JSON.parse(String(init.body || '{}')), headers: init.headers || {} })
    return new Response(JSON.stringify(options.body ?? {
      key: FAKE_KEY,
      scope: 'api',
      user_id: 'user-77',
    }), { status: options.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  return { impl, calls }
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'orcarouter-controller-'))
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_BIND_HOST = CALLBACK_BIND
  // Ephemeral port: a fixed one would collide across test files and with a
  // developer's running instance.
  process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_PORT = '0'
  delete process.env.ORCAROUTER_API_KEY
  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(join(hermesHome, 'config.yaml'), 'model:\n  provider: orcarouter\n  default: openai/gpt-5.5\n')
  vi.resetModules()
})

afterEach(async () => {
  controller?.resetOrcaRouterSessions()
  controller = null
  vi.unstubAllGlobals()
  vi.resetModules()
  rmSync(hermesHome, { recursive: true, force: true })
  delete process.env.ORCAROUTER_API_KEY
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalBind === undefined) delete process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_BIND_HOST
  else process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_BIND_HOST = originalBind
  if (originalPort === undefined) delete process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_PORT
  else process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_PORT = originalPort
})

describe('OrcaRouter connect controller', () => {
  it('starts a loopback session that points at the auth origin and never leaks the verifier', async () => {
    const { start } = await loadController()
    const ctx = makeCtx({ callback_mode: 'loopback' })
    await start(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.session_id).toBeTruthy()
    expect(ctx.body.callback_mode).toBe('loopback')
    const authorize = new URL(ctx.body.authorization_url)
    expect(authorize.origin).toBe('https://www.orcarouter.ai')
    expect(authorize.pathname).toBe('/auth')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('callback_url')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cb$/)
    const challenge = authorize.searchParams.get('code_challenge') || ''
    expect(challenge.length).toBeGreaterThan(20)
    // The verifier is never returned to the client — only its hash is, inside
    // the authorize URL the browser will use.
    const verifierShaped = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?:$|[^A-Za-z0-9_-])/.exec(
      JSON.stringify({ ...ctx.body, authorization_url: '' }),
    )
    expect(verifierShaped).toBeNull()
  })

  it('completes authorize -> loopback callback -> exchange -> persist with a fake auth server', async () => {
    const auth = fakeAuthServer()
    vi.stubGlobal('fetch', auth.impl)
    const { start, poll, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'loopback' })
    await start(startCtx)
    const authorize = new URL(startCtx.body.authorization_url)
    const callbackUrl = authorize.searchParams.get('callback_url')!
    const state = authorize.searchParams.get('state')!

    const pending = makeCtx({}, { sessionId: startCtx.body.session_id })
    await poll(pending)
    expect(pending.body.status).toBe('pending')

    // The fake consent screen "approves" by hitting the loopback callback.
    const callback = await fetch(`${callbackUrl}?code=fake-auth-code&state=${encodeURIComponent(state)}`)
    expect(callback.status).toBe(200)
    await vi.waitFor(() => expect(auth.calls.length).toBe(1))

    expect(auth.calls[0].url).toBe('https://www.orcarouter.ai/api/v1/auth/keys')
    // The documented anti-pattern is the exchange under the inference origin's
    // `/v1` prefix; the correct path is under the auth origin.
    expect(auth.calls[0].url.startsWith('https://api.orcarouter.ai/v1')).toBe(false)
    expect(auth.calls[0].body).toMatchObject({
      code: 'fake-auth-code',
      code_challenge_method: 'S256',
    })
    expect(typeof auth.calls[0].body.code_verifier).toBe('string')
    expect(JSON.stringify(auth.calls[0].headers)).not.toContain(auth.calls[0].body.code_verifier)

    await vi.waitFor(async () => {
      const settled = makeCtx({}, { sessionId: startCtx.body.session_id })
      await poll(settled)
      expect(settled.body.status).toBe('approved')
    })

    const auth_json = JSON.parse(readFileSync(join(profileDir('default'), 'auth.json'), 'utf8'))
    expect(auth_json.providers['orcarouter-oauth']).toMatchObject({
      api_key: FAKE_KEY,
      auth_mode: 'oauth_pkce',
      scope: 'api',
      account_id: 'user-77',
    })
  })

  it('rejects a callback whose state does not match the attempt', async () => {
    const auth = fakeAuthServer()
    vi.stubGlobal('fetch', auth.impl)
    const { start, poll, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'loopback' })
    await start(startCtx)
    const callbackUrl = new URL(startCtx.body.authorization_url).searchParams.get('callback_url')!

    await fetch(`${callbackUrl}?code=fake-auth-code&state=not-the-state`)
    await vi.waitFor(async () => {
      const settled = makeCtx({}, { sessionId: startCtx.body.session_id })
      await poll(settled)
      expect(settled.body.status).toBe('error')
      expect(settled.body.error_code).toBe('ORCAROUTER_STATE_MISMATCH')
    })
    // A mismatched state must never reach the exchange.
    expect(auth.calls.length).toBe(0)
    expect(() => readFileSync(join(profileDir('default'), 'auth.json'), 'utf8')).toThrow()
  })

  it('reports a denied consent screen as denied and persists nothing', async () => {
    const auth = fakeAuthServer()
    vi.stubGlobal('fetch', auth.impl)
    const { start, poll, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'loopback' })
    await start(startCtx)
    const callbackUrl = new URL(startCtx.body.authorization_url).searchParams.get('callback_url')!

    await fetch(`${callbackUrl}?error=access_denied&error_description=user+said+no`)
    await vi.waitFor(async () => {
      const settled = makeCtx({}, { sessionId: startCtx.body.session_id })
      await poll(settled)
      expect(settled.body.status).toBe('denied')
      expect(settled.body.error_code).toBe('ORCAROUTER_AUTHORIZE_DENIED')
    })
    expect(auth.calls.length).toBe(0)
    expect(() => readFileSync(join(profileDir('default'), 'auth.json'), 'utf8')).toThrow()
  })

  it('completes the out-of-band flow when the user pastes the code', async () => {
    const auth = fakeAuthServer()
    vi.stubGlobal('fetch', auth.impl)
    const { start, submit, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'oob' })
    await start(startCtx)
    expect(startCtx.body.callback_mode).toBe('oob')
    expect(new URL(startCtx.body.authorization_url).searchParams.get('callback_url')).toBe('oob')

    const submitCtx = makeCtx({ code: 'oob-code' }, { sessionId: startCtx.body.session_id })
    await submit(submitCtx)
    expect(submitCtx.body.status).toBe('approved')
    expect(auth.calls[0].url).toBe('https://www.orcarouter.ai/api/v1/auth/keys')

    const auth_json = JSON.parse(readFileSync(join(profileDir('default'), 'auth.json'), 'utf8'))
    expect(auth_json.providers['orcarouter-oauth'].api_key).toBe(FAKE_KEY)
  })

  it('classifies a reused or expired code as terminal and never retries it', async () => {
    const auth = fakeAuthServer({ status: 403, body: { error: 'invalid_grant' } })
    vi.stubGlobal('fetch', auth.impl)
    const { start, submit, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'oob' })
    await start(startCtx)
    const submitCtx = makeCtx({ code: 'spent-code' }, { sessionId: startCtx.body.session_id })
    await submit(submitCtx)

    expect(submitCtx.status).toBe(400)
    expect(submitCtx.body.error_code).toBe('ORCAROUTER_EXCHANGE_CODE_REJECTED')
    expect(auth.calls.length).toBe(1)
    expect(() => readFileSync(join(profileDir('default'), 'auth.json'), 'utf8')).toThrow()
  })

  it('classifies a rate-limited exchange as retryable without persisting a key', async () => {
    const auth = fakeAuthServer({ status: 429, body: { error: 'too_many_requests' } })
    vi.stubGlobal('fetch', auth.impl)
    const { start, submit, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'oob' })
    await start(startCtx)
    const submitCtx = makeCtx({ code: 'code' }, { sessionId: startCtx.body.session_id })
    await submit(submitCtx)
    expect(submitCtx.body.error_code).toBe('ORCAROUTER_EXCHANGE_RATE_LIMITED')
    expect(submitCtx.body.status).toBe('error')
  })

  it('surfaces a scope downgrade instead of accepting a narrower grant', async () => {
    const auth = fakeAuthServer({ body: { key: FAKE_KEY, scope: 'read:models', user_id: 'u' } })
    vi.stubGlobal('fetch', auth.impl)
    const { start, submit, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'oob' })
    await start(startCtx)
    const submitCtx = makeCtx({ code: 'code' }, { sessionId: startCtx.body.session_id })
    await submit(submitCtx)
    expect(submitCtx.body.error_code).toBe('ORCAROUTER_SCOPE_DOWNGRADED')
    expect(() => readFileSync(join(profileDir('default'), 'auth.json'), 'utf8')).toThrow()
  })

  it('cancels an in-flight attempt and refuses to settle it afterwards', async () => {
    let resolveExchange: ((value: Response) => void) | null = null
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { resolveExchange = resolve })))
    const { start, submit, cancel, poll, resetOrcaRouterSessions } = await loadController()
    resetOrcaRouterSessions()

    const startCtx = makeCtx({ callback_mode: 'oob' })
    await start(startCtx)
    const sessionId = startCtx.body.session_id

    const submitCtx = makeCtx({ code: 'slow-code' }, { sessionId })
    const submitting = submit(submitCtx)
    await vi.waitFor(() => expect(resolveExchange).toBeTruthy())

    const cancelCtx = makeCtx({}, { sessionId })
    await cancel(cancelCtx)
    expect(cancelCtx.body.status).toBe('cancelled')

    resolveExchange!(new Response(JSON.stringify({ key: FAKE_KEY, scope: 'api' }), { status: 200 }))
    await submitting

    const after = makeCtx({}, { sessionId })
    await poll(after)
    expect(after.status).toBe(404)
    expect(() => readFileSync(join(profileDir('default'), 'auth.json'), 'utf8')).toThrow()
  })

  it('rejects an expired session instead of exchanging a stale code', async () => {
    vi.useFakeTimers()
    try {
      const auth = fakeAuthServer()
      vi.stubGlobal('fetch', auth.impl)
      const { start, submit, resetOrcaRouterSessions } = await loadController()
      resetOrcaRouterSessions()

      const startCtx = makeCtx({ callback_mode: 'oob' })
      await start(startCtx)
      vi.setSystemTime(Date.now() + 16 * 60 * 1000)
      const submitCtx = makeCtx({ code: 'stale' }, { sessionId: startCtx.body.session_id })
      await submit(submitCtx)
      expect(submitCtx.status).toBe(410)
      expect(submitCtx.body.code).toBe('ORCAROUTER_SESSION_EXPIRED')
      expect(auth.calls.length).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports status from the stored PKCE key without exposing it', async () => {
    writeFileSync(join(profileDir('default'), 'auth.json'), JSON.stringify({
      providers: { 'orcarouter-oauth': { api_key: FAKE_KEY, auth_mode: 'oauth_pkce', scope: 'api' } },
      credential_pool: { 'orcarouter-oauth': [{ api_key: FAKE_KEY, auth_type: 'oauth' }] },
    }))
    const { status } = await loadController()
    const ctx = makeCtx()
    await status(ctx)
    expect(ctx.body).toMatchObject({ authenticated: true, source: 'oauth-pkce', scope: 'api' })
    expect(ctx.body.key_preview).not.toBe(FAKE_KEY)
    expect(JSON.stringify(ctx.body)).not.toContain(FAKE_KEY.slice(11, -4))
  })

  it('flags a rejected durable key as needing reauthentication rather than a silent logout', async () => {
    writeFileSync(join(profileDir('default'), 'auth.json'), JSON.stringify({
      providers: { 'orcarouter-oauth': { api_key: 'not-a-key', auth_mode: 'oauth_pkce', scope: 'api' } },
      credential_pool: { 'orcarouter-oauth': [{ api_key: 'not-a-key', auth_type: 'oauth' }] },
    }))
    const { status } = await loadController()
    const ctx = makeCtx()
    await status(ctx)
    expect(ctx.body.authenticated).toBe(false)
    expect(ctx.body.relogin_required).toBe(true)
  })
})
