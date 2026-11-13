import { randomUUID } from 'crypto'
import { normalizeThemeAppearance, type ThemeAppearance } from '../../../../../shared/theme-appearance'
import type { ThemeArchiveSettings } from '../../../../../shared/theme-archive'
import { getDb } from '../infrastructure/database'
import { USER_THEMES_TABLE, USER_THEME_PRESETS_TABLE } from '../infrastructure/database/schemas'

export const DEFAULT_THEME_FONT_SIZE = 14
export const MIN_THEME_FONT_SIZE = 12
export const MAX_THEME_FONT_SIZE = 20

export interface UserThemeRecord {
  userId: number
  activePresetId: string | null
  brightness: 'system' | 'light' | 'dark' | null
  style: 'ink' | 'comic' | null
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance: ThemeAppearance
  backgroundFilename: string | null
  backgroundUpdatedAt: number
  backgroundOriginalName: string | null
  backgroundMime: string | null
  createdAt: number
  updatedAt: number
}

export interface UserThemePayload {
  activePresetId?: string
  brightness?: NonNullable<UserThemeRecord['brightness']>
  style?: NonNullable<UserThemeRecord['style']>
  fontSize: number
  textColor: string | null
  accentColor: string | null
  appearance: ThemeAppearance
  background: {
    name: string
    mime: string | null
    updatedAt: number
  } | null
  updatedAt: number
}

interface StoredUserThemeRow {
  user_id: number
  active_preset_id: string | null
  brightness: UserThemeRecord['brightness']
  style: UserThemeRecord['style']
  font_size: number
  text_color: string | null
  accent_color: string | null
  appearance_json: string | null
  background_updated_at: number
  background_filename: string | null
  background_original_name: string | null
  background_mime: string | null
  created_at: number
  updated_at: number
}

export interface UserThemePatch {
  presetId?: unknown
  brightness?: unknown
  style?: unknown
  fontSize?: unknown
  textColor?: unknown
  accentColor?: unknown
  appearance?: unknown
}

function requireDb() {
  const db = getDb()
  if (!db) throw new Error('Theme storage unavailable')
  return db
}

function normalizeUserId(value: unknown): number {
  const userId = Number(value)
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new UserThemeValidationError('Invalid user')
  }
  return userId
}

function normalizeFontSize(value: unknown): number {
  const fontSize = Number(value)
  if (!Number.isInteger(fontSize) || fontSize < MIN_THEME_FONT_SIZE || fontSize > MAX_THEME_FONT_SIZE) {
    throw new UserThemeValidationError(
      `Font size must be between ${MIN_THEME_FONT_SIZE} and ${MAX_THEME_FONT_SIZE}`,
    )
  }
  return fontSize
}

function normalizeColor(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.trim())) {
    throw new UserThemeValidationError(`${label} must be a six-digit hex color`)
  }
  return value.trim().toLowerCase()
}

function readAppearance(value: string | null): ThemeAppearance {
  try { return normalizeThemeAppearance(value ? JSON.parse(value) : null) }
  catch { return normalizeThemeAppearance(null) }
}

function mapRow(row: StoredUserThemeRow): UserThemeRecord {
  return {
    userId: row.user_id,
    activePresetId: row.active_preset_id || null,
    brightness: row.brightness || null,
    style: row.style || null,
    fontSize: row.font_size,
    textColor: row.text_color,
    accentColor: row.accent_color,
    appearance: readAppearance(row.appearance_json),
    backgroundUpdatedAt: row.background_filename ? row.background_updated_at || row.updated_at : 0,
    backgroundFilename: row.background_filename,
    backgroundOriginalName: row.background_original_name,
    backgroundMime: row.background_mime,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function defaultTheme(userId: number): UserThemeRecord {
  return {
    userId,
    activePresetId: null,
    brightness: null,
    style: null,
    fontSize: DEFAULT_THEME_FONT_SIZE,
    textColor: null,
    accentColor: null,
    appearance: normalizeThemeAppearance(null),
    backgroundUpdatedAt: 0,
    backgroundFilename: null,
    backgroundOriginalName: null,
    backgroundMime: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

export class UserThemeValidationError extends Error {
  constructor(message: string, public readonly status = 400) { super(message) }
}

export function toUserThemePayload(theme: UserThemeRecord): UserThemePayload {
  return {
    ...(theme.activePresetId ? { activePresetId: theme.activePresetId } : {}),
    ...(theme.brightness ? { brightness: theme.brightness } : {}),
    ...(theme.style ? { style: theme.style } : {}),
    fontSize: theme.fontSize,
    textColor: theme.textColor,
    accentColor: theme.accentColor,
    appearance: theme.appearance,
    background: theme.backgroundFilename ? {
      name: theme.backgroundOriginalName || 'background',
      mime: theme.backgroundMime,
      updatedAt: theme.backgroundUpdatedAt,
    } : null,
    updatedAt: theme.updatedAt,
  }
}

export function getUserTheme(userIdValue: unknown): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  const db = getDb()
  if (!db) return defaultTheme(userId)
  const row = db.prepare(
    `SELECT * FROM ${USER_THEMES_TABLE} WHERE user_id = ?`,
  ).get(userId) as StoredUserThemeRow | undefined
  return row ? mapRow(row) : defaultTheme(userId)
}

export function saveUserTheme(userIdValue: unknown, patch: UserThemePatch): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new UserThemeValidationError('Invalid theme settings')
  }

  const current = getUserTheme(userId)
  const fontSize = Object.prototype.hasOwnProperty.call(patch, 'fontSize')
    ? normalizeFontSize(patch.fontSize)
    : current.fontSize
  const textColor = Object.prototype.hasOwnProperty.call(patch, 'textColor')
    ? normalizeColor(patch.textColor, 'Text color')
    : current.textColor
  const accentColor = Object.prototype.hasOwnProperty.call(patch, 'accentColor')
    ? normalizeColor(patch.accentColor, 'Accent color')
    : current.accentColor
  let appearance = current.appearance
  if (Object.prototype.hasOwnProperty.call(patch, 'appearance')) {
    try { appearance = normalizeThemeAppearance(patch.appearance, true) }
    catch (error) { throw new UserThemeValidationError((error as Error).message) }
  }
  assertActiveTheme(userId, patch.presetId)
  const brightness = patch.brightness === undefined ? current.brightness : normalizeChoice(patch.brightness, ['system', 'light', 'dark'] as const)
  const style = patch.style === undefined ? current.style : normalizeChoice(patch.style, ['ink', 'comic'] as const)
  return writeTheme({ ...current, fontSize, textColor, accentColor, appearance, brightness, style })
}

function normalizeChoice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new UserThemeValidationError('Invalid theme mode or style')
  return value as T
}

export function assertActiveTheme(userId: number, expectedId?: unknown) {
  if (expectedId !== undefined && expectedId !== getUserTheme(userId).activePresetId) {
    throw new UserThemeValidationError('The active theme changed. Reload before editing.', 409)
  }
}

function writeTheme(theme: UserThemeRecord): UserThemeRecord {
  const db = requireDb()
  const saved = { ...theme, createdAt: theme.createdAt || Date.now(), updatedAt: Date.now() }
  db.exec('SAVEPOINT theme_write')
  try {
    db.prepare(`INSERT INTO ${USER_THEMES_TABLE}
      (user_id, font_size, text_color, accent_color, appearance_json, background_filename,
       background_original_name, background_mime, background_updated_at, created_at, updated_at,
       active_preset_id, brightness, style)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET font_size = excluded.font_size, text_color = excluded.text_color,
        accent_color = excluded.accent_color, appearance_json = excluded.appearance_json,
        background_filename = excluded.background_filename, background_original_name = excluded.background_original_name,
        background_mime = excluded.background_mime, background_updated_at = excluded.background_updated_at,
        updated_at = excluded.updated_at, active_preset_id = excluded.active_preset_id,
        brightness = excluded.brightness, style = excluded.style`).run(
      saved.userId, saved.fontSize, saved.textColor, saved.accentColor, JSON.stringify(saved.appearance),
      saved.backgroundFilename, saved.backgroundOriginalName, saved.backgroundMime, saved.backgroundUpdatedAt,
      saved.createdAt, saved.updatedAt, saved.activePresetId, saved.brightness, saved.style,
    )
    if (saved.activePresetId) {
      db.prepare(`UPDATE ${USER_THEME_PRESETS_TABLE} SET settings_json = ?, background_filename = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
        .run(JSON.stringify(saved), saved.backgroundFilename, saved.updatedAt, saved.activePresetId, saved.userId)
    }
    db.exec('RELEASE theme_write')
    return saved
  } catch (error) {
    db.exec('ROLLBACK TO theme_write')
    db.exec('RELEASE theme_write')
    throw error
  }
}

export function saveUserThemeBackground(
  userIdValue: unknown,
  background: { filename: string; originalName: string; mime: string },
  expectedId?: unknown,
): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  assertActiveTheme(userId, expectedId)
  const current = getUserTheme(userId)
  const latest = requireDb().prepare(`SELECT MAX(json_extract(settings_json, '$.backgroundUpdatedAt')) AS version FROM ${USER_THEME_PRESETS_TABLE} WHERE user_id = ?`).get(userId) as { version: number | null }
  return writeTheme({ ...current, backgroundFilename: background.filename, backgroundOriginalName: background.originalName,
    backgroundMime: background.mime, backgroundUpdatedAt: Math.max(Date.now(), current.backgroundUpdatedAt + 1, (latest.version || 0) + 1) })
}

export function clearUserThemeBackground(userIdValue: unknown, expectedId?: unknown): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  assertActiveTheme(userId, expectedId)
  return writeTheme({ ...getUserTheme(userId), backgroundFilename: null, backgroundOriginalName: null, backgroundMime: null, backgroundUpdatedAt: 0 })
}

interface PresetRow { id: string; user_id: number; name: string; settings_json: string; background_filename: string | null }

function presetRows(userId: number): PresetRow[] {
  return requireDb().prepare(`SELECT * FROM ${USER_THEME_PRESETS_TABLE} WHERE user_id = ? ORDER BY created_at, id`).all(userId) as unknown as PresetRow[]
}

export function getThemePreset(userIdValue: unknown, id: unknown): UserThemeRecord {
  const userId = normalizeUserId(userIdValue)
  if (typeof id !== 'string') throw new UserThemeValidationError('Invalid theme id')
  const row = requireDb().prepare(`SELECT * FROM ${USER_THEME_PRESETS_TABLE} WHERE id = ? AND user_id = ?`).get(id, userId) as PresetRow | undefined
  if (!row) throw new UserThemeValidationError('Theme not found', 404)
  return { ...JSON.parse(row.settings_json), userId, activePresetId: row.id }
}

function insertPreset(theme: UserThemeRecord, name: string): string {
  const id = randomUUID()
  requireDb().prepare(`INSERT INTO ${USER_THEME_PRESETS_TABLE} (id, user_id, name, settings_json, background_filename, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, theme.userId, name, JSON.stringify({ ...theme, activePresetId: id }), theme.backgroundFilename, Date.now(), Date.now())
  return id
}

function ensureThemeLibrary(userId: number) {
  if (getUserTheme(userId).activePresetId) return
  const theme = getUserTheme(userId)
  const db = requireDb()
  db.exec('SAVEPOINT theme_library')
  try {
    const id = insertPreset(theme, '') // The UI localizes the migrated theme's default name.
    writeTheme({ ...theme, activePresetId: id })
    db.exec('RELEASE theme_library')
  } catch (error) {
    db.exec('ROLLBACK TO theme_library')
    db.exec('RELEASE theme_library')
    throw error
  }
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new UserThemeValidationError('Theme name must contain 1 to 80 characters')
  return value.trim()
}

export function normalizeImportedTheme(value: unknown): ThemeArchiveSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UserThemeValidationError('Invalid theme settings')
  const settings = value as Record<string, unknown>
  const keys = ['brightness', 'style', 'fontSize', 'textColor', 'accentColor', 'appearance']
  if (Object.keys(settings).some(key => !keys.includes(key)) || keys.some(key => !(key in settings))) {
    throw new UserThemeValidationError('Invalid theme settings fields')
  }
  let appearance: ThemeAppearance
  try { appearance = normalizeThemeAppearance(settings.appearance, true) }
  catch (error) { throw new UserThemeValidationError((error as Error).message) }
  return {
    brightness: normalizeChoice(settings.brightness, ['system', 'light', 'dark'] as const),
    style: normalizeChoice(settings.style, ['ink', 'comic'] as const),
    fontSize: normalizeFontSize(settings.fontSize),
    textColor: normalizeColor(settings.textColor, 'Text color'),
    accentColor: normalizeColor(settings.accentColor, 'Accent color'),
    appearance,
  }
}

export function importThemePreset(
  userIdValue: unknown,
  input: { name: unknown; settings: unknown },
  background: { filename: string; originalName: string; mime: string } | null,
  preferences: { brightness?: unknown; style?: unknown } = {},
) {
  const userId = normalizeUserId(userIdValue)
  const name = normalizeName(input.name)
  const settings = normalizeImportedTheme(input.settings)
  const brightness = normalizeChoice(preferences.brightness ?? 'system', ['system', 'light', 'dark'] as const)
  const style = normalizeChoice(preferences.style ?? 'ink', ['ink', 'comic'] as const)
  const db = requireDb()
  db.exec('SAVEPOINT theme_import')
  try {
    const current = getUserTheme(userId)
    if (!current.brightness || !current.style) {
      saveUserTheme(userId, { brightness: current.brightness || brightness, style: current.style || style })
    }
    ensureThemeLibrary(userId)
    const latest = db.prepare(`SELECT MAX(json_extract(settings_json, '$.backgroundUpdatedAt')) AS version FROM ${USER_THEME_PRESETS_TABLE} WHERE user_id = ?`).get(userId) as { version: number | null }
    const imported = { ...defaultTheme(userId), ...settings,
      ...(background ? { backgroundFilename: background.filename, backgroundOriginalName: background.originalName,
        backgroundMime: background.mime, backgroundUpdatedAt: Math.max(Date.now(), current.backgroundUpdatedAt + 1, (latest.version || 0) + 1) } : {}),
    }
    const id = insertPreset(imported, name)
    const result = activateThemePreset(userId, id)
    db.exec('RELEASE theme_import')
    return result
  } catch (error) {
    db.exec('ROLLBACK TO theme_import')
    db.exec('RELEASE theme_import')
    throw error
  }
}

export function listThemePresets(userIdValue: unknown) {
  const userId = normalizeUserId(userIdValue)
  ensureThemeLibrary(userId)
  return {
    activeId: getUserTheme(userId).activePresetId!,
    themes: presetRows(userId).map(row => ({ id: row.id, name: row.name, ...toUserThemePayload(getThemePreset(userId, row.id)) })),
  }
}

export function createThemePreset(userIdValue: unknown, input: { name?: unknown; sourceId?: unknown; brightness?: unknown; style?: unknown }) {
  const userId = normalizeUserId(userIdValue)
  const name = normalizeName(input.name)
  const brightness = normalizeChoice(input.brightness ?? 'system', ['system', 'light', 'dark'] as const)
  const style = normalizeChoice(input.style ?? 'ink', ['ink', 'comic'] as const)
  if (input.sourceId !== undefined) getThemePreset(userId, input.sourceId)
  const db = requireDb()
  db.exec('SAVEPOINT theme_create')
  try {
    // Capture device-only preferences before the first switch from a legacy theme.
    const current = getUserTheme(userId)
    if (!current.brightness || !current.style) {
      saveUserTheme(userId, { brightness: current.brightness || brightness, style: current.style || style })
    }
    ensureThemeLibrary(userId)
    const source = input.sourceId === undefined
      ? { ...defaultTheme(userId), brightness, style }
      : getThemePreset(userId, input.sourceId)
    const id = insertPreset(source, name)
    const result = activateThemePreset(userId, id)
    db.exec('RELEASE theme_create')
    return result
  } catch (error) {
    db.exec('ROLLBACK TO theme_create')
    db.exec('RELEASE theme_create')
    throw error
  }
}

export function renameThemePreset(userIdValue: unknown, id: unknown, nameValue: unknown) {
  const userId = normalizeUserId(userIdValue)
  const name = normalizeName(nameValue)
  getThemePreset(userId, id)
  requireDb().prepare(`UPDATE ${USER_THEME_PRESETS_TABLE} SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?`).run(name, Date.now(), id as string, userId)
  return listThemePresets(userId)
}

export function activateThemePreset(userIdValue: unknown, id: unknown) {
  const userId = normalizeUserId(userIdValue)
  const saved = writeTheme(getThemePreset(userId, id))
  return { ...listThemePresets(userId), theme: toUserThemePayload(saved) }
}

export function deleteThemePreset(userIdValue: unknown, id: unknown) {
  const userId = normalizeUserId(userIdValue)
  const removed = getThemePreset(userId, id)
  const remaining = presetRows(userId).filter(row => row.id !== id)
  if (!remaining.length) throw new UserThemeValidationError('Keep at least one theme')
  const db = requireDb()
  db.exec('SAVEPOINT theme_delete')
  try {
    if (getUserTheme(userId).activePresetId === id) writeTheme(getThemePreset(userId, remaining[0]!.id))
    db.prepare(`DELETE FROM ${USER_THEME_PRESETS_TABLE} WHERE id = ? AND user_id = ?`).run(id as string, userId)
    db.exec('RELEASE theme_delete')
  } catch (error) {
    db.exec('ROLLBACK TO theme_delete')
    db.exec('RELEASE theme_delete')
    throw error
  }
  return { removed, ...listThemePresets(userId), theme: toUserThemePayload(getUserTheme(userId)) }
}

export function isThemeBackgroundReferenced(userId: number, filename: string): boolean {
  if (getUserTheme(userId).backgroundFilename === filename) return true
  return !!requireDb().prepare(`SELECT 1 FROM ${USER_THEME_PRESETS_TABLE} WHERE user_id = ? AND background_filename = ? LIMIT 1`).get(userId, filename)
}
