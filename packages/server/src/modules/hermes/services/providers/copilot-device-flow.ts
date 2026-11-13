/**
 * GitHub OAuth Device Flow for Copilot login.
 *
 * Mirrors the upstream hermes-agent implementation
 * (`hermes_cli/copilot_auth.py:155-275`):
 *   - POST https://github.com/login/device/code  → device_code, user_code, verification_uri
 *   - POST https://github.com/login/oauth/access_token → access_token (after user approves)
 *   - Polling rules per RFC 8628: authorization_pending, slow_down, expired_token, access_denied
 *
 * Client ID `Ov23li8tweQw6odWQebz` is reused from upstream hermes-agent for now;
 * a dedicated web-ui OAuth App can be registered later without changing the protocol.
 */

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const COPILOT_OAUTH_CLIENT_ID = 'Ov23li8tweQw6odWQebz'
export const COPILOT_OAUTH_SCOPE = 'read:user'
const FETCH_TIMEOUT_MS = 15_000

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface AccessTokenSuccess {
  kind: 'success'
  access_token: string
  token_type: string
  scope: string
}

export interface AccessTokenPending {
  kind: 'pending'
}

export interface AccessTokenSlowDown {
  kind: 'slow_down'
}

export interface AccessTokenDenied {
  kind: 'denied'
}

export interface AccessTokenExpired {
  kind: 'expired'
}

export interface AccessTokenError {
  kind: 'error'
  error: string
  description?: string
}

export type AccessTokenResult =
  | AccessTokenSuccess
  | AccessTokenPending
  | AccessTokenSlowDown
  | AccessTokenDenied
  | AccessTokenExpired
  | AccessTokenError

/**
 * Request a fresh device code from GitHub. Throws on network failure or non-2xx.
 */
export async function startDeviceFlow(
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const res = await fetchImpl(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: COPILOT_OAUTH_CLIENT_ID,
      scope: COPILOT_OAUTH_SCOPE,
    }).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub device code request failed: ${res.status} ${text}`)
  }

  const data = await res.json() as Partial<DeviceCodeResponse>
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error('GitHub device code response missing required fields')
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    expires_in: typeof data.expires_in === 'number' ? data.expires_in : 900,
    interval: typeof data.interval === 'number' && data.interval > 0 ? data.interval : 5,
  }
}

/**
 * Poll the access-token endpoint once. Caller is responsible for sleeping the
 * server-suggested `interval` between calls and handling slow_down/expired.
 */
export async function pollDeviceFlow(
  deviceCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccessTokenResult> {
  let res: Response
  try {
    res = await fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: COPILOT_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err: any) {
    return { kind: 'error', error: 'network', description: err?.message ?? String(err) }
  }

  let body: any
  try {
    body = await res.json()
  } catch {
    return { kind: 'error', error: 'parse', description: `HTTP ${res.status}` }
  }

  if (body && typeof body.access_token === 'string' && body.access_token) {
    return {
      kind: 'success',
      access_token: body.access_token,
      token_type: body.token_type ?? 'bearer',
      scope: body.scope ?? COPILOT_OAUTH_SCOPE,
    }
  }

  const code = typeof body?.error === 'string' ? body.error : 'unknown_error'
  switch (code) {
    case 'authorization_pending':
      return { kind: 'pending' }
    case 'slow_down':
      return { kind: 'slow_down' }
    case 'access_denied':
      return { kind: 'denied' }
    case 'expired_token':
      return { kind: 'expired' }
    default:
      return { kind: 'error', error: code, description: body?.error_description }
  }
}
