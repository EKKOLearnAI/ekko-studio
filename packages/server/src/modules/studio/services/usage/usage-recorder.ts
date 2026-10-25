import { normalizeTokenUsage, type NormalizedTokenUsage } from './token-usage'
export { normalizeTokenUsage, type NormalizedTokenUsage } from './token-usage'
import { resolveModelBaseUrl } from '../../public/profile-config'
import { logger } from '../../public/logging'
import { updateUsage, fillMissingUsageCost } from '../../repositories/usage-store'
import { getUsagePricing } from '../../repositories/usage-pricing-store'
import { getModelCatalogSnapshot, refreshModelCatalog } from '../../public/model-catalog'
import { normalizeUsageCost, estimateUsageCost, type UsageCost } from './usage-cost'
import { estimateCatalogUsageCost } from './catalog-pricing'

export interface RecordedUsage extends NormalizedTokenUsage {
  isEstimated: boolean
  costUsd?: number
  costSource?: 'reported' | 'estimated'
}

export interface RecordSessionUsageInput {
  /** Host model calls must not report a successful accounting barrier after a write failure. */
  requirePersistence?: boolean
  onRecorded?: (usage: RecordedUsage) => void
  sessionId: string
  origin?: 'internal' | 'external'
  accountId?: string
  modelApiKeyId?: string
  runId?: string | null
  /** The foreground run, separate from the deduplication key for each API call. */
  parentRunId?: string
  createdAt?: number
  /** Model request duration in seconds, excluding tool execution. */
  apiDuration?: number
  source: 'hermes' | 'coding_agent' | 'ekko_agent' | 'model_api'
  agent: 'hermes' | 'claude_code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor' | 'antigravity' | 'qwen' | 'kimi' | 'codebuddy' | 'qoder' | 'copilot' | 'zcode' | 'ekko_agent' | 'model_api'
  profile?: string | null
  model?: string | null
  provider?: string | null
  baseUrl?: string | null
  usageScope?: 'model_call' | 'run'
  purpose?: string
  apiCalls?: number
  usage?: unknown
  fallbackUsage?: Partial<NormalizedTokenUsage>
  isEstimated?: boolean
  cost?: UsageCost
}

export function recordSessionUsage(input: RecordSessionUsageInput): NormalizedTokenUsage {
  const usage = normalizeTokenUsage(input.usage, input.fallbackUsage)
  const notify = (cost?: UsageCost) => {
    try { input.onRecorded?.({ ...usage, ...(cost ? { costUsd: cost.costUsd, costSource: cost.costSource } : {}) }) }
    catch { logger.warn('[usage-recorder] usage notification failed') }
  }
  const canPrice = input.origin !== 'external' || !usage.isEstimated
  try {
    let cost: UsageCost | undefined
    let hasManualPricing = false
    if (canPrice && input.model && input.provider) {
      try {
        const pricing = getUsagePricing(input.profile || 'default')
          .find(row => row.provider === input.provider && row.model === input.model)
        hasManualPricing = !!pricing
        cost = estimateUsageCost(usage, pricing)
        if (cost && pricing) cost.costPricing = { source: 'manual', rates: pricing }
      } catch (err) {
        logger.warn({ err }, '[usage-recorder] failed to read model pricing')
      }
    }
    if (!hasManualPricing) cost = normalizeUsageCost(input.cost) || normalizeUsageCost(input.usage)
    let baseUrl = input.baseUrl || undefined
    if (!cost && !hasManualPricing && input.model && !baseUrl) {
      try { baseUrl = resolveModelBaseUrl(input.profile || 'default', input.provider || '', input.model) } catch {}
    }
    const catalog = !cost && !hasManualPricing ? getModelCatalogSnapshot() : undefined
    if (canPrice && !cost && !hasManualPricing && input.model) {
      cost = estimateCatalogUsageCost(catalog, input.provider || '', input.model, usage, input.usageScope, input.apiCalls, baseUrl)
    }
    const row = updateUsage(input.sessionId, {
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.modelApiKeyId ? { modelApiKeyId: input.modelApiKeyId } : {}),
      runId: input.runId || '',
      ...(input.createdAt != null ? { createdAt: input.createdAt } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      ...(input.apiDuration != null ? { apiDuration: input.apiDuration } : {}),
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
      ...(cost || {}),
    })
    notify(cost)
    // Cold start: persist tokens immediately, then fill this new row after the shared download.
    // Replays return no inserted row, so a later catalog never reprices historical usage.
    if (canPrice && row && !cost && !hasManualPricing && !catalog && input.model) {
      const provider = input.provider || ''
      const model = input.model
      void refreshModelCatalog().then(snapshot => {
        const estimate = estimateCatalogUsageCost(snapshot, provider, model, usage, input.usageScope, input.apiCalls, baseUrl)
        if (estimate) { fillMissingUsageCost(row, estimate); notify(estimate) }
      }).catch(err => logger.warn({ err }, '[usage-recorder] failed to fill catalog cost'))
    }
  } catch (err) {
    logger.warn({
      err,
      sessionId: input.sessionId,
      runId: input.runId,
      source: input.source,
    }, '[usage-recorder] failed to persist session usage')
    notify()
    if (input.modelApiKeyId || input.requirePersistence) throw err
  }
  return usage
}
