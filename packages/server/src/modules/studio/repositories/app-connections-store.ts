import { deviceSystemNotificationsEnabled } from './device-notification-preferences'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { getDb, jsonGetAll, jsonSet } from '../infrastructure/database'
import { APP_AUTHORIZATION_CODES_TABLE, APP_CONNECTIONS_TABLE } from '../infrastructure/database/schemas'

export const APP_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60

export type AppConnectionType = 'lan' | 'cloud'
export type AppConnectionTokenStatus = 'active' | 'revoked' | 'expired' | 'invalid'

export interface AppConnectionRecord {
  id: number
  device_code: string
  device_name: string
  device_brand: string
  device_model: string
  connection_type: AppConnectionType
  user_id: number
  push_enabled: number
  cloud_user_id: number
  token_hash: string
  token_expires_at: number
  last_connected_at: number
  revoked_at: number | null
  cloud_revocation_pending: number
  created_at: number
  updated_at: number
}

export interface AppAuthorizationCodeRecord {
  id: string
  code_hash: string
  created_by_user_id: number
  expires_at: number
  used_at: number | null
  used_by_device_code: string
  created_at: number
}

interface StoredAppConnectionRow extends Omit<AppConnectionRecord, 'connection_type'> {
  connection_type: string
}

interface StoredAppAuthorizationCodeRow extends Omit<AppAuthorizationCodeRecord, 'used_at'> {
  used_at: number | null
}

function epochSeconds(now = Date.now()): number {
  return Math.floor(now / 1000)
}

export function hashAppCredential(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashesEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, 'hex')
    const b = Buffer.from(right, 'hex')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function normalizeConnectionType(value: unknown): AppConnectionType {
  return value === 'cloud' ? 'cloud' : 'lan'
}

function normalizeCloudUserId(connectionType: AppConnectionType, value: unknown): number {
  const userId = Number(value)
  return connectionType === 'cloud' && Number.isSafeInteger(userId) && userId > 0 ? userId : 0
}

function connectionRowToRecord(row: StoredAppConnectionRow | Record<string, any>): AppConnectionRecord {
  return {
    id: Number(row.id),
    device_code: String(row.device_code || ''),
    device_name: String(row.device_name || ''),
    device_brand: String(row.device_brand || ''),
    device_model: String(row.device_model || ''),
    connection_type: normalizeConnectionType(row.connection_type),
    user_id: Number(row.user_id || 0),
    push_enabled: row.push_enabled === 0 || row.push_enabled === false ? 0 : 1,
    cloud_user_id: Number(row.cloud_user_id || 0),
    token_hash: String(row.token_hash || ''),
    token_expires_at: Number(row.token_expires_at || 0),
    last_connected_at: Number(row.last_connected_at || 0),
    revoked_at: row.revoked_at == null ? null : Number(row.revoked_at),
    cloud_revocation_pending: Number(row.cloud_revocation_pending || 0),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
  }
}

function authorizationRowToRecord(row: StoredAppAuthorizationCodeRow | Record<string, any>): AppAuthorizationCodeRecord {
  return {
    id: String(row.id || ''),
    code_hash: String(row.code_hash || ''),
    created_by_user_id: Number(row.created_by_user_id || 0),
    expires_at: Number(row.expires_at || 0),
    used_at: row.used_at == null ? null : Number(row.used_at),
    used_by_device_code: String(row.used_by_device_code || ''),
    created_at: Number(row.created_at || 0),
  }
}

export function createAppAuthorizationCode(
  createdByUserId: number,
  now = epochSeconds(),
): { authorizationCode: string; record: AppAuthorizationCodeRecord } {
  const authorizationCode = randomBytes(24).toString('base64url')
  const record: AppAuthorizationCodeRecord = {
    id: randomUUID(),
    code_hash: hashAppCredential(authorizationCode),
    created_by_user_id: createdByUserId,
    expires_at: now + APP_AUTHORIZATION_CODE_TTL_SECONDS,
    used_at: null,
    used_by_device_code: '',
    created_at: now,
  }
  const db = getDb()
  if (!db) {
    jsonSet(APP_AUTHORIZATION_CODES_TABLE, record.id, record as any)
    return { authorizationCode, record }
  }

  db.prepare(`
    INSERT INTO ${APP_AUTHORIZATION_CODES_TABLE} (
      id, code_hash, created_by_user_id, expires_at, used_at, used_by_device_code, created_at
    ) VALUES (?, ?, ?, ?, NULL, '', ?)
  `).run(record.id, record.code_hash, record.created_by_user_id, record.expires_at, record.created_at)
  return { authorizationCode, record }
}

export function consumeAppAuthorizationCode(
  authorizationCode: string,
  deviceCode: string,
  now = epochSeconds(),
): AppAuthorizationCodeRecord {
  const codeHash = hashAppCredential(authorizationCode)
  const db = getDb()
  if (!db) {
    const stored = Object.values(jsonGetAll(APP_AUTHORIZATION_CODES_TABLE))
      .map(authorizationRowToRecord)
      .find(record => hashesEqual(record.code_hash, codeHash))
    if (!stored) throw new Error('app_authorization_code_invalid')
    if (stored.used_at != null) throw new Error('app_authorization_code_used')
    if (stored.expires_at <= now) throw new Error('app_authorization_code_expired')
    const consumed = { ...stored, used_at: now, used_by_device_code: deviceCode }
    jsonSet(APP_AUTHORIZATION_CODES_TABLE, consumed.id, consumed as any)
    return consumed
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare(
      `SELECT * FROM ${APP_AUTHORIZATION_CODES_TABLE} WHERE code_hash = ?`,
    ).get(codeHash) as unknown as StoredAppAuthorizationCodeRow | undefined
    if (!row) throw new Error('app_authorization_code_invalid')
    const record = authorizationRowToRecord(row)
    if (record.used_at != null) throw new Error('app_authorization_code_used')
    if (record.expires_at <= now) throw new Error('app_authorization_code_expired')
    const result = db.prepare(`
      UPDATE ${APP_AUTHORIZATION_CODES_TABLE}
      SET used_at = ?, used_by_device_code = ?
      WHERE id = ? AND used_at IS NULL
    `).run(now, deviceCode, record.id)
    if (Number(result.changes) !== 1) throw new Error('app_authorization_code_used')
    db.exec('COMMIT')
    return { ...record, used_at: now, used_by_device_code: deviceCode }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function upsertAppConnection(input: {
  deviceCode: string
  deviceName: string
  deviceBrand: string
  deviceModel: string
  connectionType: AppConnectionType
  userId: number
  cloudUserId?: number
  token: string
  tokenExpiresAt: number
  now?: number
}): AppConnectionRecord {
  const now = input.now ?? epochSeconds()
  const tokenHash = hashAppCredential(input.token)
  const cloudUserId = normalizeCloudUserId(input.connectionType, input.cloudUserId)
  const db = getDb()
  if (!db) {
    const rows = jsonGetAll(APP_CONNECTIONS_TABLE)
    const existing = Object.values(rows)
      .map(connectionRowToRecord)
      .find(record => (
        record.device_code === input.deviceCode
        && record.connection_type === input.connectionType
        && record.cloud_user_id === cloudUserId
      ))
    const nextId = Math.max(0, ...Object.values(rows).map(value => Number(value.id || 0))) + 1
    const row: AppConnectionRecord = {
      id: existing?.id || nextId,
      device_code: input.deviceCode,
      device_name: input.deviceName,
      device_brand: input.deviceBrand,
      device_model: input.deviceModel,
      connection_type: input.connectionType,
      user_id: input.userId,
      push_enabled: existing?.push_enabled ?? 1,
      cloud_user_id: cloudUserId,
      token_hash: tokenHash,
      token_expires_at: input.tokenExpiresAt,
      last_connected_at: now,
      revoked_at: null,
      cloud_revocation_pending: 0,
      created_at: existing?.created_at || now,
      updated_at: now,
    }
    jsonSet(APP_CONNECTIONS_TABLE, String(row.id), row as any)
    return row
  }

  db.prepare(`
    INSERT INTO ${APP_CONNECTIONS_TABLE} (
      device_code, device_name, device_brand, device_model, connection_type, user_id, cloud_user_id, token_hash,
      token_expires_at, last_connected_at, revoked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    ON CONFLICT(device_code, connection_type, cloud_user_id) DO UPDATE SET
      device_name = excluded.device_name,
      device_brand = excluded.device_brand,
      device_model = excluded.device_model,
      connection_type = excluded.connection_type,
      user_id = excluded.user_id,
      token_hash = excluded.token_hash,
      token_expires_at = excluded.token_expires_at,
      last_connected_at = excluded.last_connected_at,
      revoked_at = NULL,
      cloud_revocation_pending = 0,
      updated_at = excluded.updated_at
  `).run(
    input.deviceCode,
    input.deviceName,
    input.deviceBrand,
    input.deviceModel,
    input.connectionType,
    input.userId,
    cloudUserId,
    tokenHash,
    input.tokenExpiresAt,
    now,
    now,
    now,
  )
  const row = db.prepare(
    `SELECT * FROM ${APP_CONNECTIONS_TABLE} WHERE device_code = ? AND connection_type = ? AND cloud_user_id = ?`,
  ).get(input.deviceCode, input.connectionType, cloudUserId) as unknown as StoredAppConnectionRow
  return connectionRowToRecord(row)
}

export function listAppConnections(): AppConnectionRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(APP_CONNECTIONS_TABLE))
      .map(connectionRowToRecord)
      .filter(connection => connection.revoked_at == null)
      .sort((a, b) => b.updated_at - a.updated_at)
  }
  const rows = db.prepare(
    `SELECT * FROM ${APP_CONNECTIONS_TABLE} WHERE revoked_at IS NULL ORDER BY updated_at DESC, id DESC`,
  ).all() as unknown as StoredAppConnectionRow[]
  return rows.map(connectionRowToRecord)
}

export function updateAppConnectionPushEnabled(id: number, enabled: boolean, now = epochSeconds()): AppConnectionRecord | null {
  const connection = listAppConnections().find(row => row.id === id)
  if (!connection) return null
  const next = { ...connection, push_enabled: enabled ? 1 : 0, updated_at: now }
  const db = getDb()
  if (db) db.prepare(`UPDATE ${APP_CONNECTIONS_TABLE} SET push_enabled=?, updated_at=? WHERE id=? AND revoked_at IS NULL`)
    .run(next.push_enabled, now, id)
  else jsonSet(APP_CONNECTIONS_TABLE, String(id), next as any)
  return next
}

/** Called after authentication; browser JWTs have no App device preference. */
export function isAppConnectionPushEnabled(token: string): boolean {
  if (!token) return true
  const hash = hashAppCredential(token), db = getDb()
  const row = db ? db.prepare(`SELECT push_enabled,user_id,device_code FROM ${APP_CONNECTIONS_TABLE} WHERE token_hash=?`).get(hash)
    : Object.values(jsonGetAll(APP_CONNECTIONS_TABLE)).find(connection => connection.token_hash === hash)
  return row?.push_enabled !== 0 && row?.push_enabled !== false
    && (!row || deviceSystemNotificationsEnabled(Number(row.user_id), String(row.device_code)))
}

export function assignLegacyCloudAppConnectionUser(deviceCode: string, cloudUserId: number): boolean {
  const normalizedDeviceCode = String(deviceCode || '').trim()
  const normalizedCloudUserId = normalizeCloudUserId('cloud', cloudUserId)
  if (!normalizedDeviceCode || !normalizedCloudUserId) return false
  const db = getDb()
  if (!db) {
    const connections = Object.values(jsonGetAll(APP_CONNECTIONS_TABLE)).map(connectionRowToRecord)
    if (connections.some(connection => (
      connection.device_code === normalizedDeviceCode
      && connection.connection_type === 'cloud'
      && connection.cloud_user_id === normalizedCloudUserId
    ))) return false
    const legacy = connections.find(connection => (
      connection.device_code === normalizedDeviceCode
      && connection.connection_type === 'cloud'
      && connection.cloud_user_id === 0
      && connection.revoked_at == null
    ))
    if (!legacy) return false
    jsonSet(APP_CONNECTIONS_TABLE, String(legacy.id), {
      ...legacy,
      cloud_user_id: normalizedCloudUserId,
    } as any)
    return true
  }

  const exact = db.prepare(`
    SELECT 1 FROM ${APP_CONNECTIONS_TABLE}
    WHERE device_code = ? AND connection_type = 'cloud' AND cloud_user_id = ?
    LIMIT 1
  `).get(normalizedDeviceCode, normalizedCloudUserId)
  if (exact) return false
  const legacy = db.prepare(`
    SELECT id FROM ${APP_CONNECTIONS_TABLE}
    WHERE device_code = ? AND connection_type = 'cloud' AND cloud_user_id = 0 AND revoked_at IS NULL
    LIMIT 1
  `).get(normalizedDeviceCode) as { id?: number } | undefined
  if (!legacy?.id) return false
  const result = db.prepare(`
    UPDATE ${APP_CONNECTIONS_TABLE} SET cloud_user_id = ?
    WHERE id = ? AND cloud_user_id = 0
  `).run(normalizedCloudUserId, legacy.id)
  return Number(result.changes) === 1
}

export function getAppConnectionTokenStatus(
  deviceCode: string,
  connectionType: AppConnectionType,
  token: string,
  userId: number,
  now = epochSeconds(),
): AppConnectionTokenStatus {
  const db = getDb()
  const rows = db
    ? db.prepare(`SELECT * FROM ${APP_CONNECTIONS_TABLE} WHERE device_code = ? AND connection_type = ?`).all(deviceCode, connectionType)
    : Object.values(jsonGetAll(APP_CONNECTIONS_TABLE)).filter(value => (
        String(value.device_code || '') === deviceCode
        && normalizeConnectionType(value.connection_type) === connectionType
      ))
  const tokenHash = hashAppCredential(token)
  const record = (rows as Record<string, any>[])
    .map(connectionRowToRecord)
    .find(candidate => candidate.user_id === userId && hashesEqual(candidate.token_hash, tokenHash))
  if (!record) return 'invalid'
  if (record.revoked_at != null) return 'revoked'
  if (record.token_expires_at <= now) return 'expired'
  return 'active'
}

export function isAppConnectionTokenActive(
  deviceCode: string,
  connectionType: AppConnectionType,
  token: string,
  userId: number,
  now = epochSeconds(),
): boolean {
  return getAppConnectionTokenStatus(deviceCode, connectionType, token, userId, now) === 'active'
}

export function revokeAppConnection(id: number, now = epochSeconds()): AppConnectionRecord | null {
  if (!Number.isSafeInteger(id) || id <= 0) return null
  const db = getDb()
  if (!db) {
    const row = Object.values(jsonGetAll(APP_CONNECTIONS_TABLE))
      .map(connectionRowToRecord)
      .find(connection => connection.id === id && connection.revoked_at == null)
    if (!row) return null
    const revoked = {
      ...row,
      revoked_at: now,
      cloud_revocation_pending: row.connection_type === 'cloud' && row.cloud_user_id > 0 ? 1 : 0,
      updated_at: now,
    }
    jsonSet(APP_CONNECTIONS_TABLE, String(row.id), revoked as any)
    return revoked
  }

  const row = db.prepare(
    `SELECT * FROM ${APP_CONNECTIONS_TABLE} WHERE id = ? AND revoked_at IS NULL`,
  ).get(id) as unknown as StoredAppConnectionRow | undefined
  if (!row) return null
  db.prepare(`
    UPDATE ${APP_CONNECTIONS_TABLE}
    SET revoked_at = ?, cloud_revocation_pending = CASE
      WHEN connection_type = 'cloud' AND cloud_user_id > 0 THEN 1 ELSE 0 END, updated_at = ?
    WHERE id = ? AND revoked_at IS NULL
  `).run(now, now, id)
  return {
    ...connectionRowToRecord(row),
    revoked_at: now,
    cloud_revocation_pending: connectionRowToRecord(row).connection_type === 'cloud'
      && connectionRowToRecord(row).cloud_user_id > 0 ? 1 : 0,
    updated_at: now,
  }
}

export function hasPendingCloudAppConnectionRevocations(): boolean {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(APP_CONNECTIONS_TABLE))
      .map(connectionRowToRecord)
      .some(connection => (
        connection.connection_type === 'cloud'
        && connection.cloud_revocation_pending === 1
        && connection.cloud_user_id > 0
      ))
  }
  const row = db.prepare(`
    SELECT 1 FROM ${APP_CONNECTIONS_TABLE}
    WHERE connection_type = 'cloud' AND cloud_revocation_pending = 1 AND cloud_user_id > 0
    LIMIT 1
  `).get()
  return Boolean(row)
}

export function listPendingCloudAppConnectionRevocations(): AppConnectionRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(APP_CONNECTIONS_TABLE))
      .map(connectionRowToRecord)
      .filter(connection => (
        connection.connection_type === 'cloud'
        && connection.cloud_revocation_pending === 1
        && connection.cloud_user_id > 0
      ))
  }
  const rows = db.prepare(`
    SELECT * FROM ${APP_CONNECTIONS_TABLE}
    WHERE connection_type = 'cloud' AND cloud_revocation_pending = 1 AND cloud_user_id > 0
  `).all() as unknown as StoredAppConnectionRow[]
  return rows.map(connectionRowToRecord)
}

export function markCloudAppConnectionRevocationSynced(deviceCode: string, cloudUserId: number): void {
  const normalized = String(deviceCode || '').trim()
  const normalizedCloudUserId = normalizeCloudUserId('cloud', cloudUserId)
  if (!normalized || !normalizedCloudUserId) return
  const db = getDb()
  if (!db) {
    for (const value of Object.values(jsonGetAll(APP_CONNECTIONS_TABLE))) {
      const connection = connectionRowToRecord(value)
      if (
        connection.device_code !== normalized
        || connection.connection_type !== 'cloud'
        || (connection.cloud_user_id !== normalizedCloudUserId && connection.cloud_user_id !== 0)
      ) continue
      jsonSet(APP_CONNECTIONS_TABLE, String(connection.id), { ...connection, cloud_revocation_pending: 0 } as any)
    }
    return
  }
  db.prepare(`
    UPDATE ${APP_CONNECTIONS_TABLE}
    SET cloud_revocation_pending = 0
    WHERE device_code = ? AND connection_type = 'cloud' AND cloud_user_id IN (0, ?)
  `).run(normalized, normalizedCloudUserId)
}
