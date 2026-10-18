import { getBaseUrl, request } from '../client'

export interface ModelApiKey {
  id: string
  name: string
  preview: string
  createdAt: number
  lastUsedAt: number | null
}
export interface ApiModel {
  id: string
  owned_by: string
  api_mode: string | null
  responses_supported: boolean
}
// This account-level feature must not inherit the page's active Profile.
const headers = { 'X-Hermes-Profile': '' }
export function modelApiBaseUrl(): string {
  return new URL(`${getBaseUrl().replace(/\/$/, '')}/api/ekko-studio/models/v1`, window.location.origin).href
}
export function getModelApiKeys(signal?: AbortSignal) {
  return request<{ keys: ModelApiKey[] }>('/api/studio/models/api-keys', { headers, signal })
}
export function createModelApiKey(name: string) {
  return request<{ key: ModelApiKey; apiKey: string }>('/api/studio/models/api-keys', { method: 'POST', headers, body: JSON.stringify({ name }) })
}
export function revokeModelApiKey(id: string) {
  return request<{ success: boolean }>(`/api/studio/models/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE', headers })
}
export function getApiModels(signal?: AbortSignal) {
  return request<{ data: ApiModel[] }>('/api/ekko-studio/models/v1/models', { headers, signal })
}
