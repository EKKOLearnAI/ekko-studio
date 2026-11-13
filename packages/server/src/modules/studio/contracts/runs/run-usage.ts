/** A completed run's usage. Null means unavailable, never a measured zero. */
export interface RunUsageSummary {
  runId: string
  assistantMessageId: string
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  /** Cache-read input / all input, as a fraction in [0, 1]. */
  cacheHitRate: number | null
  costUsd: number | null
  tokensPerSecond: number | null
  /** Measured model time, estimated non-tool time, or whole-run average if timing is incomplete. */
  speedSource: 'model' | 'estimated' | 'run' | null
  isEstimated: boolean
}
