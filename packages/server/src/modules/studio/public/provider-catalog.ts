import { openCodeSessionHeaders } from './opencode-session'
import { openRouterAttributionHeaders } from './openrouter-attribution'
import { logger } from './logging'

export async function fetchProviderModels(baseUrl: string, apiKey: string, freeOnly = false): Promise<string[]> {
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
    const data = await response.json() as { data?: Array<{ id?: unknown; slug?: unknown }>; models?: Array<{ id?: unknown; slug?: unknown }> }
    const rawModels = Array.isArray(data?.data) ? data.data : data?.models
    if (!Array.isArray(rawModels)) {
      logger.warn('available-models %s returned unexpected format', modelsUrl)
      return []
    }
    let models = rawModels.map(model => String(model?.id || model?.slug || '').trim()).filter(Boolean)
    if (base.includes('generativelanguage.googleapis.com')) {
      models = models.map(model => model.startsWith('models/') ? model.slice('models/'.length) : model)
    }
    if (freeOnly) models = models.filter(model => model.endsWith(':free'))
    return models.sort()
  } catch (error: any) {
    logger.error(error, 'available-models %s failed', modelsUrl)
    return []
  }
}
