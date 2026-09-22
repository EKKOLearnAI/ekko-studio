import { createServer, type Server } from 'http'
import { randomUUID } from 'crypto'

import { logger } from '../../studio/public/logging'
import {
  ORCAROUTER_APP_NAME,
  ORCAROUTER_KEY_DASHBOARD_URL,
  ORCAROUTER_OAUTH_PROVIDER,
  ORCAROUTER_SCOPE,
} from '../../studio/public/orcarouter-catalog'
import { getActiveProfileName } from '../services/profiles/profile'
import {
  OrcaRouterPkceError,
  assertOrcaRouterScopeGranted,
  exchangeOrcaRouterCode,
  startOrcaRouterPkceAttempt,
  statesMatch,
  type OrcaRouterCallbackMode,
} from '../services/providers/orcarouter-pkce'
import {
  inspectOrcaRouterCredential,
  orcaRouterPkceAdapter,
  redactOrcaRouterKey,
  type OrcaRouterCredential,
} from '../services/providers/orcarouter-credential'

/**
 * OrcaRouter OAuth 2.0 + PKCE connect flow.
 *
 * Flow A (loopback redirect) is the default: Ekko Studio runs on the user's own
 * machine, so the server can bind 127.0.0.1 and the browser delivers the code
 * automatically. Flow B (out-of-band) is available for deployments whose
 * loopback address the user's browser cannot reach — the consent screen shows
 * the code and the user pastes it back.
 */

const CALLBACK_BIND_HOST = process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_BIND_HOST?.trim() || '127.0.0.1'
/** Preferred loopback port; `0` asks the OS for a free one. */
const CALLBACK_PORT = (() => {
  const raw = Number(process.env.HERMES_WEB_UI_ORCAROUTER_CALLBACK_PORT)
  return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : 51733
})()
const CALLBACK_PATH = '/cb'
const SESSION_TTL_MS = 15 * 60 * 1000

type OrcaRouterSessionStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'error'

interface OrcaRouterSession {
  id: string
  profile: string
  status: OrcaRouterSessionStatus
  authorizeUrl: string
  verifier: string
  state: string
  exchangeUrl: string
  apiBase: string
  callbackMode: OrcaRouterCallbackMode
  server: Server | null
  error?: string
  errorCode?: string
  /** Monotonic attempt counter; a stale callback must not settle a newer attempt. */
  generation: number
  accountId?: string
  createdAt: number
}

const sessions = new Map<string, OrcaRouterSession>()

function closeServer(session: OrcaRouterSession): void {
  try { session.server?.close() } catch { /* already closed */ }
  session.server = null
}

export function resetOrcaRouterSessions(): void {
  sessions.forEach(closeServer)
  sessions.clear()
}

function cleanupExpiredSessions(now = Date.now()): void {
  sessions.forEach((session, id) => {
    if (now - session.createdAt > SESSION_TTL_MS + 60_000) {
      closeServer(session)
      sessions.delete(id)
    }
  })
}

function requestedProfile(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    String(headerProfile || '').trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

function startCallbackServer(sessionId: string, preferredPort = CALLBACK_PORT): Promise<{ server: Server; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const session = sessions.get(sessionId)
      const url = new URL(req.url || '/', `http://${CALLBACK_BIND_HOST}`)
      if (!session || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not found.')
        return
      }
      // Serve the browser a closing page first so the user is never left
      // staring at a blank window while the exchange runs.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>OrcaRouter authorization received.</h1>You can close this tab and return to Ekko Studio.</body></html>')

      void (async () => {
        const generation = session.generation
        try {
          const error = url.searchParams.get('error')
          if (error) {
            throw new OrcaRouterPkceError(
              String(url.searchParams.get('error_description') || error),
              'ORCAROUTER_AUTHORIZE_DENIED',
            )
          }
          // Compare state before doing anything else: it is the only thing
          // standing between this listener and a code somebody else dropped here.
          if (!statesMatch(session.state, url.searchParams.get('state'))) {
            throw new OrcaRouterPkceError(
              'OrcaRouter callback state did not match this login attempt',
              'ORCAROUTER_STATE_MISMATCH',
            )
          }
          const code = String(url.searchParams.get('code') || '').trim()
          if (!code) {
            throw new OrcaRouterPkceError('OrcaRouter callback carried no authorization code', 'ORCAROUTER_CODE_MISSING')
          }
          await completeExchange(session, code, generation)
        } catch (err: any) {
          if (sessions.get(sessionId) !== session || session.generation !== generation) return
          failSession(session, err)
        } finally {
          closeServer(session)
        }
      })()
    })
    server.once('error', (err: any) => {
      if (preferredPort !== 0 && err?.code === 'EADDRINUSE') {
        startCallbackServer(sessionId, 0).then(resolve, reject)
      } else {
        reject(err)
      }
    })
    server.listen(preferredPort, CALLBACK_BIND_HOST, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : preferredPort
      resolve({ server, redirectUri: `http://${CALLBACK_BIND_HOST}:${port}${CALLBACK_PATH}` })
    })
  })
}

async function completeExchange(session: OrcaRouterSession, code: string, generation: number): Promise<void> {
  const result = await exchangeOrcaRouterCode({
    exchangeUrl: session.exchangeUrl,
    code,
    verifier: session.verifier,
  })
  // Never treat the requested scope as the granted scope.
  assertOrcaRouterScopeGranted(result.scope)
  if (sessions.get(session.id) !== session || session.generation !== generation) return
  const credential: OrcaRouterCredential = {
    source: 'oauth-pkce',
    apiKey: result.apiKey,
    baseUrl: session.apiBase,
    scope: result.scope,
    accountId: result.userId,
  }
  await orcaRouterPkceAdapter.save(session.profile, credential)
  if (sessions.get(session.id) !== session || session.generation !== generation) return
  session.status = 'approved'
  session.accountId = result.userId
  logger.info(
    '[orcarouter] PKCE connect succeeded profile=%s key=%s scope=%s',
    session.profile,
    redactOrcaRouterKey(result.apiKey),
    result.scope,
  )
}

function failSession(session: OrcaRouterSession, err: unknown): void {
  const pkceError = err instanceof OrcaRouterPkceError ? err : null
  session.status = pkceError?.code === 'ORCAROUTER_AUTHORIZE_DENIED' ? 'denied' : 'error'
  session.errorCode = pkceError?.code || 'ORCAROUTER_CONNECT_FAILED'
  // The message must never carry the verifier or the key.
  session.error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
  logger.warn('[orcarouter] PKCE connect failed profile=%s code=%s', session.profile, session.errorCode)
}

function sessionPayload(session: OrcaRouterSession): Record<string, unknown> {
  return {
    status: session.status,
    error: session.error || null,
    error_code: session.errorCode || null,
    callback_mode: session.callbackMode,
  }
}

export async function start(ctx: any): Promise<void> {
  try {
    cleanupExpiredSessions()
    const body = ctx.request?.body && typeof ctx.request.body === 'object' ? ctx.request.body : {}
    const profile = requestedProfile(ctx)
    const requestedMode = String(body.callback_mode || '').trim()
    const callbackMode: OrcaRouterCallbackMode = requestedMode === 'oob' ? 'oob' : 'loopback'
    const sessionId = randomUUID()

    let server: Server | null = null
    let redirectUri = ''
    if (callbackMode === 'loopback') {
      const started = await startCallbackServer(sessionId)
      server = started.server
      redirectUri = started.redirectUri
    }

    const attempt = startOrcaRouterPkceAttempt({
      callbackMode,
      callbackUrl: redirectUri,
      appName: ORCAROUTER_APP_NAME,
    })
    const session: OrcaRouterSession = {
      id: sessionId,
      profile,
      status: 'pending',
      authorizeUrl: attempt.authorizeUrl,
      verifier: attempt.verifier,
      state: attempt.state,
      exchangeUrl: attempt.exchangeUrl,
      apiBase: attempt.apiBase,
      callbackMode,
      server,
      generation: 1,
      createdAt: Date.now(),
    }
    sessions.set(sessionId, session)
    ctx.body = {
      session_id: sessionId,
      authorization_url: attempt.authorizeUrl,
      callback_mode: callbackMode,
      expires_in: Math.floor(SESSION_TTL_MS / 1000),
      scope: ORCAROUTER_SCOPE,
      key_dashboard_url: ORCAROUTER_KEY_DASHBOARD_URL,
    }
  } catch (err: any) {
    ctx.status = err instanceof OrcaRouterPkceError ? 400 : 500
    ctx.body = {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      code: err instanceof OrcaRouterPkceError ? err.code : 'ORCAROUTER_START_FAILED',
    }
  }
}

/** Flow B: the user pastes the code the consent screen displayed. */
export async function submit(ctx: any): Promise<void> {
  const session = sessions.get(String(ctx.params.sessionId || ''))
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found', code: 'ORCAROUTER_SESSION_MISSING' }
    return
  }
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    session.status = 'expired'
    closeServer(session)
    ctx.status = 410
    ctx.body = { error: 'Authorization window closed', code: 'ORCAROUTER_SESSION_EXPIRED' }
    return
  }
  const code = String(ctx.request?.body?.code || '').trim()
  if (!code) {
    ctx.status = 400
    ctx.body = { error: 'Authorization code is required', code: 'ORCAROUTER_CODE_MISSING' }
    return
  }
  const generation = session.generation
  try {
    await completeExchange(session, code, generation)
    closeServer(session)
    ctx.body = sessionPayload(session)
  } catch (err: any) {
    failSession(session, err)
    closeServer(session)
    ctx.status = 400
    ctx.body = { ...sessionPayload(session), error: session.error }
  }
}

export async function poll(ctx: any): Promise<void> {
  const session = sessions.get(String(ctx.params.sessionId || ''))
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found', code: 'ORCAROUTER_SESSION_MISSING' }
    return
  }
  if (session.status === 'pending' && Date.now() - session.createdAt > SESSION_TTL_MS) {
    session.status = 'expired'
    closeServer(session)
  }
  ctx.body = sessionPayload(session)
}

/**
 * Explicit cancel. The client calls this from its Cancel button and from the
 * `pagehide` handler (with `keepalive`) so a back-forward-cache restore does
 * not leave the login lock held.
 */
export async function cancel(ctx: any): Promise<void> {
  const session = sessions.get(String(ctx.params.sessionId || ''))
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found', code: 'ORCAROUTER_SESSION_MISSING' }
    return
  }
  // Bump the generation first so an in-flight exchange cannot settle this
  // attempt after the user cancelled it.
  session.generation += 1
  closeServer(session)
  sessions.delete(session.id)
  ctx.body = { status: 'cancelled' }
}

export async function status(ctx: any): Promise<void> {
  const profile = requestedProfile(ctx)
  const inspection = await inspectOrcaRouterCredential(profile, ORCAROUTER_OAUTH_PROVIDER)
  const credential = inspection.credential
  if (credential) {
    ctx.body = {
      authenticated: true,
      source: credential.source,
      scope: credential.scope || null,
      key_preview: redactOrcaRouterKey(credential.apiKey),
    }
    return
  }
  ctx.body = {
    authenticated: false,
    relogin_required: true,
    source: 'oauth-pkce',
    ...(inspection.needsReauth ? { needs_reauth: true } : {}),
    ...(inspection.errorCode ? { error_code: inspection.errorCode } : {}),
  }
}

export { ORCAROUTER_OAUTH_PROVIDER }
