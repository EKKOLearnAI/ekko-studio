export const PROVIDER_IMPORT_SCHEME = 'ekko-studio'

/** Accept only our import route. Never log incoming links: they may carry keys. */
export function providerImportPayload(link: string): string | null {
  if (link.length > 33_000) return null
  try {
    const url = new URL(link)
    if (url.protocol !== `${PROVIDER_IMPORT_SCHEME}:` || url.hostname !== 'import'
      || url.pathname !== '/provider' || url.username || url.password || url.port || url.hash) return null
    const keys = [...url.searchParams.keys()]
    const data = url.searchParams.get('data') || ''
    return keys.length === 1 && keys[0] === 'data' && data.length <= 32_768
      && /^[A-Za-z0-9_-]+$/.test(data) ? data : null
  } catch { return null }
}

export function providerImportFromArgs(args: string[]): string | null {
  for (const arg of args) {
    const data = providerImportPayload(arg)
    if (data) return data
  }
  return null
}

export function providerImportTarget(serverUrl: string, data: string): string {
  if (!data || data.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(data)) throw new Error('Invalid provider import')
  const target = new URL(serverUrl)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid Studio address')
  // The configured server origin and subpath are never supplied by the link.
  target.hash = `/hermes/models?importProvider=${data}`
  return target.toString()
}
