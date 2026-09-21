import { request as defaultRequest } from '../client'

export type SttProvider =
  | 'browser'
  | 'local'
  | 'openai'
  | 'custom'
  | 'doubao'
  | 'groq'
  | 'mistral'
  | 'xai'
  | 'elevenlabs'
  | 'deepinfra'
export type StoredSttProvider = Exclude<SttProvider, 'browser'>

export interface SttStoredSettings {
  baseUrl?: string
  baseUrlPresets?: string[]
  model?: string
  language?: string
  prompt?: string
  audioTranscode?: 'none' | 'ffmpeg'
  diarize?: string
  format?: string
  tagAudioEvents?: string
}

export interface SttStoredSecretsInput {
  apiKey?: string
}

export interface SttStoredSecretsResponse {
  apiKey?: '[stored]'
}

export interface SttProviderSettingsResponse {
  provider: StoredSttProvider
  settings: SttStoredSettings
  secrets: SttStoredSecretsResponse
  createdAt?: number
  updatedAt: number
}

export interface FetchSttSettingsResponse {
  providers: SttProviderSettingsResponse[]
  activeProvider?: SttProvider | null
}

function normalizeActiveProvider(value: unknown): SttProvider | null {
  return value === 'browser' ||
    value === 'local' ||
    value === 'openai' ||
    value === 'custom' ||
    value === 'doubao' ||
    value === 'groq' ||
    value === 'mistral' ||
    value === 'xai' ||
    value === 'elevenlabs' ||
    value === 'deepinfra'
    ? value
    : null
}

function normalizeProviders(body: unknown): FetchSttSettingsResponse {
  if (body && typeof body === 'object') {
    const payload = body as {
      providers?: unknown
      settings?: unknown
      activeProvider?: unknown
    }
    const activeProvider = normalizeActiveProvider(payload.activeProvider)

    if (Array.isArray(payload.providers)) {
      return { providers: payload.providers as SttProviderSettingsResponse[], activeProvider }
    }

    if (Array.isArray(payload.settings)) {
      return { providers: payload.settings as SttProviderSettingsResponse[], activeProvider }
    }
  }

  return { providers: [], activeProvider: null }
}


export function createApi(request: typeof defaultRequest = (...args) => defaultRequest(...args)) {
  async function fetchSttSettings(): Promise<FetchSttSettingsResponse> {
    const body = await request<{ providers?: SttProviderSettingsResponse[]; settings?: SttProviderSettingsResponse[]; activeProvider?: SttProvider | null }>(
      '/api/studio/stt/settings',
    )
    return normalizeProviders(body)
  }

  async function saveSttSettings(
    provider: StoredSttProvider,
    payload: { settings?: SttStoredSettings; secrets?: SttStoredSecretsInput; activeProvider?: SttProvider },
  ): Promise<SttProviderSettingsResponse> {
    const body = await request<SttProviderSettingsResponse | { setting: SttProviderSettingsResponse }>(
      `/api/studio/stt/settings/${provider}`,
      {
        method: 'PUT',
        body: JSON.stringify(payload),
      },
    )
    return typeof body === 'object' && body !== null && 'setting' in body ? body.setting : body
  }

  async function saveActiveSttProvider(provider: SttProvider): Promise<SttProvider> {
    const body = await request<{ activeProvider: SttProvider }>(
      '/api/studio/stt/settings/active',
      {
        method: 'PUT',
        body: JSON.stringify({ provider }),
      },
    )
    return body.activeProvider
  }

  async function clearSttSecret(
    provider: StoredSttProvider,
    secretName: keyof SttStoredSecretsInput,
  ): Promise<SttProviderSettingsResponse | null> {
    const body = await request<
      SttProviderSettingsResponse |
      { setting: SttProviderSettingsResponse | null } |
      { success?: boolean; setting: SttProviderSettingsResponse | null }
    >(
      `/api/studio/stt/settings/${provider}/secret/${secretName}`,
      {
        method: 'DELETE',
      },
    )

    if (body && typeof body === 'object' && 'setting' in body) {
      return body.setting ?? null
    }

    return body as SttProviderSettingsResponse
  }

  async function deleteSttProvider(
    provider: StoredSttProvider,
  ): Promise<{ success?: boolean; deleted?: boolean; activeProvider?: SttProvider | null }> {
    return request<{ success?: boolean; deleted?: boolean; activeProvider?: SttProvider | null }>(
      `/api/studio/stt/settings/${provider}`,
      { method: 'DELETE' },
    )
  }

  async function deleteSttBaseUrlPreset(
    provider: StoredSttProvider,
    url: string,
  ): Promise<SttProviderSettingsResponse | null> {
    const body = await request<
      SttProviderSettingsResponse |
      { success?: boolean; setting: SttProviderSettingsResponse | null }
    >(
      `/api/studio/stt/settings/${provider}/base-url-preset?url=${encodeURIComponent(url)}`,
      { method: 'DELETE' },
    )

    if (body && typeof body === 'object' && 'setting' in body) {
      return body.setting ?? null
    }

    return body as SttProviderSettingsResponse
  }

  return { fetchSttSettings, saveSttSettings, saveActiveSttProvider, clearSttSecret, deleteSttProvider, deleteSttBaseUrlPreset }
}

export const { fetchSttSettings, saveSttSettings, saveActiveSttProvider, clearSttSecret, deleteSttProvider, deleteSttBaseUrlPreset } = createApi()
