import { randomUUID } from 'node:crypto'
import { getDb } from '../infrastructure/database'
import { initSessionStateTables } from '../infrastructure/database/session-state-schema'

function database() {
  const db = getDb()
  if (!db) throw new Error('Session read state requires SQLite')
  initSessionStateTables(db)
  return db
}

export interface SessionStateRecord {
  id: string
  profile: string
  source: string
  studio_user_id: string | null
  lastMessageId: number
  readMessageId: number
  lastAttentionId: number
  readAttentionId: number
  manualUnread: number
  unreadRevision: number
  /** The session incarnation (`sessions.generation_id`); a recreated or reset session gets a new one. */
  generation: string
}

export function listSessionStateRecords(userId: number, sessionId?: string): SessionStateRecord[] {
  const db = database()
  const records = db.prepare(`SELECT s.id, s.profile, s.source, s.studio_user_id, s.generation_id AS generation,
    COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.session_id=s.id AND m.role='assistant'),0) AS lastMessageId,
    COALESCE(r.message_id,0) AS readMessageId,
    COALESCE((SELECT MAX(a.id) FROM session_attention_events a WHERE a.session_id=s.id AND a.event_key NOT LIKE 'person-stage:%' AND a.event_key NOT LIKE 'person-flow-completed:%'),0) AS lastAttentionId,
    COALESCE(r.attention_id,0) AS readAttentionId,
    COALESCE(r.manual_unread,0) AS manualUnread, COALESCE(r.unread_revision,0) AS unreadRevision
    FROM sessions s LEFT JOIN session_read_state r ON r.session_id=s.id AND r.user_id=?
    WHERE s.id NOT LIKE 'person-task-%' AND s.source NOT IN ('group_chat','workflow','global_agent')
      AND (? IS NULL OR s.id=?)`)
    .all(userId, sessionId ?? null, sessionId ?? null) as unknown as SessionStateRecord[]
  // Like getSessionGeneration: assigned on first read, so clients can name the incarnation they saw.
  for (const record of records.filter(record => !record.generation)) {
    db.prepare("UPDATE sessions SET generation_id=? WHERE id=? AND generation_id=''").run(randomUUID(), record.id)
    record.generation = (db.prepare('SELECT generation_id FROM sessions WHERE id=?').get(record.id) as { generation_id: string }).generation_id
  }
  return records
}

/**
 * Never let a delayed device clear a message it has not observed or regress the cursor.
 * A manual unread mark is cleared only by a reader that opened exactly its revision.
 */
export function markSessionRead(userId: number, sessionId: string, messageId: number, attentionId = 0, unreadRevision: number | null = null): void {
  const db = database()
  db.prepare(`INSERT INTO session_read_state(user_id,session_id,message_id,attention_id)
    SELECT ?,s.id,MIN(?,COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.session_id=s.id AND m.role='assistant'),0)),
      MIN(?,COALESCE((SELECT MAX(a.id) FROM session_attention_events a WHERE a.session_id=s.id AND a.event_key NOT LIKE 'person-stage:%' AND a.event_key NOT LIKE 'person-flow-completed:%'),0))
    FROM sessions s WHERE s.id=?
    ON CONFLICT(user_id,session_id) DO UPDATE SET message_id=MAX(session_read_state.message_id,excluded.message_id),
      attention_id=MAX(session_read_state.attention_id,excluded.attention_id),
      manual_unread=CASE WHEN session_read_state.unread_revision=? THEN 0 ELSE session_read_state.manual_unread END`)
    .run(userId, messageId, attentionId, sessionId, unreadRevision)
}

/**
 * Applies only to the revision the caller observed, so a retried request cannot re-arm a mark
 * after a later read. Callers check the session generation first.
 */
export function markSessionUnread(userId: number, sessionId: string, expectedRevision: number): boolean {
  const result = database().prepare(`INSERT INTO session_read_state(user_id,session_id,manual_unread,unread_revision)
    SELECT ?,s.id,1,1 FROM sessions s WHERE s.id=?
      AND (?=0 OR EXISTS(SELECT 1 FROM session_read_state r WHERE r.user_id=? AND r.session_id=s.id))
    ON CONFLICT(user_id,session_id) DO UPDATE SET manual_unread=1, unread_revision=session_read_state.unread_revision+1
    WHERE session_read_state.manual_unread=0 AND session_read_state.unread_revision=?`)
    .run(userId, sessionId, expectedRevision, userId, expectedRevision)
  return Number(result.changes) > 0
}

/** Completion notices without a chat-message write still need a durable read receipt. */
export function recordSessionAttention(sessionId: string, eventKey: string): void {
  database().prepare(`INSERT OR IGNORE INTO session_attention_events(session_id,event_key)
    SELECT id,? FROM sessions WHERE id=?`).run(eventKey, sessionId)
}
