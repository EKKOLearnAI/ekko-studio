import { getDb } from '../infrastructure/database'
import {
  TTS_PROFILE_PROVIDER_SETTINGS_TABLE,
  TTS_PROFILE_SETTINGS_TABLE,
} from '../infrastructure/database/schemas'
import { normalizeSafeTtsBaseUrl } from '../contracts/voice/url-safety'

export type StoredTtsProvider =
  | 'openai'
  | 'custom'
  | 'edge'
  | 'mimo'
  | 'doubao'
  | 'elevenlabs'
  | 'gemini'
  | 'xai'
  | 'mistral'
  | 'minimax'
  | 'deepinfra'
export type ActiveTtsProvider = StoredTtsProvider

const SETTINGS_KEYS = [
  'baseUrl',
  'baseUrlPresets',
  'model',
  'voice',
  'rate',
  'pitch',
  'authMode',
  'voiceMode',
  'voiceDesignDesc',
  'voiceCloneFormat',
  'stylePrompt',
  'language',
  'sampleRate',
  'bitRate',
  'speed',
  'volume',
  'emotion',
  'groupId',
] as const
const SECRET_KEYS = ['apiKey'] as const

type TtsSettingKey = (typeof SETTINGS_KEYS)[number]
type TtsSecretKey = (typeof SECRET_KEYS)[number]

export type TtsStoredSettings = Partial<Record<Exclude<TtsSettingKey, 'baseUrlPresets'>, string>> & { baseUrlPresets?: string[] }
export type TtsStoredSecrets = Partial<Record<TtsSecretKey, string>>

export interface StoredTtsProviderRow {
  profile: string
  provider: StoredTtsProvider
  settings: TtsStoredSettings
  secrets: TtsStoredSecrets
  createdAt: number
  updatedAt: number
}

export class TtsSettingsValidationError extends Error {}

const STORED_MARKER = '[stored]'
const MAX_TEXT_SETTING_LENGTH = 2000
const MAX_BASE_URL_PRESETS = 20
const PROVIDERS: StoredTtsProvider[] = [
  'custom',
  'deepinfra',
  'doubao',
  'edge',
  'elevenlabs',
  'gemini',
  'mimo',
  'minimax',
  'mistral',
  'openai',
  'xai',
]
const ACTIVE_PROVIDERS: ActiveTtsProvider[] = PROVIDERS
const PROVIDER_SQL_PLACEHOLDERS = PROVIDERS.map(() => '?').join(', ')
const PROVIDER_LABELS: Record<StoredTtsProvider, string> = {
  openai: 'OpenAI TTS',
  custom: 'Custom TTS',
  edge: 'Edge TTS',
  mimo: 'MiMo TTS',
  doubao: 'Doubao TTS',
  elevenlabs: 'ElevenLabs TTS',
  gemini: 'Gemini TTS',
  xai: 'xAI TTS',
  mistral: 'Mistral TTS',
  minimax: 'MiniMax TTS',
  deepinfra: 'DeepInfra TTS',
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
    throw new Error('TTS settings storage unavailable')
  }
  return db
}

function normalizeProfile(profile: string): string {
  if (typeof profile !== 'string') {
    throw new TtsSettingsValidationError('invalid profile')
  }
  const value = profile.trim() || 'default'
  if (value.length > 128) {
    throw new TtsSettingsValidationError('invalid profile')
  }
  return value
}

export function isStoredTtsProvider(provider: string): provider is StoredTtsProvider {
  return PROVIDERS.includes(provider as StoredTtsProvider)
}

export function isActiveTtsProvider(provider: string): provider is ActiveTtsProvider {
  return ACTIVE_PROVIDERS.includes(provider as ActiveTtsProvider)
}

export function assertStoredTtsProvider(provider: string): StoredTtsProvider {
  if (!isStoredTtsProvider(provider)) {
    throw new TtsSettingsValidationError('unknown TTS provider')
  }
  return provider
}

export function assertActiveTtsProvider(provider: string): ActiveTtsProvider {
  if (!isActiveTtsProvider(provider)) {
    throw new TtsSettingsValidationError('unknown TTS provider')
  }
  return provider
}

export function getActiveTtsProvider(profile: string): ActiveTtsProvider | null {
  const profileName = normalizeProfile(profile)
  const db = getDb()
  if (!db) return null

  const row = db.prepare(
    `SELECT active_provider FROM ${TTS_PROFILE_SETTINGS_TABLE} WHERE profile = ?`
  ).get(profileName) as { active_provider?: string } | null

  const activeProvider = row?.active_provider
  return typeof activeProvider === 'string' && isActiveTtsProvider(activeProvider) ? activeProvider : null
}

export function saveActiveTtsProvider(profile: string, provider: ActiveTtsProvider): ActiveTtsProvider {
  const profileName = normalizeProfile(profile)
  const activeProvider = assertActiveTtsProvider(provider)
  const db = requireDb()
  const now = Date.now()

  db.prepare(
    `INSERT INTO ${TTS_PROFILE_SETTINGS_TABLE} (profile, active_provider, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile) DO UPDATE SET
       active_provider = excluded.active_provider,
       updated_at = excluded.updated_at`
  ).run(profileName, activeProvider, now, now)

  return activeProvider
}

function assertKnownSecretName(secretName: string): TtsSecretKey {
  if (!SECRET_KEYS.includes(secretName as TtsSecretKey)) {
    throw new TtsSettingsValidationError('unknown TTS provider secret')
  }
  return secretName as TtsSecretKey
}

function readStoredRow(profile: string, provider: StoredTtsProvider): StoredRow | null {
  const db = getDb()
  if (!db) return null
  return db.prepare(
    `SELECT profile, provider, settings_json, secrets_json, created_at, updated_at FROM ${TTS_PROFILE_PROVIDER_SETTINGS_TABLE} WHERE profile = ? AND provider = ?`
  ).get(profile, provider) as StoredRow | null
}

function normalizeBaseUrlPresets(provider: StoredTtsProvider, input: unknown): string[] {
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
      throw new TtsSettingsValidationError(error instanceof Error ? error.message : String(error))
    }

    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= MAX_BASE_URL_PRESETS) break
  }

  return out
}

function appendBaseUrlPreset(provider: StoredTtsProvider, settings: TtsStoredSettings): TtsStoredSettings {
  if (!settings.baseUrl) return settings
  const presets = normalizeBaseUrlPresets(provider, settings.baseUrlPresets || [])
  if (!presets.includes(settings.baseUrl)) {
    presets.unshift(settings.baseUrl)
  }
  return { ...settings, baseUrlPresets: presets.slice(0, MAX_BASE_URL_PRESETS) }
}

function sanitizeStoredSettings(provider: StoredTtsProvider, input: Record<string, unknown>): TtsStoredSettings {
  const out: TtsStoredSettings = {}

  for (const key of SETTINGS_KEYS) {
    const rawValue = input[key]

    if (key === 'baseUrlPresets') {
      const presets = normalizeBaseUrlPresets(provider, rawValue)
      if (presets.length) out.baseUrlPresets = presets
      continue
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue) && (key === 'rate' || key === 'pitch')) {
      out[key] = String(rawValue)
      continue
    }

    if (typeof rawValue !== 'string') continue
    const value = rawValue.trim()
    if (!value) continue

    if (key === 'baseUrl') {
      try {
        out.baseUrl = normalizeSafeTtsBaseUrl(value, PROVIDER_LABELS[provider])
      } catch (error) {
        throw new TtsSettingsValidationError(error instanceof Error ? error.message : String(error))
      }
      continue
    }

    out[key] = value.slice(0, MAX_TEXT_SETTING_LENGTH)
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

function maskSecrets(secrets: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {}
  if (secrets.apiKey) masked.apiKey = STORED_MARKER
  return masked
}

function rowToResult(row: StoredRow, includeSecrets: boolean): StoredTtsProviderRow {
  const provider = assertStoredTtsProvider(row.provider)
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

export function listTtsProviderSettings(profile: string): StoredTtsProviderRow[] {
  const profileName = normalizeProfile(profile)
  const db = getDb()
  if (!db) return []

  const rows = db.prepare(
    `SELECT profile, provider, settings_json, secrets_json, created_at, updated_at
     FROM ${TTS_PROFILE_PROVIDER_SETTINGS_TABLE}
     WHERE profile = ? AND provider IN (${PROVIDER_SQL_PLACEHOLDERS})
     ORDER BY provider ASC`
  ).all(profileName, ...PROVIDERS) as StoredRow[]

  return rows.map(row => rowToResult(row, false))
}

export function getTtsProviderSetting(
  profile: string,
  provider: StoredTtsProvider,
  options?: { includeSecrets?: boolean },
): StoredTtsProviderRow | null {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredTtsProvider(provider)
  const row = readStoredRow(profileName, storedProvider)
  return row ? rowToResult(row, options?.includeSecrets === true) : null
}

export function saveTtsProviderSetting(
  profile: string,
  provider: StoredTtsProvider,
  input: { settings?: unknown; secrets?: unknown },
): StoredTtsProviderRow {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredTtsProvider(provider)
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
  const mergedSettings = appendBaseUrlPreset(storedProvider, { ...existingSettings, ...nextSettings })
  const mergedSecrets = { ...existingSecrets, ...nextSecrets }
  const now = Date.now()

  db.prepare(
    `INSERT INTO ${TTS_PROFILE_PROVIDER_SETTINGS_TABLE} (profile, provider, settings_json, secrets_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile, provider) DO UPDATE SET
       settings_json = excluded.settings_json,
       secrets_json = excluded.secrets_json,
       updated_at = excluded.updated_at`
  ).run(profileName, storedProvider, JSON.stringify(mergedSettings), JSON.stringify(mergedSecrets), existing?.created_at || now, now)

  return getTtsProviderSetting(profileName, storedProvider) as StoredTtsProviderRow
}

export function removeTtsBaseUrlPreset(
  profile: string,
  provider: StoredTtsProvider,
  url: string,
): StoredTtsProviderRow | null {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredTtsProvider(provider)
  const normalizedUrl = normalizeSafeTtsBaseUrl(url, PROVIDER_LABELS[storedProvider])
  const db = requireDb()
  const existing = readStoredRow(profileName, storedProvider)
  if (!existing) return null

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
    `UPDATE ${TTS_PROFILE_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE profile = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, profileName, storedProvider)

  return getTtsProviderSetting(profileName, storedProvider)
}

export function clearStoredTtsSecret(
  profile: string,
  provider: StoredTtsProvider,
  secretName: string,
): StoredTtsProviderRow | null {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredTtsProvider(provider)
  const secretKey = assertKnownSecretName(secretName)
  const db = requireDb()
  const existing = readStoredRow(profileName, storedProvider)
  if (!existing) return null

  const settings = sanitizeStoredSettings(storedProvider, parseJsonObject(existing.settings_json))
  const secrets = sanitizeStoredSecrets(parseJsonObject(existing.secrets_json))
  delete secrets[secretKey]
  const now = Date.now()

  db.prepare(
    `UPDATE ${TTS_PROFILE_PROVIDER_SETTINGS_TABLE} SET settings_json = ?, secrets_json = ?, updated_at = ? WHERE profile = ? AND provider = ?`
  ).run(JSON.stringify(settings), JSON.stringify(secrets), now, profileName, storedProvider)

  return getTtsProviderSetting(profileName, storedProvider)
}

export function deleteTtsProviderSetting(profile: string, provider: StoredTtsProvider): boolean {
  const profileName = normalizeProfile(profile)
  const storedProvider = assertStoredTtsProvider(provider)
  const db = requireDb()
  const result = db.prepare(
    `DELETE FROM ${TTS_PROFILE_PROVIDER_SETTINGS_TABLE} WHERE profile = ? AND provider = ?`
  ).run(profileName, storedProvider)
  return result.changes > 0
}
