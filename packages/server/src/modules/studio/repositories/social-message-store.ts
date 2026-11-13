import { getDb } from '../infrastructure/database'
import {
  SOCIAL_MESSAGE_ACCOUNTS_TABLE,
  SOCIAL_MESSAGE_RUNTIME_STATES_TABLE,
} from '../infrastructure/database/schemas'

export type StoredSocialMessagePlatform = 'telegram' | 'feishu' | 'weixin'
export const SOCIAL_MESSAGE_BINDING_LOCALES = [
  'zh', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'es', 'de', 'pt', 'ru', 'ar',
] as const
export type SocialMessageBindingLocale = typeof SOCIAL_MESSAGE_BINDING_LOCALES[number]

export interface SocialMessageAccountRow {
  userId: number
  platform: StoredSocialMessagePlatform
  credentials: Record<string, string>
  active: boolean
  recipient: string
  recipientType: string
  bindingLocale: SocialMessageBindingLocale
  bindingNotified: boolean
  createdAt: number
  updatedAt: number
}

interface RawAccountRow {
  user_id: number
  platform: string
  credentials_json: string
  active: number
  recipient: string
  recipient_type: string
  binding_locale: string
  binding_notified: number
  created_at: number
  updated_at: number
}

const PLATFORMS = new Set<StoredSocialMessagePlatform>(['telegram', 'feishu', 'weixin'])

function requireDb() {
  const db = getDb()
  if (!db) throw new Error('Social Messages storage unavailable')
  return db
}

function normalizedUserId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('A valid Social Messages user ID is required')
  return value
}

function normalizedPlatform(value: string): StoredSocialMessagePlatform {
  if (!PLATFORMS.has(value as StoredSocialMessagePlatform)) throw new Error('Unsupported Social Messages platform')
  return value as StoredSocialMessagePlatform
}

export function normalizeSocialMessageBindingLocale(value: unknown): SocialMessageBindingLocale {
  const locale = typeof value === 'string' ? value.trim() : ''
  return SOCIAL_MESSAGE_BINDING_LOCALES.includes(locale as SocialMessageBindingLocale)
    ? locale as SocialMessageBindingLocale
    : 'en'
}

function jsonObject(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, item]) => (
      typeof item === 'string' ? [[key, item]] : []
    )))
  } catch {
    return {}
  }
}

function accountRow(row: RawAccountRow): SocialMessageAccountRow {
  return {
    userId: Number(row.user_id),
    platform: normalizedPlatform(row.platform),
    credentials: jsonObject(row.credentials_json),
    active: Number(row.active) === 1,
    recipient: String(row.recipient || ''),
    recipientType: String(row.recipient_type || ''),
    bindingLocale: normalizeSocialMessageBindingLocale(row.binding_locale),
    bindingNotified: Number(row.binding_notified) === 1,
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
  }
}

export function listSocialMessageAccounts(userId: number): SocialMessageAccountRow[] {
  const db = getDb()
  if (!db) return []
  return (db.prepare(
    `SELECT * FROM ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} WHERE user_id = ? ORDER BY platform ASC`,
  ).all(normalizedUserId(userId)) as unknown as RawAccountRow[]).map(accountRow)
}

export function getSocialMessageAccount(
  userId: number,
  platform: StoredSocialMessagePlatform,
): SocialMessageAccountRow | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} WHERE user_id = ? AND platform = ?`,
  ).get(normalizedUserId(userId), normalizedPlatform(platform)) as unknown as RawAccountRow | undefined
  return row ? accountRow(row) : null
}

export function getActiveSocialMessageAccount(userId: number): SocialMessageAccountRow | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} WHERE user_id = ? AND active = 1 LIMIT 1`,
  ).get(normalizedUserId(userId)) as unknown as RawAccountRow | undefined
  return row ? accountRow(row) : null
}

export function upsertSocialMessageAccount(input: {
  userId: number
  platform: StoredSocialMessagePlatform
  credentials: Record<string, string>
  active?: boolean
  bindingLocale?: string
}): SocialMessageAccountRow {
  const db = requireDb()
  const userId = normalizedUserId(input.userId)
  const platform = normalizedPlatform(input.platform)
  const now = Date.now()
  const credentialsJson = JSON.stringify(input.credentials)
  const bindingLocale = normalizeSocialMessageBindingLocale(input.bindingLocale)
  db.exec('BEGIN IMMEDIATE')
  try {
    const previous = db.prepare(
      `SELECT credentials_json FROM ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} WHERE user_id = ? AND platform = ?`,
    ).get(userId, platform) as { credentials_json?: string } | undefined
    const credentialsChanged = Boolean(previous && previous.credentials_json !== credentialsJson)
    if (input.active) {
      db.prepare(`UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} SET active = 0 WHERE user_id = ?`).run(userId)
    }
    if (credentialsChanged) {
      db.prepare(
        `DELETE FROM ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE} WHERE user_id = ? AND platform = ?`,
      ).run(userId, platform)
    }
    db.prepare(
      `INSERT INTO ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}
        (user_id, platform, credentials_json, active, recipient, recipient_type,
         binding_locale, binding_notified, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', ?, 0, ?, ?)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         credentials_json = excluded.credentials_json,
         active = CASE WHEN excluded.active = 1 THEN 1 ELSE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.active END,
         recipient = CASE WHEN ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.credentials_json <> excluded.credentials_json THEN '' ELSE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.recipient END,
         recipient_type = CASE WHEN ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.credentials_json <> excluded.credentials_json THEN '' ELSE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.recipient_type END,
         binding_locale = excluded.binding_locale,
         binding_notified = CASE WHEN ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.credentials_json <> excluded.credentials_json THEN 0 ELSE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}.binding_notified END,
         updated_at = excluded.updated_at`,
    ).run(userId, platform, credentialsJson, input.active ? 1 : 0, bindingLocale, now, now)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return getSocialMessageAccount(userId, platform)!
}

export function markSocialMessageBindingNotified(
  userId: number,
  platform: StoredSocialMessagePlatform,
): boolean {
  const db = requireDb()
  const result = db.prepare(
    `UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}
     SET binding_notified = 1, updated_at = ?
     WHERE user_id = ? AND platform = ? AND binding_notified = 0`,
  ).run(Date.now(), normalizedUserId(userId), normalizedPlatform(platform))
  return Number(result.changes) > 0
}

export function setSocialMessageAccountLocale(
  userIdValue: number,
  platformValue: StoredSocialMessagePlatform,
  locale: unknown,
): boolean {
  const db = requireDb()
  const result = db.prepare(
    `UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}
     SET binding_locale = ?, updated_at = ?
     WHERE user_id = ? AND platform = ?`,
  ).run(
    normalizeSocialMessageBindingLocale(locale),
    Date.now(),
    normalizedUserId(userIdValue),
    normalizedPlatform(platformValue),
  )
  return Number(result.changes) > 0
}

export function setActiveSocialMessageAccount(userIdValue: number, platformValue: StoredSocialMessagePlatform): boolean {
  const db = requireDb()
  const userId = normalizedUserId(userIdValue)
  const platform = normalizedPlatform(platformValue)
  if (!getSocialMessageAccount(userId, platform)) return false
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} SET active = 0 WHERE user_id = ?`).run(userId)
    const result = db.prepare(
      `UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} SET active = 1, updated_at = ? WHERE user_id = ? AND platform = ?`,
    ).run(Date.now(), userId, platform)
    db.exec('COMMIT')
    return Number(result.changes) > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function setSocialMessageAccountTarget(input: {
  userId: number
  platform: StoredSocialMessagePlatform
  recipient: string
  recipientType: string
  active?: boolean
}): boolean {
  const db = requireDb()
  const userId = normalizedUserId(input.userId)
  const platform = normalizedPlatform(input.platform)
  const recipient = String(input.recipient || '').trim()
  const recipientType = String(input.recipientType || '').trim()
  if (!recipient || !recipientType) throw new Error('A valid Social Messages target is required')
  db.exec('BEGIN IMMEDIATE')
  try {
    if (input.active) {
      db.prepare(`UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} SET active = 0 WHERE user_id = ?`).run(userId)
    }
    const result = db.prepare(
      `UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}
       SET recipient = ?, recipient_type = ?, active = CASE WHEN ? = 1 THEN 1 ELSE active END, updated_at = ?
       WHERE user_id = ? AND platform = ?`,
    ).run(recipient, recipientType, input.active ? 1 : 0, Date.now(), userId, platform)
    db.exec('COMMIT')
    return Number(result.changes) > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function clearSocialMessageAccountTarget(userId: number, platform: StoredSocialMessagePlatform): boolean {
  const db = requireDb()
  const result = db.prepare(
    `UPDATE ${SOCIAL_MESSAGE_ACCOUNTS_TABLE}
     SET recipient = '', recipient_type = '', updated_at = ?
     WHERE user_id = ? AND platform = ?`,
  ).run(Date.now(), normalizedUserId(userId), normalizedPlatform(platform))
  return Number(result.changes) > 0
}

export function deleteSocialMessageAccount(userIdValue: number, platformValue: StoredSocialMessagePlatform): boolean {
  const db = requireDb()
  const userId = normalizedUserId(userIdValue)
  const platform = normalizedPlatform(platformValue)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(
      `DELETE FROM ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE} WHERE user_id = ? AND platform = ?`,
    ).run(userId, platform)
    const result = db.prepare(
      `DELETE FROM ${SOCIAL_MESSAGE_ACCOUNTS_TABLE} WHERE user_id = ? AND platform = ?`,
    ).run(userId, platform)
    db.exec('COMMIT')
    return Number(result.changes) > 0
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function parseRuntimeState(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function readSocialMessageRuntimeState(
  userId: number,
  platform: StoredSocialMessagePlatform,
  accountKey: string,
): Record<string, unknown> | null {
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT account_key, state_json FROM ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE}
     WHERE user_id = ? AND platform = ?`,
  ).get(normalizedUserId(userId), normalizedPlatform(platform)) as { account_key?: string; state_json?: string } | undefined
  if (!row || row.account_key !== accountKey) return null
  return parseRuntimeState(String(row.state_json || ''))
}

export function writeSocialMessageRuntimeState(
  userId: number,
  platform: StoredSocialMessagePlatform,
  accountKey: string,
  state: Record<string, unknown>,
): void {
  const db = requireDb()
  db.prepare(
    `INSERT INTO ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE} (user_id, platform, account_key, state_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, platform) DO UPDATE SET
       account_key = excluded.account_key,
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  ).run(normalizedUserId(userId), normalizedPlatform(platform), accountKey, JSON.stringify(state), Date.now())
}

export function updateSocialMessageRuntimeState(
  userId: number,
  platform: StoredSocialMessagePlatform,
  accountKey: string,
  updater: (current: Record<string, unknown> | null) => Record<string, unknown>,
): void {
  const db = requireDb()
  const normalizedUser = normalizedUserId(userId)
  const normalizedPlatformValue = normalizedPlatform(platform)
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(
      `SELECT account_key, state_json FROM ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE}
       WHERE user_id = ? AND platform = ?`,
    ).get(normalizedUser, normalizedPlatformValue) as { account_key?: string; state_json?: string } | undefined
    const current = row?.account_key === accountKey ? parseRuntimeState(String(row.state_json || '')) : null
    const next = updater(current)
    db.prepare(
      `INSERT INTO ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE} (user_id, platform, account_key, state_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         account_key = excluded.account_key,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run(normalizedUser, normalizedPlatformValue, accountKey, JSON.stringify(next), Date.now())
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function deleteSocialMessageRuntimeState(
  userId: number,
  platform: StoredSocialMessagePlatform,
  accountKey?: string,
): boolean {
  const db = requireDb()
  const result = accountKey
    ? db.prepare(
        `DELETE FROM ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE}
         WHERE user_id = ? AND platform = ? AND account_key = ?`,
      ).run(normalizedUserId(userId), normalizedPlatform(platform), accountKey)
    : db.prepare(
        `DELETE FROM ${SOCIAL_MESSAGE_RUNTIME_STATES_TABLE} WHERE user_id = ? AND platform = ?`,
      ).run(normalizedUserId(userId), normalizedPlatform(platform))
  return Number(result.changes) > 0
}
