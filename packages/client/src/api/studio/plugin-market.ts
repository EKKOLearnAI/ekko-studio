import { PLUGIN_CATALOG_URL, normalizePluginRepository, parsePluginRelease, repositoryStars, type PluginRelease } from './plugin-releases'

export interface MarketPlugin {
  id: string
  repository: string
  repositoryStars: number | null
  name: string
  description: string
  manifestId: string | null
  version: string | null
  permissions: string[]
  keywords: string[]
  author?: { name: string }
  iconUrl?: string
  license?: string
  release: PluginRelease | null
}

function marketPlugin(value: any): MarketPlugin {
  const repository = normalizePluginRepository(value?.repository)
  const permissions = value?.permissions
  if (!repository || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 160
    || typeof value.description !== 'string' || value.description.length > 4000
    || !Array.isArray(permissions) || permissions.some((item: unknown) => typeof item !== 'string')) throw new Error('Invalid plugin catalog entry')
  let release: PluginRelease | null = null
  // Invalid publications cannot be installed.
  try { release = parsePluginRelease(value, repository) } catch { /* Unverified releases have no install action. */ }
  return {
    id: value.id, repository, repositoryStars: repositoryStars(value.repositoryStars, repository), name: value.name, description: value.description,
    manifestId: typeof value.manifestId === 'string' ? value.manifestId : null,
    version: typeof value.version === 'string' ? value.version : null,
    permissions: permissions,
    keywords: Array.isArray(value.keywords) ? value.keywords.filter((item: unknown) => typeof item === 'string') : [],
    ...(typeof value.author?.name === 'string' ? { author: { name: value.author.name } } : {}),
    ...(typeof value.iconUrl === 'string' ? { iconUrl: value.iconUrl } : {}),
    ...(typeof value.license === 'string' ? { license: value.license } : {}),
    release,
  }
}

/** Fetch the published count without downloading catalog entries. */
export async function fetchPluginMarketCount(signal: AbortSignal): Promise<number> {
  const response = await fetch(`${PLUGIN_CATALOG_URL}/count`, {
    credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  if (!response.ok) throw new Error('Plugin catalog count unavailable')
  const body = await response.json(), total = body?.data?.total
  if (body?.ok !== true || !Number.isSafeInteger(total) || total < 0) throw new Error('Invalid plugin catalog count response')
  return total
}

/** Load every page before filtering, so categories/search include the entire directory. */
export async function fetchPluginMarket(signal: AbortSignal): Promise<MarketPlugin[]> {
  const entries = new Map<string, MarketPlugin>()
  const pageSize = 100
  let pages = 1
  for (let page = 1; page <= pages; page++) {
    const response = await fetch(`${PLUGIN_CATALOG_URL}?${new URLSearchParams({ page: String(page), pageSize: String(pageSize) })}`, {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', headers: { Accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    })
    if (!response.ok) throw new Error('Plugin catalog unavailable')
    const body = await response.json(), data = body?.data
    if (body?.ok !== true || !Array.isArray(data?.list) || data.list.length > pageSize
      || data.page !== page || data.pageSize !== pageSize || !Number.isSafeInteger(data.total) || data.total < 0
      || (data.total > (page - 1) * pageSize && !data.list.length)) throw new Error('Invalid plugin catalog response')
    // Snapshot the initial page count; concurrent publications cannot extend this request indefinitely.
    if (page === 1) pages = Math.ceil(data.total / pageSize)
    for (const value of data.list) { const entry = marketPlugin(value); entries.set(entry.id, entry) }
  }
  return [...entries.values()]
}
