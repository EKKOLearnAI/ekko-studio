import { openCodeSessionHeaders } from './opencode-session'
import { openRouterAttributionHeaders } from './openrouter-attribution'
import { logger } from './logging'
import { OPENCODE_FREE_BASE_URL, isOpenCodeFreeModel } from '../contracts/opencode-free'

export async function fetchOpenCodeFreeModels(): Promise<string[]> {
  return (await fetchProviderModels(OPENCODE_FREE_BASE_URL, '')).filter(isOpenCodeFreeModel)
}

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
    const data = await response.json() as { data?: Array<{ id: string }> }
    if (!Array.isArray(data.data)) {
      logger.warn('available-models %s returned unexpected format', modelsUrl)
      return []
    }
    let models = data.data.map(model => model.id)
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
