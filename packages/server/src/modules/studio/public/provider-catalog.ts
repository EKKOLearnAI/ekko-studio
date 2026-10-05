import { openCodeSessionHeaders } from './opencode-session'
import { openRouterAttributionHeaders } from './openrouter-attribution'
import { logger } from './logging'

export interface ProviderModelDescriptor {
  id: string
  /** Context window advertised by the provider's live `/v1/models`, when present. */
  contextLength?: number
}

function positiveInteger(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : value
  return typeof num === 'number' && Number.isFinite(num) && num > 0 ? Math.floor(num) : null
}

/**
 * Read a model's context window from a live catalog entry. OpenAI-compatible
 * gateways (OpenRouter, local proxies such as Magpie) expose this as
 * `context_length`, some use `context_window` / `max_input_tokens`, and
 * OpenRouter nests the upstream value under `top_provider`.
 */
export function advertisedModelContextLength(item: Record<string, any> | undefined): number | null {
  if (!item || typeof item !== 'object') return null
  const direct = positiveInteger(item.context_length)
    ?? positiveInteger(item.context_window)
    ?? positiveInteger(item.max_input_tokens)
  if (direct) return direct
  const topProvider = item.top_provider
  if (topProvider && typeof topProvider === 'object') {
    return positiveInteger(topProvider.context_length) ?? positiveInteger(topProvider.max_input_tokens)
  }
  return null
}

/**
 * Fetch a provider's live model catalog with the metadata it advertises.
 * The returned descriptors keep the model id plus an optional context window;
 * callers that only need ids should use {@link fetchProviderModels}.
 */
export async function fetchProviderModelDescriptors(
  baseUrl: string,
  apiKey: string,
  freeOnly = false,
): Promise<ProviderModelDescriptor[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
  try {
    const response = await fetch(modelsUrl, {
      headers: { ...openCodeSessionHeaders(modelsUrl), ...openRouterAttributionHeaders(modelsUrl), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      logger.warn('available-models %s returned %d', modelsUrl, response.status)
      return []
    }
    const data = await response.json() as { data?: Array<Record<string, any>> }
    if (!Array.isArray(data.data)) {
      logger.warn('available-models %s returned unexpected format', modelsUrl)
      return []
    }
    const stripGeminiPrefix = base.includes('generativelanguage.googleapis.com')
    const descriptors: ProviderModelDescriptor[] = []
    for (const item of data.data) {
      let id = String(item?.id || '').trim()
      if (!id) continue
      if (stripGeminiPrefix && id.startsWith('models/')) id = id.slice('models/'.length)
      if (freeOnly && !id.endsWith(':free')) continue
      const contextLength = advertisedModelContextLength(item)
      descriptors.push(contextLength ? { id, contextLength } : { id })
    }
    return descriptors
  } catch (error: any) {
    logger.error(error, 'available-models %s failed', modelsUrl)
    return []
  }
}

export async function fetchProviderModels(baseUrl: string, apiKey: string, freeOnly = false): Promise<string[]> {
  const descriptors = await fetchProviderModelDescriptors(baseUrl, apiKey, freeOnly)
  return descriptors.map(model => model.id).sort()
}
