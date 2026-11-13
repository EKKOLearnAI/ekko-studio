import { deploymentUrl } from '@/utils/deployment-url'
import { getApiKey } from '../client'
import type { LoginResponse, UserRole } from './auth'

export class DeviceAuthError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`Device authentication failed (HTTP ${status})`)
    this.status = status
    this.code = code
  }
}

interface DeviceLoginRequest {
  login_id: string
  appid: string
  scope?: string
  state: string
  redirect_uri: string
  style?: string
}

type DeviceLoginStatus =
  | { status: 'pending' | 'expired' }
  | {
      status: 'approved'
      device: { device_id: number | string; name?: string }
      api: { api_base: string; api_key: string; models?: string[] }
    }

export interface DeviceLoginPayload {
  api_base: string
  api_key: string
  device_id: number | string
  device_name?: string
  models?: string[]
}

export interface DeviceLoginSession extends LoginResponse {
  user: {
    id: number
    username: string
    role: UserRole
    phone_number?: string | null
    active_profile?: string
  }
}

export interface DeviceLoginChoice {
  status: 'needs_choice'
  profile: { display_name: string; phone: string | null }
  options: string[]
}

function platformUrl(value: string): URL {
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error('Invalid Token Platform URL')
  }
  return url
}

async function platformRequest<T>(
  base: string,
  path: string,
  options: RequestInit & { signal: AbortSignal },
): Promise<T> {
  const res = await fetch(platformUrl(base).href.replace(/\/+$/, '') + path, {
    ...options,
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(12_000)]),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.success || !data.data) {
    throw new Error(`Token Platform request failed (HTTP ${res.status})`)
  }
  return data.data as T
}

export async function startDeviceLogin(base: string, hardwareId: string, signal: AbortSignal): Promise<DeviceLoginRequest> {
  const data = await platformRequest<DeviceLoginRequest>(base, '/api/device-login/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hardware_id: hardwareId, device_name: 'Hermes' }),
    signal,
  })
  if (![data.login_id, data.appid, data.state, data.redirect_uri].every(value => typeof value === 'string' && value)) {
    throw new Error('Invalid WeChat login request')
  }
  const callback = new URL(data.redirect_uri)
  if (callback.origin !== platformUrl(base).origin || callback.username || callback.password || callback.hash) {
    throw new Error('WeChat callback does not match the configured Token Platform')
  }
  return data
}

export async function getDeviceLoginStatus(base: string, loginId: string, signal: AbortSignal): Promise<DeviceLoginStatus> {
  const status = await platformRequest<DeviceLoginStatus>(base, `/api/device-login/status?login_id=${encodeURIComponent(loginId)}`, { signal })
  if (status.status === 'pending' || status.status === 'expired') return status
  if (status.status !== 'approved'
    || typeof status.api?.api_base !== 'string'
    || platformUrl(status.api.api_base).href.replace(/\/+$/, '') !== platformUrl(base).href.replace(/\/+$/, '')
    || typeof status.api.api_key !== 'string' || !status.api.api_key
    || !(typeof status.device?.device_id === 'number' || typeof status.device?.device_id === 'string')) {
    throw new Error('Invalid WeChat device approval')
  }
  return status
}

export function weChatQrConnectUrl(data: DeviceLoginRequest): string {
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect')
  url.search = new URLSearchParams({
    appid: data.appid,
    scope: data.scope || 'snsapi_login',
    redirect_uri: data.redirect_uri,
    state: data.state,
    style: data.style || 'white',
    self_redirect: 'true',
  }).toString()
  return url.toString()
}

// Verification errors on the login screen must not trigger the authenticated API's global 401 redirect.
async function submitDeviceAuth<T>(
  path: string,
  method: 'POST' | 'DELETE',
  body: object,
  signal?: AbortSignal,
  authenticated = false,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authenticated) {
    const token = getApiKey()
    if (!token) throw new Error('Unauthorized')
    headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(deploymentUrl(`/api/auth${path}`), {
    method,
    headers,
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data) {
    throw new DeviceAuthError(res.status, typeof data?.code === 'string' ? data.code : '')
  }
  return data as T
}

export function deviceAuthErrorKey(error: unknown, fallback = 'login.deviceLoginFailed'): string {
  if (!(error instanceof DeviceAuthError)) return fallback
  if (error.status === 401) return 'login.invalidCredentials'
  if (error.status === 429) return 'login.tooManyAttempts'
  if (error.code === 'ADMIN_SETUP_REQUIRED') return 'login.wechatAdminSetupRequired'
  return fallback
}

function validateSession(value: unknown): DeviceLoginSession {
  const session = value as Partial<DeviceLoginSession> | null
  if (typeof session?.token !== 'string' || !session.token || !Number.isSafeInteger(session.user?.id)) {
    throw new Error('Invalid local sign-in result')
  }
  return session as DeviceLoginSession
}

export async function completeDeviceLogin(input: DeviceLoginPayload, signal: AbortSignal): Promise<DeviceLoginSession | DeviceLoginChoice> {
  const result = await submitDeviceAuth<DeviceLoginSession | DeviceLoginChoice>('/device-login', 'POST', input, signal)
  if ('status' in result && result.status === 'needs_choice' && Array.isArray(result.options) && result.profile) {
    return result
  }
  return validateSession(result)
}

export async function createDeviceAccount(
  input: DeviceLoginPayload & { username: string; password: string; phone?: string },
  signal: AbortSignal,
): Promise<DeviceLoginSession> {
  return validateSession(await submitDeviceAuth('/device-login/create-user', 'POST', input, signal))
}

export async function bindDeviceAccount(
  input: DeviceLoginPayload & { identifier: string; password: string },
  signal: AbortSignal,
  authenticated = false,
): Promise<DeviceLoginSession> {
  return validateSession(await submitDeviceAuth('/device-login/bind-by-credentials', 'POST', input, signal, authenticated))
}

export function unbindDeviceAccount(currentPassword: string): Promise<{ hadBinding: boolean }> {
  return submitDeviceAuth('/device-binding', 'DELETE', { currentPassword }, undefined, true)
}

export function bindAccountPhone(phone: string): Promise<{ phone_number: string }> {
  return submitDeviceAuth('/bind-phone', 'POST', { phone }, undefined, true)
}

export function unbindAccountPhone(): Promise<void> {
  return submitDeviceAuth('/phone', 'DELETE', {}, undefined, true)
}

export function setInitialAccountPassword(newPassword: string): Promise<void> {
  return submitDeviceAuth('/set-password', 'POST', { newPassword }, undefined, true)
}
