import { openCodeSessionHeaders } from '../../studio/public/opencode-session'
import { openRouterAttributionHeaders } from '../../studio/public/openrouter-attribution'
import { readFile } from 'fs/promises'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getActiveEnvPath, getActiveAuthPath, getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from '../services/profiles/profile'
import { readConfigYaml, readConfigYamlForProfile, updateConfigYaml, updateConfigYamlForProfile, buildModelGroups, PROVIDER_ENV_MAP } from '../../studio/public/profile-config'
import { fetchProviderModels } from '../../studio/public/provider-catalog'
import { getCompatibleCustomProviders } from '../../studio/contracts/provider-compat'
import { buildProviderModelMap, PROVIDER_PRESETS } from '../../studio/contracts/providers'
import { getCopilotModelsDetailed, resolveCopilotOAuthToken, type CopilotModelMeta } from '../services/providers/copilot-models'
import { readAppConfig, writeAppConfig, providerDisplayLabel, type ModelVisibilityRule } from '../../studio/public/app-config'
import { listUserProfiles } from '../../studio/public/users'
import { readModelContextRecord, upsertModelContextRecord } from '../../studio/public/provider-context'
import { getModelContextLength } from '../services/models/context'
import { readProviderModelCatalogCache,
  refreshConfiguredProviderModelCatalogs,
  resolveProviderCatalogModels,
  resolveProviderCatalogEntry,
  writeProviderModelCatalogEntry,
  type ProviderModelCatalogCache,
} from '../services/providers/model-catalog-cache'
import { providerEditorCapabilities, type ProviderEditableField } from '../services/providers/provider-editor'
import { providerModelRefreshCapabilities } from '../services/providers/provider-model-refresh'
import { getOpenCodeFreeStatus, type OpenCodeFreeStatus } from '../services/providers/opencode-free'
import { OPENCODE_FREE_PROVIDER, OPENCODE_FREE_BASE_URL, isOpenCodeFreeModel } from '../../studio/contracts/opencode-free'

const PROVIDER_MODEL_CATALOG = buildProviderModelMap()

type ModelMeta = { preview?: boolean; disabled?: boolean; alias?: string }
type ProviderApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'
type AvailableGroup = { catalog_status?: OpenCodeFreeStatus; provider: string; label: string; base_url: string; models: string[]; api_key: string; api_mode?: ProviderApiMode; builtin?: boolean; model_meta?: Record<string, ModelMeta>; available_models?: string[]; base_url_env?: string; provider_source?: 'custom_providers' | 'providers'; provider_key?: string; provider_editable?: boolean; editable_fields?: ProviderEditableField[]; model_refreshable?: boolean; model_refresh_reason?: string; model_restore_available?: boolean }
type ModelVisibility = Record<string, ModelVisibilityRule>
type CustomModels = Record<string, string[]>

const RESERVED_ALIAS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function enabledMoaPresetNames(config: any): string[] {
  const presets = config?.moa?.presets
  if (!presets || typeof presets !== 'object' || Array.isArray(presets)) return []
  const enabled = Object.entries(presets)
    .filter(([name, preset]) => {
      if (!name.trim() || !preset || typeof preset !== 'object' || Array.isArray(preset)) return false
      return (preset as Record<string, unknown>).enabled !== false
    })
    .map(([name]) => name.trim())
  const defaultPreset = typeof config?.moa?.default_preset === 'string'
    ? config.moa.default_preset.trim()
    : ''
  if (!defaultPreset || !enabled.includes(defaultPreset)) return enabled
  return [defaultPreset, ...enabled.filter(name => name !== defaultPreset)]
}

function isSafeAliasKey(value: string): boolean {
  const trimmed = value.trim()
  return !!trimmed && trimmed.length <= 512 && !RESERVED_ALIAS_KEYS.has(trimmed)
}

function createAliasMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function createProviderAliasMap(): Record<string, Record<string, string>> {
  return Object.create(null) as Record<string, Record<string, string>>
}

function normalizeAliases(value: unknown): Record<string, Record<string, string>> {
  const normalized = createProviderAliasMap()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized
  for (const [provider, models] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafeAliasKey(provider) || !models || typeof models !== 'object' || Array.isArray(models)) continue
    for (const [model, alias] of Object.entries(models as Record<string, unknown>)) {
      if (!isSafeAliasKey(model) || typeof alias !== 'string') continue
      const trimmed = alias.trim()
      if (!trimmed || trimmed.length > 512) continue
      if (!Object.hasOwn(normalized, provider)) normalized[provider] = createAliasMap()
      normalized[provider][model] = trimmed
    }
  }
  return normalized
}

function applyModelAliases<T extends { provider: string; models: string[]; model_meta?: Record<string, ModelMeta> }>(groups: T[], aliases: Record<string, Record<string, string>>): T[] {
  return groups.map((group) => {
    const providerAliases = aliases[group.provider]
    if (!providerAliases) return group
    const modelMeta: Record<string, ModelMeta> = { ...(group.model_meta || {}) }
    let changed = false
    for (const model of group.models) {
      const alias = providerAliases[model]
      if (!alias) continue
      modelMeta[model] = { ...(modelMeta[model] || {}), alias }
      changed = true
    }
    return changed ? { ...group, model_meta: modelMeta } : group
  })
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.map(v => String(v || '').trim()).filter(Boolean)))
}

function normalizeCustomModels(input: unknown): CustomModels {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: CustomModels = {}
  for (const [provider, rawModels] of Object.entries(input as Record<string, unknown>)) {
    const providerKey = String(provider || '').trim()
    if (!providerKey) continue
    const models = uniqueStrings(rawModels)
    if (models.length > 0) out[providerKey] = models
  }
  return out
}

function applyCustomModels(groups: AvailableGroup[], customModels: CustomModels): AvailableGroup[] {
  return groups.map(group => {
    if (group.provider === OPENCODE_FREE_PROVIDER) return group
    const extra = customModels[group.provider] || []
    if (!extra.length) return group
    const models = [...new Set([...group.models, ...extra])]
    const availableModels = [...new Set([...(group.available_models || group.models), ...extra])]
    return { ...group, models, available_models: availableModels }
  })
}

function providerPresetToGroup(p: any, models?: string[]): AvailableGroup {
  const envMapping = PROVIDER_ENV_MAP[p.value]
  const apiMode = providerApiMode(p.value)
  const editor = providerEditorCapabilities(p.value)
  return {
    provider: p.value,
    label: p.label,
    base_url: p.base_url,
    models: p.value === OPENCODE_FREE_PROVIDER
      ? getOpenCodeFreeStatus() === 'unsupported' ? [] : (models || p.models).filter(isOpenCodeFreeModel)
      : models || p.models,
    ...(p.value === OPENCODE_FREE_PROVIDER ? { catalog_status: getOpenCodeFreeStatus() } : {}),
    api_key: '',
    ...(apiMode ? { api_mode: apiMode } : {}),
    ...(p.builtin ? { builtin: true } : {}),
    ...(envMapping?.base_url_env ? { base_url_env: envMapping.base_url_env } : {}),
    provider_editable: editor.editable,
    editable_fields: editor.editable_fields,
  }
}

function normalizeModelVisibility(input: unknown): ModelVisibility {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const out: ModelVisibility = {}
  for (const [provider, rawRule] of Object.entries(input as Record<string, unknown>)) {
    const providerKey = String(provider || '').trim()
    if (!providerKey || !rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue
    const rule = rawRule as { mode?: unknown; models?: unknown }
    const mode = rule.mode === 'include' ? 'include' : 'all'
    const models = uniqueStrings(rule.models)
    if (mode === 'include') {
      if (models.length > 0) out[providerKey] = { mode, models }
    } else {
      out[providerKey] = { mode: 'all', models: [] }
    }
  }
  return out
}

function filterModelsForProvider(provider: string, models: string[], visibility: ModelVisibility): string[] {
  const rule = visibility[provider]
  if (!rule || rule.mode !== 'include') return models
  const allowed = new Set(rule.models)
  const visible = models.filter(model => allowed.has(model))
  // If a stale hand-edited rule references models that are no longer present,
  // fail open so the provider remains recoverable from the Web UI.
  return visible.length > 0 ? visible : models
}

function applyModelVisibility(groups: AvailableGroup[], visibility: ModelVisibility): AvailableGroup[] {
  return groups
    .map(group => {
      const availableModels = group.available_models || group.models
      return {
        ...group,
        available_models: availableModels,
        models: filterModelsForProvider(group.provider, availableModels, visibility),
      }
    })
    .filter(group => group.models.length > 0 || group.provider === OPENCODE_FREE_PROVIDER)
}

function resolveVisibleDefault(defaultModel: string, defaultProvider: string, groups: AvailableGroup[]) {
  if (defaultModel) {
    const explicit = groups.find(group => group.provider === defaultProvider && group.models.includes(defaultModel))
    if (explicit) return { defaultModel, defaultProvider }
    const inferred = groups.find(group => group.models.includes(defaultModel))
    if (inferred) return { defaultModel, defaultProvider: inferred.provider }
  }
  const fallback = groups.find(group => group.models.length > 0)
  return { defaultModel: fallback?.models[0] || '', defaultProvider: fallback?.provider || '' }
}

function profileEnvPath(profile: string): string {
  return join(getProfileDir(profile), '.env')
}

function profileAuthPath(profile: string): string {
  return join(getProfileDir(profile), 'auth.json')
}

function envReader(envContent: string) {
  const envHasValue = (key: string): boolean => {
    if (!key) return false
    const match = envContent.match(new RegExp(`^${key}\\s*=[ \\t]*(.+)`, 'm'))
    return !!match && match[1].trim() !== '' && !match[1].trim().startsWith('#')
  }
  const envGetValue = (key: string): string => {
    if (!key) return ''
    const match = envContent.match(new RegExp(`^${key}\\s*=[ \\t]*(.+)`, 'm'))
    return match?.[1]?.trim() || ''
  }
  return { envHasValue, envGetValue }
}

function providerKeyForCustom(name: string): string {
  return `custom:${name.trim().toLowerCase().replace(/ /g, '-')}`
}

function providerKeyWithoutCustomPrefix(providerKey: string): string {
  return providerKey.startsWith('custom:') ? providerKey.slice('custom:'.length) : providerKey
}

function isBuiltinProviderKey(providerKey: string): boolean {
  const normalized = providerKeyWithoutCustomPrefix(providerKey)
  return PROVIDER_PRESETS.some((preset: any) => preset.value === normalized && preset.builtin === true)
}

function normalizeProviderApiMode(mode: unknown): AvailableGroup['api_mode'] {
  return mode === 'chat_completions' ||
    mode === 'codex_responses' ||
    mode === 'anthropic_messages' ||
    mode === 'bedrock_converse' ||
    mode === 'codex_app_server'
    ? mode
    : undefined
}

function providerApiMode(providerKey: string, configuredMode?: unknown): AvailableGroup['api_mode'] {
  const explicitMode = normalizeProviderApiMode(configuredMode)
  if (explicitMode) return explicitMode
  const normalized = providerKeyWithoutCustomPrefix(providerKey)
  const preset = PROVIDER_PRESETS.find((item: any) => item.value === normalized)
  return normalizeProviderApiMode(preset?.api_mode)
}

function providerShouldFetchLiveModels(providerKey: string): boolean {
  return providerKey === 'openrouter' ||
    providerKey === 'cliproxyapi' ||
    providerKey === 'ollama-cloud' ||
    providerKey === 'lmstudio' ||
    providerKey === 'nvidia'
}

function providerSupportsStoredOAuth(providerKey: string): boolean {
  return providerKey === 'claude-oauth' || providerKey === 'minimax-oauth'
}

interface StoredOAuthCredential {
  authorized: boolean
  baseUrl: string
}

function storedOAuthCredential(auth: any, providerKey: string): StoredOAuthCredential {
  const providerKeys = providerKey === 'claude-oauth'
    ? ['claude-oauth', 'anthropic']
    : [providerKey]
  for (const key of providerKeys) {
    const provider = auth?.providers?.[key]
    const pool = auth?.credential_pool?.[key]
    const poolEntry = Array.isArray(pool)
      ? pool.find((entry: any) => entry?.access_token || entry?.agent_key)
      : undefined
    const authorized = !!(
      provider?.tokens?.access_token ||
      provider?.access_token ||
      provider?.agent_key ||
      poolEntry?.access_token ||
      poolEntry?.agent_key
    )
    if (!authorized) continue
    const baseUrl = String(
      provider?.inference_base_url ||
      provider?.runtime_base_url ||
      provider?.base_url ||
      poolEntry?.inference_base_url ||
      poolEntry?.runtime_base_url ||
      poolEntry?.base_url ||
      '',
    ).trim().replace(/\/+$/, '')
    return { authorized: true, baseUrl }
  }
  return { authorized: false, baseUrl: '' }
}

function includeConfiguredDefaultModel(providerKey: string, modelsList: string[], currentDefault: string, currentDefaultProvider: string): string[] {
  if (!currentDefault || providerKey !== currentDefaultProvider) return modelsList
  return [...new Set([...modelsList, currentDefault])]
}

function mergeAvailableGroups(groups: AvailableGroup[]): AvailableGroup[] {
  const byProvider = new Map<string, AvailableGroup>()
  for (const group of groups) {
    const existing = byProvider.get(group.provider)
    if (!existing) {
      byProvider.set(group.provider, {
        ...group,
        models: [...new Set(group.models)],
        available_models: [...new Set(group.available_models || group.models)],
        model_meta: group.model_meta ? { ...group.model_meta } : undefined,
      })
      continue
    }
    existing.models = [...new Set([...existing.models, ...group.models])]
    existing.available_models = [...new Set([...(existing.available_models || existing.models), ...(group.available_models || group.models)])]
    existing.api_key = existing.api_key || group.api_key
    existing.base_url = existing.base_url || group.base_url
    existing.api_mode = existing.api_mode || group.api_mode
    existing.builtin = existing.builtin || group.builtin
    existing.model_meta = { ...(existing.model_meta || {}), ...(group.model_meta || {}) }
    if (existing.model_meta && Object.keys(existing.model_meta).length === 0) delete existing.model_meta
  }
  return [...byProvider.values()]
}

type ProviderFetchCache = Map<string, Promise<string[]>>

function requestedProfileName(ctx: any): string {
  const queryProfile = ctx.query?.profile
  return typeof queryProfile === 'string' && queryProfile.trim() ? queryProfile.trim() : ''
}

function requestScopedProfileName(ctx: any): string {
  const headerProfile = typeof ctx.get === 'function' ? ctx.get('x-hermes-profile') : ''
  const queryProfile = typeof ctx.query?.profile === 'string' ? ctx.query.profile : ''
  const bodyProfile = typeof ctx.request?.body?.profile === 'string' ? ctx.request.body.profile : ''
  return ctx.state?.profile?.name ||
    headerProfile.trim() ||
    queryProfile.trim() ||
    bodyProfile.trim() ||
    getActiveProfileName() ||
    'default'
}

function visibleProfileNamesForUser(ctx: any): string[] {
  const diskProfiles = listProfileNamesFromDisk()
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return diskProfiles
  const allowed = new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
  return diskProfiles.filter(profile => allowed.has(profile))
}

function cachedProviderModels(
  cache: ProviderFetchCache,
  baseUrl: string,
  apiKey: string,
  freeOnly = false,
): Promise<string[]> {
  const key = `${baseUrl.replace(/\/+$/, '')}\n${apiKey}\n${freeOnly ? 'free' : 'all'}`
  let pending = cache.get(key)
  if (!pending) {
    pending = fetchProviderModels(baseUrl, apiKey, freeOnly)
    cache.set(key, pending)
  }
  return pending
}


// Copilot 授权检测：复用同一套 token 解析逻辑（含 ~/.config/github-copilot/apps.json
// 与 ghp_ PAT 跳过），与 getCopilotModels 行为一致，避免出现"模型能拉到却被判未授权"。
async function isCopilotAuthorized(envContent: string): Promise<boolean> {
  return !!(await resolveCopilotOAuthToken(envContent))
}

async function buildAvailableForProfile(
  profile: string,
  modelCatalogCache: ProviderModelCatalogCache,
  appConfig: Awaited<ReturnType<typeof readAppConfig>>,
): Promise<{
  profile: string
  default: string
  default_provider: string
  groups: AvailableGroup[]
}> {
  const config = await readConfigYamlForProfile(profile)
  const modelSection = config.model
  let currentDefault = ''
  let currentDefaultProvider = ''
  if (typeof modelSection === 'object' && modelSection !== null) {
    currentDefault = String(modelSection.default || '').trim()
    currentDefaultProvider = String(modelSection.provider || '').trim()
    if (currentDefaultProvider === 'custom' && currentDefault) {
      const cps = getCompatibleCustomProviders(config)
      const match = cps.find(
        (cp) => cp.base_url?.replace(/\/+$/, '') === String(modelSection.base_url || '').replace(/\/+$/, '')
          && cp.model === currentDefault,
      )
      if (match) currentDefaultProvider = providerKeyForCustom(String(match.name || ''))
    }
  } else if (typeof modelSection === 'string') {
    currentDefault = modelSection.trim()
  }

  let envContent = ''
  try { envContent = await readFile(profileEnvPath(profile), 'utf-8') } catch {}
  const { envHasValue, envGetValue } = envReader(envContent)

  let storedAuth: any = {}
  try {
    const authPath = profileAuthPath(profile)
    if (existsSync(authPath)) storedAuth = JSON.parse(readFileSync(authPath, 'utf-8'))
  } catch {}
  const oauthCredential = (providerKey: string): StoredOAuthCredential => (
    storedOAuthCredential(storedAuth, providerKey)
  )
  const isOAuthAuthorized = (providerKey: string): boolean => oauthCredential(providerKey).authorized

  const groups: AvailableGroup[] = []
  const seenProviders = new Set<string>()
  const addGroup = (provider: string, label: string, base_url: string, models: string[], api_key: string, builtin?: boolean, model_meta?: Record<string, ModelMeta>, extra?: Pick<AvailableGroup, 'provider_source' | 'provider_key' | 'api_mode'>) => {
    if (seenProviders.has(provider)) return
    seenProviders.add(provider)
    const availableModels = [...new Set(models)]
    const apiMode = providerApiMode(provider, extra?.api_mode)
    const displayLabel = providerDisplayLabel(appConfig, profile, provider, label)
    const editor = providerEditorCapabilities(provider)
    const refresh = providerModelRefreshCapabilities(apiMode)
    const catalogEntry = resolveProviderCatalogEntry(modelCatalogCache, provider, base_url, {
      freeOnly: provider === 'openrouter',
      profile,
    })
    const unavailableMeta: Record<string, ModelMeta> = { ...(model_meta || {}) }
    for (const model of catalogEntry?.unavailable_models || []) {
      unavailableMeta[model] = { ...(unavailableMeta[model] || {}), disabled: true }
    }
    groups.push({
      provider,
      label: displayLabel,
      base_url,
      models: availableModels,
      available_models: availableModels,
      api_key,
      ...(apiMode ? { api_mode: apiMode } : {}),
      ...(builtin ? { builtin: true } : {}),
      ...(Object.keys(unavailableMeta).length ? { model_meta: unavailableMeta } : {}),
      ...(extra?.provider_source ? { provider_source: extra.provider_source } : {}),
      ...(extra?.provider_key ? { provider_key: extra.provider_key } : {}),
      provider_editable: editor.editable,
      editable_fields: editor.editable_fields,
      model_refreshable: refresh.refreshable,
      ...(refresh.refresh_reason ? { model_refresh_reason: refresh.refresh_reason } : {}),
      model_restore_available: !!(catalogEntry?.previous_models?.length),
    })
  }

  const copilotEnabled = appConfig.copilotEnabled === true
  if (!copilotEnabled && currentDefaultProvider.toLowerCase() === 'copilot') {
    currentDefault = ''
    currentDefaultProvider = ''
  }

  for (const [providerKey, envMapping] of Object.entries(PROVIDER_ENV_MAP)) {
    if (providerKey === OPENCODE_FREE_PROVIDER) {
      const freeStatus = getOpenCodeFreeStatus()
      const models = freeStatus === 'unsupported' ? [] : resolveProviderCatalogModels(
        modelCatalogCache, providerKey, OPENCODE_FREE_BASE_URL, [],
      ).filter(isOpenCodeFreeModel)
      addGroup(providerKey, 'OpenCode Free', OPENCODE_FREE_BASE_URL, models, '', true)
      const group = groups.find(item => item.provider === providerKey)
      if (group) group.catalog_status = freeStatus
      continue
    }
    const oauthAuthorized = providerSupportsStoredOAuth(providerKey) ? isOAuthAuthorized(providerKey) : false
    if (envMapping.api_key_env && !envHasValue(envMapping.api_key_env) && !oauthAuthorized) continue
    if (!envMapping.api_key_env) {
      if (providerKey === 'copilot') {
        if (!copilotEnabled) continue
        if (!(await isCopilotAuthorized(envContent))) continue
      } else if (!isOAuthAuthorized(providerKey)) {
        continue
      }
    }
    const preset = PROVIDER_PRESETS.find((p: any) => p.value === providerKey)
    const label = preset?.label || providerKey.replace(/^custom:/, '')
    let baseUrl = oauthCredential(providerKey).baseUrl || preset?.base_url || ''
    if (envMapping.base_url_env && envHasValue(envMapping.base_url_env)) {
      baseUrl = envGetValue(envMapping.base_url_env) || baseUrl
    }
    const catalogModels = PROVIDER_MODEL_CATALOG[providerKey]
    const staticModels: string[] = catalogModels && catalogModels.length > 0 ? [...catalogModels] : [...(preset?.models || [])]
    let modelsList = resolveProviderCatalogModels(
      modelCatalogCache,
      providerKey,
      baseUrl,
      staticModels,
      {
        freeOnly: providerKey === 'openrouter',
        hasStaticManifest: preset?.builtin === true,
        profile,
      },
    )
    modelsList = includeConfiguredDefaultModel(providerKey, modelsList, currentDefault, currentDefaultProvider)
    if (modelsList.length > 0) {
      const apiKey = envMapping.api_key_env ? envGetValue(envMapping.api_key_env) : ''
      addGroup(providerKey, label, baseUrl, modelsList, apiKey, true)
    }
  }

  const customProviders = getCompatibleCustomProviders(config)
  const customFetches = await Promise.allSettled(
    customProviders.map(async cp => {
      if (!cp.base_url) return null
      const providerKey = providerKeyForCustom(cp.name)
      const baseUrl = cp.base_url.replace(/\/+$/, '')
      const builtinProviderKey = providerKeyWithoutCustomPrefix(providerKey)
      const builtinPreset = PROVIDER_PRESETS.find((preset: any) => preset.value === builtinProviderKey)
      const hasStaticManifest = builtinPreset?.builtin === true
      const builtinCatalogModels = hasStaticManifest
        ? (PROVIDER_MODEL_CATALOG[builtinProviderKey] || builtinPreset.models || [])
        : []
      // Both Hermes config styles are valid: custom providers may expose a
      // `models` mapping (for per-model metadata/API modes) as well as the
      // legacy single `model` field. Explicit IDs remain visible alongside the
      // resolved live-or-static provider catalog.
      const configuredModels = cp.models ? Object.keys(cp.models) : []
      const resolvedCatalogModels = resolveProviderCatalogModels(
        modelCatalogCache,
        providerKey,
        baseUrl,
        [...builtinCatalogModels],
        { hasStaticManifest, profile },
      )
      const models = [...new Set([cp.model, ...configuredModels, ...resolvedCatalogModels].filter(Boolean) as string[])]
      return { providerKey, label: cp.name, base_url: baseUrl, models, api_key: cp.api_key || '', api_mode: cp.api_mode, builtin: hasStaticManifest, provider_source: cp.source, provider_key: cp.provider_key }
    }),
  )
  for (const result of customFetches) {
    if (result.status === 'fulfilled' && result.value?.models.length) {
      const { providerKey, label, base_url, models, api_key, api_mode, builtin, provider_source, provider_key } = result.value
      addGroup(providerKey, label, base_url, models, api_key, builtin, undefined, { provider_source, provider_key, api_mode })
    }
  }

  if (groups.length === 0) {
    const fallback = buildModelGroups(config)
    for (const group of fallback.groups) {
      const models = group.models.map(model => model.id)
      if (models.length) addGroup(group.provider, group.provider, '', models, '')
    }
    currentDefault = currentDefault || fallback.default
  }

  const moaPresets = enabledMoaPresetNames(config)
  if (moaPresets.length > 0) {
    addGroup(
      'moa',
      'Mixture of Agents',
      'moa://local',
      moaPresets,
      'moa-virtual-provider',
      true,
      undefined,
      { api_mode: 'chat_completions' },
    )
  }

  for (const g of groups) {
    g.models = Array.from(new Set(g.models))
    g.available_models = Array.from(new Set(g.available_models || g.models))
  }
  const groupsWithCustomModels = applyCustomModels(groups, normalizeCustomModels(appConfig.customModels))

  return { profile, default: currentDefault, default_provider: currentDefaultProvider, groups: groupsWithCustomModels }
}

export async function getAvailableModelGroupsForProfile(profile: string): Promise<AvailableGroup[]> {
  const appConfig = await readAppConfig()
  const modelVisibility = normalizeModelVisibility(appConfig.modelVisibility)
  const modelCatalogCache = await readProviderModelCatalogCache()
  const result = await buildAvailableForProfile(profile || 'default', modelCatalogCache, appConfig)
  return applyModelVisibility(result.groups, modelVisibility)
}

export async function getAvailable(ctx: any) {
  try {
    const requestedProfile = requestedProfileName(ctx)
    if (!requestedProfile) {
      const appConfig = await readAppConfig()
      const modelAliases = normalizeAliases(appConfig.modelAliases)
      const modelVisibility = normalizeModelVisibility(appConfig.modelVisibility)
      const customModels = normalizeCustomModels(appConfig.customModels)
      const modelCatalogCache = await readProviderModelCatalogCache()
      const visibleProfiles = visibleProfileNamesForUser(ctx)
      const profileResults = await Promise.all(
        visibleProfiles.map(profile => buildAvailableForProfile(profile, modelCatalogCache, appConfig)),
      )
      const mergedGroups = mergeAvailableGroups(profileResults.flatMap(result => result.groups))
      const groupsWithAliases = applyModelAliases(mergedGroups, modelAliases)
      const visibleGroups = applyModelVisibility(groupsWithAliases, modelVisibility)
      const activeProfile = requestScopedProfileName(ctx)
      const defaultProfile = profileResults.find(result => result.profile === activeProfile && (result.default || result.default_provider))
        || profileResults.find(result => result.default && result.default_provider)
        || profileResults.find(result => result.default)
      const visibleDefault = resolveVisibleDefault(
        defaultProfile?.default || '',
        defaultProfile?.default_provider || '',
        visibleGroups,
      )
      const allProvidersBase = PROVIDER_PRESETS.map((p: any) => providerPresetToGroup(
        p,
        resolveProviderCatalogModels(modelCatalogCache, p.value, p.base_url, p.models, {
          freeOnly: p.value === 'openrouter',
          hasStaticManifest: p.builtin === true,
        }),
      ))
      ctx.body = {
        default: visibleDefault.defaultModel,
        default_provider: visibleDefault.defaultProvider,
        groups: visibleGroups,
        allProviders: applyModelAliases(allProvidersBase, modelAliases),
        model_aliases: modelAliases,
        model_visibility: modelVisibility,
        custom_models: customModels,
        profiles: profileResults.map(result => ({
          profile: result.profile,
          default: result.default,
          default_provider: result.default_provider,
          groups: applyModelVisibility(applyModelAliases(result.groups, modelAliases), modelVisibility),
        })),
      }
      return
    }

    const appConfigForProfile = await readAppConfig()
    const modelAliasesForProfile = normalizeAliases(appConfigForProfile.modelAliases)
    const modelVisibilityForProfile = normalizeModelVisibility(appConfigForProfile.modelVisibility)
    const customModelsForProfile = normalizeCustomModels(appConfigForProfile.customModels)
    const modelCatalogCacheForProfile = await readProviderModelCatalogCache()
    const profileResult = await buildAvailableForProfile(requestedProfile, modelCatalogCacheForProfile, appConfigForProfile)
    const profileGroupsWithAliases = applyModelAliases(profileResult.groups, modelAliasesForProfile)
    const visibleProfileGroups = applyModelVisibility(profileGroupsWithAliases, modelVisibilityForProfile)
    const visibleProfileDefault = resolveVisibleDefault(profileResult.default, profileResult.default_provider, visibleProfileGroups)
    ctx.body = {
      default: visibleProfileDefault.defaultModel,
      default_provider: visibleProfileDefault.defaultProvider,
      groups: visibleProfileGroups,
      allProviders: applyModelAliases(PROVIDER_PRESETS.map((p: any) => providerPresetToGroup(
        p,
        resolveProviderCatalogModels(modelCatalogCacheForProfile, p.value, p.base_url, p.models, {
          freeOnly: p.value === 'openrouter',
          hasStaticManifest: p.builtin === true,
        }),
      )), modelAliasesForProfile),
      model_aliases: modelAliasesForProfile,
      model_visibility: modelVisibilityForProfile,
      custom_models: customModelsForProfile,
      profiles: [{
        profile: profileResult.profile,
        default: profileResult.default,
        default_provider: profileResult.default_provider,
        groups: visibleProfileGroups,
      }],
    }
    return

    const config = await readConfigYaml()
    const modelSection = config.model
    let currentDefault = ''
    let currentDefaultProvider = ''
    if (typeof modelSection === 'object' && modelSection !== null) {
      currentDefault = String(modelSection.default || '').trim()
      currentDefaultProvider = String(modelSection.provider || '').trim()
      // When hermes CLI sets provider: custom, resolve to custom:name
      // by matching base_url + model against custom providers (v12 dict + legacy list).
      if (currentDefaultProvider === 'custom' && currentDefault) {
        const cps = getCompatibleCustomProviders(config) as any[]
        const match = cps.find(
          (cp: any) => cp.base_url?.replace(/\/+$/, '') === String(modelSection.base_url || '').replace(/\/+$/, '')
            && cp.model === currentDefault,
        )
        if (match) {
          currentDefaultProvider = `custom:${match.name.trim().toLowerCase().replace(/ /g, '-')}`
        }
      }
    } else if (typeof modelSection === 'string') {
      currentDefault = modelSection.trim()
    }

    const groups: AvailableGroup[] = []
    const seenProviders = new Set<string>()

    let envContent = ''
    try { envContent = await readFile(getActiveEnvPath(), 'utf-8') } catch { }

    const envHasValue = (key: string): boolean => {
      if (!key) return false
      const match = envContent.match(new RegExp(`^${key}\\s*=[ \\t]*(.+)`, 'm'))
      return !!match && match[1].trim() !== '' && !match[1].trim().startsWith('#')
    }
    const envGetValue = (key: string): string => {
      if (!key) return ''
      const match = envContent.match(new RegExp(`^${key}\\s*=[ \\t]*(.+)`, 'm'))
      return match?.[1]?.trim() || ''
    }
    const addGroup = (provider: string, label: string, base_url: string, models: string[], api_key: string, builtin?: boolean, model_meta?: Record<string, ModelMeta>, extra?: Pick<AvailableGroup, 'provider_source' | 'provider_key'>) => {
      if (seenProviders.has(provider)) return
      seenProviders.add(provider)
      const availableModels = [...models]
      const apiMode = providerApiMode(provider)
      groups.push({ provider, label, base_url, models: availableModels, available_models: availableModels, api_key, ...(apiMode ? { api_mode: apiMode } : {}), ...(builtin ? { builtin: true } : {}), ...(model_meta ? { model_meta } : {}), ...(extra?.provider_source ? { provider_source: extra.provider_source } : {}), ...(extra?.provider_key ? { provider_key: extra.provider_key } : {}) })
    }

    let storedAuth: any = {}
    try {
      const authPath = getActiveAuthPath()
      if (existsSync(authPath)) storedAuth = JSON.parse(readFileSync(authPath, 'utf-8'))
    } catch {}
    const oauthCredential = (providerKey: string): StoredOAuthCredential => (
      storedOAuthCredential(storedAuth, providerKey)
    )
    const isOAuthAuthorized = (providerKey: string): boolean => oauthCredential(providerKey).authorized

    // 同一请求内复用 copilot 动态模型（getCopilotModelsDetailed 内部有 inflight + 缓存，
    // 这里再缓存到局部变量进一步减少分支）
    let copilotLiveModels: CopilotModelMeta[] | null = null
    const getCopilotLive = async (): Promise<CopilotModelMeta[]> => {
      if (copilotLiveModels !== null) return copilotLiveModels
      try { copilotLiveModels = await getCopilotModelsDetailed(envContent) }
      catch { copilotLiveModels = [] }
      return copilotLiveModels
    }

    // Copilot 显式 opt-in：即便能解析到 token，未通过 web-ui Add Provider 显式启用
    // 时也不返回。避免误把 VS Code/gh CLI 用户的全局凭证当作 hermes provider。
    const appConfig = await readAppConfig()
    const copilotEnabled = appConfig.copilotEnabled === true
    const modelAliases = normalizeAliases(appConfig.modelAliases)
    const modelVisibility = normalizeModelVisibility(appConfig.modelVisibility)
    const customModels = normalizeCustomModels(appConfig.customModels)

    // 兼容老用户：上一版本会"自动 fallback discovery"出 Copilot；升级后这些用户的
    // config.yaml 可能仍把 model.default 指向某个 copilot 模型。若此时 copilot 已不
    // 启用，把返回的 default 清掉，让前端兜底自动选剩余 provider 的第一个 model。
    if (!copilotEnabled && currentDefaultProvider.toLowerCase() === 'copilot') {
      currentDefault = ''
      currentDefaultProvider = ''
    }

    for (const [providerKey, envMapping] of Object.entries(PROVIDER_ENV_MAP)) {
      const oauthAuthorized = providerSupportsStoredOAuth(providerKey) ? isOAuthAuthorized(providerKey) : false
      if (envMapping.api_key_env && !envHasValue(envMapping.api_key_env) && !oauthAuthorized) continue
      if (!envMapping.api_key_env) {
        if (providerKey === 'copilot') {
          if (!copilotEnabled) continue
          if (!(await isCopilotAuthorized(envContent))) continue
        } else if (!isOAuthAuthorized(providerKey)) {
          continue
        }
      }
      const preset = PROVIDER_PRESETS.find((p: any) => p.value === providerKey)
      const label = preset?.label || providerKey.replace(/^custom:/, '')
      let baseUrl = oauthCredential(providerKey).baseUrl || preset?.base_url || ''
      if (envMapping.base_url_env && envHasValue(envMapping.base_url_env)) {
        baseUrl = envGetValue(envMapping.base_url_env) || baseUrl
      }
      const catalogModels = PROVIDER_MODEL_CATALOG[providerKey]
      let modelsList: string[] = catalogModels && catalogModels.length > 0 ? [...catalogModels] : []
      let modelMeta: Record<string, ModelMeta> | undefined
      if (providerKey === 'copilot') {
        const live = await getCopilotLive()
        if (live.length > 0) {
          modelsList = live.map((m) => m.id)
          const nextModelMeta: Record<string, ModelMeta> = {}
          for (const m of live) {
            if (m.preview || m.disabled) {
              nextModelMeta[m.id] = {
                ...(m.preview ? { preview: true } : {}),
                ...(m.disabled ? { disabled: true } : {}),
              }
            }
          }
          modelMeta = Object.keys(nextModelMeta).length > 0 ? nextModelMeta : undefined
        }
      } else if (providerShouldFetchLiveModels(providerKey)) {
        // These providers expose dynamic OpenAI-compatible /models catalogs.
        if (envMapping.api_key_env) {
          const apiKey = envGetValue(envMapping.api_key_env)
          if (apiKey) {
            try {
              const fetched = await fetchProviderModels(baseUrl, apiKey, providerKey === 'openrouter')
              if (fetched.length > 0) modelsList = fetched
            } catch { /* ignore — leave empty, won't show */ }
          }
        }
      }
      modelsList = includeConfiguredDefaultModel(providerKey, modelsList, currentDefault, currentDefaultProvider)
      if (modelsList.length > 0) {
        const apiKey = envMapping.api_key_env ? envGetValue(envMapping.api_key_env) : ''
        addGroup(providerKey, label, baseUrl, modelsList, apiKey, true, modelMeta)
      }
    }

    const customProviders = getCompatibleCustomProviders(config)

    const customFetches = await Promise.allSettled(
      customProviders.map(async cp => {
        if (!cp.base_url) return null
        const providerKey = `custom:${cp.name.trim().toLowerCase().replace(/ /g, '-')}`
        const baseUrl = cp.base_url.replace(/\/+$/, '')
        const configuredModels = cp.models ? Object.keys(cp.models) : []
        let models = [...new Set([cp.model, ...configuredModels].filter(Boolean) as string[])]
        if (cp.api_key) {
          try { const fetched = await fetchProviderModels(baseUrl, cp.api_key); if (fetched.length > 0) models = [...new Set([...models, ...fetched])] } catch { }
        }
        return { providerKey, label: cp.name, base_url: baseUrl, models, api_key: cp.api_key || '', builtin: isBuiltinProviderKey(providerKey), provider_source: cp.source, provider_key: cp.provider_key }
      }),
    )

    for (const result of customFetches) {
      const value = (result as { value?: any }).value
      if (value) {
        const { providerKey, label, base_url, models, api_key: cpApiKey, builtin: cpBuiltin, provider_source, provider_key } = value
        addGroup(providerKey, label, base_url, models, cpApiKey, cpBuiltin, undefined, { provider_source, provider_key })
      }
    }

    for (const g of groups) { g.models = Array.from(new Set(g.models)) }
    const groupsWithAliases = applyModelAliases(applyCustomModels(groups, customModels), modelAliases)
    const visibleGroups = applyModelVisibility(groupsWithAliases, modelVisibility)
    const visibleDefault = resolveVisibleDefault(currentDefault, currentDefaultProvider, visibleGroups)

    // 动态拉一次 copilot 模型用于 allProviders 展示（同一请求复用缓存）
    // 未启用 Copilot 时跳过拉取，避免空跑网络请求。
    const liveCopilotModels = copilotEnabled ? await getCopilotLive() : []
    const liveCopilotIds = liveCopilotModels.map((m) => m.id)

    const allProvidersBase = PROVIDER_PRESETS.map((p: any) => providerPresetToGroup(
      p,
      p.value === 'copilot' && liveCopilotIds.length > 0 ? liveCopilotIds : p.models,
    ))
    const allProviders = applyModelAliases(allProvidersBase, modelAliases)

    if (groups.length === 0) {
      const fallback = buildModelGroups(config)
      const fallbackGroups: AvailableGroup[] = fallback.groups.map(group => {
        const models = group.models.map(model => model.id)
        const apiMode = providerApiMode(group.provider)
        return {
          provider: group.provider,
          label: group.provider,
          base_url: '',
          models,
          available_models: models,
          api_key: '',
          ...(apiMode ? { api_mode: apiMode } : {}),
        }
      })
      const fallbackGroupsWithAliases = applyModelAliases(fallbackGroups, modelAliases)
      const visibleFallbackGroups = applyModelVisibility(fallbackGroupsWithAliases, modelVisibility)
      const fallbackDefault = resolveVisibleDefault(fallback.default, currentDefaultProvider, visibleFallbackGroups)
      ctx.body = {
        default: fallbackDefault.defaultModel,
        default_provider: fallbackDefault.defaultProvider,
        groups: visibleFallbackGroups,
        allProviders,
        model_aliases: modelAliases,
        model_visibility: modelVisibility,
        custom_models: customModels,
      }
      return
    }

    ctx.body = {
      default: visibleDefault.defaultModel,
      default_provider: visibleDefault.defaultProvider,
      groups: visibleGroups,
      allProviders,
      model_aliases: modelAliases,
      model_visibility: modelVisibility,
      custom_models: customModels,
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function addCustomModel(ctx: any) {
  const { provider, model } = (ctx.request.body || {}) as { provider?: string; model?: string }
  const providerKey = String(provider || '').trim()
  const modelId = String(model || '').trim()
  if (!providerKey || !modelId) {
    ctx.status = 400
    ctx.body = { error: 'Missing provider or model' }
    return
  }

  try {
    const appConfig = await readAppConfig()
    const customModels = normalizeCustomModels(appConfig.customModels)
    customModels[providerKey] = Array.from(new Set([...(customModels[providerKey] || []), modelId]))
    const saved = await writeAppConfig({ customModels })
    ctx.body = { success: true, custom_models: normalizeCustomModels(saved.customModels) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function removeCustomModel(ctx: any) {
  const body = (ctx.request.body || {}) as { provider?: string; model?: string }
  const provider = body.provider ?? ctx.query?.provider
  const model = body.model ?? ctx.query?.model
  const providerKey = String(provider || '').trim()
  const modelId = String(model || '').trim()
  if (!providerKey || !modelId) {
    ctx.status = 400
    ctx.body = { error: 'Missing provider or model' }
    return
  }

  try {
    const appConfig = await readAppConfig()
    const customModels = normalizeCustomModels(appConfig.customModels)
    const remaining = (customModels[providerKey] || []).filter(item => item !== modelId)
    if (remaining.length > 0) customModels[providerKey] = remaining
    else delete customModels[providerKey]
    const saved = await writeAppConfig({ customModels })
    ctx.body = { success: true, custom_models: normalizeCustomModels(saved.customModels) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function fetchProviderModelList(ctx: any) {
  try {
    const body = ctx.request.body as { base_url?: string; api_key?: string; freeOnly?: boolean; provider?: string; label?: string; update_cache?: boolean }
    const provider = String(body?.provider || '').trim()
    const baseUrl = provider === OPENCODE_FREE_PROVIDER ? OPENCODE_FREE_BASE_URL : String(body?.base_url || '').trim()
    const apiKey = String(body?.api_key || '').trim()
    const freeOnly = body?.freeOnly === true
    const label = String(body?.label || provider).trim()

    if (!baseUrl) {
      ctx.status = 400
      ctx.body = { error: 'Missing base_url' }
      return
    }

    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      ctx.status = 400
      ctx.body = { error: 'Invalid base_url' }
      return
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      ctx.status = 400
      ctx.body = { error: 'base_url must use http or https' }
      return
    }

    const base = baseUrl.replace(/\/+$/, '')
    const modelsUrl = /\/v\d+\/?$/.test(base) ? `${base}/models` : `${base}/v1/models`
    const headers: Record<string, string> = { ...openCodeSessionHeaders(modelsUrl), ...openRouterAttributionHeaders(modelsUrl, provider) }
    if (apiKey && provider !== OPENCODE_FREE_PROVIDER) headers.Authorization = `Bearer ${apiKey}`

    const res = await fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      ctx.status = 502
      ctx.body = { error: `Provider returned HTTP ${res.status}` }
      return
    }

    const data = await res.json() as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(data.data)) {
      ctx.status = 502
      ctx.body = { error: 'Provider returned unexpected format' }
      return
    }

    let models = data.data
      .map(m => String(m?.id || '').trim())
      .filter(Boolean)
    if (freeOnly) models = models.filter(m => m.endsWith(':free'))
    if (provider === OPENCODE_FREE_PROVIDER) models = models.filter(isOpenCodeFreeModel)
    const uniqueModels = Array.from(new Set(models)).sort()
    if (provider === OPENCODE_FREE_PROVIDER && !uniqueModels.length) {
      ctx.status = 502
      ctx.body = { error: 'OpenCode returned no free models; the cached catalog was retained' }
      return
    }
    if (body?.update_cache === true && provider) {
      await writeProviderModelCatalogEntry({
        provider,
        label,
        base_url: baseUrl,
        models: uniqueModels,
        source: 'live',
        free_only: freeOnly,
      })
    }
    ctx.body = { models: uniqueModels }
  } catch (err: any) {
    ctx.status = err?.name === 'TimeoutError' ? 504 : 502
    ctx.body = { error: err?.message || 'Failed to fetch provider models' }
  }
}

export async function refreshProviderModelCatalogCache(ctx: any) {
  try {
    await refreshConfiguredProviderModelCatalogs({ force: true })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err?.message || 'Failed to refresh provider model cache' }
  }
}


export async function setModelAlias(ctx: any) {
  const body = ctx.request.body
  const provider = body && typeof body === 'object' && !Array.isArray(body) ? body.provider : undefined
  const model = body && typeof body === 'object' && !Array.isArray(body) ? body.model : undefined
  const alias = body && typeof body === 'object' && !Array.isArray(body) ? body.alias : undefined

  if (typeof provider !== 'string' || typeof model !== 'string' || (alias !== undefined && typeof alias !== 'string')) {
    ctx.status = 400
    ctx.body = { error: 'Invalid provider, model, or alias' }
    return
  }

  const cleanProvider = provider.trim()
  const cleanModel = model.trim()
  const cleanAlias = (alias || '').trim()

  if (!isSafeAliasKey(cleanProvider) || !isSafeAliasKey(cleanModel)) {
    ctx.status = 400
    ctx.body = { error: 'Invalid provider or model' }
    return
  }

  if (cleanAlias.length > 512) {
    ctx.status = 400
    ctx.body = { error: 'Alias is too long' }
    return
  }

  try {
    const appConfig = await readAppConfig()
    const modelAliases = normalizeAliases(appConfig.modelAliases)
    if (cleanAlias) {
      if (!Object.hasOwn(modelAliases, cleanProvider)) modelAliases[cleanProvider] = createAliasMap()
      modelAliases[cleanProvider][cleanModel] = cleanAlias
    } else {
      if (Object.hasOwn(modelAliases, cleanProvider)) delete modelAliases[cleanProvider][cleanModel]
      if (Object.hasOwn(modelAliases, cleanProvider) && Object.keys(modelAliases[cleanProvider]).length === 0) {
        delete modelAliases[cleanProvider]
      }
    }
    await writeAppConfig({ modelAliases })
    ctx.body = { success: true, model_aliases: modelAliases }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function getConfigModels(ctx: any) {
  try {
    const config = await readConfigYamlForProfile(requestScopedProfileName(ctx))
    ctx.body = buildModelGroups(config)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

export async function setConfigModel(ctx: any) {
  const { default: defaultModel, provider: reqProvider } = ctx.request.body as { default: string; provider?: string }
  if (!defaultModel) {
    ctx.status = 400
    ctx.body = { error: 'Missing default model' }
    return
  }
  if (reqProvider === OPENCODE_FREE_PROVIDER && !isOpenCodeFreeModel(defaultModel)) {
    ctx.status = 400
    ctx.body = { error: 'Select an OpenCode Free model' }
    return
  }
  try {
    const profile = requestScopedProfileName(ctx)
    await updateConfigYamlForProfile(profile, (config) => {
      config.model = {}
      config.model.default = defaultModel
      if (reqProvider) { config.model.provider = reqProvider }
      return config
    })
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/**
 * 设置模型上下文配置（UPSERT：存在则更新，不存在则插入）
 * 支持路径参数和查询参数两种方式
 */
export async function updateModelContext(ctx: any) {
  // 支持两种方式：
  // 1. 路径参数: /api/hermes/model-context/:provider/:model
  // 2. 查询参数: /api/hermes/model-context?provider=xxx&model=xxx
  let provider: string | undefined
  let model: string | undefined

  // 优先从路径参数获取
  if (ctx.params.provider && ctx.params.model) {
    provider = ctx.params.provider
    model = ctx.params.model
  } else {
    // 从查询参数获取
    const query = ctx.query as { provider?: string; model?: string }
    provider = query.provider
    model = query.model
  }

  // 如果没有参数，从请求体获取
  if (!provider || !model) {
    const body = ctx.request.body as { provider?: string; model?: string; context_limit?: number }
    provider = body.provider
    model = body.model
  }

  const { context_limit } = ctx.request.body as { context_limit: number }

  if (!provider || !model || !context_limit) {
    ctx.status = 400
    ctx.body = { error: 'Missing required fields: provider, model, context_limit' }
    return
  }

  if (typeof context_limit !== 'number' || context_limit <= 0) {
    ctx.status = 400
    ctx.body = { error: 'Context limit must be a positive number' }
    return
  }

  try {
    const profile = requestScopedProfileName(ctx)
    const result = upsertModelContextRecord(profile, provider, model, context_limit)
    if (!result.available) {
      ctx.status = 500
      ctx.body = { error: 'Database not available' }
      return
    }

    ctx.body = {
      success: true,
      data: result.row
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}

/**
 * 查询模型上下文配置
 */
export async function getModelContext(ctx: any) {
  // 支持两种方式：
  // 1. 路径参数: /api/hermes/model-context/:provider/:model
  // 2. 查询参数: /api/hermes/model-context?provider=xxx&model=xxx
  let provider: string | undefined
  let model: string | undefined

  // 优先从路径参数获取
  if (ctx.params.provider && ctx.params.model) {
    provider = ctx.params.provider
    model = ctx.params.model
  } else {
    // 从查询参数获取
    const query = ctx.query as { provider?: string; model?: string }
    provider = query.provider
    model = query.model
  }

  if (!provider || !model) {
    ctx.status = 400
    ctx.body = { error: 'Missing provider or model parameter' }
    return
  }

  try {
    const profile = requestScopedProfileName(ctx)
    const result = readModelContextRecord(profile, provider, model)
    if (!result.available) {
      ctx.status = 500
      ctx.body = { error: 'Database not available' }
      return
    }
    if (!result.row) {
      const isCustomProvider = provider === 'custom' || provider.startsWith('custom:')
      if (!isCustomProvider) {
        ctx.status = 404
        ctx.body = { error: 'Model context not found' }
        return
      }
      const fallbackContextLength = 128_000
      const contextLimit = getModelContextLength({ profile, provider, model, fallbackContextLength })
      ctx.body = {
        data: { id: null, provider, model, context_limit: contextLimit, limit: contextLimit },
      }
      return
    }

    ctx.body = { data: { ...result.row, limit: result.row.context_limit } }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}


export async function setModelVisibility(ctx: any) {
  const { provider, mode, models } = ctx.request.body as { provider?: string; mode?: string; models?: string[] }
  const providerKey = String(provider || '').trim()
  if (!providerKey) {
    ctx.status = 400
    ctx.body = { error: 'Missing provider' }
    return
  }
  if (mode !== 'all' && mode !== 'include') {
    ctx.status = 400
    ctx.body = { error: 'Invalid visibility mode' }
    return
  }
  const selectedModels = uniqueStrings(models)
  if (mode === 'include' && selectedModels.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'Select at least one model' }
    return
  }

  try {
    const appConfig = await readAppConfig()
    const modelVisibility = normalizeModelVisibility(appConfig.modelVisibility)
    if (mode === 'all') {
      delete modelVisibility[providerKey]
    } else {
      modelVisibility[providerKey] = { mode: 'include', models: selectedModels }
    }
    const saved = await writeAppConfig({ modelVisibility })
    ctx.body = { success: true, model_visibility: normalizeModelVisibility(saved.modelVisibility) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
}
