import { getDb } from '../infrastructure/database'
import { SESSION_SHARES_TABLE } from '../infrastructure/database/schemas'
import { SessionShareError, type SessionShareRecord, type SessionShareAppUser } from '../contracts/session-shares'

function db() {
  const value = getDb()
  // Claiming an invitation needs an atomic compare-and-set. Never emulate it
  // with the read/modify/write JSON fallback.
  if (!value) throw new SessionShareError('share_storage_unavailable', 503)
  return value
}

function decode(row: any): SessionShareRecord | null {
  if (!row) return null
  return { ...row, permissions: JSON.parse(row.permissions), extra_paths: JSON.parse(row.extra_paths) }
}

export const sessionSharesStore = {
  insert(record: SessionShareRecord): void {
    const columns = Object.keys(record)
    const stored = { ...record, permissions: JSON.stringify(record.permissions), extra_paths: JSON.stringify(record.extra_paths) }
    db().prepare(`INSERT INTO ${SESSION_SHARES_TABLE} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...columns.map(key => stored[key as keyof typeof stored]))
  },
  find(id: string): SessionShareRecord | null {
    return decode(db().prepare(`SELECT * FROM ${SESSION_SHARES_TABLE} WHERE id = ?`).get(id))
  },
  findByHash(hash: string): SessionShareRecord | null {
    return decode(db().prepare(`SELECT * FROM ${SESSION_SHARES_TABLE} WHERE token_hash = ?`).get(hash))
  },
  list(sessionId: string, appUserId: number): SessionShareRecord[] {
    return db().prepare(`SELECT * FROM ${SESSION_SHARES_TABLE} WHERE session_id = ? AND sharer_app_user_id = ? ORDER BY created_at DESC, id`)
      .all(sessionId, appUserId).map(row => decode(row)!)
  },
  claim(id: string, actor: SessionShareAppUser, now: number): SessionShareRecord | null {
    db().prepare(`UPDATE ${SESSION_SHARES_TABLE} SET recipient_app_user_id = ?, recipient_name_snapshot = ?,
      claimed_at = ?, updated_at = ?, policy_version = policy_version + 1
      WHERE id = ? AND recipient_app_user_id IS NULL AND revoked_at IS NULL AND expires_at > ?`)
      .run(actor.id, actor.name, now, now, id, now)
    return this.find(id)
  },
  update(record: SessionShareRecord, expectedVersion: number): boolean {
    return Number(db().prepare(`UPDATE ${SESSION_SHARES_TABLE} SET permissions = ?, extra_paths = ?,
      updated_at = ?, revoked_at = ?, policy_version = policy_version + 1
      WHERE id = ? AND policy_version = ? AND revoked_at IS NULL`)
      .run(JSON.stringify(record.permissions), JSON.stringify(record.extra_paths), record.updated_at,
        record.revoked_at, record.id, expectedVersion).changes) === 1
  },
}
