import { logger } from '../../public/logging'
import { reverseDoubleUtf8Fields } from './double-utf8'

/**
 * Minimal client for the Token Platform (api.quantclaw.vip) device login APIs.
 *
 * The Hermes device renders a WeChat QR, the user scans it, and this module
 * polls the platform until the login session is approved. On approval the
 * platform returns the device's dedicated API key plus the model capabilities
 * the user's account grants. `fetchDeviceSelf` then resolves the bound user
 * profile so Hermes can sync the account locally.
 */

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Decode an HTTP response body robustly: the Token Platform server has
 * historically emitted Chinese nicknames in two incompatible ways on the
 * wire — UTF-8 (modern) and GBK (legacy OneAPI/Go). `Response.text()` follows
 * the Content-Type header, which is often missing or wrong, so we read the
 * raw bytes and pick the decoder that actually parses. Exported for tests so
 * the GBK fallback can be exercised byte-for-byte without going through fetch.
 */
export function decodeResponseBody(buffer: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(buffer)
  }
}

export interface TokenPlatformDeviceLoginRequest {
  login_id: string
  expires_at: number
  appid: string
  state: string
  redirect_uri: string
}

export type TokenPlatformDeviceLoginStatus =
  | { status: 'pending' }
  | { status: 'expired' }
  | {
      status: 'approved'
      device: { device_id: number; name: string }
      api: { api_base: string; api_key: string; models: string[] }
    }

export interface TokenPlatformUserProfile {
  id: number
  username: string
  display_name?: string
  avatar_url?: string
  role?: number
  status?: number
  email?: string
  phone?: string
  wechat_id?: string
  group?: string
  quota?: number
  used_quota?: number
}

interface ApiEnvelope {
  success: boolean
  message?: string
  data?: unknown
}

async function requestJson(
  url: string,
  init: RequestInit = {},
): Promise<ApiEnvelope> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: controller.signal })
    // Decode the body robustly: see decodeResponseBody for the strategy.
    const buffer = new Uint8Array(await res.arrayBuffer())
    const text = decodeResponseBody(buffer)
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Token Platform request failed')
      return { success: false, message: `HTTP ${res.status}` }
    }
    return (json as ApiEnvelope) || { success: false, message: `HTTP ${res.status}` }
  } catch (err: any) {
    logger.warn({ errorName: err instanceof Error ? err.name : 'UnknownError' }, 'Token Platform request error')
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export function tokenPlatformBaseUrl(): string {
  return process.env.TOKEN_PLATFORM_BASE_URL?.trim() || 'https://api.quantclaw.vip'
}

/** Device approval can return an origin, never an arbitrary network destination. */
export function validateTokenPlatformBaseUrl(value: string): string {
  const configured = new URL(tokenPlatformBaseUrl())
  const candidate = new URL(value)
  if (!['http:', 'https:'].includes(configured.protocol)
    || configured.username || configured.password || configured.search || configured.hash
    || candidate.username || candidate.password || candidate.search || candidate.hash
    || configured.href.replace(/\/+$/, '') !== candidate.href.replace(/\/+$/, '')) {
    throw new Error('Device approval does not match the configured Token Platform')
  }
  return configured.href.replace(/\/+$/, '')
}

function deviceLoginUrl(path: string): string {
  const base = tokenPlatformBaseUrl().replace(/\/+$/, '')
  return `${base}${path}`
}

/**
 * Request a new pending device login session and return the QR parameters.
 */
export async function requestDeviceLogin(
  hardwareId: string,
  deviceName: string,
): Promise<TokenPlatformDeviceLoginRequest> {
  const res = await requestJson(deviceLoginUrl('/api/device-login/request'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hardware_id: hardwareId, device_name: deviceName }),
  })
  if (!res.success || !res.data) {
    throw new Error(res.message || 'Failed to start device login')
  }
  const data = res.data as TokenPlatformDeviceLoginRequest
  if (!data?.login_id || !data.appid || !data.state) {
    throw new Error('Invalid device login response')
  }
  return data
}

/**
 * Poll the device login status until approved/expired.
 */
export async function pollDeviceLoginStatus(
  loginId: string,
): Promise<TokenPlatformDeviceLoginStatus> {
  const res = await requestJson(
    deviceLoginUrl(`/api/device-login/status?login_id=${encodeURIComponent(loginId)}`),
  )
  if (!res.success || !res.data) {
    throw new Error(res.message || 'Failed to poll device login status')
  }
  return res.data as TokenPlatformDeviceLoginStatus
}

/**
 * Fetch the bound user profile using the device's dedicated API key.
 *
 * The Token Platform has a known encoding bug on its side: Chinese
 * nicknames are sent over the wire as "double-UTF-8" mojibake (UTF-8 bytes
 * were read as Latin1 characters and re-encoded as UTF-8 by the upstream
 * backend). We detect this on every call and recover the real nickname
 * transparently so callers never see mojibake.
 */
export async function fetchDeviceSelf(
  apiBase: string,
  apiKey: string,
): Promise<TokenPlatformUserProfile> {
  const base = validateTokenPlatformBaseUrl(apiBase)
  const res = await requestJson(`${base}/api/device/self`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.success || !res.data) {
    throw new Error(res.message || 'Failed to fetch device profile')
  }
  // Fix the upstream double-UTF-8 mojibake for every string field
  // (display_name, username, email, …). Non-mojibake values pass through.
  return reverseDoubleUtf8Fields(res.data as TokenPlatformUserProfile)
}

/**
 * Verify a device API key against the Token Platform by fetching its models.
 * Returns the list of usable models, or throws when the key is invalid.
 */
export async function verifyDeviceApiKey(
  apiBase: string,
  apiKey: string,
): Promise<string[]> {
  const base = validateTokenPlatformBaseUrl(apiBase)
  const res = await requestJson(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.success || !res.data) {
    throw new Error(res.message || 'API key verification failed')
  }
  const data = res.data as { data?: Array<{ id?: string }> }
  const ids = (data?.data || [])
    .map(model => model?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  return ids
}
