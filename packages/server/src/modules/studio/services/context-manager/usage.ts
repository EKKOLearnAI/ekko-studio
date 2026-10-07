export interface ExternalContextUsage {
  manager: 'bili'
  conversationId: string
  model: string
  tokens: number
  source: 'usage' | 'estimate'
  observedAt: number
  generation: string
  window: number
}

export function selectExternalContextUsage(
  status: unknown,
  target: { conversationId: string; model: string; now?: number; maxAgeMs?: number },
): ExternalContextUsage | undefined {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined
  const value = status as Record<string, unknown>
  const now = target.now ?? Date.now()
  const maxAge = target.maxAgeMs ?? 15 * 60 * 1_000
  const tokens = value.contextTokens
  const observedAt = value.contextTokensAt
  const window = value.contextLimit
  if (value.ok !== true || value.fallback === true
    || value.conversationId !== target.conversationId || value.model !== target.model
    || (value.contextTokensSource !== 'usage' && value.contextTokensSource !== 'estimate')
    || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0
    || typeof observedAt !== 'number' || !Number.isFinite(observedAt)
    || observedAt < now - maxAge || observedAt > now + 60_000
    || typeof window !== 'number' || !Number.isFinite(window) || window <= 0
    || typeof value.contextGeneration !== 'string' || !value.contextGeneration
    || typeof value.requests !== 'number' || value.requests <= 0) return undefined
  return {
    manager: 'bili',
    conversationId: target.conversationId,
    model: target.model,
    tokens: Math.floor(tokens),
    source: value.contextTokensSource,
    observedAt,
    generation: value.contextGeneration,
    window: Math.floor(window),
  }
}