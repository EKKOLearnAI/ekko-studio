import { getDb } from '../infrastructure/database'
import { SESSION_NOTICE_PUBLISHERS_TABLE } from '../infrastructure/database/schemas'

export interface SessionNoticePublisherRecord {
  id: string
  token_hash: string
  owner_user_id: number
  namespace: string
  profile: string
  session_id: string
  session_generation: string
  sources: string[]
  label: string
  created_at: number
  expires_at: number
  revoked_at: number | null
  last_used_at: number | null
}

/** A grant without its secret hash, as returned to its owner. */
export type PublicSessionNoticePublisher = Omit<SessionNoticePublisherRecord, 'token_hash' | 'owner_user_id'>

function db() {
  const value = getDb()
  if (!value) throw new Error('Session notice publishers require SQLite')
  return value
}

function decode(row: any): SessionNoticePublisherRecord | null {
  if (!row) return null
  return { ...row, owner_user_id: Number(row.owner_user_id), sources: JSON.parse(row.sources) }
}

export const sessionNoticePublishersStore = {
  insert(record: SessionNoticePublisherRecord): void {
    db().prepare(`INSERT INTO ${SESSION_NOTICE_PUBLISHERS_TABLE} (id, token_hash, owner_user_id, namespace, profile, session_id,
      session_generation, sources, label, created_at, expires_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.token_hash, record.owner_user_id, record.namespace, record.profile, record.session_id,
        record.session_generation, JSON.stringify(record.sources), record.label, record.created_at, record.expires_at,
        record.revoked_at, record.last_used_at)
  },
  findByHash(tokenHash: string): SessionNoticePublisherRecord | null {
    return decode(db().prepare(`SELECT * FROM ${SESSION_NOTICE_PUBLISHERS_TABLE} WHERE token_hash = ?`).get(tokenHash))
  },
  listForOwner(ownerUserId: number, sessionId: string): SessionNoticePublisherRecord[] {
    return (db().prepare(`SELECT * FROM ${SESSION_NOTICE_PUBLISHERS_TABLE} WHERE owner_user_id = ? AND session_id = ?
      ORDER BY created_at DESC, id`).all(ownerUserId, sessionId) as any[]).map(row => decode(row)!)
  },
  revoke(ownerUserId: number, sessionId: string, id: string, now: number): boolean {
    return Number(db().prepare(`UPDATE ${SESSION_NOTICE_PUBLISHERS_TABLE} SET revoked_at = ?
      WHERE id = ? AND owner_user_id = ? AND session_id = ? AND revoked_at IS NULL`).run(now, id, ownerUserId, sessionId).changes) === 1
  },
  touch(id: string, now: number): void {
    db().prepare(`UPDATE ${SESSION_NOTICE_PUBLISHERS_TABLE} SET last_used_at = ? WHERE id = ?`).run(now, id)
  },
}
