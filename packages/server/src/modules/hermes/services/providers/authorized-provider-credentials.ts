import { randomUUID } from 'crypto'
import { chmod, mkdir, open, readFile, rename, rm } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { getHermesBaseDir, getProfileDir } from '../profiles/profile'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_REFRESH_SKEW_MS = 120_000
const XAI_LONG_LIVED_REFRESH_SKEW_MS = 60 * 60 * 1000
const CLAUDE_REFRESH_SKEW_MS = 60_000
const MINIMAX_REFRESH_SKEW_MS = 60_000

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex'

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_DISCOVERY_URL = 'https://auth.x.ai/.well-known/openid-configuration'
const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

const QWEN_CLIENT_ID = 'f0304373b74a44d2b584a3fb70ca9e56'
const QWEN_TOKEN_URL = 'https://chat.qwen.ai/api/v1/oauth2/token'
const QWEN_DEFAULT_BASE_URL = 'https://portal.qwen.ai/v1'

const NOUS_DEFAULT_PORTAL_URL = 'https://portal.nousresearch.com'
const NOUS_DEFAULT_INFERENCE_URL = 'https://inference-api.nousresearch.com/v1'
const NOUS_DEFAULT_CLIENT_ID = 'hermes-cli'
const NOUS_DEFAULT_SCOPE = 'inference:invoke'

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
]
const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com'

const MINIMAX_CLIENT_ID = '78257093-7e40-4613-99e0-527b14b39113'
const MINIMAX_DEFAULT_PORTAL_URL = 'https://api.minimax.io'
const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/anthropic'

type AuthorizedProvider =
  | 'nous'
  | 'openai-codex'
  | 'xai-oauth'
  | 'qwen-oauth'
  | 'claude-oauth'
  | 'minimax-oauth'

type JsonRecord = Record<string, any>

export const AUTHORIZED_RUNTIME_PROVIDERS = new Set<AuthorizedProvider>([
  'nous',
  'openai-codex',
  'xai-oauth',
  'qwen-oauth',
  'claude-oauth',
  'minimax-oauth',
])

export interface AuthorizedProviderRuntimeCredentials {
  provider: string
  apiKey: string
  baseUrl?: string
  apiMode?: string
  source?: string
  lastRefresh?: string
  expiresAt?: string
  expiresAtMs?: number
}

export class AuthorizedProviderCredentialError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly code = 'AUTHORIZED_PROVIDER_CREDENTIAL_FAILED',
    readonly reloginRequired = false,
  ) {
    super(message)
  }
}

interface ResolverDependencies {
  fetch?: typeof fetch
  now?: () => number
  profileDir?: (profile: string) => string
  hermesBaseDir?: () => string
  qwenAuthPath?: () => string
  env?: NodeJS.ProcessEnv
}

interface CredentialSnapshot {
  provider: AuthorizedProvider
  authPath: string
  auth: JsonRecord
  stateKey: string
  state: JsonRecord
  poolKey: string
  poolEntry: JsonRecord
  accessToken: string
  refreshToken: string
  baseUrl: string
  apiMode: string
  source: string
  lastRefresh?: string
  expiresAtMs?: number
}

interface RefreshedTokens {
  accessToken: string
  refreshToken: string
  tokenType?: string
  expiresAtMs?: number
  expiresIn?: number
  idToken?: string
  scope?: string
  inferenceBaseUrl?: string
  tokenEndpoint?: string
  resourceUrl?: string
}

const refreshes = new Map<string, Promise<AuthorizedProviderRuntimeCredentials>>()

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = clean(value)
    if (text) return text
  }
  return ''
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function providerKeys(provider: AuthorizedProvider): string[] {
  return provider === 'claude-oauth' ? ['claude-oauth', 'anthropic'] : [provider]
}

function hasCredential(value: unknown): boolean {
  const record = objectValue(value)
  const tokens = objectValue(record.tokens)
  return !!firstText(
    tokens.access_token,
    tokens.refresh_token,
    record.access_token,
    record.refresh_token,
    record.agent_key,
  )
}

function authContainsProvider(auth: JsonRecord, provider: AuthorizedProvider): boolean {
  const providers = objectValue(auth.providers)
  const pool = objectValue(auth.credential_pool)
  return providerKeys(provider).some((key) => {
    if (hasCredential(providers[key])) return true
    const entries = Array.isArray(pool[key]) ? pool[key] : []
    return entries.some(hasCredential)
  })
}

async function readJsonFile(path: string): Promise<JsonRecord> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'))
    return objectValue(parsed)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return {}
    throw err
  }
}

async function atomicWritePrivateJson(path: string, value: JsonRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  const handle = await open(temporaryPath, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf-8')
    await handle.sync()
    await handle.close()
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } catch (err) {
    await handle.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw err
  }
}

function decodeJwtClaims(token: string): JsonRecord {
  const parts = token.split('.')
  if (parts.length !== 3) return {}
  try {
    return objectValue(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')))
  } catch {
    return {}
  }
}

function jwtExpiryMs(token: string): number | undefined {
  const exp = Number(decodeJwtClaims(token).exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 10_000_000_000 ? value : value * 1000
  }
  const text = clean(value)
  if (!text) return undefined
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function derivedExpiryMs(
  accessToken: string,
  tokens: JsonRecord,
  state: JsonRecord,
  poolEntry: JsonRecord,
): number | undefined {
  const explicit = [
    tokens.expires_at_ms,
    state.expires_at_ms,
    poolEntry.expires_at_ms,
    tokens.expiry_date,
    state.expiry_date,
    poolEntry.expiry_date,
    tokens.expires_at,
    state.expires_at,
    poolEntry.expires_at,
  ].map(parseTimestampMs).find(value => value !== undefined)
  if (explicit !== undefined) return explicit

  const expiresIn = Number(tokens.expires_in ?? state.expires_in ?? poolEntry.expires_in)
  const anchor = parseTimestampMs(
    firstText(
      state.last_refresh,
      tokens.last_refresh,
      poolEntry.last_refresh,
      state.obtained_at,
      poolEntry.obtained_at,
    ),
  )
  if (Number.isFinite(expiresIn) && expiresIn > 0 && anchor !== undefined) {
    return anchor + expiresIn * 1000
  }
  return jwtExpiryMs(accessToken)
}

function poolEntryFor(auth: JsonRecord, keys: string[]): { key: string; entry: JsonRecord } {
  const pool = objectValue(auth.credential_pool)
  for (const key of keys) {
    const entries = Array.isArray(pool[key]) ? pool[key] : []
    const entry = entries.find(hasCredential)
    if (entry) return { key, entry: objectValue(entry) }
  }
  return { key: keys[0], entry: {} }
}

function providerStateFor(auth: JsonRecord, keys: string[]): { key: string; state: JsonRecord } {
  const providers = objectValue(auth.providers)
  for (const key of keys) {
    if (hasCredential(providers[key])) return { key, state: objectValue(providers[key]) }
  }
  for (const key of keys) {
    if (providers[key] && typeof providers[key] === 'object') {
      return { key, state: objectValue(providers[key]) }
    }
  }
  return { key: keys[0], state: {} }
}

function runtimeDefaults(provider: AuthorizedProvider): {
  baseUrl: string
  apiMode: string
  source: string
} {
  switch (provider) {
    case 'openai-codex':
      return { baseUrl: CODEX_DEFAULT_BASE_URL, apiMode: 'codex_responses', source: 'hermes-auth-store' }
    case 'xai-oauth':
      return { baseUrl: XAI_DEFAULT_BASE_URL, apiMode: 'codex_responses', source: 'hermes-auth-store' }
    case 'qwen-oauth':
      return { baseUrl: QWEN_DEFAULT_BASE_URL, apiMode: 'chat_completions', source: 'qwen-cli' }
    case 'claude-oauth':
      return { baseUrl: CLAUDE_DEFAULT_BASE_URL, apiMode: 'anthropic_messages', source: 'hermes-auth-store' }
    case 'minimax-oauth':
      return { baseUrl: MINIMAX_DEFAULT_BASE_URL, apiMode: 'anthropic_messages', source: 'hermes-auth-store' }
    case 'nous':
      return { baseUrl: NOUS_DEFAULT_INFERENCE_URL, apiMode: 'chat_completions', source: 'invoke_jwt' }
  }
}

function snapshotFromAuth(
  authPath: string,
  auth: JsonRecord,
  provider: AuthorizedProvider,
  env: NodeJS.ProcessEnv,
): CredentialSnapshot {
  const keys = providerKeys(provider)
  const { key: stateKey, state } = providerStateFor(auth, keys)
  const { key: poolKey, entry: poolEntry } = poolEntryFor(auth, keys)
  const tokens = objectValue(state.tokens)
  const accessToken = firstText(tokens.access_token, state.access_token, poolEntry.access_token)
  const refreshToken = firstText(tokens.refresh_token, state.refresh_token, poolEntry.refresh_token)
  const defaults = runtimeDefaults(provider)
  let baseUrl = firstText(
    poolEntry.base_url,
    state.base_url,
    state.inference_base_url,
    defaults.baseUrl,
  )
  if (provider === 'openai-codex') baseUrl = firstText(env.HERMES_CODEX_BASE_URL, baseUrl)
  if (provider === 'xai-oauth') baseUrl = firstText(env.HERMES_XAI_BASE_URL, env.XAI_BASE_URL, baseUrl)
  if (provider === 'nous') baseUrl = firstText(env.NOUS_INFERENCE_BASE_URL, baseUrl)
  const lastRefresh = firstText(state.last_refresh, tokens.last_refresh, poolEntry.last_refresh) || undefined
  return {
    provider,
    authPath,
    auth,
    stateKey,
    state,
    poolKey,
    poolEntry,
    accessToken,
    refreshToken,
    baseUrl: stripTrailingSlash(baseUrl),
    apiMode: firstText(poolEntry.api_mode, state.api_mode, defaults.apiMode),
    source: firstText(poolEntry.source, state.source, defaults.source),
    lastRefresh,
    expiresAtMs: derivedExpiryMs(accessToken, tokens, state, poolEntry),
  }
}

async function locateAuthSnapshot(
  profile: string,
  provider: AuthorizedProvider,
  dependencies: ResolverDependencies,
): Promise<CredentialSnapshot | null> {
  const profileDir = dependencies.profileDir || getProfileDir
  const requestedPath = join(profileDir(profile), 'auth.json')
  const requestedAuth = await readJsonFile(requestedPath)
  if (authContainsProvider(requestedAuth, provider)) {
    return snapshotFromAuth(requestedPath, requestedAuth, provider, dependencies.env || process.env)
  }

  const defaultPath = join(profileDir('default'), 'auth.json')
  if (resolve(defaultPath) === resolve(requestedPath)) return null
  const defaultAuth = await readJsonFile(defaultPath)
  if (!authContainsProvider(defaultAuth, provider)) return null
  return snapshotFromAuth(defaultPath, defaultAuth, provider, dependencies.env || process.env)
}

function scopes(value: unknown): Set<string> {
  const parts = Array.isArray(value) ? value : clean(value).replace(/,/g, ' ').split(/\s+/)
  return new Set(parts.map(item => clean(item)).filter(Boolean))
}

function nousTokenUsable(token: string, scope: unknown, expiresAt: unknown, now: number): boolean {
  if (!token) return false
  const claims = decodeJwtClaims(token)
  if (Object.keys(claims).length > 0) {
    const tokenScopes = new Set([...scopes(scope), ...scopes(claims.scope), ...scopes(claims.scp)])
    if (!tokenScopes.has(NOUS_DEFAULT_SCOPE)) return false
    const expiry = jwtExpiryMs(token) || parseTimestampMs(expiresAt)
    return expiry !== undefined && expiry > now + DEFAULT_REFRESH_SKEW_MS
  }
  const expiry = parseTimestampMs(expiresAt)
  return expiry === undefined || expiry > now + DEFAULT_REFRESH_SKEW_MS
}

function selectedCredential(snapshot: CredentialSnapshot, now: number): {
  token: string
  expiresAtMs?: number
  refreshNeeded: boolean
} {
  if (snapshot.provider === 'nous') {
    const agentKey = firstText(snapshot.state.agent_key, snapshot.poolEntry.agent_key)
    const agentExpiry = firstText(snapshot.state.agent_key_expires_at, snapshot.poolEntry.agent_key_expires_at)
    if (nousTokenUsable(agentKey, NOUS_DEFAULT_SCOPE, agentExpiry, now)) {
      return { token: agentKey, expiresAtMs: parseTimestampMs(agentExpiry), refreshNeeded: false }
    }
    if (nousTokenUsable(
      snapshot.accessToken,
      snapshot.state.scope,
      snapshot.state.expires_at,
      now,
    )) {
      return { token: snapshot.accessToken, expiresAtMs: snapshot.expiresAtMs, refreshNeeded: false }
    }
    return { token: '', refreshNeeded: true }
  }

  if (!snapshot.accessToken) return { token: '', refreshNeeded: true }
  if (snapshot.expiresAtMs === undefined) {
    return { token: snapshot.accessToken, refreshNeeded: false }
  }
  let skew = DEFAULT_REFRESH_SKEW_MS
  if (snapshot.provider === 'xai-oauth') {
    skew = XAI_LONG_LIVED_REFRESH_SKEW_MS
  } else if (snapshot.provider === 'claude-oauth') {
    skew = CLAUDE_REFRESH_SKEW_MS
  } else if (snapshot.provider === 'minimax-oauth') {
    skew = MINIMAX_REFRESH_SKEW_MS
  }
  return {
    token: snapshot.accessToken,
    expiresAtMs: snapshot.expiresAtMs,
    refreshNeeded: snapshot.expiresAtMs <= now + skew,
  }
}

function runtimeCredentials(
  snapshot: CredentialSnapshot,
  selected: { token: string; expiresAtMs?: number },
): AuthorizedProviderRuntimeCredentials {
  const expiresAtMs = selected.expiresAtMs
  return {
    provider: snapshot.provider,
    apiKey: selected.token,
    ...(snapshot.baseUrl ? { baseUrl: snapshot.baseUrl } : {}),
    ...(snapshot.apiMode ? { apiMode: snapshot.apiMode } : {}),
    ...(snapshot.source ? { source: snapshot.source } : {}),
    ...(snapshot.lastRefresh ? { lastRefresh: snapshot.lastRefresh } : {}),
    ...(expiresAtMs !== undefined ? {
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    } : {}),
  }
}

function missingCredentials(provider: AuthorizedProvider, detail = ''): AuthorizedProviderCredentialError {
  return new AuthorizedProviderCredentialError(
    detail || `No ${provider} OAuth credentials were found in the Hermes credential store`,
    provider,
    'AUTHORIZED_PROVIDER_AUTH_MISSING',
    true,
  )
}

function refreshFailure(
  provider: AuthorizedProvider,
  message: string,
  code: string,
  reloginRequired: boolean,
): AuthorizedProviderCredentialError {
  return new AuthorizedProviderCredentialError(message, provider, code, reloginRequired)
}

function responseErrorDetail(payload: JsonRecord): string {
  const nested = objectValue(payload.error)
  return firstText(
    payload.error_description,
    nested.message,
    nested.code,
    typeof payload.error === 'string' ? payload.error : '',
    objectValue(payload.base_resp).status_msg,
    payload.message,
  ).slice(0, 300)
}

async function responsePayload(response: Response): Promise<JsonRecord> {
  try {
    return objectValue(await response.json())
  } catch {
    return {}
  }
}

async function postForm(
  fetcher: typeof fetch,
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ response: Response; payload: JsonRecord }> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  })
  return { response, payload: await responsePayload(response) }
}

function requireRefreshToken(snapshot: CredentialSnapshot): string {
  if (snapshot.refreshToken) return snapshot.refreshToken
  throw refreshFailure(
    snapshot.provider,
    `${snapshot.provider} OAuth session has expired and has no refresh token`,
    'AUTHORIZED_PROVIDER_REFRESH_TOKEN_MISSING',
    true,
  )
}

function validateXaiEndpoint(raw: string): string {
  try {
    const url = new URL(raw)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) throw new Error()
    return raw
  } catch {
    throw refreshFailure(
      'xai-oauth',
      'Refusing to send the xAI refresh token to an untrusted OAuth endpoint',
      'XAI_DISCOVERY_INVALID',
      false,
    )
  }
}

function validateNousPortal(raw: string, trustedOverride: boolean): string {
  try {
    const url = new URL(raw)
    const local = ['localhost', '127.0.0.1'].includes(url.hostname)
    if (trustedOverride && (url.protocol === 'https:' || (url.protocol === 'http:' && local))) return stripTrailingSlash(raw)
    if (url.protocol === 'https:' && url.hostname === 'portal.nousresearch.com') return stripTrailingSlash(raw)
    if (url.protocol === 'http:' && local) return stripTrailingSlash(raw)
  } catch {}
  return NOUS_DEFAULT_PORTAL_URL
}

function validateNousInference(raw: unknown): string | undefined {
  const value = clean(raw)
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.hostname === 'inference-api.nousresearch.com') {
      return stripTrailingSlash(value)
    }
  } catch {}
  return undefined
}

function minimaxExpiryMs(value: unknown, now: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return now + 3600_000
  return raw > now / 2 ? raw : now + raw * 1000
}

async function refreshProvider(
  snapshot: CredentialSnapshot,
  dependencies: ResolverDependencies,
): Promise<RefreshedTokens> {
  const fetcher = dependencies.fetch || fetch
  const now = (dependencies.now || Date.now)()
  const refreshToken = requireRefreshToken(snapshot)
  let result: { response: Response; payload: JsonRecord }

  if (snapshot.provider === 'openai-codex') {
    result = await postForm(fetcher, CODEX_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }, { 'User-Agent': 'hermes-studio' })
    if (!result.response.ok) {
      const detail = responseErrorDetail(result.payload)
      const relogin = [400, 401, 403].includes(result.response.status)
      throw refreshFailure(
        snapshot.provider,
        `Codex token refresh failed (${result.response.status})${detail ? `: ${detail}` : ''}`,
        result.response.status === 429 ? 'CODEX_REFRESH_RATE_LIMITED' : 'CODEX_REFRESH_FAILED',
        result.response.status === 429 ? false : relogin,
      )
    }
    const accessToken = clean(result.payload.access_token)
    if (!accessToken) throw refreshFailure(snapshot.provider, 'Codex refresh response has no access token', 'CODEX_REFRESH_INVALID_RESPONSE', true)
    return {
      accessToken,
      refreshToken: firstText(result.payload.refresh_token, refreshToken),
      tokenType: firstText(result.payload.token_type, 'Bearer'),
      expiresIn: Number(result.payload.expires_in) || undefined,
    }
  }

  if (snapshot.provider === 'xai-oauth') {
    let tokenEndpoint = clean(objectValue(snapshot.state.discovery).token_endpoint)
    if (!tokenEndpoint) {
      const discoveryResponse = await fetcher(XAI_DISCOVERY_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      })
      const discovery = await responsePayload(discoveryResponse)
      if (!discoveryResponse.ok) {
        throw refreshFailure(snapshot.provider, `xAI OAuth discovery failed (${discoveryResponse.status})`, 'XAI_DISCOVERY_FAILED', false)
      }
      tokenEndpoint = clean(discovery.token_endpoint)
    }
    tokenEndpoint = validateXaiEndpoint(tokenEndpoint)
    result = await postForm(fetcher, tokenEndpoint, {
      grant_type: 'refresh_token',
      client_id: XAI_CLIENT_ID,
      refresh_token: refreshToken,
    })
    if (!result.response.ok) {
      const detail = responseErrorDetail(result.payload)
      throw refreshFailure(
        snapshot.provider,
        `xAI token refresh failed (${result.response.status})${detail ? `: ${detail}` : ''}`,
        result.response.status === 403 ? 'XAI_OAUTH_TIER_DENIED' : 'XAI_REFRESH_FAILED',
        [400, 401].includes(result.response.status),
      )
    }
    const accessToken = clean(result.payload.access_token)
    if (!accessToken) throw refreshFailure(snapshot.provider, 'xAI refresh response has no access token', 'XAI_REFRESH_INVALID_RESPONSE', true)
    return {
      accessToken,
      refreshToken: firstText(result.payload.refresh_token, refreshToken),
      tokenType: firstText(result.payload.token_type, 'Bearer'),
      expiresIn: Number(result.payload.expires_in) || undefined,
      idToken: clean(result.payload.id_token) || undefined,
      tokenEndpoint,
    }
  }

  if (snapshot.provider === 'nous') {
    const env = dependencies.env || process.env
    const override = firstText(env.HERMES_PORTAL_BASE_URL, env.NOUS_PORTAL_BASE_URL)
    const portalUrl = validateNousPortal(
      override || firstText(snapshot.state.portal_base_url, snapshot.poolEntry.portal_base_url, NOUS_DEFAULT_PORTAL_URL),
      !!override,
    )
    const clientId = firstText(snapshot.state.client_id, NOUS_DEFAULT_CLIENT_ID)
    result = await postForm(fetcher, `${portalUrl}/api/oauth/token`, {
      grant_type: 'refresh_token',
      client_id: clientId,
    }, { 'x-nous-refresh-token': refreshToken })
    if (!result.response.ok) {
      const detail = responseErrorDetail(result.payload)
      const code = firstText(result.payload.error, 'NOUS_REFRESH_FAILED')
      const relogin = ['invalid_grant', 'invalid_token', 'refresh_token_reused'].includes(code) || [400, 401].includes(result.response.status)
      throw refreshFailure(
        snapshot.provider,
        `Nous token refresh failed (${result.response.status})${detail ? `: ${detail}` : ''}`,
        code,
        relogin,
      )
    }
    const accessToken = clean(result.payload.access_token)
    if (!accessToken) throw refreshFailure(snapshot.provider, 'Nous refresh response has no access token', 'NOUS_REFRESH_INVALID_RESPONSE', true)
    return {
      accessToken,
      refreshToken: firstText(result.payload.refresh_token, refreshToken),
      tokenType: firstText(result.payload.token_type, snapshot.state.token_type, 'Bearer'),
      expiresIn: Math.max(1, Number(result.payload.expires_in) || 3600),
      scope: firstText(result.payload.scope, snapshot.state.scope, NOUS_DEFAULT_SCOPE),
      inferenceBaseUrl: validateNousInference(result.payload.inference_base_url) || NOUS_DEFAULT_INFERENCE_URL,
    }
  }

  if (snapshot.provider === 'claude-oauth') {
    let lastStatus = 0
    let lastPayload: JsonRecord = {}
    for (const tokenUrl of CLAUDE_TOKEN_URLS) {
      result = await postForm(fetcher, tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }, { 'User-Agent': 'hermes-studio' })
      if (result.response.ok) {
        const accessToken = clean(result.payload.access_token)
        if (!accessToken) throw refreshFailure(snapshot.provider, 'Claude refresh response has no access token', 'CLAUDE_REFRESH_INVALID_RESPONSE', true)
        const expiresIn = Math.max(60, Number(result.payload.expires_in) || 3600)
        return {
          accessToken,
          refreshToken: firstText(result.payload.refresh_token, refreshToken),
          tokenType: firstText(result.payload.token_type, 'Bearer'),
          expiresIn,
          expiresAtMs: now + expiresIn * 1000,
        }
      }
      lastStatus = result.response.status
      lastPayload = result.payload
    }
    const detail = responseErrorDetail(lastPayload)
    throw refreshFailure(
      snapshot.provider,
      `Claude token refresh failed (${lastStatus})${detail ? `: ${detail}` : ''}`,
      'CLAUDE_REFRESH_FAILED',
      [400, 401, 403].includes(lastStatus),
    )
  }

  const portalUrl = firstText(snapshot.state.portal_base_url, MINIMAX_DEFAULT_PORTAL_URL)
  result = await postForm(fetcher, `${stripTrailingSlash(portalUrl)}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: firstText(snapshot.state.client_id, MINIMAX_CLIENT_ID),
    refresh_token: refreshToken,
  })
  if (!result.response.ok || result.payload.status !== 'success') {
    const detail = responseErrorDetail(result.payload)
    const lower = detail.toLowerCase()
    const relogin = ['invalid_grant', 'refresh_token_reused', 'invalid_refresh_token']
      .some(marker => lower.includes(marker)) || [400, 401].includes(result.response.status)
    throw refreshFailure(
      snapshot.provider,
      `MiniMax token refresh failed (${result.response.status})${detail ? `: ${detail}` : ''}`,
      'MINIMAX_REFRESH_FAILED',
      relogin,
    )
  }
  const accessToken = clean(result.payload.access_token)
  if (!accessToken) throw refreshFailure(snapshot.provider, 'MiniMax refresh response has no access token', 'MINIMAX_REFRESH_INVALID_RESPONSE', true)
  return {
    accessToken,
    refreshToken: firstText(result.payload.refresh_token, refreshToken),
    tokenType: firstText(result.payload.token_type, snapshot.state.token_type, 'Bearer'),
    expiresAtMs: minimaxExpiryMs(result.payload.expired_in, now),
    resourceUrl: clean(result.payload.resource_url) || undefined,
  }
}

function clearCredentialErrors(entry: JsonRecord): void {
  for (const key of [
    'last_error_code',
    'last_error_message',
    'last_error_reason',
    'last_error_reset_at',
  ]) delete entry[key]
  entry.last_status = null
  entry.last_status_at = null
}

function syncPoolEntry(
  auth: JsonRecord,
  key: string,
  snapshot: CredentialSnapshot,
  values: JsonRecord,
): void {
  const pool = objectValue(auth.credential_pool)
  auth.credential_pool = pool
  const entries = Array.isArray(pool[key]) ? pool[key] : []
  if (entries.length === 0) return
  let index = entries.findIndex((entry: unknown) => {
    const item = objectValue(entry)
    return !!(
      snapshot.refreshToken && clean(item.refresh_token) === snapshot.refreshToken ||
      snapshot.accessToken && clean(item.access_token) === snapshot.accessToken
    )
  })
  if (index < 0 && entries.length === 1) index = 0
  if (index < 0) return
  const updated = { ...objectValue(entries[index]), ...values }
  clearCredentialErrors(updated)
  entries[index] = updated
  pool[key] = entries
}

function applyRefreshedTokens(
  auth: JsonRecord,
  snapshot: CredentialSnapshot,
  refreshed: RefreshedTokens,
  now: number,
): void {
  const provider = snapshot.provider
  const providers = objectValue(auth.providers)
  auth.providers = providers
  const refreshedAt = new Date(now).toISOString()
  const expiresAtMs = refreshed.expiresAtMs ?? (
    refreshed.expiresIn ? now + refreshed.expiresIn * 1000 : jwtExpiryMs(refreshed.accessToken)
  )
  const commonPool = {
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken,
    ...(refreshed.tokenType ? { token_type: refreshed.tokenType } : {}),
    ...(expiresAtMs !== undefined ? { expires_at_ms: expiresAtMs } : {}),
    last_refresh: refreshedAt,
  }

  if (provider === 'openai-codex') {
    const state = objectValue(providers[provider])
    state.tokens = {
      ...objectValue(state.tokens),
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      ...(refreshed.tokenType ? { token_type: refreshed.tokenType } : {}),
    }
    state.last_refresh = refreshedAt
    state.auth_mode = firstText(state.auth_mode, 'chatgpt')
    providers[provider] = state
    syncPoolEntry(auth, provider, snapshot, commonPool)
  } else if (provider === 'xai-oauth') {
    const state = objectValue(providers[provider])
    state.tokens = {
      ...objectValue(state.tokens),
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      ...(refreshed.idToken ? { id_token: refreshed.idToken } : {}),
      ...(refreshed.expiresIn ? { expires_in: refreshed.expiresIn } : {}),
      ...(refreshed.tokenType ? { token_type: refreshed.tokenType } : {}),
    }
    state.discovery = {
      ...objectValue(state.discovery),
      ...(refreshed.tokenEndpoint ? { token_endpoint: refreshed.tokenEndpoint } : {}),
    }
    state.last_refresh = refreshedAt
    providers[provider] = state
    syncPoolEntry(auth, provider, snapshot, commonPool)
  } else if (provider === 'nous') {
    const state = objectValue(providers[provider])
    const expiresAt = new Date(expiresAtMs || now + 3600_000).toISOString()
    Object.assign(state, {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_type: refreshed.tokenType || state.token_type || 'Bearer',
      scope: refreshed.scope || state.scope || NOUS_DEFAULT_SCOPE,
      obtained_at: refreshedAt,
      expires_at: expiresAt,
      expires_in: Math.max(0, Math.floor(((expiresAtMs || now) - now) / 1000)),
      inference_base_url: refreshed.inferenceBaseUrl || NOUS_DEFAULT_INFERENCE_URL,
      agent_key: refreshed.accessToken,
      agent_key_id: null,
      agent_key_expires_at: expiresAt,
      agent_key_expires_in: Math.max(0, Math.floor(((expiresAtMs || now) - now) / 1000)),
      agent_key_reused: false,
      agent_key_obtained_at: refreshedAt,
    })
    providers[provider] = state
    syncPoolEntry(auth, provider, snapshot, {
      ...commonPool,
      agent_key: refreshed.accessToken,
      agent_key_expires_at: expiresAt,
      inference_base_url: state.inference_base_url,
      base_url: state.inference_base_url,
    })
  } else if (provider === 'claude-oauth') {
    for (const key of providerKeys(provider)) {
      const state = objectValue(providers[key] || providers[snapshot.stateKey])
      state.tokens = {
        ...objectValue(state.tokens),
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        expires_at_ms: expiresAtMs,
        token_type: refreshed.tokenType || 'Bearer',
      }
      state.last_refresh = refreshedAt
      state.auth_mode = firstText(state.auth_mode, 'oauth_pkce')
      state.base_url = firstText(state.base_url, CLAUDE_DEFAULT_BASE_URL)
      providers[key] = state
      syncPoolEntry(auth, key, snapshot, commonPool)
    }
  } else if (provider === 'minimax-oauth') {
    const state = objectValue(providers[provider])
    Object.assign(state, {
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_type: refreshed.tokenType || state.token_type || 'Bearer',
      obtained_at: refreshedAt,
      expires_at: new Date(expiresAtMs || now + 3600_000).toISOString(),
      expires_in: Math.max(0, Math.floor(((expiresAtMs || now) - now) / 1000)),
      ...(refreshed.resourceUrl ? { resource_url: refreshed.resourceUrl } : {}),
    })
    providers[provider] = state
    syncPoolEntry(auth, provider, snapshot, commonPool)
  }
  auth.updated_at = refreshedAt
}

async function syncProviderSidecars(
  snapshot: CredentialSnapshot,
  refreshed: RefreshedTokens,
  dependencies: ResolverDependencies,
): Promise<void> {
  const now = (dependencies.now || Date.now)()
  if (snapshot.provider === 'claude-oauth') {
    const expiresAt = refreshed.expiresAtMs || now + Math.max(60, refreshed.expiresIn || 3600) * 1000
    await atomicWritePrivateJson(join(dirname(snapshot.authPath), '.anthropic_oauth.json'), {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt,
      tokenType: refreshed.tokenType || 'Bearer',
      updatedAt: new Date(now).toISOString(),
    })
  }
  if (snapshot.provider === 'nous') {
    const baseDir = (dependencies.hermesBaseDir || getHermesBaseDir)()
    const sharedDir = firstText((dependencies.env || process.env).HERMES_SHARED_AUTH_DIR) || join(baseDir, 'shared')
    const expiresAt = refreshed.expiresAtMs || now + Math.max(1, refreshed.expiresIn || 3600) * 1000
    await atomicWritePrivateJson(join(sharedDir, 'nous_auth.json'), {
      _schema: 1,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_type: refreshed.tokenType || 'Bearer',
      scope: refreshed.scope || NOUS_DEFAULT_SCOPE,
      client_id: firstText(snapshot.state.client_id, NOUS_DEFAULT_CLIENT_ID),
      portal_base_url: firstText(snapshot.state.portal_base_url, NOUS_DEFAULT_PORTAL_URL),
      inference_base_url: refreshed.inferenceBaseUrl || NOUS_DEFAULT_INFERENCE_URL,
      obtained_at: new Date(now).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
  }
}

async function resolveHermesStoredProvider(
  profile: string,
  provider: Exclude<AuthorizedProvider, 'qwen-oauth'>,
  dependencies: ResolverDependencies,
  forceRefresh = false,
): Promise<AuthorizedProviderRuntimeCredentials> {
  const initial = await locateAuthSnapshot(profile, provider, dependencies)
  if (!initial) throw missingCredentials(provider)
  const now = (dependencies.now || Date.now)()
  const selected = selectedCredential(initial, now)
  if (!forceRefresh && !selected.refreshNeeded && selected.token) return runtimeCredentials(initial, selected)
  if (!initial.refreshToken) throw missingCredentials(provider, `${provider} OAuth session expired; sign in again`)

  const lockKey = `${resolve(initial.authPath)}:${provider}`
  const existing = refreshes.get(lockKey)
  if (existing) return existing
  const pending = (async () => {
    const latestAuth = await readJsonFile(initial.authPath)
    const latest = snapshotFromAuth(initial.authPath, latestAuth, provider, dependencies.env || process.env)
    const latestSelected = selectedCredential(latest, (dependencies.now || Date.now)())
    if (!forceRefresh && !latestSelected.refreshNeeded && latestSelected.token) return runtimeCredentials(latest, latestSelected)
    if (!latest.refreshToken) throw missingCredentials(provider, `${provider} OAuth session expired; sign in again`)

    let refreshed: RefreshedTokens
    try {
      refreshed = await refreshProvider(latest, dependencies)
    } catch (err) {
      if (err instanceof AuthorizedProviderCredentialError) throw err
      throw refreshFailure(
        provider,
        `${provider} token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        'AUTHORIZED_PROVIDER_REFRESH_FAILED',
        false,
      )
    }

    const currentAuth = await readJsonFile(latest.authPath)
    const current = snapshotFromAuth(latest.authPath, currentAuth, provider, dependencies.env || process.env)
    if (current.refreshToken && current.refreshToken !== latest.refreshToken) {
      const currentSelected = selectedCredential(current, (dependencies.now || Date.now)())
      if (!currentSelected.refreshNeeded && currentSelected.token) {
        return runtimeCredentials(current, currentSelected)
      }
      throw refreshFailure(
        provider,
        `${provider} credentials changed while Studio was refreshing them`,
        'AUTHORIZED_PROVIDER_REFRESH_CONFLICT',
        false,
      )
    }

    const writeNow = (dependencies.now || Date.now)()
    applyRefreshedTokens(currentAuth, current, refreshed, writeNow)
    await atomicWritePrivateJson(current.authPath, currentAuth)
    await syncProviderSidecars(current, refreshed, dependencies)
    const saved = snapshotFromAuth(current.authPath, currentAuth, provider, dependencies.env || process.env)
    const savedSelected = selectedCredential(saved, writeNow)
    const token = savedSelected.token || refreshed.accessToken
    const expiresAtMs = savedSelected.expiresAtMs || refreshed.expiresAtMs || (
      refreshed.expiresIn ? writeNow + refreshed.expiresIn * 1000 : jwtExpiryMs(token)
    )
    return runtimeCredentials(saved, { token, expiresAtMs })
  })()
  refreshes.set(lockKey, pending)
  try {
    return await pending
  } finally {
    if (refreshes.get(lockKey) === pending) refreshes.delete(lockKey)
  }
}

async function resolveQwenCredentials(
  dependencies: ResolverDependencies,
  forceRefresh = false,
): Promise<AuthorizedProviderRuntimeCredentials> {
  const path = (dependencies.qwenAuthPath || (() => join(homedir(), '.qwen', 'oauth_creds.json')))()
  const env = dependencies.env || process.env
  const now = (dependencies.now || Date.now)()
  const current = await readJsonFile(path)
  const accessToken = clean(current.access_token)
  const expiresAtMs = parseTimestampMs(current.expiry_date)
  const valid = !!accessToken && expiresAtMs !== undefined && expiresAtMs > now + DEFAULT_REFRESH_SKEW_MS
  if (!forceRefresh && valid) {
    return {
      provider: 'qwen-oauth',
      apiKey: accessToken,
      baseUrl: stripTrailingSlash(firstText(env.HERMES_QWEN_BASE_URL, QWEN_DEFAULT_BASE_URL)),
      apiMode: 'chat_completions',
      source: 'qwen-cli',
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    }
  }
  const refreshToken = clean(current.refresh_token)
  if (!refreshToken) throw missingCredentials('qwen-oauth')

  const lockKey = `${resolve(path)}:qwen-oauth`
  const existing = refreshes.get(lockKey)
  if (existing) return existing
  const pending = (async () => {
    const latest = await readJsonFile(path)
    const latestExpiry = parseTimestampMs(latest.expiry_date)
    const latestAccess = clean(latest.access_token)
    if (!forceRefresh && latestAccess && latestExpiry !== undefined && latestExpiry > (dependencies.now || Date.now)() + DEFAULT_REFRESH_SKEW_MS) {
      return {
        provider: 'qwen-oauth',
        apiKey: latestAccess,
        baseUrl: stripTrailingSlash(firstText(env.HERMES_QWEN_BASE_URL, QWEN_DEFAULT_BASE_URL)),
        apiMode: 'chat_completions',
        source: 'qwen-cli',
        expiresAt: new Date(latestExpiry).toISOString(),
        expiresAtMs: latestExpiry,
      }
    }
    const latestRefresh = clean(latest.refresh_token)
    if (!latestRefresh) throw missingCredentials('qwen-oauth')
    const fetcher = dependencies.fetch || fetch
    let result: { response: Response; payload: JsonRecord }
    try {
      result = await postForm(fetcher, QWEN_TOKEN_URL, {
        grant_type: 'refresh_token',
        refresh_token: latestRefresh,
        client_id: QWEN_CLIENT_ID,
      })
    } catch (err) {
      throw refreshFailure('qwen-oauth', `Qwen token refresh failed: ${err instanceof Error ? err.message : String(err)}`, 'QWEN_REFRESH_FAILED', false)
    }
    if (!result.response.ok) {
      const detail = responseErrorDetail(result.payload)
      throw refreshFailure(
        'qwen-oauth',
        `Qwen token refresh failed (${result.response.status})${detail ? `: ${detail}` : ''}`,
        'QWEN_REFRESH_FAILED',
        [400, 401, 403].includes(result.response.status),
      )
    }
    const refreshedAccess = clean(result.payload.access_token)
    if (!refreshedAccess) throw refreshFailure('qwen-oauth', 'Qwen refresh response has no access token', 'QWEN_REFRESH_INVALID_RESPONSE', true)
    const writeNow = (dependencies.now || Date.now)()
    const refreshedExpiry = writeNow + Math.max(1, Number(result.payload.expires_in) || 6 * 60 * 60) * 1000
    await atomicWritePrivateJson(path, {
      ...latest,
      access_token: refreshedAccess,
      refresh_token: firstText(result.payload.refresh_token, latestRefresh),
      token_type: firstText(result.payload.token_type, latest.token_type, 'Bearer'),
      resource_url: firstText(result.payload.resource_url, latest.resource_url, 'portal.qwen.ai'),
      expiry_date: refreshedExpiry,
    })
    return {
      provider: 'qwen-oauth',
      apiKey: refreshedAccess,
      baseUrl: stripTrailingSlash(firstText(env.HERMES_QWEN_BASE_URL, QWEN_DEFAULT_BASE_URL)),
      apiMode: 'chat_completions',
      source: 'qwen-cli',
      expiresAt: new Date(refreshedExpiry).toISOString(),
      expiresAtMs: refreshedExpiry,
    }
  })()
  refreshes.set(lockKey, pending)
  try {
    return await pending
  } finally {
    if (refreshes.get(lockKey) === pending) refreshes.delete(lockKey)
  }
}

export function isAuthorizedRuntimeProvider(provider: unknown): boolean {
  return AUTHORIZED_RUNTIME_PROVIDERS.has(clean(provider).toLowerCase() as AuthorizedProvider)
}

export async function resolveAuthorizedProviderRuntimeCredentials(
  input: { profile: string; provider: string; model?: string; forceRefresh?: boolean },
  dependencies: ResolverDependencies = {},
): Promise<AuthorizedProviderRuntimeCredentials> {
  const provider = clean(input.provider).toLowerCase() as AuthorizedProvider
  if (!isAuthorizedRuntimeProvider(provider)) {
    throw new AuthorizedProviderCredentialError(
      `Provider "${provider}" is not managed by Hermes authorization`,
      provider,
      'AUTHORIZED_PROVIDER_UNSUPPORTED',
    )
  }
  if (provider === 'qwen-oauth') return resolveQwenCredentials(dependencies, input.forceRefresh === true)
  const profile = clean(input.profile) || 'default'
  return resolveHermesStoredProvider(profile, provider, dependencies, input.forceRefresh === true)
}
