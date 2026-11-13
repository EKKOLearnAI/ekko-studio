import { getDb } from '../infrastructure/database/index'
import { REALTIME_PROFILE_SETTINGS_TABLE } from '../infrastructure/database/schemas'

/**
 * Per-profile Realtime (Qwen / DashScope) model settings storage.
 *
 * Mirrors the STT/TTS profile settings stores: one row per Hermes profile
 * holding the shared Qwen realtime configuration ("设置 → 模型 → Realtime
 * 模型"): non-secret settings (`model`, `voice`) plus the DashScope API key
 * kept in a separate `secrets` map. Storage is server-side (SQLite), so the
 * configuration follows the user's profile across browsers/devices instead of
 * living only in browser localStorage.
 */

export interface RealtimeModelStoredSettings {
  /** Realtime dialog model id, e.g. `qwen3.8-omni-flash-realtime`. */
  model?: string
  /** Default voice within the model's voice catalogue. */
  voice?: string
  /**
   * Optional ASR provider selected for meeting-mode speech recognition.
   * `'dashscope'` (default — uses DashScope Paraformer/Fun-ASR) or `'minimax'`
   * (uses the MiniMax Speech-to-Text REST API). Empty/undefined treated as
   * `'dashscope'` for backward compatibility.
   */
  asrProvider?: 'dashscope' | 'minimax' | string
  /** MiniMax ASR model id, e.g. `asr-1.0`. Empty uses the API default. */
  minimaxAsrModel?: string
  /** MiniMax ASR HTTP endpoint, defaults to https://api.minimaxi.com. */
  minimaxBaseUrl?: string
}

export interface RealtimeModelStoredSecrets {
  /** 千问/DashScope API key (sk-...), shared by meeting ASR + Realtime. */
  apiKey?: string
  /**
   * MiniMax API key (Bearer token for api.minimaxi.com / api.minimax.io).
   * Optional — only required when ASR provider is `'minimax'`. Stored
   * separately from the DashScope key so the two providers stay independent.
   */
  minimaxApiKey?: string
}

export interface StoredRealtimeModelRow {
  profile: string
  settings: RealtimeModelStoredSettings
  secrets: RealtimeModelStoredSecrets
  createdAt: number
  updatedAt: number
}

export class RealtimeModelSettingsValidationError extends Error {}

const SETTINGS_KEYS = ['model', 'voice', 'asrProvider', 'minimaxAsrModel', 'minimaxBaseUrl'] as const
const SECRET_KEYS = ['apiKey', 'minimaxApiKey'] as const
/** Marker used to indicate a stored secret exists without echoing its value. */
export const REALTIME_STORED_MARKER = '[stored]'
const MAX_MODEL_LENGTH = 200
const MAX_VOICE_LENGTH = 100
const MAX_API_KEY_LENGTH = 1000
const MAX_BASE_URL_LENGTH = 200
const MINIMAX_PROVIDERS = new Set(['dashscope', 'minimax'])

type StoredRow = {
  profile: string
  settings_json: string
  secrets_json: string
  created_at: number
  updated_at: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return asObject(parsed)
  } catch {
    return {}
  }
}

function requireDb() {
  const db = getDb()
  if (!db) {
    throw new RealtimeModelSettingsValidationError('Realtime model settings storage unavailable')
  }
  return db
}

function normalizeProfile(profile: string): string {
  if (typeof profile !== 'string') {
    throw new RealtimeModelSettingsValidationError('invalid profile')
  }
  const value = profile.trim() || 'default'
  if (value.length > 128) {
    throw new RealtimeModelSettingsValidationError('invalid profile')
  }
  return value
}

function sanitizeStoredSettings(input: Record<string, unknown>): RealtimeModelStoredSettings {
  const out: RealtimeModelStoredSettings = {}

  for (const key of SETTINGS_KEYS) {
    const rawValue = input[key]
    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value) continue

    if (key === 'model' && value.length <= MAX_MODEL_LENGTH) {
      out.model = value
    } else if (key === 'voice' && value.length <= MAX_VOICE_LENGTH) {
      out.voice = value
    } else if (key === 'asrProvider' && MINIMAX_PROVIDERS.has(value)) {
      out.asrProvider = value
    } else if (key === 'minimaxAsrModel' && value.length <= MAX_MODEL_LENGTH) {
      out.minimaxAsrModel = value
    } else if (key === 'minimaxBaseUrl' && value.length <= MAX_BASE_URL_LENGTH) {
      // Only accept https URLs (defence-in-depth — these are passed straight
      // to the Python ASR client).
      if (/^https:\/\//i.test(value)) out.minimaxBaseUrl = value
    }
  }

  return out
}

/** Read a stored secrets_json object into the typed secret map (no masking). */
function readSecrets(input: Record<string, unknown>): RealtimeModelStoredSecrets {
  const out: RealtimeModelStoredSecrets = {}
  for (const key of Object.keys(input)) {
    if (!SECRET_KEYS.includes(key as (typeof SECRET_KEYS)[number])) continue
    const raw = input[key]
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    if (value && value !== REALTIME_STORED_MARKER && value.length <= MAX_API_KEY_LENGTH) {
      out[key as 'apiKey' | 'minimaxApiKey'] = value
    }
  }
  return out
}

function maskSecrets(secrets: RealtimeModelStoredSecrets): RealtimeModelStoredSecrets {
  const masked: RealtimeModelStoredSecrets = {}
  if (secrets.apiKey) {
    masked.apiKey = REALTIME_STORED_MARKER
  }
  if (secrets.minimaxApiKey) {
    masked.minimaxApiKey = REALTIME_STORED_MARKER
  }
  return masked
}

function rowToResult(row: StoredRow, includeSecrets: boolean): StoredRealtimeModelRow {
  const settings = sanitizeStoredSettings(parseJsonObject(row.settings_json))
  const secrets = readSecrets(parseJsonObject(row.secrets_json))

  return {
    profile: row.profile || 'default',
    settings,
    secrets: includeSecrets ? secrets : maskSecrets(secrets),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  }
}

function readStoredRow(profile: string): StoredRow | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT profile, settings_json, secrets_json, created_at, updated_at
     FROM ${REALTIME_PROFILE_SETTINGS_TABLE}
     WHERE profile = ?`
  ).get(profile) as StoredRow | null
}

/**
 * Read the stored realtime model config for a profile. Secrets are masked
 * (`[stored]`) unless `includeSecrets` is true — owner-only paths (settings
 * panel hydration, realtime session bootstrap) may request the raw key.
 */
export function getRealtimeModelSetting(
  profile: string,
  options?: { includeSecrets?: boolean },
): StoredRealtimeModelRow | null {
  const profileName = normalizeProfile(profile)
  const row = readStoredRow(profileName)
  return row ? rowToResult(row, options?.includeSecrets === true) : null
}

  /**
   * Create/update the realtime model config for a profile.
   *
   * The client always saves the complete configuration (model + voice + the
   * current apiKey field), so `settings` replaces the stored settings and an
   * explicitly empty `secrets.<field>` clears that specific stored secret.
   * For defensive compatibility, an absent `secrets` or a `[stored]` marker
   * leaves the stored value untouched. Returns the masked row.
   */
export function saveRealtimeModelSetting(
  profile: string,
  input: {
    settings?: unknown
    secrets?: unknown
  },
): StoredRealtimeModelRow {
  const profileName = normalizeProfile(profile)
  const db = requireDb()
  const existing = readStoredRow(profileName)
  const existingSettings = existing
    ? sanitizeStoredSettings(parseJsonObject(existing.settings_json))
    : {}
  const existingSecrets = existing
    ? readSecrets(parseJsonObject(existing.secrets_json))
    : {}

  const settingsInput = asObject(input.settings)
  const nextSettings = Object.keys(settingsInput).length > 0
    ? sanitizeStoredSettings(settingsInput)
    : existingSettings

  let nextSecrets: RealtimeModelStoredSecrets = { ...existingSecrets }
  const secretsInput = asObject(input.secrets)
  // Each recognised secret key is handled independently so a partial update
  // (e.g. the MiniMax key on a request that omits `apiKey`) does not wipe the
  // other provider's key. Mirrors the STT settings store's per-field model.
  for (const key of SECRET_KEYS) {
    const raw = secretsInput[key]
    if (typeof raw !== 'string') continue
    const cleaned = raw.trim()
    if (cleaned === REALTIME_STORED_MARKER) {
      // Masked marker from a client that does not echo secrets → keep stored.
      continue
    }
    if (!cleaned) {
      // User cleared this secret field → drop only this key.
      delete nextSecrets[key]
      continue
    }
    nextSecrets[key] = cleaned.slice(0, MAX_API_KEY_LENGTH)
  }

  const now = Date.now()

  db.prepare(
    `INSERT INTO ${REALTIME_PROFILE_SETTINGS_TABLE} (profile, settings_json, secrets_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(profile) DO UPDATE SET
       settings_json = excluded.settings_json,
       secrets_json = excluded.secrets_json,
       updated_at = excluded.updated_at`
  ).run(
    profileName,
    JSON.stringify(nextSettings),
    JSON.stringify(nextSecrets),
    existing?.created_at || now,
    now,
  )

  return getRealtimeModelSetting(profileName) as StoredRealtimeModelRow
}

/** Remove the stored realtime model config row for a profile. */
export function deleteRealtimeModelSetting(profile: string): boolean {
  const profileName = normalizeProfile(profile)
  const db = requireDb()
  const result = db.prepare(
    `DELETE FROM ${REALTIME_PROFILE_SETTINGS_TABLE} WHERE profile = ?`
  ).run(profileName)
  return Number(result.changes ?? 0) > 0
}
