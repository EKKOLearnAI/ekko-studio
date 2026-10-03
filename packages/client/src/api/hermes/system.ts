import { request } from '../client'
import type { ProviderApiMode } from '../studio/provider-api-mode'

// Config-based model types
export interface ModelInfo {
  id: string
  label: string
}

export interface ModelGroup {
  provider: string
  models: ModelInfo[]
}

export interface ConfigModelsResponse {
  default: string
  groups: ModelGroup[]
}

export interface ModelVisibilityRule {
  mode: 'all' | 'include'
  models: string[]
}

export type ModelVisibility = Record<string, ModelVisibilityRule>
export type CustomModels = Record<string, string[]>
export interface AvailableModelGroup {
  provider: string   // credential pool key (e.g. "zai", "custom:subrouter.ai")
  label: string      // display name (e.g. "zai", "subrouter.ai")
  base_url: string
  models: string[]
  /** Full unfiltered model catalog for this provider, used to restore hidden WUI models. */
  available_models?: string[]
  api_key: string
  api_mode?: ProviderApiMode
  builtin?: boolean
  /** Env var used by Hermes to override this provider's base URL. If present, the preset URL is editable. */
  base_url_env?: string
  /** Config source for custom providers. Dict-backed providers can be deleted from providers:<key>. */
  provider_source?: 'custom_providers' | 'providers'
  provider_key?: string
  provider_editable?: boolean
  editable_fields?: ProviderEditableField[]
  model_refreshable?: boolean
  model_refresh_reason?: string
  model_restore_available?: boolean
  /** 可选：模型 ID -> 元数据（preview/disabled/alias）。alias 仅用于 Web UI 展示。 */
  model_meta?: Record<string, { preview?: boolean; disabled?: boolean; alias?: string }>
}

export interface ProfileAvailableModels {
  profile: string
  default: string
  default_provider: string
  groups: AvailableModelGroup[]
}

export interface AvailableModelsResponse {
  default: string
  default_provider: string
  groups: AvailableModelGroup[]
  allProviders: AvailableModelGroup[]
  profiles?: ProfileAvailableModels[]
  /** Web UI-only display aliases keyed by provider -> canonical model ID. */
  model_aliases?: Record<string, Record<string, string>>
  model_visibility?: ModelVisibility
  custom_models?: CustomModels
}

export interface CustomProvider {
  name: string
  base_url: string
  api_key: string
  model: string
  context_length?: number
  api_mode?: ProviderApiMode
  providerKey?: string | null
}

export type ProviderEditableField =
  | 'label'
  | 'base_url'
  | 'api_key'
  | 'api_mode'
  | 'preferred_model'
  | 'context_lengths'
  | 'discover_models'
  | 'rate_limit_delay'
  | 'request_timeout_seconds'
  | 'stale_timeout_seconds'
  | 'extra_body'
export type ProviderCredentialAction = 'keep' | 'replace' | 'clear'

export interface ProviderEditorDetail {
  id: string
  label: string
  builtin: boolean
  source: 'builtin_env' | 'custom_providers' | 'providers'
  source_key?: string
  base_url: string
  api_mode?: ProviderApiMode
  preferred_model: string
  credential_configured: boolean
  editable: boolean
  editable_fields: ProviderEditableField[]
  context_lengths: Record<string, number>
  discover_models?: boolean
  rate_limit_delay?: number
  request_timeout_seconds?: number
  stale_timeout_seconds?: number
  extra_body?: Record<string, unknown>
  connection_test_supported: boolean
  connection_test_reason?: string
  revision: string
}

export interface ProviderEditorPatch {
  label?: string
  base_url?: string
  api_mode?: ProviderApiMode
  preferred_model?: string
  credential_action?: ProviderCredentialAction
  api_key?: string
  discover_models?: boolean
  rate_limit_delay?: number | null
  request_timeout_seconds?: number | null
  stale_timeout_seconds?: number | null
  extra_body?: Record<string, unknown> | null
}

export interface ProviderEditorResponse {
  success?: boolean
  provider: ProviderEditorDetail
  changed?: string[]
}

export async function fetchConfigModels(): Promise<ConfigModelsResponse> {
  return request<ConfigModelsResponse>('/api/hermes/config/models')
}

export async function fetchAvailableModels(): Promise<AvailableModelsResponse> {
  return request<AvailableModelsResponse>('/api/hermes/available-models')
}

export async function fetchAvailableModelsForProfile(profile: string): Promise<AvailableModelsResponse> {
  const params = new URLSearchParams()
  params.set('profile', profile || 'default')
  return request<AvailableModelsResponse>(`/api/hermes/available-models?${params.toString()}`)
}

export async function fetchProviderModels(data: {
  base_url: string
  api_key?: string
  freeOnly?: boolean
  provider?: string
  label?: string
  update_cache?: boolean
}): Promise<{ models: string[] }> {
  return request<{ models: string[] }>('/api/hermes/provider-models', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function refreshProviderModelCache(): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/hermes/provider-models/cache/refresh', {
    method: 'POST',
  })
}

export async function updateDefaultModel(data: {
  default: string
  provider?: string
  base_url?: string
  api_key?: string
}): Promise<void> {
  await request('/api/hermes/config/model', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function updateModelAlias(data: {
  provider: string
  model: string
  alias: string
}): Promise<void> {
  await request('/api/hermes/model-alias', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function addCustomProvider(data: CustomProvider): Promise<void> {
  await request('/api/hermes/config/providers', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function removeCustomProvider(name: string, options: { source?: 'custom_providers' | 'providers'; providerKey?: string } = {}): Promise<void> {
  const query = new URLSearchParams()
  if (options.source) query.set('source', options.source)
  if (options.providerKey) query.set('providerKey', options.providerKey)
  await request(`/api/hermes/config/providers/${encodeURIComponent(name)}${query.size ? `?${query}` : ''}`, {
    method: 'DELETE',
  })
}

export async function updateProvider(poolKey: string, data: {
  name?: string
  base_url?: string
  api_key?: string
  model?: string
  api_mode?: ProviderApiMode
}): Promise<void> {
  await request(`/api/hermes/config/providers/${encodeURIComponent(poolKey)}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function fetchProviderEditor(poolKey: string): Promise<ProviderEditorDetail> {
  const response = await request<ProviderEditorResponse>(
    `/api/hermes/config/providers/${encodeURIComponent(poolKey)}/editor`,
  )
  return response.provider
}

export async function patchProviderEditor(
  poolKey: string,
  revision: string,
  data: ProviderEditorPatch,
): Promise<ProviderEditorResponse> {
  return request<ProviderEditorResponse>(
    `/api/hermes/config/providers/${encodeURIComponent(poolKey)}/editor`,
    {
      method: 'PATCH',
      headers: { 'If-Match': `"${revision}"` },
      body: JSON.stringify(data),
    },
  )
}

export async function testProviderEditor(
  poolKey: string,
  data: ProviderEditorPatch,
): Promise<{ success: boolean; models?: string[]; model_count?: number; catalog_unavailable?: boolean; error?: string; code?: string }> {
  return request(`/api/hermes/config/providers/${encodeURIComponent(poolKey)}/editor/test`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function patchProviderEditorContexts(
  poolKey: string,
  revision: string,
  contextLengths: Record<string, number | null>,
): Promise<ProviderEditorResponse> {
  return request<ProviderEditorResponse>(
    `/api/hermes/config/providers/${encodeURIComponent(poolKey)}/editor/contexts`,
    {
      method: 'PATCH',
      headers: { 'If-Match': `"${revision}"` },
      body: JSON.stringify({ context_lengths: contextLengths }),
    },
  )
}

export interface ProviderModelRefreshResult {
  success: boolean
  applied: boolean
  requires_confirmation: boolean
  models: string[]
  previous_models: string[]
  unavailable_models: string[]
  restore_available: boolean
  diff: { added: string[]; removed: string[]; unchanged: string[] }
  preferred_model?: string
  message?: string
  error?: string
  code?: string
}

export async function refreshProviderModels(
  poolKey: string,
  options: { confirm?: boolean } = {},
): Promise<ProviderModelRefreshResult> {
  return request<ProviderModelRefreshResult>(
    `/api/hermes/config/providers/${encodeURIComponent(poolKey)}/models/refresh`,
    {
      method: 'POST',
      body: JSON.stringify({ confirm: options.confirm === true }),
    },
  )
}

export async function restoreProviderModels(poolKey: string): Promise<ProviderModelRefreshResult> {
  return request<ProviderModelRefreshResult>(
    `/api/hermes/config/providers/${encodeURIComponent(poolKey)}/models/restore`,
    { method: 'POST', body: JSON.stringify({}) },
  )
}

export async function updateModelVisibility(data: {
  provider: string
  mode: 'all' | 'include'
  models: string[]
}): Promise<{ success: boolean; model_visibility: ModelVisibility }> {
  return request<{ success: boolean; model_visibility: ModelVisibility }>('/api/hermes/model-visibility', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function addCustomModel(data: {
  provider: string
  model: string
}): Promise<{ success: boolean; custom_models: CustomModels }> {
  return request<{ success: boolean; custom_models: CustomModels }>('/api/hermes/custom-model', {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function removeCustomModel(data: {
  provider: string
  model: string
}): Promise<{ success: boolean; custom_models: CustomModels }> {
  const params = new URLSearchParams()
  params.set('provider', data.provider)
  params.set('model', data.model)
  return request<{ success: boolean; custom_models: CustomModels }>(`/api/hermes/custom-model?${params.toString()}`, {
    method: 'DELETE',
  })
}
