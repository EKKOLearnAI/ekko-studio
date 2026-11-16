/** Names are account identities, independent of endpoint, credential and Profile. */
export const providerNameKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-')

export function providerNames(config: Record<string, any>): Array<{ id: string; name: string }> {
  return [
    ...Object.entries(config.providers || {}).map(([key, value]: [string, any]) => ({ id: value?.catalog_provider || key, name: String(value?.name || key) })),
    ...(config.custom_providers || []).map((value: any) => ({ id: value.catalog_provider || `custom:${providerNameKey(value.name || '')}`, name: String(value.name || '') })),
  ]
}

export function assertUniqueProviderNames(config: Record<string, any>, labels: Record<string, string> = {}): void {
  const seen = new Map<string, number>()
  providerNames(config).forEach(({ id, name }, index) => {
    for (const value of [name, id.replace(/^custom[:_]/, ''), labels[id]]) {
      if (!value?.trim()) continue
      const key = providerNameKey(value)
      if (seen.has(key) && seen.get(key) !== index) {
        throw Object.assign(new Error(`Provider name "${value.trim()}" already exists; choose another name`), { status: 409, code: 'DUPLICATE_PROVIDER_NAME' })
      }
      seen.set(key, index)
    }
  })
}

/** Imported display preferences must not reintroduce duplicate visible names. */
export function uniqueProviderLabels(config: Record<string, any>, labels: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { id } of providerNames(config)) {
    if (!labels[id]) continue
    result[id] = labels[id]
    try { assertUniqueProviderNames(config, result) } catch { delete result[id] }
  }
  return result
}
