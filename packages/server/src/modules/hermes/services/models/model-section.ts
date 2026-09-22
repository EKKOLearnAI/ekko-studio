const MODEL_BINDING_KEYS = new Set(['default', 'provider', 'base_url', 'api_key'])

export function isPlainModelSection(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function preservedModelKeys(section: unknown): Record<string, any> {
  if (!isPlainModelSection(section)) return {}
  return Object.fromEntries(
    Object.entries(section).filter(([key]) => !MODEL_BINDING_KEYS.has(key)),
  )
}
