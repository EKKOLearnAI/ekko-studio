/** Persisted defaults and runtime overrides use the same JEV settings. */
export interface EkkoJevConfig {
  enabled: boolean
  /** Allow memory to use JEV independently of other JEV consumers. */
  memoryEnabled: boolean
  memoryKindRoutingEnabled: boolean
  memoryRelevanceFilterEnabled: boolean
  memoryRerankEnabled: boolean
  memoryWriteReviewEnabled: boolean
  memoryCandidateLimit: number
  /** Relevance probability for routing; minimum ranking confidence for recall. */
  memoryRecallMinConfidence: number
  /** Minimum confidence for write-review decisions only. */
  memoryMinConfidence: number
  /** Discard irrelevant cards only at this confidence; uncertain cards remain. */
  memoryFilterMinConfidence: number
  /** Total budget per automatic recall or write batch, including all JEV stages. */
  memoryTimeoutMs: number
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}

/** Undefined fields inherit; false explicitly disables JEV. Overrides are never persisted. */
export type EkkoJevOverrides = Partial<EkkoJevConfig> | false

export const DEFAULT_EKKO_JEV_CONFIG: Readonly<EkkoJevConfig> = Object.freeze({
  enabled: false,
  memoryEnabled: false,
  memoryKindRoutingEnabled: false,
  memoryRelevanceFilterEnabled: false,
  memoryRerankEnabled: false,
  memoryWriteReviewEnabled: false,
  memoryCandidateLimit: 20,
  memoryRecallMinConfidence: 0.5,
  memoryMinConfidence: 0.8,
  memoryFilterMinConfidence: 0.8,
  memoryTimeoutMs: 3000,
  apiKey: '',
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 10_000,
})

/** Later layers win, including explicit false and empty keys. No environment fallback. */
export function resolveEkkoJevConfig(
  ...layers: Array<EkkoJevOverrides | undefined>
): EkkoJevConfig {
  const next = { ...DEFAULT_EKKO_JEV_CONFIG }
  for (const layer of layers) {
    if (layer === undefined) continue
    if (layer === false) { next.enabled = false; continue }
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      throw new TypeError('JEV configuration must be an object or false.')
    }
    for (const key of Object.keys(next) as Array<keyof EkkoJevConfig>) {
      if (layer[key] !== undefined) Object.assign(next, { [key]: layer[key] })
    }
  }
  if (typeof next.enabled !== 'boolean') throw new TypeError('JEV enabled must be a boolean.')
  if (typeof next.memoryEnabled !== 'boolean') throw new TypeError('JEV memoryEnabled must be a boolean.')
  for (const key of ['memoryKindRoutingEnabled', 'memoryRelevanceFilterEnabled', 'memoryRerankEnabled', 'memoryWriteReviewEnabled'] as const) {
    if (typeof next[key] !== 'boolean') throw new TypeError(`JEV ${key} must be a boolean.`)
  }
  if (!Number.isInteger(next.memoryCandidateLimit) || next.memoryCandidateLimit < 1 || next.memoryCandidateLimit > 50) {
    throw new TypeError('JEV memory candidate limit must be between 1 and 50.')
  }
  if (!Number.isFinite(next.memoryMinConfidence) || next.memoryMinConfidence < 0.5 || next.memoryMinConfidence > 1) {
    throw new TypeError('JEV memory confidence must be between 0.5 and 1.')
  }
  if (!Number.isFinite(next.memoryRecallMinConfidence) || next.memoryRecallMinConfidence < 0.5 || next.memoryRecallMinConfidence > 1) {
    throw new TypeError('JEV memory recall confidence must be between 0.5 and 1.')
  }
  if (!Number.isFinite(next.memoryFilterMinConfidence) || next.memoryFilterMinConfidence < 0.5 || next.memoryFilterMinConfidence > 1) {
    throw new TypeError('JEV memory filter confidence must be between 0.5 and 1.')
  }
  if (!Number.isInteger(next.memoryTimeoutMs) || next.memoryTimeoutMs < 100 || next.memoryTimeoutMs > 30_000) {
    throw new TypeError('JEV memory timeout must be between 100 and 30000 ms.')
  }
  for (const key of ['apiKey', 'baseUrl', 'model'] as const) {
    if (typeof next[key] !== 'string' || next[key].length > 4096 || /[\r\n]/.test(next[key])) {
      throw new TypeError(`Invalid JEV ${key}.`)
    }
    next[key] = next[key].trim()
  }
  if (!next.model || next.model.length > 200) throw new TypeError('Invalid JEV model.')
  if (!Number.isInteger(next.timeoutMs) || next.timeoutMs < 1000 || next.timeoutMs > 120_000) {
    throw new TypeError('JEV timeout must be between 1000 and 120000 ms.')
  }
  let url: URL
  try { url = new URL(next.baseUrl) } catch { throw new TypeError('Invalid JEV base URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('JEV base URL must use HTTP(S) without credentials, query or fragment.')
  }
  next.baseUrl = url.toString().replace(/\/+$/, '')
  return next
}
