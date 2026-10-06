import { PROVIDER_PRESETS } from '../../contracts/providers'
import type { CatalogModel, ModelCatalog } from './model-catalog'

export const CATALOG_PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ['google'], moonshot: ['moonshotai'], kilocode: ['kilo'],
  'ai-gateway': ['vercel'], 'opencode-zen': ['opencode'], 'opencode-go': ['opencode'],
  glm: ['zhipuai-coding-plan'], 'glm-coding-plan': ['zai-coding-plan'],
  'kimi-coding': ['kimi-code-plan-global'], 'kimi-coding-cn': ['kimi-code-plan-cn'],
  'xai-oauth': ['xai'], 'claude-oauth': ['anthropic'],
  'minimax-oauth': ['minimax-coding-plan'], 'openai-api': ['openai'],
  copilot: ['github-copilot'], novita: ['novita-ai'], gmi: ['gmicloud'],
  'xiaomi-token-plan': ['xiaomi-token-plan-sgp'],
}

export interface CatalogModelMatch {
  provider: string
  modelId: string
  model: CatalogModel
  matchedBy: 'provider' | 'url' | 'model'
}
export interface CatalogModelQuery {
  provider?: string | null
  baseUrl?: string | null
  model: string
}

function providerCandidates(provider: string): string[] {
  const normalized = provider.trim().toLowerCase()
  return [normalized, ...(Object.hasOwn(CATALOG_PROVIDER_ALIASES, normalized) ? CATALOG_PROVIDER_ALIASES[normalized] : [])]
}

function modelMatch(models: Record<string, CatalogModel>, id: string, names = true): { modelId: string; model: CatalogModel; rank: number } | undefined {
  if (!id) return undefined
  if (Object.hasOwn(models, id)) return { modelId: id, model: models[id], rank: 0 }
  const lower = id.toLowerCase()
  const entries = Object.entries(models)
  const exact = entries.find(([key, model]) => key.toLowerCase() === lower || model.id?.toLowerCase() === lower)
  if (exact) return { modelId: exact[0], model: exact[1], rank: 1 }
  const named = names ? entries.find(([, model]) => model.name?.toLowerCase() === lower) : undefined
  if (named) return { modelId: named[0], model: named[1], rank: 2 }
  if (!names) return undefined
  const suffix = `/${lower}`
  const prefixed = entries.find(([key, model]) => key.toLowerCase().endsWith(suffix) || model.id?.toLowerCase().endsWith(suffix))
  if (prefixed) return { modelId: prefixed[0], model: prefixed[1], rank: 3 }
}

export function findCatalogModel(models: Record<string, CatalogModel>, modelId: string): CatalogModel | undefined {
  return modelMatch(models, modelId.trim())?.model
}

function providerMatch(catalog: ModelCatalog, provider: string, modelId: string): CatalogModelMatch | undefined {
  const entries = Object.entries(catalog)
  for (const candidate of providerCandidates(provider)) {
    const found = entries.find(([key]) => key.toLowerCase() === candidate)
    const match = modelMatch(found?.[1].models || {}, modelId)
    if (found && match) return { provider: found[0], modelId: match.modelId, model: match.model, matchedBy: 'provider' }
  }
}

export function findCatalogModelByProvider(catalog: ModelCatalog, provider: string, modelId: string): CatalogModel | undefined {
  return providerMatch(catalog, provider, modelId.trim())?.model
}

function httpUrl(value: string | null | undefined): URL | undefined {
  try {
    const url = new URL(value || '')
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch { return undefined }
}

type EndpointEntry = { provider: string; models: Record<string, CatalogModel>; url: URL }
const endpointIndexes = new WeakMap<ModelCatalog, Map<string, EndpointEntry[]>>()
function endpointIndex(catalog: ModelCatalog): Map<string, EndpointEntry[]> {
  const cached = endpointIndexes.get(catalog)
  if (cached) return cached
  const index = new Map<string, EndpointEntry[]>()
  for (const [provider, entry] of Object.entries(catalog)) {
    const advertised = httpUrl(entry.api)
    // SDK-backed directories may omit api; their official preset supplies it.
    const urls = advertised ? [advertised] : PROVIDER_PRESETS
      .filter(preset => providerCandidates(preset.value).includes(provider.toLowerCase()))
      .flatMap(preset => { const url = httpUrl(preset.base_url); return url ? [url] : [] })
    for (const url of urls) {
      const matches = index.get(url.hostname) || []
      matches.push({ provider, models: entry.models || {}, url })
      index.set(url.hostname, matches)
    }
  }
  endpointIndexes.set(catalog, index)
  return index
}

function chooseMatch(catalog: ModelCatalog, matches: CatalogModelMatch[], allowOriginalLookup = false): CatalogModelMatch | undefined {
  if (matches.length <= 1) return matches[0]
  const canonicalIds = [...new Set(matches.flatMap(match => match.model.canonical_model_id ? [match.model.canonical_model_id] : []))]
  if (canonicalIds.length === 1) {
    const canonical = canonicalIds[0]
    const slash = canonical.indexOf('/')
    if (slash > 0) {
      const original = providerMatch(catalog, canonical.slice(0, slash), canonical.slice(slash + 1))
      if (original && (allowOriginalLookup || matches.some(match => match.provider === original.provider && match.modelId === original.modelId))) {
        return { ...original, matchedBy: matches[0].matchedBy }
      }
    }
  }
  // Identical data is usable even when the owner is not advertised. Otherwise
  // keep it unknown rather than making directory order decide the price.
  const signature = (model: CatalogModel) => JSON.stringify([model.limit, model.cost, model.reasoning, model.reasoning_options, model.attachment, model.modalities])
  return matches.every(match => signature(match.model) === signature(matches[0].model)) ? matches[0] : undefined
}

export function resolveCatalogModel(catalog: ModelCatalog, query: CatalogModelQuery): CatalogModelMatch | undefined {
  const id = query.model.trim()
  if (!id) return undefined
  if (query.provider) {
    const match = providerMatch(catalog, query.provider, id)
    if (match) return match
  }
  const endpoint = httpUrl(query.baseUrl)
  if (endpoint) {
    const matches = (endpointIndex(catalog).get(endpoint.hostname) || []).flatMap(entry => {
      const match = modelMatch(entry.models, id)
      if (!match) return []
      const prefix = entry.url.pathname.replace(/\/+$/, '')
      const path = endpoint.pathname === prefix || endpoint.pathname.startsWith(`${prefix}/`) ? prefix.length : -1
      return [{ provider: entry.provider, modelId: match.modelId, model: match.model, matchedBy: 'url' as const, path }]
    })
    if (matches.length) {
      const path = Math.max(...matches.map(match => match.path))
      const selected = chooseMatch(catalog, matches.filter(match => match.path === path))
      if (selected) return selected
    }
  }
  const matches = Object.entries(catalog).flatMap(([provider, entry]) => {
    const match = modelMatch(entry.models || {}, id, false)
    return match ? [{ provider, modelId: match.modelId, model: match.model, matchedBy: 'model' as const, rank: match.rank }] : []
  })
  const rank = Math.min(...matches.map(match => match.rank))
  return chooseMatch(catalog, matches.filter(match => match.rank === rank), true)
}

const EFFORT_VALUES = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export function catalogReasoningEfforts(model: CatalogModel | undefined): string[] | undefined {
  if (!model) return undefined
  if (model.reasoning === false) return []
  if (!Array.isArray(model.reasoning_options)) return undefined
  const efforts = model.reasoning_options.filter(option => option?.type === 'effort')
    .flatMap(option => Array.isArray(option.values) ? option.values.filter(value => EFFORT_VALUES.has(value)) : [])
  if (model.reasoning_options.some(option => option?.type === 'toggle')) efforts.unshift('none')
  return [...new Set(efforts)]
}
