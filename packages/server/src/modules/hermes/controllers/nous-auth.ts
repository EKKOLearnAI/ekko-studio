import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { logger } from '../../studio/public/logging'
import { resolveAuthorizedProviderRuntimeCredentials } from '../services/providers/authorized-provider-credentials'

// --- Nous Portal OAuth Constants ---
const NOUS_PORTAL_URL = 'https://portal.nousresearch.com'
const NOUS_CLIENT_ID = 'hermes-cli'
const NOUS_SCOPE = 'inference:mint_agent_key'
const POLL_MAX_DURATION = 15 * 60 * 1000
const POLL_DEFAULT_INTERVAL = 5000

// --- Session Store ---
interface NousSession {
  id: string
  profile: string
  deviceCode: string
  userCode: string
  verificationUrl: string
  verificationUrlComplete: string
  expiresIn: number
  interval: number
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'error'
  error?: string
  createdAt: number
}

const sessions = new Map<string, NousSession>()

function cleanupExpiredSessions() {
  const now = Date.now()
  sessions.forEach((s, id) => { if (now - s.createdAt > POLL_MAX_DURATION + 60000) sessions.delete(id) })
}

// --- Auth file helpers ---
interface AuthJson {
  version?: number
  active_provider?: string
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
  updated_at?: string
}

function loadAuthJson(authPath: string): AuthJson {
  try { return JSON.parse(readFileSync(authPath, 'utf-8')) as AuthJson } catch { return { version: 1 } }
}

function saveAuthJson(authPath: string, data: AuthJson): void {
  data.updated_at = new Date().toISOString()
  const dir = dirname(authPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(authPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
}

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

function authPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'auth.json')
}

export function saveNousOAuthTokensForProfile(
  profile: string,
  tokenData: {
    access_token: string
    refresh_token?: string
    expires_in?: number
    inference_base_url?: string
  },
  agentKey = '',
  agentKeyExpiresAt = '',
): void {
  const inferenceBaseUrl = tokenData.inference_base_url || 'https://inference-api.nousresearch.com/v1'
  const auth = loadAuthJson(authPathForProfile(profile))
  if (!auth.providers) auth.providers = {}
  const now = new Date()
  auth.providers['nous'] = {
    portal_base_url: NOUS_PORTAL_URL,
    inference_base_url: inferenceBaseUrl,
    client_id: NOUS_CLIENT_ID,
    scope: NOUS_SCOPE,
    token_type: 'Bearer',
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    obtained_at: now.toISOString(),
    expires_at: tokenData.expires_in ? new Date(now.getTime() + tokenData.expires_in * 1000).toISOString() : null,
    agent_key: agentKey || null,
    agent_key_expires_at: agentKeyExpiresAt || null,
    agent_key_obtained_at: agentKey ? now.toISOString() : null,
  }

  if (!auth.credential_pool) auth.credential_pool = {}
  auth.credential_pool['nous'] = [{
    id: `nous-${Date.now()}`,
    label: 'Nous Portal',
    auth_type: 'oauth',
    source: 'device_code',
    priority: 0,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || null,
    portal_base_url: NOUS_PORTAL_URL,
    inference_base_url: inferenceBaseUrl,
    agent_key: agentKey || null,
    agent_key_expires_at: agentKeyExpiresAt || null,
    base_url: inferenceBaseUrl,
  }]

  saveAuthJson(authPathForProfile(profile), auth)
}

// --- Background poll worker ---
async function nousLoginWorker(session: NousSession): Promise<void> {
  const startTime = Date.now()
  let interval = session.interval || POLL_DEFAULT_INTERVAL

  while (Date.now() - startTime < POLL_MAX_DURATION) {
    await new Promise(resolve => setTimeout(resolve, interval))
    if (session.status !== 'pending') return

    try {
      const res = await fetch(`${NOUS_PORTAL_URL}/api/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: NOUS_CLIENT_ID,
          device_code: session.deviceCode,
        }).toString(),
        signal: AbortSignal.timeout(15000),
      })

      if (res.ok) {
        const tokenData = await res.json() as {
          access_token: string
          refresh_token?: string
          expires_in?: number
          inference_base_url?: string
        }

        // Mint agent key
        const inferenceBaseUrl = tokenData.inference_base_url || 'https://inference-api.nousresearch.com/v1'
        let agentKey = ''
        let agentKeyExpiresAt = ''
        try {
          const mintRes = await fetch(`${NOUS_PORTAL_URL}/api/oauth/agent-key`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${tokenData.access_token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ min_ttl_seconds: 1800 }),
            signal: AbortSignal.timeout(15000),
          })
          if (mintRes.ok) {
            const mintData = await mintRes.json() as {
              api_key: string
              expires_at: string
              inference_base_url?: string
            }
            agentKey = mintData.api_key
            agentKeyExpiresAt = mintData.expires_at
            if (mintData.inference_base_url) {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              void mintData.inference_base_url
            }
          }
        } catch (err: any) {
          logger.warn(err, 'Nous agent key minting failed, proceeding without')
        }

        saveNousOAuthTokensForProfile(session.profile, tokenData, agentKey, agentKeyExpiresAt)
        session.status = 'approved'
        logger.info('Nous login successful')
        return
      }

      // Parse error
      const errData = await res.json().catch(() => ({}))
      const errorCode = errData.error

      if (errorCode === 'authorization_pending') {
        continue
      }
      if (errorCode === 'slow_down') {
        interval = Math.min(interval + 1000, 30000)
        continue
      }
      if (errorCode === 'access_denied' || errorCode === 'expired_token') {
        session.status = errorCode === 'access_denied' ? 'denied' : 'expired'
        return
      }

      logger.error('Nous poll error: %s %s', res.status, errorCode)
      session.status = 'error'
      session.error = `OAuth error: ${errorCode}`
      return
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') continue
      logger.error(err, 'Nous poll error')
      session.status = 'error'
      session.error = err.message
      return
    }
  }

  session.status = 'expired'
}

// --- Controller functions ---

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()

    const res = await fetch(`${NOUS_PORTAL_URL}/api/oauth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        client_id: NOUS_CLIENT_ID,
        scope: NOUS_SCOPE,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      let errorBody: any = null
      try { errorBody = await res.json() } catch { }
      logger.error('Nous device code request failed: %d %s', res.status, errorBody)
      ctx.status = 502
      ctx.body = { error: `Nous Portal error: ${res.status}` }
      return
    }

    const data = await res.json() as {
      device_code: string
      user_code: string
      verification_uri: string
      verification_uri_complete: string
      expires_in: number
      interval: number
    }

    const sessionId = randomUUID()
    const session: NousSession = {
      id: sessionId,
      profile: requestedProfile(ctx),
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_uri,
      verificationUrlComplete: data.verification_uri_complete,
      expiresIn: data.expires_in,
      interval: data.interval,
      status: 'pending',
      createdAt: Date.now(),
    }
    sessions.set(sessionId, session)

    nousLoginWorker(session).catch(err => {
      logger.error(err, 'Nous login worker error')
      session.status = 'error'
      session.error = err.message
    })

    ctx.body = {
      session_id: sessionId,
      user_code: data.user_code,
      verification_url: data.verification_uri_complete,
      expires_in: data.expires_in,
    }
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      ctx.status = 504
      ctx.body = { error: 'Nous Portal timeout' }
      return
    }
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function poll(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { status: session.status, error: session.error || null }
}

export async function status(ctx: any) {
  try {
    await resolveAuthorizedProviderRuntimeCredentials({
      profile: requestedProfile(ctx),
      provider: 'nous',
    })
    ctx.body = { authenticated: true }
  } catch (err: any) {
    ctx.body = { authenticated: false, relogin_required: err?.reloginRequired === true }
  }
}
