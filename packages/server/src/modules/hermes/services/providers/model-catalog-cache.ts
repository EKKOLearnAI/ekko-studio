import { openCodeSessionHeaders } from '../../../studio/public/opencode-session'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { getCompatibleCustomProviders } from '../../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import { readAppConfig } from '../../../studio/public/app-config'
import { config } from '../../../studio/public/config'
import { logger } from '../../../studio/public/logging'
import { fetchProviderModels, fetchOpenCodeFreeModels } from '../../../studio/public/provider-catalog'
import {
  ORCAROUTER_PROVIDER,
  ORCAROUTER_OAUTH_PROVIDER,
  filterOrcaRouterModels,
  normalizeOrcaRouterCatalogModels,
  normalizeOrcaRouterApiBase,
  orcaRouterModelsUrl,
  type OrcaRouterCatalogModel,
} from '../../../studio/public/orcarouter-catalog'
import {
  ORCAROUTER_CATALOG_MAX_BYTES,
  ORCAROUTER_CATALOG_TIMEOUT_MS,
} from '../../../studio/public/orcarouter-catalog'
import { OPENCODE_FREE_PROVIDER, OPENCODE_FREE_BASE_URL } from '../../../studio/contracts/opencode-free'
import { PROVIDER_ENV_MAP, readConfigYamlForProfile } from '../../../studio/public/profile-config'
import { safeFileStore } from '../../../studio/public/safe-file-store'
import { fetchCopilotModelsWithOAuthToken, resolveCopilotOAuthToken } from './copilot-models'
import { getProfileDir, listProfileNamesFromDisk } from '../profiles/profile'
import { resolveAuthorizedProviderRuntimeCredentials } from './authorized-provider-credentials'

export type ModelCatalogSource = 'live' | 'fallback'

export interface ProviderModelCatalogEntry {
  provider: string
  label: string
  base_url: string
  models: string[]
  source: ModelCatalogSource
  updated_at: string
  free_only?: boolean
  profiles?: string[]
  /** Profile-scoped authoritative refresh may keep models that disappeared remotely. */
  unavailable_models?: string[]
  /** One-step restore snapshot for the previous authoritative list. */
  previous_models?: string[]
  previous_unavailable_models?: string[]
  previous_updated_at?: string
  profile?: string
}

export interface ProviderModelCatalogCache {
  version: 1
  updated_at: string
  providers: Record<string, ProviderModelCatalogEntry>
}

export interface ProviderCatalogRefreshTarget {
  provider: string
  label: string
  base_url: string
  api_key: string
  fallback_models: string[]
  free_only?: boolean
  profile: string
  api_mode?: string
  credential_kind: 'api_key' | 'oauth' | 'copilot' | 'none'
  skip_live_fetch?: boolean
  /**
   * Catalog reader to use. `capability` reads `GET /v1/models?capability=<name>`
   * and intersects the result with the endpoint types and input modalities this
   * client can speak, so a selector can never be offered a route we cannot call.
   */
  catalog_kind?: 'generic' | 'capability'
}

type RefreshCandidate = ProviderCatalogRefreshTarget

interface StoredAuthCatalogCredential {
  hasAuth: boolean
  api_key?: string
  base_url?: string
}

const CACHE_VERSION = 1
const CACHE_PATH = join(config.appHome, 'cache', 'provider-model-catalog.json')
const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const KEYLESS_CATALOG_PROVIDERS = new Set(['cliproxyapi'])
const AUTH_CATALOG_PROVIDERS = new Set([
  'openai-codex',
  'copilot',
  'xai-oauth',
  'nous',
  'claude-oauth',
  'qwen-oauth',
  'minimax-oauth',
  ORCAROUTER_OAUTH_PROVIDER,
])
let backgroundRefresh: Promise<void> | null = null

function emptyCache(): ProviderModelCatalogCache {
  return { version: CACHE_VERSION, updated_at: new Date(0).toISOString(), providers: {} }
}

function safeKey(value: string): boolean {
  return !!value && !RESERVED_KEYS.has(value)
}

export function normalizeCatalogBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/+$/, '')
}

export function providerModelCatalogKey(
  provider: string,
  baseUrl: string,
  freeOnly = false,
  profile?: string,
): string {
  const base = `${provider.trim()}|${normalizeCatalogBaseUrl(baseUrl)}|${freeOnly ? 'free' : 'all'}`
  const scopedProfile = String(profile || '').trim()
  return scopedProfile ? `profile:${scopedProfile}|${base}` : base
}

function uniqueModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  return Array.from(new Set(models.map(model => String(model || '').trim()).filter(Boolean)))
}

function normalizeCache(raw: unknown): ProviderModelCatalogCache {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyCache()
  const input = raw as Record<string, any>
  const providers: Record<string, ProviderModelCatalogEntry> = {}
  if (input.providers && typeof input.providers === 'object' && !Array.isArray(input.providers)) {
    for (const [key, value] of Object.entries(input.providers as Record<string, any>)) {
      if (!safeKey(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue
      const provider = String(value.provider || '').trim()
      const baseUrl = normalizeCatalogBaseUrl(value.base_url || '')
      const models = uniqueModels(value.models)
      if (!provider || !baseUrl) continue
      providers[key] = {
        provider,
        label: String(value.label || provider).trim() || provider,
        base_url: baseUrl,
        models,
        source: value.source === 'fallback' ? 'fallback' : 'live',
        updated_at: typeof value.updated_at === 'string' ? value.updated_at : new Date(0).toISOString(),
        ...(value.free_only === true ? { free_only: true } : {}),
        ...(Array.isArray(value.profiles) ? { profiles: uniqueModels(value.profiles) } : {}),
        ...(Array.isArray(value.unavailable_models) ? { unavailable_models: uniqueModels(value.unavailable_models) } : {}),
        ...(Array.isArray(value.previous_models) ? { previous_models: uniqueModels(value.previous_models) } : {}),
        ...(Array.isArray(value.previous_unavailable_models) ? { previous_unavailable_models: uniqueModels(value.previous_unavailable_models) } : {}),
        ...(typeof value.previous_updated_at === 'string' ? { previous_updated_at: value.previous_updated_at } : {}),
        ...(typeof value.profile === 'string' && value.profile.trim() ? { profile: value.profile.trim() } : {}),
      }
    }
  }
  return {
    version: CACHE_VERSION,
    updated_at: typeof input.updated_at === 'string' ? input.updated_at : new Date(0).toISOString(),
    providers,
  }
}

export async function readProviderModelCatalogCache(): Promise<ProviderModelCatalogCache> {
  try {
    const raw = await safeFileStore.readText(CACHE_PATH)
    return normalizeCache(JSON.parse(raw))
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn(err, '[model-catalog-cache] failed to read provider model catalog cache')
    }
    return emptyCache()
  }
}

export function resolveProviderCatalogEntry(
  cache: ProviderModelCatalogCache,
  provider: string,
  baseUrl: string,
  options: { freeOnly?: boolean; profile?: string } = {},
): ProviderModelCatalogEntry | undefined {
  const freeOnly = options.freeOnly === true
  const profile = provider === OPENCODE_FREE_PROVIDER ? '' : String(options.profile || '').trim()
  if (profile) {
    const scoped = cache.providers[providerModelCatalogKey(provider, baseUrl, freeOnly, profile)]
    if (scoped) return scoped
  }
  return cache.providers[providerModelCatalogKey(provider, baseUrl, freeOnly)]
}

export function resolveProviderCatalogModels(
  cache: ProviderModelCatalogCache,
  provider: string,
  baseUrl: string,
  staticModels: string[],
  options: { freeOnly?: boolean; hasStaticManifest?: boolean; profile?: string } = {},
): string[] {
  const entry = resolveProviderCatalogEntry(cache, provider, baseUrl, options)
  if (!entry || entry.models.length === 0) return [...staticModels]
  const hasStaticManifest = options.hasStaticManifest ?? staticModels.length > 0
  if (entry.source === 'fallback' && hasStaticManifest) return [...staticModels]
  const unavailable = uniqueModels(entry.unavailable_models || [])
  return uniqueModels([...entry.models, ...unavailable])
}

export async function writeProviderModelCatalogEntry(input: {
  provider: string
  label: string
  base_url: string
  models: string[]
  source: ModelCatalogSource
  free_only?: boolean
  profiles?: string[]
  profile?: string
  unavailable_models?: string[]
  previous_models?: string[] | null
  previous_unavailable_models?: string[] | null
  previous_updated_at?: string | null
  overwriteExistingModels?: boolean
  clear_profiles?: string[]
}): Promise<ProviderModelCatalogEntry> {
  const provider = input.provider.trim()
  const baseUrl = normalizeCatalogBaseUrl(input.base_url)
  const models = uniqueModels(input.models)
  const profile = provider === OPENCODE_FREE_PROVIDER ? '' : String(input.profile || '').trim()
  const key = providerModelCatalogKey(provider, baseUrl, input.free_only === true, profile || undefined)
  const now = new Date().toISOString()
  const entry: ProviderModelCatalogEntry = {
    provider,
    label: input.label.trim() || provider,
    base_url: baseUrl,
    models,
    source: input.source,
    updated_at: now,
    ...(input.free_only === true ? { free_only: true } : {}),
    ...(input.profiles?.length ? { profiles: uniqueModels(input.profiles) } : {}),
    ...(profile ? { profile } : {}),
    ...(input.unavailable_models?.length ? { unavailable_models: uniqueModels(input.unavailable_models) } : {}),
  }
  if (input.previous_models !== undefined) {
    if (input.previous_models && input.previous_models.length) entry.previous_models = uniqueModels(input.previous_models)
  }
  if (input.previous_unavailable_models !== undefined) {
    if (input.previous_unavailable_models && input.previous_unavailable_models.length) {
      entry.previous_unavailable_models = uniqueModels(input.previous_unavailable_models)
    }
  }
  if (input.previous_updated_at !== undefined) {
    if (input.previous_updated_at) entry.previous_updated_at = input.previous_updated_at
  }

  await safeFileStore.updateText(CACHE_PATH, (current) => {
    let cache = emptyCache()
    if (current.trim()) {
      try { cache = normalizeCache(JSON.parse(current)) } catch { cache = emptyCache() }
    }
    const existing = cache.providers[key]
    if (existing && existing.models.length > 0 && input.overwriteExistingModels === false) {
      const profiles = Array.from(new Set([...(existing.profiles || []), ...(entry.profiles || [])]))
      cache.providers[key] = { ...existing, ...(profiles.length ? { profiles } : {}) }
    } else if (input.previous_models === undefined && existing) {
      // Preserve restore snapshot unless the caller explicitly manages it.
      cache.providers[key] = {
        ...entry,
        ...(existing.previous_models?.length ? { previous_models: existing.previous_models } : {}),
        ...(existing.previous_unavailable_models?.length ? { previous_unavailable_models: existing.previous_unavailable_models } : {}),
        ...(existing.previous_updated_at ? { previous_updated_at: existing.previous_updated_at } : {}),
      }
    } else {
      cache.providers[key] = entry
    }
    if (!profile) {
      for (const scopedProfile of uniqueModels(input.clear_profiles)) {
        delete cache.providers[providerModelCatalogKey(provider, baseUrl, input.free_only === true, scopedProfile)]
      }
    }
    cache.updated_at = now
    return JSON.stringify(cache, null, 2) + '\n'
  })

  return entry
}

export async function refreshProviderModelCatalog(input: {
  provider: string
  label: string
  base_url: string
  api_key?: string
  fallback_models?: string[]
  free_only?: boolean
  profiles?: string[]
  profile?: string
  api_mode?: string
  credential_kind?: ProviderCatalogRefreshTarget['credential_kind']
}): Promise<ProviderModelCatalogEntry | null> {
  const provider = input.provider.trim()
  const baseUrl = normalizeCatalogBaseUrl(input.base_url)
  if (!provider || !baseUrl) return null

  const fetched = await fetchProviderCatalogRefreshTargetModels({
    provider,
    label: input.label,
    base_url: baseUrl,
    api_key: input.api_key || '',
    fallback_models: uniqueModels(input.fallback_models),
    free_only: input.free_only,
    profile: String(input.profile || input.profiles?.[0] || '').trim(),
    api_mode: input.api_mode,
    credential_kind: input.credential_kind || (input.api_key ? 'api_key' : 'none'),
  })
  if (fetched.length > 0) {
    return writeProviderModelCatalogEntry({
      provider,
      label: input.label,
      base_url: baseUrl,
      models: fetched,
      source: 'live',
      free_only: input.free_only,
      profiles: input.profiles,
      clear_profiles: input.profiles,
    })
  }

  const fallback = uniqueModels(input.fallback_models)
  if (fallback.length > 0) {
    return writeProviderModelCatalogEntry({
      provider,
      label: input.label,
      base_url: baseUrl,
      models: fallback,
      source: 'fallback',
      free_only: input.free_only,
      profiles: input.profiles,
      overwriteExistingModels: false,
    })
  }
  return null
}

function parseEnv(raw: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key && value && !value.startsWith('#')) env[key] = value
  }
  return env
}

function providerKeyForCustom(name: string): string {
  return `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
}

function mergeCandidate(candidates: Map<string, RefreshCandidate>, candidate: RefreshCandidate) {
  const key = providerModelCatalogKey(candidate.provider, candidate.base_url, candidate.free_only === true)
  const existing = candidates.get(key)
  if (!existing) {
    candidates.set(key, candidate)
    return
  }
  existing.fallback_models = Array.from(new Set([...existing.fallback_models, ...candidate.fallback_models]))
  existing.profile = Array.from(new Set([existing.profile, candidate.profile])).join(',')
  if (!existing.api_key && candidate.api_key) {
    existing.api_key = candidate.api_key
    existing.credential_kind = candidate.credential_kind
  }
  existing.skip_live_fetch = existing.skip_live_fetch === true && candidate.skip_live_fetch === true
}

async function fetchCodexOAuthModels(accessToken: string): Promise<string[]> {
  if (!accessToken) return []
  try {
    const res = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=1.0.0', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      logger.warn('[model-catalog-cache] Codex models returned %d', res.status)
      return []
    }
    const body = await res.json() as { models?: Array<{ slug?: unknown; visibility?: unknown; priority?: unknown }> }
    const sortable: Array<{ model: string; rank: number }> = []
    for (const item of Array.isArray(body.models) ? body.models : []) {
      const model = String(item.slug || '').trim()
      if (!model) continue
      const visibility = String(item.visibility || '').trim().toLowerCase()
      if (visibility === 'hide' || visibility === 'hidden') continue
      const priority = Number(item.priority)
      sortable.push({ model, rank: Number.isFinite(priority) ? priority : 10000 })
    }
    sortable.sort((a, b) => a.rank - b.rank || a.model.localeCompare(b.model))
    return uniqueModels(sortable.map(item => item.model))
  } catch (err) {
    logger.warn(err, '[model-catalog-cache] Codex models fetch failed')
    return []
  }
}

async function fetchClaudeOAuthModels(baseUrl: string, accessToken: string): Promise<string[]> {
  if (!accessToken) return []
  const base = normalizeCatalogBaseUrl(baseUrl)
  const modelsUrl = /\/v\d+(?:beta)?$/.test(base) ? `${base}/models` : `${base}/v1/models`
  try {
    const res = await fetch(modelsUrl, {
      headers: {
        ...openCodeSessionHeaders(modelsUrl),
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      logger.warn('[model-catalog-cache] Claude OAuth models returned %d', res.status)
      return []
    }
    const body = await res.json() as { data?: Array<{ id?: unknown }> }
    return uniqueModels((Array.isArray(body.data) ? body.data : []).map(item => String(item.id || '')))
  } catch (err) {
    logger.warn(err, '[model-catalog-cache] Claude OAuth models fetch failed')
    return []
  }
}

export async function fetchProviderCatalogRefreshTargetModels(
  target: ProviderCatalogRefreshTarget,
): Promise<string[]> {
  if (target.skip_live_fetch) return []
  if (target.provider === OPENCODE_FREE_PROVIDER) return fetchOpenCodeFreeModels()
  if (target.provider === 'openai-codex') return fetchCodexOAuthModels(target.api_key)
  if (target.provider === 'copilot') {
    try {
      const models = await fetchCopilotModelsWithOAuthToken(target.api_key)
      return uniqueModels(models.map(model => model.id))
    } catch (err) {
      logger.warn(err, '[model-catalog-cache] Copilot models fetch failed')
      return []
    }
  }
  if (target.provider === 'claude-oauth') {
    return fetchClaudeOAuthModels(target.base_url, target.api_key)
  }
  if (target.catalog_kind === 'capability') {
    return fetchOrcaRouterChatModels(target.base_url, target.api_key)
  }
  return fetchProviderModels(target.base_url, target.api_key, target.free_only === true)
}

export function usesOrcaRouterCapabilityCatalog(provider: string): boolean {
  return provider === ORCAROUTER_PROVIDER || provider === ORCAROUTER_OAUTH_PROVIDER
}

/** Full capability-filtered catalog with metadata, for the provider editor. */
export async function fetchOrcaRouterCapabilityCatalog(
  baseUrl: string,
  apiKey: string,
  capability: 'chat' | 'embedding' | 'image' | 'video' | 'rerank',
): Promise<OrcaRouterCatalogModel[]> {
  return fetchOrcaRouterCatalog(baseUrl, apiKey, capability)
}

/**
 * OrcaRouter's chat catalog needs its own read: the generic `/v1/models` fetch
 * would return image, video, embedding and rerank models too, and the model
 * selectors must only ever be offered routes this client can speak. The request
 * is bounded and fails closed — an undeclared capability is not a capability.
 */
export async function fetchOrcaRouterChatModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const models = await fetchOrcaRouterCatalog(baseUrl, apiKey, 'chat')
  return models.map(model => model.id)
}

export async function fetchOrcaRouterCatalog(
  baseUrl: string,
  apiKey: string,
  capability: 'chat' | 'embedding' | 'image' | 'video' | 'rerank',
): Promise<OrcaRouterCatalogModel[]> {
  if (!apiKey) return []
  const modelsUrl = orcaRouterModelsUrl(normalizeOrcaRouterApiBase(baseUrl), capability)
  try {
    const response = await fetch(modelsUrl, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(ORCAROUTER_CATALOG_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.warn('[model-catalog-cache] OrcaRouter catalog %s returned %d', capability, response.status)
      return []
    }
    const declaredLength = Number(response.headers.get('content-length') || 0)
    if (declaredLength > ORCAROUTER_CATALOG_MAX_BYTES) {
      logger.warn('[model-catalog-cache] OrcaRouter catalog %s exceeded the byte cap', capability)
      return []
    }
    const text = await response.text()
    if (text.length > ORCAROUTER_CATALOG_MAX_BYTES) {
      logger.warn('[model-catalog-cache] OrcaRouter catalog %s exceeded the byte cap', capability)
      return []
    }
    const parsed = text ? JSON.parse(text) : {}
    return filterOrcaRouterModels(normalizeOrcaRouterCatalogModels(parsed), capability)
  } catch (err) {
    logger.warn(err, '[model-catalog-cache] OrcaRouter catalog %s fetch failed', capability)
    return []
  }
}

function hasOAuthCredential(value: any): boolean {
  return !!(
    value?.tokens?.access_token ||
    value?.tokens?.refresh_token ||
    value?.access_token ||
    value?.refresh_token ||
    value?.agent_key
  )
}

async function profileStoredAuthCredential(profile: string, provider: string): Promise<StoredAuthCatalogCredential> {
  if (provider === 'qwen-oauth') {
    try {
      const credentials = await resolveAuthorizedProviderRuntimeCredentials({ profile, provider })
      return {
        hasAuth: true,
        api_key: credentials.apiKey,
        ...(credentials.baseUrl ? { base_url: credentials.baseUrl } : {}),
      }
    } catch {
      return { hasAuth: false }
    }
  }
  try {
    const raw = await readFile(join(getProfileDir(profile), 'auth.json'), 'utf-8')
    const auth = JSON.parse(raw)
    const providerEntry = auth?.providers?.[provider]
    const pool = auth?.credential_pool?.[provider]
    const poolEntry = Array.isArray(pool) ? pool.find(hasOAuthCredential) : null
    const hasAuth = !!(
      hasOAuthCredential(providerEntry) ||
      poolEntry
    )
    if (!hasAuth) return { hasAuth: false }
    try {
      const credentials = await resolveAuthorizedProviderRuntimeCredentials({ profile, provider })
      return {
        hasAuth: true,
        api_key: credentials.apiKey,
        ...(credentials.baseUrl ? { base_url: credentials.baseUrl } : {}),
      }
    } catch (err) {
      logger.warn(err, '[model-catalog-cache] failed to refresh authorized credentials profile=%s provider=%s', profile, provider)
      return { hasAuth: true }
    }
  } catch {
    return { hasAuth: false }
  }
}

async function collectRefreshCandidates(profiles = listProfileNamesFromDisk()): Promise<RefreshCandidate[]> {
  const candidates = new Map<string, RefreshCandidate>()
  const presetsByProvider = new Map(PROVIDER_PRESETS.map(preset => [preset.value, preset]))
  const appConfig = await readAppConfig().catch((): { copilotEnabled?: boolean } => ({}))
  const copilotEnabled = appConfig.copilotEnabled === true

  for (const profile of profiles) {
    let env: Record<string, string> = {}
    let envContent = ''
    try {
      envContent = await readFile(join(getProfileDir(profile), '.env'), 'utf-8')
      env = parseEnv(envContent)
    } catch {}

    let configYaml: Record<string, any> = {}
    try { configYaml = await readConfigYamlForProfile(profile) } catch {}
    const activeProvider = typeof configYaml.model === 'object' && configYaml.model !== null
      ? String(configYaml.model.provider || '').trim()
      : ''

    for (const [provider, mapping] of Object.entries(PROVIDER_ENV_MAP)) {
      const preset = presetsByProvider.get(provider)
      if (!preset?.base_url) continue
      if (provider === 'copilot') {
        if (!copilotEnabled) continue
        const oauthToken = await resolveCopilotOAuthToken(envContent)
        if (!oauthToken) continue
        mergeCandidate(candidates, {
          provider,
          label: preset.label,
          base_url: normalizeCatalogBaseUrl(preset.base_url),
          api_key: oauthToken,
          fallback_models: preset.models,
          profile,
          api_mode: preset.api_mode,
          credential_kind: 'copilot',
        })
        continue
      }
      const apiKey = mapping.api_key_env ? env[mapping.api_key_env] || '' : ''
      let skipLiveFetch = false
      if (mapping.api_key_env && !apiKey) {
        continue
      }
      if (!mapping.api_key_env) {
        const keylessActive = KEYLESS_CATALOG_PROVIDERS.has(provider) && activeProvider === provider
        const authCredential = AUTH_CATALOG_PROVIDERS.has(provider)
          ? await profileStoredAuthCredential(profile, provider)
          : { hasAuth: false }
        if (!keylessActive && !authCredential.hasAuth) continue
        if (authCredential.api_key) {
          const authBaseUrl = normalizeCatalogBaseUrl(authCredential.base_url || preset.base_url)
          if (authBaseUrl) {
            mergeCandidate(candidates, {
              provider,
              label: preset.label,
              base_url: authBaseUrl,
              api_key: authCredential.api_key,
              fallback_models: preset.models,
              free_only: provider === 'openrouter',
              profile,
              api_mode: preset.api_mode,
              credential_kind: 'oauth',
              ...(usesOrcaRouterCapabilityCatalog(provider) ? { catalog_kind: 'capability' as const } : {}),
            })
            continue
          }
        }
        skipLiveFetch = authCredential.hasAuth && !keylessActive
      }
      const baseUrl = normalizeCatalogBaseUrl(mapping.base_url_env && env[mapping.base_url_env] ? env[mapping.base_url_env] : preset.base_url)
      if (!baseUrl) continue
      mergeCandidate(candidates, {
        provider,
        label: preset.label,
        base_url: baseUrl,
        api_key: apiKey,
        fallback_models: preset.models,
        free_only: provider === 'openrouter',
        profile,
        api_mode: preset.api_mode,
        credential_kind: apiKey ? 'api_key' : 'none',
        skip_live_fetch: skipLiveFetch,
        ...(usesOrcaRouterCapabilityCatalog(provider) ? { catalog_kind: 'capability' as const } : {}),
      })
    }

    const customProviders = getCompatibleCustomProviders(configYaml)
    for (const cp of customProviders) {
      const name = cp.name
      const baseUrl = normalizeCatalogBaseUrl(cp.base_url)
      if (!name || !baseUrl) continue
      const provider = providerKeyForCustom(name)
      const presetModels = presetsByProvider.get(name)?.models || []
      // Respect the configured `models:` whitelist (v12+ dict) when present —
      // those entries should always be reachable as fallbacks even before a
      // live `/v1/models` probe runs.
      const configuredModels = cp.models ? Object.keys(cp.models) : []
      const apiKey = cp.key_env ? env[cp.key_env] || '' : cp.api_key || ''
      mergeCandidate(candidates, {
        provider,
        label: name,
        base_url: baseUrl,
        api_key: apiKey,
        fallback_models: uniqueModels([cp.model, ...configuredModels, ...presetModels]),
        profile,
        api_mode: cp.api_mode,
        credential_kind: apiKey ? 'api_key' : 'none',
      })
    }
  }

  return [...candidates.values()]
}

export async function resolveProviderCatalogRefreshTarget(
  profile: string,
  provider: string,
): Promise<ProviderCatalogRefreshTarget | null> {
  if (provider === OPENCODE_FREE_PROVIDER) {
    return { provider, label: 'OpenCode Free', base_url: OPENCODE_FREE_BASE_URL,
      api_key: '', fallback_models: [], profile, credential_kind: 'none' }
  }
  const candidates = await collectRefreshCandidates([profile])
  return candidates.find(candidate => candidate.provider === provider) || null
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) continue
      await worker(item)
    }
  })
  await Promise.all(workers)
}

export async function refreshConfiguredProviderModelCatalogs(options: { force?: boolean } = {}): Promise<void> {
  const cache = await readProviderModelCatalogCache()
  if (!options.force && Object.keys(cache.providers).length > 0) {
    logger.info('[model-catalog-cache] provider model catalog cache exists; skipping startup refresh')
    return
  }

  const candidates = await collectRefreshCandidates()
  if (candidates.length === 0) return
  logger.info('[model-catalog-cache] refreshing %d configured provider catalogs', candidates.length)
  await runLimited(candidates, 4, async (candidate) => {
    try {
      const profiles = candidate.profile.split(',').filter(Boolean)
      if (candidate.skip_live_fetch) {
        await writeProviderModelCatalogEntry({
          provider: candidate.provider,
          label: candidate.label,
          base_url: candidate.base_url,
          models: candidate.fallback_models,
          source: 'fallback',
          free_only: candidate.free_only,
          profiles,
          overwriteExistingModels: false,
        })
      } else {
        await refreshProviderModelCatalog({
          provider: candidate.provider,
          label: candidate.label,
          base_url: candidate.base_url,
          api_key: candidate.api_key,
          fallback_models: candidate.fallback_models,
          free_only: candidate.free_only,
          profiles,
          profile: candidate.profile,
          api_mode: candidate.api_mode,
          credential_kind: candidate.credential_kind,
        })
      }
    } catch (err) {
      logger.warn(err, '[model-catalog-cache] failed to refresh provider=%s base_url=%s', candidate.provider, candidate.base_url)
    }
  })
}

export function refreshConfiguredProviderModelCatalogsInBackground(reason = 'startup'): void {
  if (backgroundRefresh) return
  backgroundRefresh = refreshConfiguredProviderModelCatalogs()
    .catch(err => logger.warn(err, '[model-catalog-cache] background refresh failed reason=%s', reason))
    .finally(() => { backgroundRefresh = null })
}
