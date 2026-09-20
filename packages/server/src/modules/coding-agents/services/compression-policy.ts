export interface CodingAgentCompressionPolicy {
  enabled: boolean
  threshold: number
  targetRatio: number
  contextWindow: number
  triggerTokens: number
  reserveTokens: number
  keepRecentTokens: number
  thresholdPercent: number
}

function clampRatio(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

export function resolveCodingAgentCompressionPolicy(
  config: Record<string, any> | null | undefined,
  contextWindow: number,
): CodingAgentCompressionPolicy {
  const raw = config?.compression && typeof config.compression === 'object' && !Array.isArray(config.compression)
    ? config.compression
    : {}
  const normalizedWindow = Math.max(1, Math.floor(contextWindow))
  const threshold = clampRatio(raw.threshold, 0.5, 0.05, 0.95)
  const targetRatio = Math.round(Math.min(
    threshold - 0.01,
    clampRatio(raw.target_ratio, 0.2, 0.01, 0.8),
  ) * 1000) / 1000
  const triggerTokens = Math.max(1, Math.floor(normalizedWindow * threshold))

  return {
    enabled: raw.enabled !== false,
    threshold,
    targetRatio,
    contextWindow: normalizedWindow,
    triggerTokens,
    reserveTokens: Math.max(0, normalizedWindow - triggerTokens),
    keepRecentTokens: Math.max(0, Math.floor(normalizedWindow * targetRatio)),
    thresholdPercent: Math.max(1, Math.min(100, Math.round(threshold * 100))),
  }
}
