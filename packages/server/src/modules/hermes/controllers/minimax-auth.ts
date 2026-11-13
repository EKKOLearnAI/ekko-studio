import { createHash, randomBytes, randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { updateConfigYamlForProfile } from '../../studio/public/profile-config'
import { logger } from '../../studio/public/logging'
import { resolveAuthorizedProviderRuntimeCredentials } from '../services/providers/authorized-provider-credentials'

const MINIMAX_PROVIDER = 'minimax-oauth'
const MINIMAX_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113'
const MINIMAX_SCOPE = 'group_id profile model.completion'
const MINIMAX_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:user_code'
const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3'
const POLL_MAX_DURATION_MS = 15 * 60 * 1000

const REGIONS = {
  global: {
    portalBaseUrl: 'https://api.minimax.io',
    inferenceBaseUrl: 'https://api.minimax.io/anthropic',
  },
  cn: {
    portalBaseUrl: 'https://api.minimaxi.com',
    inferenceBaseUrl: 'https://api.minimaxi.com/anthropic',
  },
} as const

type MiniMaxRegion = keyof typeof REGIONS

interface MiniMaxSession {
  id: string
  profile: string
  region: MiniMaxRegion
  portalBaseUrl: string
  inferenceBaseUrl: string
  userCode: string
  verificationUrl: string
  codeVerifier: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  createdAt: number
  deadlineAt: number
  intervalMs: number
  error?: string
}

interface AuthJson {
  version?: number
  active_provider?: string
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
  updated_at?: string
}

const sessions = new Map<string, MiniMaxSession>()

function requestedProfile(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    headerProfile.trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

function loadAuthJson(authPath: string): AuthJson {
  try { return JSON.parse(readFileSync(authPath, 'utf8')) as AuthJson } catch { return { version: 1 } }
}

function saveAuthJson(authPath: string, auth: AuthJson): void {
  auth.updated_at = new Date().toISOString()
  const parent = dirname(authPath)
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
  writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n', { mode: 0o600 })
}

function base64Url(input: Buffer): string {
  return input.toString('base64url')
}

function resolveDeadlineMs(expiredIn: unknown, now = Date.now()): number {
  const raw = Number(expiredIn)
  if (!Number.isFinite(raw) || raw <= 0) return now + POLL_MAX_DURATION_MS
  return raw > now / 2 ? raw : now + raw * 1000
}

function cleanupExpiredSessions(): void {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now > session.deadlineAt + 60_000) sessions.delete(id)
  }
}

export function applyMiniMaxOAuthDefaultModel(config: Record<string, any>): Record<string, any> {
  if (typeof config.model !== 'object' || config.model === null) config.model = {}
  const currentDefault = String(config.model.default || '').trim()
  config.model.provider = MINIMAX_PROVIDER
  config.model.default = currentDefault.toLowerCase().startsWith('minimax-')
    ? currentDefault
    : MINIMAX_DEFAULT_MODEL
  delete config.model.base_url
  delete config.model.api_key
  return config
}

export async function saveMiniMaxOAuthTokensForProfile(
  profile: string,
  session: Pick<MiniMaxSession, 'region' | 'portalBaseUrl' | 'inferenceBaseUrl'>,
  tokenData: Record<string, any>,
): Promise<void> {
  const accessToken = String(tokenData.access_token || '').trim()
  const refreshToken = String(tokenData.refresh_token || '').trim()
  if (!accessToken || !refreshToken) {
    throw new Error('MiniMax OAuth response missing access_token or refresh_token')
  }

  const now = new Date()
  const expiresAtMs = resolveDeadlineMs(tokenData.expired_in, now.getTime())
  const providerState = {
    provider: MINIMAX_PROVIDER,
    region: session.region,
    portal_base_url: session.portalBaseUrl,
    inference_base_url: session.inferenceBaseUrl,
    client_id: MINIMAX_CLIENT_ID,
    scope: MINIMAX_SCOPE,
    token_type: String(tokenData.token_type || 'Bearer'),
    access_token: accessToken,
    refresh_token: refreshToken,
    resource_url: tokenData.resource_url,
    obtained_at: now.toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
    expires_in: Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000)),
  }

  const authPath = join(getProfileDir(profile), 'auth.json')
  const auth = loadAuthJson(authPath)
  if (!auth.providers) auth.providers = {}
  auth.providers[MINIMAX_PROVIDER] = providerState
  // Match Hermes Agent's own MiniMax login storage. The runtime seeds its
  // managed credential-pool entry from providers.minimax-oauth, so writing a
  // second static pool row here would bypass proactive token refresh.
  auth.active_provider = MINIMAX_PROVIDER
  saveAuthJson(authPath, auth)
  await updateConfigYamlForProfile(profile, applyMiniMaxOAuthDefaultModel)
}

async function pollLogin(session: MiniMaxSession): Promise<void> {
  while (Date.now() < session.deadlineAt && session.status === 'pending') {
    await new Promise(resolve => setTimeout(resolve, session.intervalMs))
    if (session.status !== 'pending') return
    try {
      const response = await fetch(`${session.portalBaseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: MINIMAX_GRANT_TYPE,
          client_id: MINIMAX_CLIENT_ID,
          user_code: session.userCode,
          code_verifier: session.codeVerifier,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      const payload = await response.json().catch(() => ({})) as Record<string, any>
      if (!response.ok) {
        const detail = payload.base_resp?.status_msg || `HTTP ${response.status}`
        throw new Error(`MiniMax OAuth token exchange failed: ${detail}`)
      }
      if (payload.status === 'pending') continue
      if (payload.status !== 'success') {
        throw new Error('MiniMax OAuth authorization was denied')
      }
      await saveMiniMaxOAuthTokensForProfile(session.profile, session, payload)
      session.status = 'approved'
      return
    } catch (err: any) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') continue
      logger.error(err, 'MiniMax OAuth polling failed')
      session.status = 'error'
      session.error = err?.message || String(err)
      return
    }
  }
  if (session.status === 'pending') session.status = 'expired'
}

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const requestedRegion = String(ctx.request?.body?.region || 'global').trim().toLowerCase()
    const region: MiniMaxRegion = requestedRegion === 'cn' ? 'cn' : 'global'
    const endpoints = REGIONS[region]
    const codeVerifier = base64Url(randomBytes(64)).slice(0, 96)
    const codeChallenge = base64Url(createHash('sha256').update(codeVerifier).digest())
    const state = base64Url(randomBytes(16))
    const response = await fetch(`${endpoints.portalBaseUrl}/oauth/code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'x-request-id': randomUUID(),
      },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: MINIMAX_CLIENT_ID,
        scope: MINIMAX_SCOPE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => ({})) as Record<string, any>
    if (!response.ok) {
      throw new Error(`MiniMax OAuth authorization failed: ${payload.base_resp?.status_msg || response.status}`)
    }
    if (!payload.user_code || !payload.verification_uri || !payload.expired_in) {
      throw new Error('MiniMax OAuth response is incomplete')
    }
    if (payload.state !== state) throw new Error('MiniMax OAuth state mismatch')

    const sessionId = randomUUID()
    const session: MiniMaxSession = {
      id: sessionId,
      profile: requestedProfile(ctx),
      region,
      portalBaseUrl: endpoints.portalBaseUrl,
      inferenceBaseUrl: endpoints.inferenceBaseUrl,
      userCode: String(payload.user_code),
      verificationUrl: String(payload.verification_uri),
      codeVerifier,
      status: 'pending',
      createdAt: Date.now(),
      deadlineAt: resolveDeadlineMs(payload.expired_in),
      intervalMs: Math.max(2_000, Number(payload.interval || 2_000)),
    }
    sessions.set(sessionId, session)
    void pollLogin(session)
    ctx.body = {
      session_id: sessionId,
      user_code: session.userCode,
      verification_url: session.verificationUrl,
      expires_in: Math.max(1, Math.floor((session.deadlineAt - Date.now()) / 1000)),
    }
  } catch (err: any) {
    logger.error(err, 'MiniMax OAuth start failed')
    ctx.status = 502
    ctx.body = { error: err?.message || String(err) }
  }
}

export async function poll(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (Date.now() >= session.deadlineAt && session.status === 'pending') session.status = 'expired'
  ctx.body = { status: session.status, error: session.error || null }
}

export async function status(ctx: any) {
  try {
    const credentials = await resolveAuthorizedProviderRuntimeCredentials({
      profile: requestedProfile(ctx),
      provider: MINIMAX_PROVIDER,
    })
    ctx.body = {
      authenticated: true,
      expires_at: credentials.expiresAt,
    }
  } catch (err: any) {
    ctx.body = { authenticated: false, relogin_required: err?.reloginRequired === true }
  }
}
