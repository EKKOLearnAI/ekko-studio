import type { CatalogModel, ModelCatalog } from './model-catalog'

// Studio's runtime provider IDs do not always match models.dev directory IDs.
export const CATALOG_PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ['google'],
  moonshot: ['moonshotai'],
  kilocode: ['kilo'],
  'ai-gateway': ['vercel'],
  'opencode-zen': ['opencode'],
  'opencode-go': ['opencode'],
  glm: ['zhipuai-coding-plan'],
  'glm-coding-plan': ['zai-coding-plan'],
  'kimi-coding': ['kimi-code-plan-global'],
  'kimi-coding-cn': ['kimi-code-plan-cn'],
  'xai-oauth': ['xai'],
  'claude-oauth': ['anthropic'],
  'minimax-oauth': ['minimax-coding-plan'],
  'openai-api': ['openai'],
  copilot: ['github-copilot'],
  novita: ['novita-ai'],
  gmi: ['gmicloud'],
  'xiaomi-token-plan': ['xiaomi-token-plan-sgp'],
}

// Only use the same vendor's public specifications for omitted plan models.
// This fallback is for capabilities, never for pricing.
const METADATA_PROVIDER_FALLBACKS: Record<string, string> = {
  'zhipuai-coding-plan': 'zhipuai',
  'zai-coding-plan': 'zai',
  'kimi-code-plan-global': 'moonshotai',
  'kimi-code-plan-cn': 'moonshotai-cn',
  'minimax-coding-plan': 'minimax',
  'xiaomi-token-plan-sgp': 'xiaomi',
}

export function findCatalogModel(models: Record<string, CatalogModel>, modelId: string): CatalogModel | undefined {
  const id = modelId.trim()
  if (!id) return undefined
  if (Object.hasOwn(models, id)) return models[id]
  const lower = id.toLowerCase()
  for (const [key, model] of Object.entries(models)) {
    if (key.toLowerCase() === lower || model.id?.toLowerCase() === lower || model.name?.toLowerCase() === lower) return model
  }
  const suffix = `/${lower}`
  for (const [key, model] of Object.entries(models)) {
    if (key.toLowerCase().endsWith(suffix) || model.id?.toLowerCase().endsWith(suffix)) return model
  }
}

export function findCatalogModelByProvider(catalog: ModelCatalog, provider: string, modelId: string): CatalogModel | undefined {
  const normalized = provider.trim().toLowerCase()
  const candidates = [normalized, ...(Object.hasOwn(CATALOG_PROVIDER_ALIASES, normalized) ? CATALOG_PROVIDER_ALIASES[normalized] : [])]
  const entries = Object.entries(catalog)
  const lookup = (id: string) => {
    const entry = (Object.hasOwn(catalog, id) ? catalog[id] : undefined) || entries.find(([key]) => key.toLowerCase() === id)?.[1]
    return findCatalogModel(entry?.models || {}, modelId)
  }
  for (const candidate of candidates) {
    const model = lookup(candidate)
    if (model) return model
  }
  for (const candidate of candidates) {
    const fallback = Object.hasOwn(METADATA_PROVIDER_FALLBACKS, candidate) ? METADATA_PROVIDER_FALLBACKS[candidate] : undefined
    const model = fallback ? lookup(fallback) : undefined
    if (model) return model
  }
}

const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

export function catalogReasoningEfforts(model: CatalogModel | undefined): string[] | undefined {
  if (!model) return undefined
  if (model.reasoning === false) return []
  if (!Array.isArray(model.reasoning_options)) return undefined
  const efforts = model.reasoning_options.filter(option => option?.type === 'effort')
    .flatMap(option => Array.isArray(option.values) ? option.values.filter(value => EFFORT_VALUES.has(value)) : [])
  if (model.reasoning_options.some(option => option?.type === 'toggle')) efforts.unshift('none')
  // Token budgets do not advertise named effort levels. Keep the runtime default.
  return [...new Set(efforts)]
}
