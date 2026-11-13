import { request } from '../client'
import type { TtsProviderId } from './tts'

export type StoredTtsProvider = TtsProviderId

export interface TtsStoredSettings {
  baseUrl?: string
  baseUrlPresets?: string[]
  model?: string
  voice?: string
  rate?: string
  pitch?: string
  authMode?: string
  voiceMode?: string
  voiceDesignDesc?: string
  voiceCloneFormat?: string
  stylePrompt?: string
  language?: string
  sampleRate?: string
  bitRate?: string
  speed?: string
  volume?: string
  emotion?: string
  groupId?: string
}

export interface TtsStoredSecretsInput {
  apiKey?: string
}

export interface TtsStoredSecretsResponse {
  apiKey?: '[stored]'
}

export interface TtsProviderSettingsResponse {
  provider: StoredTtsProvider
  settings: TtsStoredSettings
  secrets: TtsStoredSecretsResponse
  createdAt?: number
  updatedAt: number
}

export interface FetchTtsSettingsResponse {
  providers: TtsProviderSettingsResponse[]
  activeProvider?: StoredTtsProvider | null
}

function normalizeActiveProvider(value: unknown): StoredTtsProvider | null {
  return value === 'edge' ||
    value === 'openai' ||
    value === 'custom' ||
    value === 'mimo' ||
    value === 'doubao' ||
    value === 'elevenlabs' ||
    value === 'gemini' ||
    value === 'xai' ||
    value === 'mistral' ||
    value === 'minimax' ||
    value === 'deepinfra'
    ? value
    : null
}

function normalizeProviders(body: unknown): FetchTtsSettingsResponse {
  if (body && typeof body === 'object') {
    const payload = body as { providers?: unknown; settings?: unknown; activeProvider?: unknown }
    const activeProvider = normalizeActiveProvider(payload.activeProvider)
    if (Array.isArray(payload.providers)) {
      return { providers: payload.providers as TtsProviderSettingsResponse[], activeProvider }
    }
    if (Array.isArray(payload.settings)) {
      return { providers: payload.settings as TtsProviderSettingsResponse[], activeProvider }
    }
  }
  return { providers: [], activeProvider: null }
}

export async function fetchTtsSettings(): Promise<FetchTtsSettingsResponse> {
  const body = await request<{ providers?: TtsProviderSettingsResponse[]; settings?: TtsProviderSettingsResponse[]; activeProvider?: StoredTtsProvider | null }>(
    '/api/studio/tts/settings',
  )
  return normalizeProviders(body)
}

export async function saveTtsSettings(
  provider: StoredTtsProvider,
  payload: { settings?: TtsStoredSettings; secrets?: TtsStoredSecretsInput; activeProvider?: StoredTtsProvider },
): Promise<TtsProviderSettingsResponse> {
  const body = await request<TtsProviderSettingsResponse | { setting: TtsProviderSettingsResponse }>(
    `/api/studio/tts/settings/${provider}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  )
  return typeof body === 'object' && body !== null && 'setting' in body ? body.setting : body
}

export async function saveActiveTtsProvider(provider: StoredTtsProvider): Promise<StoredTtsProvider> {
  const body = await request<{ activeProvider: StoredTtsProvider }>(
    '/api/studio/tts/settings/active',
    {
      method: 'PUT',
      body: JSON.stringify({ provider }),
    },
  )
  return body.activeProvider
}

export async function clearTtsSecret(
  provider: StoredTtsProvider,
  secretName: keyof TtsStoredSecretsInput,
): Promise<TtsProviderSettingsResponse | null> {
  const body = await request<
    TtsProviderSettingsResponse |
    { setting: TtsProviderSettingsResponse | null } |
    { success?: boolean; setting: TtsProviderSettingsResponse | null }
  >(
    `/api/studio/tts/settings/${provider}/secret/${secretName}`,
    { method: 'DELETE' },
  )

  if (body && typeof body === 'object' && 'setting' in body) {
    return body.setting ?? null
  }
  return body as TtsProviderSettingsResponse
}

export async function deleteTtsProvider(
  provider: Exclude<StoredTtsProvider, 'edge'>,
): Promise<{ success?: boolean; deleted?: boolean; activeProvider?: StoredTtsProvider | null }> {
  return request<{ success?: boolean; deleted?: boolean; activeProvider?: StoredTtsProvider | null }>(
    `/api/studio/tts/settings/${provider}`,
    { method: 'DELETE' },
  )
}

export async function deleteTtsBaseUrlPreset(
  provider: StoredTtsProvider,
  url: string,
): Promise<TtsProviderSettingsResponse | null> {
  const body = await request<
    { success?: boolean; setting: TtsProviderSettingsResponse | null } |
    TtsProviderSettingsResponse
  >(
    `/api/studio/tts/settings/${provider}/base-url-preset?url=${encodeURIComponent(url)}`,
    { method: 'DELETE' },
  )

  if (body && typeof body === 'object' && 'setting' in body) {
    return body.setting ?? null
  }
  return body as TtsProviderSettingsResponse
}
