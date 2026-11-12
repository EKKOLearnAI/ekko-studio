export const PLUGIN_CATALOG_URL = 'https://api.ekkostudio.xyz/api/studio/plugins'
export interface PluginRelease {
  id: string; repository: string; manifestId: string; version: string; apiVersion: number
  sourceCommit: string; installSource: string; iconUrl?: string | null
  repositoryStars?: number | null
}

export function repositoryStars(value: unknown, repository: string): number | null {
  const canonical = normalizePluginRepository(repository)
  return canonical && new URL(canonical).hostname === 'github.com'
    && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 4_294_967_295 ? value : null
}

export function normalizePluginRepository(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /\s|\\/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.search || url.hash || url.port
      || !['github.com', 'gitlab.com', 'gitee.com'].includes(url.hostname)) return null
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
    const parts = url.pathname.slice(1).split('/')
    if (parts.length < 2 || (url.hostname !== 'gitlab.com' && parts.length !== 2)
      || parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) return null
    if (url.hostname === 'github.com') url.pathname = url.pathname.toLowerCase()
    return url.toString()
  } catch { return null }
}

export async function fetchPluginRelease(repository: string, signal?: AbortSignal): Promise<PluginRelease | null> {
  const canonical = normalizePluginRepository(repository)
  if (!canonical) return null
  // The public cloud directory never receives a Studio token, cookie, or profile.
  const response = await fetch(`${PLUGIN_CATALOG_URL}?${new URLSearchParams({ repository: canonical, pageSize: '1' })}`, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Plugin catalog unavailable')
  const body = await response.json()
  if (body?.ok !== true || !Array.isArray(body?.data?.list)) throw new Error('Invalid plugin catalog response')
  return parsePluginRelease(body.data.list[0], canonical)
}

export function parsePluginRelease(release: any, canonical: string): PluginRelease | null {
  if (!release) return null
  if (typeof release.id !== 'string' || !/^[a-f0-9]{64}$/.test(release.id) || normalizePluginRepository(release.repository) !== canonical) throw new Error('Invalid plugin catalog response')
  if (!release.version || !release.manifestId || !release.sourceCommit) return null
  if (typeof release.manifestId !== 'string' || typeof release.version !== 'string' || release.apiVersion !== 1
    || !/^[a-z][a-z0-9._-]{0,79}$/.test(release.manifestId) || release.manifestId.includes('..')
    || ['constructor', 'prototype', '__proto__'].includes(release.manifestId)
    || release.version.length > 128 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.version)
    || !/^[a-f0-9]{40}$/.test(release.sourceCommit)) throw new Error('Invalid plugin release')
  const url = new URL(canonical), path = url.pathname.slice(1)
  const installSource = url.hostname === 'github.com' ? `github:${path}#${release.sourceCommit}`
    : `git+https://${url.hostname}/${path}.git#${release.sourceCommit}`
  if (release.installSource !== installSource) throw new Error('Invalid plugin release source')
  return { ...release, repository: canonical, installSource,
    ...(release.repositoryStars !== undefined ? { repositoryStars: repositoryStars(release.repositoryStars, canonical) } : {}) }
}
