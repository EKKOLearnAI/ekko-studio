import { createHash, randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getActiveProfileName, getProfileDir } from '../services/profiles/profile'
import { saveEnvValueForProfile } from '../services/profiles/config'
import { logger } from '../../studio/public/logging'
import { updateConfigYamlForProfile } from '../../studio/public/profile-config'
import { resolveAuthorizedProviderRuntimeCredentials } from '../services/providers/authorized-provider-credentials'

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const ANTHROPIC_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const ANTHROPIC_SCOPES = 'org:create_api_key user:profile user:inference'
const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-6'
const CLAUDE_OAUTH_PROVIDER = 'claude-oauth'
const ANTHROPIC_RUNTIME_PROVIDER = 'anthropic'
const POLL_MAX_DURATION = 15 * 60 * 1000

interface AnthropicSession {
  id: string
  profile: string
  status: 'pending' | 'approved' | 'expired' | 'error'
  authorizeUrl: string
  codeVerifier: string
  state: string
  createdAt: number
  error?: string
}

interface AuthJson {
  version?: number
  active_provider?: string
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
  updated_at?: string
}

const sessions = new Map<string, AnthropicSession>()

export function applyAnthropicOAuthDefaultModel(config: Record<string, any>): Record<string, any> {
  if (typeof config.model !== 'object' || config.model === null) config.model = {}
  const currentDefault = String(config.model.default || '').trim()
  config.model.provider = CLAUDE_OAUTH_PROVIDER
  config.model.default = currentDefault.toLowerCase().startsWith('claude-')
    ? currentDefault
    : ANTHROPIC_DEFAULT_MODEL
  delete config.model.base_url
  delete config.model.api_key
  return config
}

function cleanupExpiredSessions() {
  const now = Date.now()
  sessions.forEach((session, id) => {
    if (now - session.createdAt > POLL_MAX_DURATION + 60000) {
      sessions.delete(id)
    }
  })
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function makeCodeVerifier(): string {
  return base64Url(randomBytes(32))
}

function makeCodeChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest())
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

function anthropicOAuthPathForProfile(profile: string): string {
  return join(getProfileDir(profile), '.anthropic_oauth.json')
}

export async function saveAnthropicOAuthTokensForProfile(
  profile: string,
  tokenData: { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string },
): Promise<void> {
  const accessToken = String(tokenData.access_token || '').trim()
  const refreshToken = String(tokenData.refresh_token || '').trim()
  if (!accessToken) throw new Error('Anthropic token response missing access_token')

  const expiresIn = Number(tokenData.expires_in || 3600)
  const expiresAtMs = Date.now() + Math.max(60, expiresIn) * 1000
  const lastRefresh = new Date().toISOString()

  const profileDir = getProfileDir(profile)
  const oauthPath = anthropicOAuthPathForProfile(profile)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(oauthPath, JSON.stringify({
    accessToken,
    refreshToken,
    expiresAt: expiresAtMs,
    tokenType: tokenData.token_type || 'Bearer',
    updatedAt: lastRefresh,
  }, null, 2) + '\n', { mode: 0o600 })

  const auth = loadAuthJson(authPathForProfile(profile))
  if (!auth.providers) auth.providers = {}
  const providerEntry = {
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at_ms: expiresAtMs,
      token_type: tokenData.token_type || 'Bearer',
    },
    last_refresh: lastRefresh,
    auth_mode: 'oauth_pkce',
    base_url: ANTHROPIC_DEFAULT_BASE_URL,
  }
  auth.providers[CLAUDE_OAUTH_PROVIDER] = providerEntry
  auth.providers[ANTHROPIC_RUNTIME_PROVIDER] = providerEntry
  if (!auth.credential_pool) auth.credential_pool = {}
  const poolEntry = {
    id: `${CLAUDE_OAUTH_PROVIDER}-${Date.now()}`,
    label: 'Claude OAuth',
    auth_type: 'oauth',
    source: 'dashboard_pkce',
    priority: 0,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at_ms: expiresAtMs,
    base_url: ANTHROPIC_DEFAULT_BASE_URL,
  }
  auth.credential_pool[CLAUDE_OAUTH_PROVIDER] = [poolEntry]
  auth.credential_pool[ANTHROPIC_RUNTIME_PROVIDER] = [{
    ...poolEntry,
    id: `${ANTHROPIC_RUNTIME_PROVIDER}-${Date.now()}`,
    label: 'Anthropic Claude OAuth',
  }]
  saveAuthJson(authPathForProfile(profile), auth)

  // Hermes Agent's native Anthropic runtime discovers Claude OAuth through
  // ANTHROPIC_TOKEN. Keep only the short-lived access token in the profile
  // environment; refresh_token remains exclusively in Studio-managed auth
  // storage.
  await saveEnvValueForProfile(profile, 'ANTHROPIC_TOKEN', accessToken)
  await updateConfigYamlForProfile(profile, applyAnthropicOAuthDefaultModel)
}

export async function start(ctx: any) {
  try {
    cleanupExpiredSessions()
    const codeVerifier = makeCodeVerifier()
    const codeChallenge = makeCodeChallenge(codeVerifier)
    const state = randomBytes(32).toString('base64url')
    const sessionId = randomUUID()
    const params = new URLSearchParams({
      code: 'true',
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: 'code',
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      scope: ANTHROPIC_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    })
    const authorizeUrl = `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`
    sessions.set(sessionId, {
      id: sessionId,
      profile: requestedProfile(ctx),
      status: 'pending',
      authorizeUrl,
      codeVerifier,
      state,
      createdAt: Date.now(),
    })
    ctx.body = { session_id: sessionId, authorization_url: authorizeUrl, expires_in: Math.floor(POLL_MAX_DURATION / 1000) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function submit(ctx: any) {
  const session = sessions.get(ctx.params.sessionId)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  if (Date.now() - session.createdAt > POLL_MAX_DURATION) {
    session.status = 'expired'
    ctx.body = { status: session.status, error: null }
    return
  }
  if (session.status !== 'pending') {
    ctx.body = { status: session.status, error: session.error || null }
    return
  }

  const rawCode = String(ctx.request?.body?.code || '').trim()
  const [code, receivedState = ''] = rawCode.split('#', 2)
  if (!code.trim()) {
    ctx.status = 400
    ctx.body = { error: 'Authorization code is required' }
    return
  }
  if (receivedState && receivedState !== session.state) {
    session.status = 'error'
    session.error = 'OAuth state mismatch'
    ctx.status = 400
    ctx.body = { status: session.status, error: session.error }
    return
  }

  try {
    const res = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'hermes-web-ui/1.0',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: ANTHROPIC_CLIENT_ID,
        code: code.trim(),
        state: receivedState || session.state,
        redirect_uri: ANTHROPIC_REDIRECT_URI,
        code_verifier: session.codeVerifier,
      }),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Anthropic token exchange failed: ${res.status}${text ? ` ${text}` : ''}`)
    }
    const tokenData = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }
    await saveAnthropicOAuthTokensForProfile(session.profile, tokenData)
    session.status = 'approved'
    ctx.body = { status: 'approved', error: null }
  } catch (err: any) {
    logger.error(err, 'Anthropic OAuth submit failed')
    session.status = 'error'
    session.error = err.message || String(err)
    ctx.status = 502
    ctx.body = { status: session.status, error: session.error }
  }
}

export async function status(ctx: any) {
  try {
    const credentials = await resolveAuthorizedProviderRuntimeCredentials({
      profile: requestedProfile(ctx),
      provider: CLAUDE_OAUTH_PROVIDER,
    })
    ctx.body = { authenticated: true, last_refresh: credentials.lastRefresh }
  } catch (err: any) {
    ctx.body = { authenticated: false, relogin_required: err?.reloginRequired === true }
  }
}
