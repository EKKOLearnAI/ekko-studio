export interface RunUsageSummary {
  runId: string
  assistantMessageId: string
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheHitRate: number | null
  costUsd: number | null
  tokensPerSecond: number | null
  speedSource?: 'model' | 'estimated' | 'run' | null
  isEstimated: boolean
}

export function normalizeRunUsage(value: unknown): RunUsageSummary | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.runId !== 'string' || !raw.runId) return undefined
  const number = (key: string): number | null => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] : null
  const hitRate = number('cacheHitRate')
  return { runId: raw.runId, assistantMessageId: String(raw.assistantMessageId || ''),
    inputTokens: number('inputTokens'), outputTokens: number('outputTokens'), cacheReadTokens: number('cacheReadTokens'),
    cacheHitRate: hitRate != null && hitRate <= 1 ? hitRate : null,
    costUsd: number('costUsd'), tokensPerSecond: number('tokensPerSecond'),
    speedSource: raw.speedSource === 'model' || raw.speedSource === 'estimated' || raw.speedSource === 'run' ? raw.speedSource : null,
    isEstimated: raw.isEstimated === true }
}

export function formatRunTokens(value: number | null): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

export function parseGroupRunUsageMessage(message: { role?: string; tool_name?: string | null; content: unknown; run_id?: string | null }): RunUsageSummary | undefined {
  if (message.role !== 'tool' || message.tool_name !== 'run_usage') return undefined
  try {
    const usage = normalizeRunUsage(typeof message.content === 'string' ? JSON.parse(message.content) : message.content)
    return usage?.runId === message.run_id ? usage : undefined
  } catch { return undefined }
}

export function formatRunCost(value: number | null): string {
  if (value == null) return '—'
  if (value > 0 && value < 0.0001) return '< $0.0001'
  return `$${value.toFixed(4)}`
}

export function formatCacheHitRate(value: number | null): string {
  return value == null || !Number.isFinite(value) || value < 0 || value > 1 ? '—' : `${(value * 100).toFixed(1)}%`
}
