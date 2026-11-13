import { getDb } from '../infrastructure/database'
import {
  PROVIDER_AUDIT_INDEXES,
  PROVIDER_AUDIT_SCHEMA,
  PROVIDER_AUDIT_TABLE,
  syncTable,
} from '../infrastructure/database/schemas'

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const MAX_EVENTS = 10_000
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|credential)/i

export interface ProviderAuditActor {
  id?: number
  username?: string
  role?: string
}

export interface ProviderAuditEventInput {
  actor?: ProviderAuditActor
  profile: string
  providerId: string
  providerLabel?: string
  action: string
  fields?: string[]
  result?: 'success' | 'failed' | 'conflict'
  details?: Record<string, unknown>
  revisionBefore?: string
  revisionAfter?: string
  createdAt?: number
}

export interface ProviderAuditEvent {
  id: number
  created_at: number
  actor_user_id: number | null
  actor_username: string
  actor_role: string
  profile: string
  provider_id: string
  provider_label: string
  action: string
  fields: string[]
  result: string
  details: Record<string, unknown>
  revision_before: string
  revision_after: string
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, value.endsWith('/') ? '/' : '')
  } catch {
    return value
  }
}

export function sanitizeProviderAuditValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY_PATTERN.test(key)) return '[redacted]'
  if (Array.isArray(value)) return value.map(item => sanitizeProviderAuditValue(item))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      output[childKey] = sanitizeProviderAuditValue(childValue, childKey)
    }
    return output
  }
  if (typeof value === 'string' && /url/i.test(key)) return sanitizeUrl(value)
  return value
}

function ensureProviderAuditTable(): void {
  syncTable(PROVIDER_AUDIT_TABLE, PROVIDER_AUDIT_SCHEMA, {
    indexes: PROVIDER_AUDIT_INDEXES,
  })
}

function pruneProviderAuditEvents(now: number): void {
  ensureProviderAuditTable()
  const db = getDb()
  if (!db) return
  db.prepare(`DELETE FROM ${PROVIDER_AUDIT_TABLE} WHERE created_at < ?`).run(now - RETENTION_MS)
  db.prepare(
    `DELETE FROM ${PROVIDER_AUDIT_TABLE} WHERE id NOT IN (` +
    `SELECT id FROM ${PROVIDER_AUDIT_TABLE} ORDER BY created_at DESC, id DESC LIMIT ?` +
    `)`,
  ).run(MAX_EVENTS)
}

export function appendProviderAuditEvent(input: ProviderAuditEventInput): void {
  ensureProviderAuditTable()
  const db = getDb()
  if (!db) return
  const createdAt = input.createdAt ?? Date.now()
  const details = sanitizeProviderAuditValue(input.details || {}) as Record<string, unknown>
  db.prepare(
    `INSERT INTO ${PROVIDER_AUDIT_TABLE} (` +
    `created_at, actor_user_id, actor_username, actor_role, profile, provider_id, provider_label, ` +
    `action, fields_json, result, details_json, revision_before, revision_after` +
    `) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    createdAt,
    input.actor?.id ?? null,
    input.actor?.username || '',
    input.actor?.role || '',
    input.profile || 'default',
    input.providerId,
    input.providerLabel || '',
    input.action,
    JSON.stringify(input.fields || []),
    input.result || 'success',
    JSON.stringify(details),
    input.revisionBefore || '',
    input.revisionAfter || '',
  )
  pruneProviderAuditEvents(createdAt)
}

export function listProviderAuditEvents(options: {
  profile?: string
  providerId?: string
  limit?: number
} = {}): ProviderAuditEvent[] {
  ensureProviderAuditTable()
  const db = getDb()
  if (!db) return []
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.profile) {
    where.push('profile = ?')
    params.push(options.profile)
  }
  if (options.providerId) {
    where.push('provider_id = ?')
    params.push(options.providerId)
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit || 100), 1), 500)
  params.push(limit)
  const rows = db.prepare(
    `SELECT * FROM ${PROVIDER_AUDIT_TABLE}` +
    `${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
    `ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...params) as Array<Record<string, any>>

  return rows.map(row => ({
    id: Number(row.id),
    created_at: Number(row.created_at),
    actor_user_id: row.actor_user_id == null ? null : Number(row.actor_user_id),
    actor_username: String(row.actor_username || ''),
    actor_role: String(row.actor_role || ''),
    profile: String(row.profile || 'default'),
    provider_id: String(row.provider_id || ''),
    provider_label: String(row.provider_label || ''),
    action: String(row.action || ''),
    fields: JSON.parse(String(row.fields_json || '[]')),
    result: String(row.result || ''),
    details: JSON.parse(String(row.details_json || '{}')),
    revision_before: String(row.revision_before || ''),
    revision_after: String(row.revision_after || ''),
  }))
}
