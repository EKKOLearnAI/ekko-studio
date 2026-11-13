import {
  fetchProviderCatalogRefreshTargetModels,
  normalizeCatalogBaseUrl,
  readProviderModelCatalogCache,
  resolveProviderCatalogRefreshTarget,
  resolveProviderCatalogEntry,
  writeProviderModelCatalogEntry,
  type ProviderCatalogRefreshTarget,
  type ProviderModelCatalogEntry,
} from './model-catalog-cache'
import {
  fetchProviderCatalogForTest,
  getProviderEditorDetail,
  ProviderEditorError,
  type ProviderApiMode,
} from './provider-editor'
import { getCompatibleCustomProviders } from '../../../studio/contracts/provider-compat'
import { PROVIDER_PRESETS } from '../../../studio/contracts/providers'
import { readConfigYamlForProfile } from '../../../studio/public/profile-config'

export interface ProviderModelRefreshDiff {
  added: string[]
  removed: string[]
  unchanged: string[]
}

export interface ProviderModelRefreshResult {
  provider_id: string
  applied: boolean
  requires_confirmation: boolean
  models: string[]
  previous_models: string[]
  unavailable_models: string[]
  restore_available: boolean
  diff: ProviderModelRefreshDiff
  default_model?: string
  preferred_model?: string
  message?: string
}

const inflight = new Map<string, Promise<ProviderModelRefreshResult>>()

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map(model => String(model || '').trim()).filter(Boolean)))
}

function lockKey(profile: string, providerId: string): string {
  return `${profile}::${providerId}`
}

function refreshCapability(apiMode: ProviderApiMode | undefined): { supported: boolean; reason?: string } {
  if (apiMode === 'bedrock_converse' || apiMode === 'codex_app_server') {
    return { supported: false, reason: `Model refresh is not available for ${apiMode}` }
  }
  return { supported: true }
}

function diffModels(current: string[], remote: string[]): ProviderModelRefreshDiff {
  const currentSet = new Set(current)
  const remoteSet = new Set(remote)
  return {
    added: remote.filter(model => !currentSet.has(model)),
    removed: current.filter(model => !remoteSet.has(model)),
    unchanged: remote.filter(model => currentSet.has(model)),
  }
}

async function currentModelsForProvider(
  profile: string,
  providerId: string,
  baseUrl: string,
): Promise<{ models: string[]; entry?: ProviderModelCatalogEntry; freeOnly: boolean }> {
  const freeOnly = providerId === 'openrouter'
  const cache = await readProviderModelCatalogCache()
  const entry = resolveProviderCatalogEntry(cache, providerId, baseUrl, { freeOnly, profile })
  if (entry?.models?.length) {
    return {
      models: uniqueModels([...entry.models, ...(entry.unavailable_models || [])]),
      entry,
      freeOnly,
    }
  }

  // Fallback to configured/static models when no cache entry exists yet.
  const config = await readConfigYamlForProfile(profile)
  if (providerId.startsWith('custom:')) {
    const custom = getCompatibleCustomProviders(config).find(
      item => `custom:${String(item.name || '').trim().toLowerCase().replace(/ /g, '-')}` === providerId,
    )
    const configured = uniqueModels([
      custom?.model || '',
      ...(custom?.models ? Object.keys(custom.models) : []),
    ])
    return { models: configured, freeOnly }
  }
  const preset = PROVIDER_PRESETS.find(item => item.value === providerId)
  return { models: uniqueModels(preset?.models || []), freeOnly }
}

async function protectedModels(profile: string, providerId: string, preferredModel: string): Promise<string[]> {
  const config = await readConfigYamlForProfile(profile)
  const modelSection = config.model
  const defaults: string[] = []
  if (typeof modelSection === 'object' && modelSection !== null) {
    const defaultProvider = String(modelSection.provider || '').trim()
    const defaultModel = String(modelSection.default || '').trim()
    if (defaultProvider === providerId && defaultModel) defaults.push(defaultModel)
  }
  if (preferredModel.trim()) defaults.push(preferredModel.trim())
  return uniqueModels(defaults)
}

async function preferredModelForProvider(profile: string, providerId: string): Promise<string> {
  try {
    return (await getProviderEditorDetail(profile, providerId)).preferred_model
  } catch (error) {
    if (error instanceof ProviderEditorError && error.code === 'PROVIDER_NOT_EDITABLE') return ''
    throw error
  }
}

async function applyAuthoritativeList(input: {
  profile: string
  providerId: string
  label: string
  baseUrl: string
  freeOnly: boolean
  remoteModels: string[]
  currentModels: string[]
  currentEntry?: ProviderModelCatalogEntry
  protectedModels: string[]
  createRestoreSnapshot: boolean
}): Promise<ProviderModelCatalogEntry> {
  const remote = uniqueModels(input.remoteModels)
  if (remote.length === 0) {
    throw new ProviderEditorError('Provider returned an empty model catalog', 422, 'PROVIDER_EMPTY_CATALOG')
  }
  const unavailable = input.protectedModels.filter(model => !remote.includes(model))
  const previousModels = uniqueModels(
    input.currentEntry?.models?.length ? input.currentEntry.models : input.currentModels,
  )
  const previousUnavailable = uniqueModels(input.currentEntry?.unavailable_models || [])
  return writeProviderModelCatalogEntry({
    provider: input.providerId,
    label: input.label,
    base_url: input.baseUrl,
    models: remote,
    source: 'live',
    free_only: input.freeOnly,
    profile: input.profile,
    profiles: [input.profile],
    unavailable_models: unavailable,
    previous_models: input.createRestoreSnapshot
      ? (previousModels.length ? previousModels : null)
      : undefined,
    previous_unavailable_models: input.createRestoreSnapshot
      ? (previousUnavailable.length ? previousUnavailable : null)
      : undefined,
    previous_updated_at: input.createRestoreSnapshot
      ? input.currentEntry?.updated_at || null
      : undefined,
  })
}

export async function refreshProviderModels(
  profile: string,
  providerId: string,
  options: { confirm?: boolean } = {},
): Promise<ProviderModelRefreshResult> {
  const key = lockKey(profile, providerId)
  const existing = inflight.get(key)
  if (existing) return existing

  const task = (async () => {
    const target = await resolveProviderCatalogRefreshTarget(profile, providerId)
    if (!target) {
      throw new ProviderEditorError(`Provider "${providerId}" is not refreshable`, 404, 'PROVIDER_NOT_REFRESHABLE')
    }
    const apiMode = target.api_mode as ProviderApiMode | undefined
    const capability = refreshCapability(apiMode)
    if (!capability.supported) {
      throw new ProviderEditorError(capability.reason || 'Model refresh is not supported', 422, 'PROVIDER_REFRESH_UNSUPPORTED')
    }
    if (target.skip_live_fetch) {
      throw new ProviderEditorError('Provider does not expose a live model catalog', 422, 'PROVIDER_REFRESH_UNSUPPORTED')
    }

    const preferredModel = await preferredModelForProvider(profile, providerId)
    const baseUrl = normalizeCatalogBaseUrl(target.base_url)
    const { models: currentModels, entry, freeOnly } = await currentModelsForProvider(profile, providerId, baseUrl)
    const protectedList = await protectedModels(profile, providerId, preferredModel)
    const remoteModels = await fetchFullRemoteModels(target, apiMode)
    if (remoteModels.length === 0) {
      // The global catalog refresh treats an empty result as a failed probe and
      // keeps the last-good cache. Do the same before calculating removals;
      // otherwise a transient OAuth/API failure looks like "delete every model".
      throw new ProviderEditorError('Provider returned an empty model catalog', 422, 'PROVIDER_EMPTY_CATALOG')
    }
    const diff = diffModels(currentModels, remoteModels)

    if (diff.removed.length > 0 && !options.confirm) {
      return {
        provider_id: providerId,
        applied: false,
        requires_confirmation: true,
        models: currentModels,
        previous_models: entry?.previous_models || [],
        unavailable_models: entry?.unavailable_models || [],
        restore_available: !!(entry?.previous_models?.length),
        diff,
        preferred_model: preferredModel,
        message: 'Refreshing would remove models; confirmation is required',
      }
    }

    const written = await applyAuthoritativeList({
      profile,
      providerId,
      label: target.label,
      baseUrl,
      freeOnly,
      remoteModels,
      currentModels,
      currentEntry: entry,
      protectedModels: protectedList,
      createRestoreSnapshot: diff.added.length > 0 || diff.removed.length > 0,
    })

    return {
      provider_id: providerId,
      applied: true,
      requires_confirmation: false,
      models: uniqueModels([...written.models, ...(written.unavailable_models || [])]),
      previous_models: written.previous_models || [],
      unavailable_models: written.unavailable_models || [],
      restore_available: !!(written.previous_models?.length),
      diff,
      preferred_model: preferredModel,
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    if (inflight.get(key) === task) inflight.delete(key)
  }
}

async function fetchFullRemoteModels(
  target: ProviderCatalogRefreshTarget,
  apiMode: ProviderApiMode | undefined,
): Promise<string[]> {
  if (target.credential_kind === 'api_key' || target.credential_kind === 'none') {
    return fetchProviderCatalogForTest(target.base_url, target.api_key, apiMode)
  }
  return fetchProviderCatalogRefreshTargetModels(target)
}

export async function restoreProviderModels(
  profile: string,
  providerId: string,
): Promise<ProviderModelRefreshResult> {
  const key = lockKey(profile, providerId)
  const existing = inflight.get(key)
  if (existing) return existing

  const task = (async () => {
    const target = await resolveProviderCatalogRefreshTarget(profile, providerId)
    if (!target) {
      throw new ProviderEditorError(`Provider "${providerId}" is not refreshable`, 404, 'PROVIDER_NOT_REFRESHABLE')
    }
    const preferredModel = await preferredModelForProvider(profile, providerId)
    const baseUrl = normalizeCatalogBaseUrl(target.base_url)
    const freeOnly = providerId === 'openrouter'
    const cache = await readProviderModelCatalogCache()
    const entry = resolveProviderCatalogEntry(cache, providerId, baseUrl, { freeOnly, profile })
    if (!entry?.previous_models?.length) {
      throw new ProviderEditorError('No previous model list is available to restore', 404, 'PROVIDER_RESTORE_UNAVAILABLE')
    }

    const restored = await writeProviderModelCatalogEntry({
      provider: providerId,
      label: target.label,
      base_url: baseUrl,
      models: entry.previous_models,
      source: 'live',
      free_only: freeOnly,
      profile,
      profiles: [profile],
      unavailable_models: entry.previous_unavailable_models || [],
      previous_models: null,
      previous_unavailable_models: null,
      previous_updated_at: null,
    })

    const current = uniqueModels([...(entry.models || []), ...(entry.unavailable_models || [])])
    const next = uniqueModels([...(restored.models || []), ...(restored.unavailable_models || [])])
    return {
      provider_id: providerId,
      applied: true,
      requires_confirmation: false,
      models: next,
      previous_models: [],
      unavailable_models: restored.unavailable_models || [],
      restore_available: false,
      diff: diffModels(current, next),
      preferred_model: preferredModel,
    }
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    if (inflight.get(key) === task) inflight.delete(key)
  }
}

export function providerModelRefreshCapabilities(apiMode?: ProviderApiMode): {
  refreshable: boolean
  refresh_reason?: string
} {
  const capability = refreshCapability(apiMode)
  return {
    refreshable: capability.supported,
    ...(capability.reason ? { refresh_reason: capability.reason } : {}),
  }
}
