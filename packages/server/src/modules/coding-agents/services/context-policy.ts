import { readCompressionPolicy } from '../../studio/public/compression-policy'
import { getModelRuntimeCapabilities } from '../../studio/public/provider-runtime'

export interface CodingAgentContextPolicy {
  contextWindow: number
  outputLimit: number
  threshold: number
  triggerTokens: number
}

export async function codingAgentContextPolicy(input: {
  profile: string
  provider: string
  model: string
}): Promise<CodingAgentContextPolicy> {
  const capabilities = getModelRuntimeCapabilities(input)
  const contextWindow = Math.max(1, Math.floor(capabilities.contextWindow))
  const compression = await readCompressionPolicy(input.profile)
  // Coding agents always keep their native auto-compaction enabled. Only the
  // threshold is shared with ordinary chat, not its compression.enabled switch.
  return {
    contextWindow,
    outputLimit: Math.max(1, Math.min(Math.floor(capabilities.outputLimit || 8192), contextWindow - 1)),
    threshold: compression.threshold,
    triggerTokens: Math.max(1, Math.floor(contextWindow * compression.threshold)),
  }
}

export function compactionPercent(threshold: number): number {
  return Math.max(1, Math.min(100, Math.floor(threshold * 100 + 1e-8)))
}

export function claudeCompactionPercent(policy: CodingAgentContextPolicy): number {
  const nativeWindow = Math.max(100_000, Math.min(1_000_000, policy.contextWindow))
  return compactionPercent(policy.triggerTokens / nativeWindow)
}

export function piCompactionSettings(existing: Record<string, any>, policy: CodingAgentContextPolicy, model: string) {
  const previous = existing.compaction && typeof existing.compaction === 'object' ? existing.compaction : {}
  const keepRecentTokens = Math.min(
    typeof previous.keepRecentTokens === 'number' && Number.isFinite(previous.keepRecentTokens)
      ? Math.max(0, Math.floor(previous.keepRecentTokens)) : 20_000,
    Math.floor(policy.triggerTokens / 2),
  )
  const budgets = { reserveTokens: policy.contextWindow - policy.triggerTokens, keepRecentTokens }
  return {
    ...existing,
    compaction: {
      ...previous,
      enabled: true,
      ...budgets,
      // A native model override otherwise wins over the ordinary settings.
      modelOverrides: { ...previous.modelOverrides, [`hermes-studio/${model}`]: budgets },
    },
  }
}
