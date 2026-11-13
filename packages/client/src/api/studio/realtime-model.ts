import { request } from '../client'

/**
 * Realtime (Qwen / DashScope) model settings API.
 *
 * Mirrors STT/TTS provider settings: the config is persisted server-side per
 * Hermes profile (the active profile is sent via the `X-Hermes-Profile`
 * header the shared `request()` helper attaches), not in browser storage.
 */

export interface RealtimeModelServerSettings {
  model?: string
  voice?: string
  /** ASR provider: 'dashscope' (default) or 'minimax'. */
  asrProvider?: string
  /** MiniMax ASR model id, e.g. 'asr-1.0'. */
  minimaxAsrModel?: string
  /** MiniMax ASR HTTP endpoint, defaults to https://api.minimaxi.com. */
  minimaxBaseUrl?: string
}

export interface RealtimeModelServerSecrets {
  apiKey?: string
  /** MiniMax API key (Bearer token for api.minimaxi.com / api.minimax.io). */
  minimaxApiKey?: string
}

export interface RealtimeModelServerSetting {
  profile: string
  settings: RealtimeModelServerSettings
  secrets: RealtimeModelServerSecrets
  createdAt?: number
  updatedAt: number
}

export interface SaveRealtimeModelSettingPayload {
  settings?: RealtimeModelServerSettings
  secrets?: RealtimeModelServerSecrets
}

function normalizeSetting(value: unknown): RealtimeModelServerSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as {
    profile?: unknown
    settings?: unknown
    secrets?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }

  const settings = raw.settings && typeof raw.settings === 'object' && !Array.isArray(raw.settings)
    ? raw.settings as RealtimeModelServerSettings
    : {}
  const secrets = raw.secrets && typeof raw.secrets === 'object' && !Array.isArray(raw.secrets)
    ? raw.secrets as RealtimeModelServerSecrets
    : {}

  return {
    profile: typeof raw.profile === 'string' ? raw.profile : 'default',
    settings,
    secrets,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

/** GET /api/studio/realtime-model/settings — null when the profile has no row. */
export async function fetchRealtimeModelSetting(): Promise<RealtimeModelServerSetting | null> {
  const body = await request<{ setting?: unknown }>('/api/studio/realtime-model/settings')
  return normalizeSetting(body?.setting)
}

/** PUT /api/studio/realtime-model/settings — persists for the active profile. */
export async function saveRealtimeModelSetting(
  payload: SaveRealtimeModelSettingPayload,
): Promise<RealtimeModelServerSetting> {
  const body = await request<{ setting?: unknown }>('/api/studio/realtime-model/settings', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  const setting = normalizeSetting(body?.setting)
  if (!setting) {
    throw new Error('Failed to save realtime model settings')
  }
  return setting
}
