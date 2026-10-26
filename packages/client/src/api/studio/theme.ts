import type { ThemeAppearance } from '../../../../shared/theme-appearance'
import {
  ensureDesktopAuthReady,
  getApiKey,
  getBaseUrlValue,
  request,
} from '../client'

export interface UserThemeSettings {
  activePresetId?: string
  brightness?: 'system' | 'light' | 'dark'
  style?: 'ink' | 'comic'
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance?: ThemeAppearance
  background: {
    name: string
    mime: string | null
    updatedAt: number
  } | null
  updatedAt: number
}

const BACKGROUND_CACHE_NAME = 'hermes-theme-background-v1'

function backgroundCacheKey(userId: number, version: number): string {
  const origin = typeof window === 'undefined' ? 'http://hermes.local' : window.location.origin
  return new URL(`/__hermes-theme-background/${userId}/${version}`, origin).toString()
}

async function themeFetch(path: string, options: RequestInit = {}): Promise<Response> {
  await ensureDesktopAuthReady()
  const headers = new Headers(options.headers)
  const token = getApiKey()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(`${getBaseUrlValue()}${path}`, { ...options, headers })
}

export function fetchThemeSettings(): Promise<UserThemeSettings> {
  return request<UserThemeSettings>('/api/theme')
}

export function updateThemeSettings(
  patch: Partial<Pick<UserThemeSettings, 'fontSize' | 'textColor' | 'accentColor' | 'appearance' | 'brightness' | 'style'>> & { presetId?: string },
): Promise<UserThemeSettings> {
  return request<UserThemeSettings>('/api/theme', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

export function uploadThemeBackground(file: File, presetId?: string): Promise<UserThemeSettings> {
  const formData = new FormData()
  formData.append('background', file)
  return request<UserThemeSettings>(backgroundPath(presetId), {
    method: 'POST',
    body: formData,
  })
}

export function deleteThemeBackground(presetId?: string): Promise<UserThemeSettings> {
  return request<UserThemeSettings>(backgroundPath(presetId), {
    method: 'DELETE',
  })
}

export async function fetchThemeBackgroundBlob(
  userId: number,
  version: number,
  refresh = false,
  presetId?: string,
): Promise<Blob> {
  const cacheKey = backgroundCacheKey(userId, version)
  const cache = typeof caches === 'undefined'
    ? null
    : await caches.open(BACKGROUND_CACHE_NAME).catch(() => null)
  if (!refresh) {
    const cached = await cache?.match(cacheKey).catch(() => undefined)
    if (cached) return cached.blob()
  }

  const response = await themeFetch(`/api/theme/background?v=${encodeURIComponent(version)}${presetId ? `&presetId=${encodeURIComponent(presetId)}` : ''}`)
  if (!response.ok) throw new Error(`Failed to load theme background (${response.status})`)
  const blob = await response.blob()
  if (cache) {
    const prefix = `/__hermes-theme-background/${userId}/`
    const requests = await cache.keys().catch(() => [])
    await Promise.all(requests
      .filter(entry => {
        const url = new URL(entry.url)
        return url.pathname.startsWith(prefix) && entry.url !== cacheKey
      })
      .map(entry => cache.delete(entry).catch(() => false)))
    await cache.put(
      cacheKey,
      new Response(blob, { headers: { 'Content-Type': blob.type } }),
    ).catch(() => undefined)
  }
  return blob
}

export async function clearThemeBackgroundCache(userId: number): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(BACKGROUND_CACHE_NAME).catch(() => null)
  if (!cache) return
  const prefix = `/__hermes-theme-background/${userId}/`
  const requests = await cache.keys().catch(() => [])
  await Promise.all(requests
    .filter(entry => new URL(entry.url).pathname.startsWith(prefix))
    .map(entry => cache.delete(entry).catch(() => false)))
}

export interface ThemePreset extends UserThemeSettings { id: string; name: string }
export interface ThemeLibrary { activeId: string; themes: ThemePreset[] }
export interface ThemeLibraryChange extends ThemeLibrary { theme: UserThemeSettings }

function backgroundPath(presetId?: string): string {
  return `/api/theme/background${presetId ? `?presetId=${encodeURIComponent(presetId)}` : ''}`
}

export function fetchThemePresets(): Promise<ThemeLibrary> {
  return request('/api/theme/presets')
}
export function createThemePreset(input: { name: string; sourceId?: string; brightness: UserThemeSettings['brightness']; style: UserThemeSettings['style'] }): Promise<ThemeLibraryChange> {
  return request('/api/theme/presets', { method: 'POST', body: JSON.stringify(input) })
}
export function renameThemePreset(id: string, name: string): Promise<ThemeLibrary> {
  return request(`/api/theme/presets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}
export function activateThemePreset(id: string): Promise<ThemeLibraryChange> {
  return request(`/api/theme/presets/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}
export function deleteThemePreset(id: string): Promise<ThemeLibraryChange> {
  return request(`/api/theme/presets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

type ThemePreferences = { brightness: string; style: string }

export function importThemeArchive(file: File, preferences: ThemePreferences): Promise<ThemeLibraryChange> {
  return request(`/api/theme/presets/import?${new URLSearchParams(preferences)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
  })
}

export async function exportThemeArchive(id: string, preferences: ThemePreferences): Promise<Blob> {
  const response = await themeFetch(`/api/theme/presets/${encodeURIComponent(id)}/export?${new URLSearchParams(preferences)}`)
  if (!response.ok) throw new Error(`Failed to export theme (${response.status})`)
  return response.blob()
}
