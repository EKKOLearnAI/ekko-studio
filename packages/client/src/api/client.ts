import router from '@/router'
import { invalidateAuth } from './auth-invalidation'

const DEFAULT_BASE_URL = ''
const ACTIVE_PROFILE_STORAGE_KEY = 'hermes_active_profile_name'

function isDesktopShell(): boolean {
  return typeof window !== 'undefined' &&
    (window as typeof window & { hermesDesktop?: { isDesktop?: boolean } }).hermesDesktop?.isDesktop === true
}

export async function ensureDesktopAuthReady(): Promise<void> {
  if (typeof window === 'undefined' || getApiKey()) return
  const bridge = (window as typeof window & {
    hermesDesktop?: { isDesktop?: boolean; ensureAuth?: () => Promise<boolean> }
  }).hermesDesktop
  if (bridge?.isDesktop === true && bridge.ensureAuth) {
    await bridge.ensureAuth().catch(() => false)
  }
}

function getBaseUrl(): string {
  if (import.meta.env.VITE_HERMES_PREVIEW === '1') return DEFAULT_BASE_URL
  if (isDesktopShell()) return DEFAULT_BASE_URL
  return localStorage.getItem('hermes_server_url') || DEFAULT_BASE_URL
}

export function getApiKey(): string {
  return localStorage.getItem('hermes_api_key') || ''
}

export function setServerUrl(url: string) {
  const previousBase = getBaseUrl()
  localStorage.setItem('hermes_server_url', url)
  if (getBaseUrl() !== previousBase) invalidateAuth()
}

export function setApiKey(key: string) {
  const changed = getApiKey() !== key
  localStorage.setItem('hermes_api_key', key)
  if (changed) invalidateAuth()
}

export function clearApiKey() {
  localStorage.removeItem('hermes_api_key')
  invalidateAuth()
}

function clearAuthSessionState() {
  clearApiKey()
  localStorage.removeItem(ACTIVE_PROFILE_STORAGE_KEY)
}

export function hasApiKey(): boolean {
  return !!getApiKey()
}

export type StoredUserRole = 'super_admin' | 'admin'

export function getStoredUserRole(): StoredUserRole | null {
  const token = getApiKey()
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data = JSON.parse(atob(padded)) as { role?: unknown }
    return data.role === 'super_admin' || data.role === 'admin' ? data.role : null
  } catch {
    return null
  }
}

export function isStoredSuperAdmin(): boolean {
  return getStoredUserRole() === 'super_admin'
}

export function getStoredUsername(): string | null {
  const token = getApiKey()
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data = JSON.parse(atob(padded)) as { username?: unknown }
    return typeof data.username === 'string' && data.username.length > 0 ? data.username : null
  } catch {
    return null
  }
}

export function getStoredUserId(): number | null {
  const token = getApiKey()
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const data = JSON.parse(atob(padded)) as { sub?: unknown }
    const userId = Number(data.sub)
    return Number.isInteger(userId) && userId > 0 ? userId : null
  } catch {
    return null
  }
}

export function getActiveProfileName(): string | null {
  return localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
}

function bodyHasProfileSelector(body: BodyInit | null | undefined): boolean {
  if (typeof body !== 'string') return false
  try {
    const parsed = JSON.parse(body) as { profile?: unknown }
    return typeof parsed?.profile === 'string' && parsed.profile.trim().length > 0
  } catch {
    return false
  }
}

function shouldAttachProfileHeader(path: string, options: RequestInit): boolean {
  try {
    const url = new URL(path, 'http://hermes.local')
    if (url.searchParams.has('profile')) return false
    if (url.pathname.startsWith('/api/hermes/profiles')) return false
    if (url.pathname.startsWith('/api/theme')) return false
    if (isProfileWideSessionCollection(url.pathname)) return false
  } catch {
    if (path.startsWith('/api/hermes/profiles')) return false
    if (path.startsWith('/api/theme')) return false
    if (isProfileWideSessionCollection(path.split('?')[0] || path)) return false
  }
  return !bodyHasProfileSelector(options.body)
}

function isProfileWideSessionCollection(pathname: string): boolean {
  return pathname === '/api/studio/sessions' ||
    pathname === '/api/studio/sessions/batch-delete' ||
    pathname === '/api/studio/search/sessions' ||
    pathname === '/api/studio/sessions/search' ||
    pathname === '/api/studio/sessions/conversations'
}

function emitAuthNotice(kind: 'expired' | 'forbidden') {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('hermes-auth-notice', { detail: { kind } }))
}

function messageFromErrorValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (typeof value !== 'object') return String(value)

  const record = value as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description']) {
    const message = messageFromErrorValue(record[key])
    if (message) return message
  }

  if (Array.isArray(value)) {
    return value.map(messageFromErrorValue).filter(Boolean).join('\n')
  }

  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function responseErrorMessage(text: string, statusText: string): string {
  const trimmed = text.trim()
  if (!trimmed) return statusText
  try {
    const parsed = JSON.parse(trimmed)
    return messageFromErrorValue(parsed) || trimmed
  } catch {
    return trimmed
  }
}

function responseErrorCode(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as { code?: unknown }
    return typeof parsed?.code === 'string' && parsed.code ? parsed.code : undefined
  } catch {
    return undefined
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  await ensureDesktopAuthReady()
  const base = getBaseUrl()
  const url = `${base}${path}`
  const isFormDataBody = typeof FormData !== 'undefined' && options.body instanceof FormData
  const headers: Record<string, string> = {
    ...(isFormDataBody ? {} : { 'Content-Type': 'application/json' }),
    ...options.headers as Record<string, string>,
  }

  const apiKey = getApiKey()
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // Inject active profile header for request-scoped endpoints. Explicit profile
  // selectors in the URL/body and profile-name routes are validated directly.
  const profileName = getActiveProfileName()
  if (profileName && shouldAttachProfileHeader(path, options)) {
    headers['X-Hermes-Profile'] = profileName
  }

  const res = await fetch(url, { ...options, headers })

  // Global 401 handler — only redirect to login for local BFF endpoints
  // Proxied gateway requests should not trigger logout
  const isLocalBff = !path.startsWith('/api/hermes/v1/') &&
    !path.startsWith('/v1/')

  if (res.status === 401 && isLocalBff) {
    clearAuthSessionState()
    emitAuthNotice('expired')
    if (router.currentRoute.value.name !== 'login') {
      router.replace({ name: 'login' })
    }
    throw new Error('Unauthorized')
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 403 && isLocalBff) {
      if (text.includes('User is disabled or does not exist')) {
        clearAuthSessionState()
        emitAuthNotice('expired')
        if (router.currentRoute.value.name !== 'login') {
          router.replace({ name: 'login' })
        }
      } else {
        emitAuthNotice('forbidden')
      }
    }
    throw Object.assign(
      new Error(`API Error ${res.status}: ${responseErrorMessage(text, res.statusText)}`),
      { status: res.status, code: responseErrorCode(text) },
    )
  }

  return res.json()
}

export function getBaseUrlValue(): string {
  return getBaseUrl()
}
