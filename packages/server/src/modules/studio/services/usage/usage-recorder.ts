import { logger } from '../../public/logging'
import { updateUsage } from '../../repositories/usage-store'

export interface NormalizedTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface RecordSessionUsageInput {
  sessionId: string
  runId?: string | null
  source: 'hermes' | 'coding_agent' | 'ekko_agent'
  agent: 'hermes' | 'claude_code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'ekko_agent'
  profile?: string | null
  model?: string | null
  provider?: string | null
  usageScope?: 'model_call' | 'run'
  purpose?: string
  apiCalls?: number
  usage?: unknown
  fallbackUsage?: Partial<NormalizedTokenUsage>
  isEstimated?: boolean
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined
}

function finiteToken(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value == null || (typeof value === 'string' && !value.trim())) continue
    const token = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(token) && token >= 0) return Math.floor(token)
  }
  return undefined
}

function usagePayload(value: unknown): Record<string, any> {
  const root = asRecord(value) || {}
  const response = asRecord(root.response)
  const result = asRecord(root.result)
  return asRecord(root.usage)
    || asRecord(response?.usage)
    || asRecord(result?.usage)
    || root
}

export function normalizeTokenUsage(
  value: unknown,
  fallback: Partial<NormalizedTokenUsage> = {},
  options: { inputIncludesCache?: boolean } = {},
): NormalizedTokenUsage & { isEstimated: boolean } {
  const usage = usagePayload(value)
  const inputDetails = asRecord(usage.input_tokens_details)
    || asRecord(usage.inputTokensDetails)
    || asRecord(usage.prompt_tokens_details)
    || asRecord(usage.promptTokensDetails)
    || {}
  const outputDetails = asRecord(usage.output_tokens_details)
    || asRecord(usage.outputTokensDetails)
    || asRecord(usage.completion_tokens_details)
    || asRecord(usage.completionTokensDetails)
    || {}

  const rawInput = finiteToken(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens)
  const rawOutput = finiteToken(usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens)
  const rawCacheRead = finiteToken(
    usage.cache_read_tokens,
    usage.cacheReadTokens,
    usage.cache_read_input_tokens,
    usage.cached_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_hit_tokens,
    inputDetails.cached_tokens,
    inputDetails.cachedTokens,
  )
  const rawCacheWrite = finiteToken(
    usage.cache_write_tokens,
    usage.cacheWriteTokens,
    usage.cache_creation_input_tokens,
  )
  const rawReasoning = finiteToken(
    usage.reasoning_tokens,
    usage.reasoningTokens,
    outputDetails.reasoning_tokens,
    outputDetails.reasoningTokens,
  )

  const inputTokens = rawInput ?? finiteToken(fallback.inputTokens) ?? 0
  const cacheReadTokens = rawCacheRead ?? finiteToken(fallback.cacheReadTokens) ?? 0
  const cacheWriteTokens = rawCacheWrite ?? finiteToken(fallback.cacheWriteTokens) ?? 0

  return {
    inputTokens: options.inputIncludesCache
      ? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
      : inputTokens,
    outputTokens: rawOutput ?? finiteToken(fallback.outputTokens) ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: rawReasoning ?? finiteToken(fallback.reasoningTokens) ?? 0,
    isEstimated: rawInput == null || rawOutput == null,
  }
}

export function recordSessionUsage(input: RecordSessionUsageInput): NormalizedTokenUsage {
  const usage = normalizeTokenUsage(input.usage, input.fallbackUsage)
  try {
    updateUsage(input.sessionId, {
      runId: input.runId || '',
      source: input.source,
      agent: input.agent,
      usageScope: input.usageScope,
      purpose: input.purpose,
      apiCalls: input.apiCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      model: input.model || '',
      provider: input.provider || '',
      profile: input.profile || 'default',
      isEstimated: input.isEstimated ?? usage.isEstimated,
    })
  } catch (err) {
    logger.warn({
      err,
      sessionId: input.sessionId,
      runId: input.runId,
      source: input.source,
    }, '[usage-recorder] failed to persist session usage')
  }
  return usage
}
