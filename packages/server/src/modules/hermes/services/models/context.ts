import { resolve, join } from 'path'
import { readFileSync, existsSync, statSync } from 'fs'
import yaml from 'js-yaml'
import { getCompatibleCustomProviders } from '../../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import { readModelContextRecord } from '../../../studio/public/provider-context'
import { detectHermesHome } from '../runtime/path'

const HERMES_BASE = detectHermesHome()
const MODELS_DEV_CACHE = resolve(HERMES_BASE, 'models_dev_cache.json')
const DEFAULT_CONTEXT_LENGTH = 256_000

function fallbackContextLength(options: ModelContextLengthOptions): number {
  return options.fallbackContextLength && options.fallbackContextLength > 0
    ? Math.floor(options.fallbackContextLength)
    : DEFAULT_CONTEXT_LENGTH
}

export interface ModelContextLengthOptions {
  profile?: string
  model?: string | null
  provider?: string | null
  fallbackContextLength?: number
}

interface ModelLimit {
  context?: number
  output?: number
  input?: number
}

interface ModelEntry {
  id?: string
  name?: string
  limit?: ModelLimit
  reasoning?: boolean
  attachment?: boolean
  modalities?: {
    input?: string[]
    output?: string[]
  }
}

interface ProviderEntry {
  models?: Record<string, ModelEntry>
}

interface CustomProviderEntry {
  name?: string
  base_url?: string
  model?: string
  models?: Record<string, { context_length?: number }>
}

type ConfigProviderModels = Record<string, { context_length?: number } | string> | string[]

interface ConfigProviderEntry {
  context_length?: number
  default_model?: string
  model?: string
  models?: ConfigProviderModels
}

const MODEL_CACHE_PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ['google'],
  moonshot: ['moonshotai'],
  kilocode: ['kilo'],
  'ai-gateway': ['vercel'],
  'opencode-zen': ['opencode'],
  'opencode-go': ['opencode'],
  'glm-coding-plan': ['zai-coding-plan'],
  'kimi-coding': ['kimi-for-coding'],
  'kimi-coding-cn': ['kimi-for-coding'],
  'xai-oauth': ['xai'],
}

// --- Config YAML helpers (js-yaml) ---

function loadConfig(profileDir: string): any | null {
  const configPath = join(profileDir, 'config.yaml')
  if (!existsSync(configPath)) return null
  try {
    return yaml.load(readFileSync(configPath, 'utf-8'), { json: true }) as any
  } catch {
    return null
  }
}

// --- In-memory cache: parsed models_dev_cache (1.7MB), invalidated by mtime ---

let _cache: Record<string, ProviderEntry> | null = null
let _cacheMtime = 0
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
let _cacheLoadedAt = 0

function loadModelsDevCache(): Record<string, ProviderEntry> | null {
  if (!existsSync(MODELS_DEV_CACHE)) return null
  try {
    const stat = statSync(MODELS_DEV_CACHE)
    const now = Date.now()
    // Return cached if file hasn't changed and within TTL
    if (_cache && stat.mtimeMs === _cacheMtime && now - _cacheLoadedAt < CACHE_TTL_MS) {
      return _cache
    }
    const raw = readFileSync(MODELS_DEV_CACHE, 'utf-8')
    _cache = JSON.parse(raw) as Record<string, ProviderEntry>
    _cacheMtime = stat.mtimeMs
    _cacheLoadedAt = now
    return _cache
  } catch {
    return _cache // return stale cache on error
  }
}

// --- Profile helpers ---

function getProfileDir(profile?: string): string {
  if (!profile || profile === 'default') return HERMES_BASE
  const dir = join(HERMES_BASE, 'profiles', profile)
  return existsSync(dir) ? dir : HERMES_BASE
}

function getDefaultModel(config: any): string | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  return typeof model.default === 'string' ? model.default.trim() || null : null
}

function getDefaultProvider(config: any): string | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  return typeof model.provider === 'string' ? model.provider.trim() || null : null
}

function resolveMoaAggregator(config: any, presetName: string): { model: string; provider: string } | null {
  const moa = config?.moa
  if (!moa || typeof moa !== 'object' || Array.isArray(moa)) return null
  const presets = moa.presets
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) return null
  const preset = presets[presetName]
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) return null
  const aggregator = preset.aggregator
  if (!aggregator || typeof aggregator !== 'object' || Array.isArray(aggregator)) return null
  const model = typeof aggregator.model === 'string' ? aggregator.model.trim() : ''
  const provider = typeof aggregator.provider === 'string' ? aggregator.provider.trim() : ''
  return model && provider ? { model, provider } : null
}

/**
 * Read context_length from config.yaml, only as a sibling of default.
 * e.g. model:\n  default: gpt-5.4\n  context_length: 256000
 */
function getConfigContextLength(config: any): number | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  const val = model.context_length
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
  return val
}

function getConfigProvider(config: any, provider: string | null): ConfigProviderEntry | null {
  if (!provider) return null
  const providers = config?.providers
  if (!providers || typeof providers !== 'object') return null
  const exact = providers[provider]
  if (exact && typeof exact === 'object') return exact as ConfigProviderEntry
  const lower = provider.toLowerCase()
  const match = Object.entries(providers).find(([name]) => name.toLowerCase() === lower)
  const value = match?.[1]
  return value && typeof value === 'object' ? value as ConfigProviderEntry : null
}

function getPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function providerHasModel(provider: ConfigProviderEntry, modelName: string): boolean {
  if (provider.default_model === modelName || provider.model === modelName) return true
  const models = provider.models
  if (Array.isArray(models)) return models.includes(modelName)
  return !!models && typeof models === 'object' && Object.prototype.hasOwnProperty.call(models, modelName)
}

function lookupProviderConfigContextLength(config: any, modelName: string, provider: string | null): number | null {
  const providerEntry = getConfigProvider(config, provider)
  if (!providerEntry) return null

  const models = providerEntry.models
  if (models && !Array.isArray(models) && typeof models === 'object') {
    const modelEntry = models[modelName]
    if (modelEntry && typeof modelEntry === 'object') {
      const modelCtx = getPositiveNumber(modelEntry.context_length)
      if (modelCtx) return modelCtx
    }
  }

  if (!providerHasModel(providerEntry, modelName)) return null
  return getPositiveNumber(providerEntry.context_length)
}

function normalizeCustomProviderName(name: string): string {
  return name.trim().toLowerCase().replace(/ /g, '-')
}

function normalizeBaseUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '')
}

function getModelBaseUrl(config: any): string | null {
  const model = config?.model
  if (!model || typeof model !== 'object') return null
  return typeof model.base_url === 'string' ? model.base_url.trim() || null : null
}

function getCustomProviders(config: any): CustomProviderEntry[] {
  // Read from both legacy `custom_providers:` list and v12+ `providers:` dict
  // so context-length resolution stays correct after a v11→v12 migration.
  return getCompatibleCustomProviders(config) as unknown as CustomProviderEntry[]
}

function resolveCustomProviderEntry(config: any, modelName: string, provider: string | null): CustomProviderEntry | null {
  if (!provider || !provider.startsWith('custom')) return null

  const providers = getCustomProviders(config)
  if (provider !== 'custom') {
    const suffix = normalizeCustomProviderName(provider.slice('custom:'.length))
    return providers.find((cp) => normalizeCustomProviderName(String(cp?.name || '')) === suffix) || null
  }

  const modelBaseUrl = getModelBaseUrl(config)
  if (modelBaseUrl) {
    const normalizedBaseUrl = normalizeBaseUrl(modelBaseUrl)
    const exactByBaseUrl = providers.find((cp) =>
      normalizeBaseUrl(String(cp?.base_url || '')) === normalizedBaseUrl
      && String(cp?.model || '').trim() === modelName,
    )
    if (exactByBaseUrl) return exactByBaseUrl
  }

  const matchesByModel = providers.filter((cp) => String(cp?.model || '').trim() === modelName)
  return matchesByModel.length === 1 ? matchesByModel[0] : null
}

/**
 * Lookup context_length from custom_providers in config.yaml.
 * - "custom:xxx" → strip prefix, match by name
 * - "custom" → match by model name
 */
function lookupCustomProviderContextLength(config: any, modelName: string, provider: string | null): number | null {
  const matched = resolveCustomProviderEntry(config, modelName, provider)
  if (!matched) return null

  const models = matched.models
  if (!models || typeof models !== 'object') return null

  const modelEntry = models[modelName]
  if (!modelEntry || typeof modelEntry !== 'object') return null

  const val = modelEntry.context_length
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) return null
  return val
}

// --- Context lookup ---

function getCachedContext(entry: ModelEntry | undefined): number | null {
  const context = entry?.limit?.context
  return typeof context === 'number' && Number.isFinite(context) && context > 0 ? context : null
}

function normalizeProviderKey(provider: string): string {
  return provider.trim().toLowerCase()
}

function getProviderCandidates(provider: string): string[] {
  const normalized = normalizeProviderKey(provider)
  return [normalized, ...(MODEL_CACHE_PROVIDER_ALIASES[normalized] || [])]
}

function getProviderEntry(data: Record<string, ProviderEntry>, provider: string): ProviderEntry | null {
  const candidates = getProviderCandidates(provider)

  for (const candidate of candidates) {
    const exact = data[candidate]
    if (exact) return exact
  }

  const entries = Object.entries(data)
  for (const candidate of candidates) {
    const match = entries.find(([name]) => name.toLowerCase() === candidate)
    if (match) return match[1]
  }

  return null
}

function findModelEntry(models: Record<string, ModelEntry>, modelName: string): ModelEntry | undefined {
  const exact = models[modelName]
  if (exact) return exact

  const lower = modelName.toLowerCase()
  for (const [name, entry] of Object.entries(models)) {
    if (name.toLowerCase() === lower) return entry
    if (entry.id?.toLowerCase() === lower) return entry
    if (entry.name?.toLowerCase() === lower) return entry
  }

  const suffix = `/${lower}`
  for (const [name, entry] of Object.entries(models)) {
    if (name.toLowerCase().endsWith(suffix)) return entry
    if (entry.id?.toLowerCase().endsWith(suffix)) return entry
  }

  return undefined
}

function lookupContextInProvider(provider: ProviderEntry | null, modelName: string): number | null {
  const models = provider?.models || {}
  return getCachedContext(findModelEntry(models, modelName))
}

function lookupContextGloballyByModelName(data: Record<string, ProviderEntry>, modelName: string): number | null {
  for (const prov of Object.values(data)) {
    const context = getCachedContext(prov.models?.[modelName])
    if (context) return context
  }

  const lower = modelName.toLowerCase()
  for (const prov of Object.values(data)) {
    const models = prov.models || {}
    for (const [name, entry] of Object.entries(models)) {
      if (name.toLowerCase() === lower) {
        const context = getCachedContext(entry)
        if (context) return context
      }
    }
  }

  return null
}

function lookupUniqueContextGloballyByModelName(data: Record<string, ProviderEntry>, modelName: string): number | null {
  const exactMatches: number[] = []
  for (const prov of Object.values(data)) {
    const context = getCachedContext(prov.models?.[modelName])
    if (context) exactMatches.push(context)
    if (exactMatches.length > 1) return null
  }
  if (exactMatches.length === 1) return exactMatches[0]

  const lower = modelName.toLowerCase()
  const ciMatches: number[] = []
  for (const prov of Object.values(data)) {
    const models = prov.models || {}
    for (const [name, entry] of Object.entries(models)) {
      if (name.toLowerCase() !== lower) continue
      const context = getCachedContext(entry)
      if (context) ciMatches.push(context)
      break
    }
    if (ciMatches.length > 1) return null
  }

  return ciMatches[0] || null
}

function resolveCacheProviderFromBaseUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  const preset = PROVIDER_PRESETS.find((entry) => normalizeBaseUrl(entry.base_url) === normalizedBaseUrl)
  return preset?.value || null
}

function resolveCustomCacheProvider(config: any, modelName: string, provider: string): string | null {
  const customEntry = resolveCustomProviderEntry(config, modelName, provider)
  const entryBaseUrl = typeof customEntry?.base_url === 'string' ? customEntry.base_url : null
  const providerFromEntryBaseUrl = resolveCacheProviderFromBaseUrl(entryBaseUrl)
  if (providerFromEntryBaseUrl) return providerFromEntryBaseUrl

  return resolveCacheProviderFromBaseUrl(getModelBaseUrl(config))
}

function lookupContextFromCache(config: any, modelName: string, provider: string | null): number | null {
  const data = loadModelsDevCache()
  if (!data) return null

  if (provider) {
    if (provider === 'custom' || provider.startsWith('custom:')) {
      const inferredProvider = resolveCustomCacheProvider(config, modelName, provider)

      if (inferredProvider) {
        const scoped = lookupContextInProvider(getProviderEntry(data, inferredProvider), modelName)
        if (scoped) return scoped
        return null
      }

      if (provider === 'custom') {
        return lookupUniqueContextGloballyByModelName(data, modelName)
      }

      return null
    }

    return lookupContextInProvider(getProviderEntry(data, provider), modelName)
  }

  // Legacy configs may omit model.provider; preserve the old global exact/CI lookup semantics.
  return lookupContextGloballyByModelName(data, modelName)
}

/**
 * Get the context length for the current profile's default model.
 * Resolution order:
 *   1. model_context database override
 *   2. provider/model-specific providers.<provider>.models.<model>.context_length
 *   3. provider-level providers.<provider>.context_length when the model belongs to that provider
 *   4. custom_providers models.<model>.context_length
 *   5. top-level model.context_length fallback
 *   6. models_dev_cache.json, scoped to model.provider when configured
 *   7. DEFAULT_CONTEXT_LENGTH
 */
/**
 * 从数据库 model_context 表查找上下文长度（最高优先级）
 */
function lookupContextFromDatabase(modelName: string, provider: string | null, profile = 'default'): number | null {
  try {
    const result = readModelContextRecord(profile || 'default', provider || 'default', modelName)
    return result.available ? result.row?.context_limit || null : null
  } catch {
    return null
  }
}

export function getModelContextLength(input?: string | ModelContextLengthOptions): number {
  const options: ModelContextLengthOptions = typeof input === 'string'
    ? { profile: input }
    : input || {}
  const profile = options.profile
  const profileDir = getProfileDir(profile)
  // Explicit model/database overrides are valid even before config.yaml exists.
  const config = loadConfig(profileDir) || {}

  let model = String(options.model || '').trim() || getDefaultModel(config)
  if (!model) return fallbackContextLength(options)

  let provider = String(options.provider || '').trim() || getDefaultProvider(config)

  // 0. Database model_context table (highest priority). Keep a virtual MoA
  // preset override addressable as moa/<preset> before resolving its acting
  // aggregator model.
  const dbCtx = lookupContextFromDatabase(model, provider, profile)
  if (dbCtx && dbCtx > 0) return dbCtx

  if (provider?.toLowerCase() === 'moa') {
    const aggregator = resolveMoaAggregator(config, model)
    if (!aggregator) return fallbackContextLength(options)
    model = aggregator.model
    provider = aggregator.provider

    const aggregatorDbCtx = lookupContextFromDatabase(model, provider, profile)
    if (aggregatorDbCtx && aggregatorDbCtx > 0) return aggregatorDbCtx
  }

  // 1. Provider-specific context_length in config.yaml
  const providerConfigCtx = lookupProviderConfigContextLength(config, model, provider)
  if (providerConfigCtx && providerConfigCtx > 0) return providerConfigCtx

  // 2. Custom provider context_length
  const customCtx = lookupCustomProviderContextLength(config, model, provider)
  if (customCtx && customCtx > 0) return customCtx

  // 3. Global context_length fallback in config.yaml
  const configCtx = getConfigContextLength(config)
  if (configCtx && configCtx > 0) return configCtx

  // 4. models_dev_cache.json
  const cached = lookupContextFromCache(config, model, provider)
  if (cached) return cached

  // 5. Fallback
  return fallbackContextLength(options)
}

export function getModelRuntimeCapabilities(input: ModelContextLengthOptions): {
  contextWindow: number
  outputLimit: number
  reasoning: boolean
  input: Array<'text' | 'image'>
} {
  const contextWindow = getModelContextLength(input)
  const model = String(input.model || '').trim()
  const provider = String(input.provider || '').trim()
  const data = loadModelsDevCache()
  let entry: ModelEntry | undefined
  if (data && model) {
    if (provider === 'custom' || provider.startsWith('custom:')) {
      const profileDir = getProfileDir(input.profile)
      const config = loadConfig(profileDir)
      const inferredProvider = resolveCustomCacheProvider(config, model, provider)
      if (inferredProvider) entry = findModelEntry(getProviderEntry(data, inferredProvider)?.models || {}, model)
      else if (provider === 'custom') {
        for (const candidate of Object.values(data)) {
          const found = findModelEntry(candidate.models || {}, model)
          if (!found) continue
          if (entry) {
            entry = undefined
            break
          }
          entry = found
        }
      }
    } else if (provider) {
      entry = findModelEntry(getProviderEntry(data, provider)?.models || {}, model)
    } else {
      for (const candidate of Object.values(data)) {
        entry = findModelEntry(candidate.models || {}, model)
        if (entry) break
      }
    }
  }
  const outputLimit = getPositiveNumber(entry?.limit?.output) || Math.min(32_000, contextWindow)
  // Unknown custom models must remain usable. A missing models.dev entry is
  // absence of metadata, not evidence that reasoning or image input is
  // unsupported. Keep the runtime permissive and let the upstream provider
  // return a capability error if it truly cannot accept the requested mode.
  const imageInput = !entry || entry.attachment === true || entry.modalities?.input?.includes('image') === true
  return {
    contextWindow,
    outputLimit: Math.min(outputLimit, contextWindow),
    reasoning: entry ? entry.reasoning === true : true,
    input: imageInput ? ['text', 'image'] : ['text'],
  }
}
