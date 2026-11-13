import { getDb } from '../infrastructure/database'
import {
  STT_PROFILE_PROVIDER_SETTINGS_TABLE,
  STT_PROFILE_SETTINGS_TABLE,
} from '../infrastructure/database/schemas'
import { normalizeSafeTtsBaseUrl } from '../contracts/voice/url-safety'

export type StoredSttProvider =
  | 'local'
  | 'openai'
  | 'custom'
  | 'doubao'
  | 'groq'
  | 'mistral'
  | 'xai'
  | 'elevenlabs'
  | 'deepinfra'
export type ActiveSttProvider = 'browser' | StoredSttProvider

const SETTINGS_KEYS = [
  'baseUrl',
  'baseUrlPresets',
  'model',
  'language',
  'prompt',
  'audioTranscode',
  'diarize',
  'format',
  'tagAudioEvents',
] as const
const SECRET_KEYS = ['apiKey'] as const

type SttSettingKey = (typeof SETTINGS_KEYS)[number]
type SttSecretKey = (typeof SECRET_KEYS)[number]

export type SttStoredSettings = Partial<Record<Exclude<SttSettingKey, 'baseUrlPresets'>, string>> & { baseUrlPresets?: string[] }
export type SttStoredSecrets = Partial<Record<SttSecretKey, string>>

export interface StoredSttProviderRow {
  profile: string
  provider: StoredSttProvider
  settings: SttStoredSettings
  secrets: SttStoredSecrets
  createdAt: number
  updatedAt: number
}

export class SttSettingsValidationError extends Error {}

const STORED_MARKER = '[stored]'
const MAX_PROMPT_LENGTH = 1000
const MAX_BASE_URL_PRESETS = 20
const PROVIDERS: StoredSttProvider[] = [
  'local',
  'openai',
  'custom',
  'doubao',
  'groq',
  'mistral',
  'xai',
  'elevenlabs',
  'deepinfra',
]
const ACTIVE_PROVIDERS: ActiveSttProvider[] = ['browser', ...PROVIDERS]
const PROVIDER_SQL_PLACEHOLDERS = PROVIDERS.map(() => '?').join(', ')
const PROVIDER_LABELS: Record<StoredSttProvider, string> = {
  local: 'Local STT',
  openai: 'OpenAI STT',
  custom: 'Custom STT',
  doubao: 'Doubao STT',
  groq: 'Groq STT',
  mistral: 'Mistral STT',
  xai: 'xAI STT',
  elevenlabs: 'ElevenLabs STT',
  deepinfra: 'DeepInfra STT',
}
type StoredRow = {
  profile: string
  provider: string
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
    throw new Error('STT settings storage unavailable')
  }
  return db
}

function normalizeProfile(profile: string): string {
  if (typeof profile !== 'string') {
    throw new SttSettingsValidationError('invalid profile')
  }
  const value = profile.trim() || 'default'
  if (value.length > 128) {
    throw new SttSettingsValidationError('invalid profile')
  }
  return value
}

export function isStoredSttProvider(provider: string): provider is StoredSttProvider {
  return PROVIDERS.includes(provider as StoredSttProvider)
}

export function isActiveSttProvider(provider: string): provider is ActiveSttProvider {
  return ACTIVE_PROVIDERS.includes(provider as ActiveSttProvider)
}

export function assertStoredSttProvider(provider: string): StoredSttProvider {
  if (!isStoredSttProvider(provider)) {
    throw new SttSettingsValidationError('unknown STT provider')
  }
  return provider
}

export function assertActiveSttProvider(provider: string): ActiveSttProvider {
  if (!isActiveSttProvider(provider)) {
    throw new SttSettingsValidationError('unknown STT provider')
  }
  return provider
}

export function getActiveSttProvider(profile: string): ActiveSttProvider | null {
  const profileName = normalizeProfile(profile)
  const db = getDb()
  if (!db) return null

  const row = db.prepare(
    `SELECT active_provider FROM ${STT_PROFILE_SETTINGS_TABLE} WHERE profile = ?`
  ).get(profileName) as { active_provider?: string } | null

  const activeProvider = row?.active_provider
  return typeof activeProvider === 'string' && isActiveSttProvider(activeProvider) ? activeProvider : null
}

export function saveActiveSttProvider(profile: string, provider: ActiveSttProvider): ActiveSttProvider {
  const profileName = normalizeProfile(profile)
  const activeProvider = assertActiveSttProvider(provider)
  const db = requireDb()
  const now = Date.now()

  db.prepare(
    `INSERT INTO ${STT_PROFILE_SETTINGS_TABLE} (profile, active_provider, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile) DO UPDATE SET
       active_provider = excluded.active_provider,
       updated_at = excluded.updated_at`
  ).run(profileName, activeProvider, now, now)

  return activeProvider
}

function assertKnownSecretName(secretName: string): SttSecretKey {
  if (!SECRET_KEYS.includes(secretName as SttSecretKey)) {
    throw new SttSettingsValidationError('unknown STT provider secret')
  }
  return secretName as SttSecretKey
}

function readStoredRow(profile: string, provider: StoredSttProvider): StoredRow | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT profile, provider, settings_json, secrets_json, created_at, updated_at FROM ${STT_PROFILE_PROVIDER_SETTINGS_TABLE} WHERE profile = ? AND provider = ?`
  ).get(profile, provider) as StoredRow | null
}

function normalizeBaseUrlPresets(provider: StoredSttProvider, input: unknown): string[] {
  const values = Array.isArray(input) ? input : []
  const out: string[] = []
  const seen = new Set<string>()

  for (const rawValue of values) {
    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value) continue

    let normalized: string
    try {
      normalized = normalizeSafeTtsBaseUrl(value, PROVIDER_LABELS[provider])
    } catch (error) {
      throw new SttSettingsValidationError(error instanceof Error ? error.message : String(error))
    }

    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= MAX_BASE_URL_PRESETS) break
  }

  return out
}

function appendBaseUrlPreset(provider: StoredSttProvider, settings: SttStoredSettings): SttStoredSettings {
  if (!settings.baseUrl) return settings
  const presets = normalizeBaseUrlPresets(provider, settings.baseUrlPresets || [])
  if (!presets.includes(settings.baseUrl)) {
    presets.unshift(settings.baseUrl)
  }
  return { ...settings, baseUrlPresets: presets.slice(0, MAX_BASE_URL_PRESETS) }
}

function sanitizeStoredSettings(provider: StoredSttProvider, input: Record<string, unknown>): SttStoredSettings {
  const out: SttStoredSettings = {}

  for (const key of SETTINGS_KEYS) {
    const rawValue = input[key]

    if (key === 'baseUrlPresets') {
      const presets = normalizeBaseUrlPresets(provider, rawValue)
      if (presets.length) out.baseUrlPresets = presets
      continue
    }

    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value) continue

    if (key === 'baseUrl') {
      try {
        out.baseUrl = normalizeSafeTtsBaseUrl(value, PROVIDER_LABELS[provider])
      } catch (error) {
        throw new SttSettingsValidationError(error instanceof Error ? error.message : String(error))
      }
      continue
    }

    if (key === 'prompt') {
      out.prompt = value.slice(0, MAX_PROMPT_LENGTH)
      continue
    }

    if (key === 'audioTranscode') {
      if (value === 'ffmpeg' || value === 'none') {
        out.audioTranscode = value
      }
      continue
    }

    out[key] = value
  }

  return out
}

function sanitizeStoredSecrets(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}

  for (const key of Object.keys(input)) {
    assertKnownSecretName(key)
  }

  const rawApiKey = input.apiKey
  if (typeof rawApiKey !== 'string') {
    return out
  }

  const apiKey = rawApiKey.trim()
  if (!apiKey || apiKey === STORED_MARKER) {
    return out
  }

  out.apiKey = apiKey
  return out
}

function mergeStoredValues(current: SttStoredSettings, patch: SttStoredSettings): SttStoredSettings {
  return { ...current, ...patch }
}

function maskSecrets(secrets: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  if (secrets.apiKey) {
    masked.apiKey = STORED_MARKER
  }
  return masked
}

function rowToResult(row: StoredRow, includeSecrets: boolean): StoredSttProviderRow {
  const provider = assertStoredSttProvider(row.provider)
  const settings = sanitizeStoredSettings(provider, parseJsonObject(row.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(row.secrets_json))

  return {
    profile: row.profile || 'default',
    provider,
    settings,
    secrets: includeSecrets ? secrets : maskSecrets(secrets),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  }
}

export function listSttProviderSettings(profile: string): StoredSttProviderRow[] {
  const profileName = normalizeProfile(profile)
  const db = getDb()
  if (!db) return []

  const rows = db.prepare(
    `SELECT profile, provider, settings_json, secrets_json, created_at, updated_at
     FROM ${STT_PROFILE_PROVIDER_SETTINGS_TABLE}
     WHERE profile = ? AND provider IN (${PROVIDER_SQL_PLACEHOLDERS})
     ORDER BY provider ASC`
  ).all(profileName, ...PROVIDERS) as StoredRow[]

  return rows.map(row => rowToResult(row, false))
}

export function getSttProviderSetting(
  profile: string,
  provider: StoredSttProvider,
  options?: { includeSecrets?: boolean },
): StoredSttProviderRow | null {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredSttProvider(provider)
  const row = readStoredRow(profileName, storedProvider)
  return row ? rowToResult(row, options?.includeSecrets === true) : null
}

export function saveSttProviderSetting(
  profile: string,
  provider: StoredSttProvider,
  input: {
    settings?: unknown
    secrets?: unknown
  },
): StoredSttProviderRow {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredSttProvider(provider)
  const db = requireDb()
  const existing = readStoredRow(profileName, storedProvider)
  const existingSettings = existing ? sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json)) : {}
  const existingSecrets = existing ? sanitizeStoredSecrets(parseJsonObject(existing.secrets_json)) : {}
  const nextSettings = sanitizeStoredSettings(storedProvider, asObject(input.settings))
  const nextSecretsObject = asObject(input.secrets)

  for (const key of Object.keys(nextSecretsObject)) {
    assertKnownSecretName(key)
  }

  const nextSecrets = sanitizeStoredSecrets(nextSecretsObject)
  const mergedSettings = appendBaseUrlPreset(storedProvider, mergeStoredValues(existingSettings, nextSettings))
  const mergedSecrets = mergeStoredValues(existingSecrets, nextSecrets)
  const now = Date.now()

  db.prepare(
    `INSERT INTO ${STT_PROFILE_PROVIDER_SETTINGS_TABLE} (profile, provider, settings_json, secrets_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile, provider) DO UPDATE SET
       settings_json = excluded.settings_json,
       secrets_json = excluded.secrets_json,
       updated_at = excluded.updated_at`
  ).run(profileName, storedProvider, JSON.stringify(mergedSettings), JSON.stringify(mergedSecrets), existing?.created_at || now, now)

  return getSttProviderSetting(profileName, storedProvider) as StoredSttProviderRow
}

export function removeSttBaseUrlPreset(
  profile: string,
  provider: StoredSttProvider,
  url: string,
): StoredSttProviderRow | null {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredSttProvider(provider)
  const normalizedUrl = normalizeSafeTtsBaseUrl(url, PROVIDER_LABELS[storedProvider])
  const db = requireDb()
  const existing = readStoredRow(profileName, storedProvider)
  if (!existing) {
    return null
  }

  const settings = sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(existing.secrets_json))
  const nextPresets = normalizeBaseUrlPresets(storedProvider, settings.baseUrlPresets || [])
    .filter(preset => preset !== normalizedUrl)

  if (settings.baseUrl === normalizedUrl) {
    delete settings.baseUrl
  }

  if (nextPresets.length) {
    settings.baseUrlPresets = nextPresets
  } else {
    delete settings.baseUrlPresets
  }

  const now = Date.now()
  db.prepare(
    `UPDATE ${STT_PROFILE_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE profile = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, profileName, storedProvider)

  return getSttProviderSetting(profileName, storedProvider)
}

export function clearStoredSttSecret(
  profile: string,
  provider: StoredSttProvider,
  secretName: string,
): StoredSttProviderRow | null {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredSttProvider(provider)
  const secretKey = assertKnownSecretName(secretName)
  const db = requireDb()
  const existing = readStoredRow(profileName, storedProvider)
  if (!existing) {
    return null
  }

  const settings = sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(existing.secrets_json))
  delete secrets[secretKey]
  const now = Date.now()

  db.prepare(
    `UPDATE ${STT_PROFILE_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE profile = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, profileName, storedProvider)

  return getSttProviderSetting(profileName, storedProvider)
}

export function deleteSttProviderSetting(profile: string, provider: StoredSttProvider): boolean {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredSttProvider(provider)
  const db = requireDb()
  const result = db.prepare(
    `DELETE FROM ${STT_PROFILE_PROVIDER_SETTINGS_TABLE} WHERE profile = ? AND provider = ?`
  ).run(profileName, storedProvider)
  return result.changes > 0
}
