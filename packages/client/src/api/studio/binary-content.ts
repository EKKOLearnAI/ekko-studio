import { ensureDesktopAuthReady, getActiveProfileName, getApiKey, getBaseUrlValue } from '../client'

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const error = (value as Record<string, unknown>).error
  return typeof error === 'string' && error.trim() ? error : fallback
}

export async function fetchAuthenticatedBlob(
  path: string,
  options: { signal?: AbortSignal; profile?: string | null } = {},
): Promise<Blob> {
  await ensureDesktopAuthReady()
  const headers: Record<string, string> = {}
  const apiKey = getApiKey()
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const profile = typeof options.profile === 'string' && options.profile.trim()
    ? options.profile.trim()
    : getActiveProfileName()
  if (profile) headers['X-Hermes-Profile'] = profile

  const response = await fetch(`${getBaseUrlValue()}${path}`, {
    headers,
    signal: options.signal,
    cache: 'no-store',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(errorMessage(body, `Preview failed: HTTP ${response.status}`))
  }
  return response.blob()
}

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
