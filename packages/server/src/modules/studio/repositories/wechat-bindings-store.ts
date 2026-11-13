import { getDb } from '../infrastructure/database/index'
import { USERS_TABLE, WECHAT_BINDINGS_TABLE } from '../infrastructure/database/schemas'
import { normalizePhoneNumber } from './users-store'

/**
 * Per-WeChat-account device bindings.
 *
 * A device hosts many bound WeChat accounts (each with its own Token Platform
 * api_key and its own personal agent profile). One row per bound platform user;
 * `platform_profile_id` is the stable Token Platform user id behind `tp_<id>`.
 */

export interface WeChatBindingRecord {
  id: number
  user_id: number | null
  platform_profile_id: number
  platform_username: string
  api_base: string
  api_key: string
  device_id: string
  models_json: string
  display_name: string
  bound_at: number
  updated_at: number
}

export interface WeChatBindingInput {
  userId?: number | null
  platformProfileId: number
  platformUsername?: string
  apiBase: string
  apiKey: string
  deviceId?: string
  models?: string[]
  displayName?: string
}

export function parseBindingModels(record: WeChatBindingRecord): string[] {
  try {
    const parsed = JSON.parse(record.models_json)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function upsertBindingByPlatformId(input: WeChatBindingInput): WeChatBindingRecord | null {
  const db = getDb()
  if (!db) return null
  const now = Date.now()
  const models = JSON.stringify(Array.isArray(input.models) ? input.models : [])
  db.prepare(
    `INSERT INTO ${WECHAT_BINDINGS_TABLE}
       (user_id, platform_profile_id, platform_username, api_base, api_key, device_id, models_json, display_name, bound_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform_profile_id) DO UPDATE SET
       user_id = excluded.user_id,
       platform_username = excluded.platform_username,
       api_base = excluded.api_base,
       api_key = excluded.api_key,
       device_id = excluded.device_id,
       models_json = excluded.models_json,
       display_name = excluded.display_name,
       updated_at = excluded.updated_at
     WHERE ${WECHAT_BINDINGS_TABLE}.user_id IS NULL OR ${WECHAT_BINDINGS_TABLE}.user_id = excluded.user_id`
  ).run(
    input.userId ?? null,
    input.platformProfileId,
    input.platformUsername || '',
    input.apiBase,
    input.apiKey,
    input.deviceId || '',
    models,
    input.displayName || '',
    now,
    now,
  )
  return findBindingByPlatformId(input.platformProfileId)
}

export function listWeChatBindings(): WeChatBindingRecord[] {
  const db = getDb()
  if (!db) return []
  return db.prepare(
    `SELECT * FROM ${WECHAT_BINDINGS_TABLE} ORDER BY bound_at ASC`
  ).all() as unknown as WeChatBindingRecord[]
}

export function findBindingByPlatformId(platformProfileId: number): WeChatBindingRecord | null {
  const db = getDb()
  if (!db) return null
  if (!Number.isInteger(platformProfileId)) return null
  const row = db.prepare(
    `SELECT * FROM ${WECHAT_BINDINGS_TABLE} WHERE platform_profile_id = ?`
  ).get(platformProfileId) as WeChatBindingRecord | undefined
  return row || null
}

export function findBindingByUserId(userId: number): WeChatBindingRecord | null {
  const db = getDb()
  if (!db) return null
  if (!Number.isInteger(userId) || userId <= 0) return null
  const row = db.prepare(
    `SELECT * FROM ${WECHAT_BINDINGS_TABLE} WHERE user_id = ? LIMIT 1`
  ).get(userId) as WeChatBindingRecord | undefined
  return row || null
}

export function deleteBindingByUserId(userId: number): boolean {
  const db = getDb()
  if (!db) return false
  if (!Number.isInteger(userId) || userId <= 0) return false
  const result = db.prepare(`DELETE FROM ${WECHAT_BINDINGS_TABLE} WHERE user_id = ?`).run(userId)
  return result.changes > 0
}

export function deleteBindingByPlatformId(platformProfileId: number): boolean {
  const db = getDb()
  if (!db) return false
  if (!Number.isInteger(platformProfileId)) return false
  const result = db.prepare(`DELETE FROM ${WECHAT_BINDINGS_TABLE} WHERE platform_profile_id = ?`).run(platformProfileId)
  return result.changes > 0
}

export function countWeChatBindings(): number {
  const db = getDb()
  if (!db) return 0
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${WECHAT_BINDINGS_TABLE}`).get() as { count?: number } | undefined
  return Number(row?.count || 0)
}

/**
 * Find a user by phone number who is eligible for WeChat binding:
 * - user exists and is active
 * - user's phone_number matches
 * - user is NOT already bound to a WeChat account (wechat_bound = 0)
 * Returns the user id or null.
 */
export function findUnboundUserByPhone(phone: string): number | null {
  const db = getDb()
  if (!db) return null
  const normalized = normalizePhoneNumber(phone)
  if (!normalized) return null
  const row = db.prepare(
    `SELECT id FROM ${USERS_TABLE} WHERE phone_number = ? AND wechat_bound = 0 AND status = 'active' LIMIT 1`
  ).get(normalized) as { id: number } | undefined
  return row?.id ?? null
}
