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
}

export function listSessionStateRecords(userId: number, sessionId?: string): SessionStateRecord[] {
  return database().prepare(`SELECT s.id, s.profile, s.source, s.studio_user_id,
    COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.session_id=s.id AND m.role='assistant'),0) AS lastMessageId,
    COALESCE(r.message_id,0) AS readMessageId,
    COALESCE((SELECT MAX(a.id) FROM session_attention_events a WHERE a.session_id=s.id AND a.event_key NOT LIKE 'person-stage:%'),0) AS lastAttentionId,
    COALESCE(r.attention_id,0) AS readAttentionId
    FROM sessions s LEFT JOIN session_read_state r ON r.session_id=s.id AND r.user_id=?
    WHERE s.id NOT LIKE 'person-task-%' AND s.source NOT IN ('group_chat','workflow','global_agent')
      AND (? IS NULL OR s.id=?)`)
    .all(userId, sessionId ?? null, sessionId ?? null) as unknown as SessionStateRecord[]
}

/** Never let a delayed device clear a message it has not observed or regress the cursor. */
export function markSessionRead(userId: number, sessionId: string, messageId: number, attentionId = 0): void {
  const db = database()
  db.prepare(`INSERT INTO session_read_state(user_id,session_id,message_id,attention_id)
    SELECT ?,s.id,MIN(?,COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.session_id=s.id AND m.role='assistant'),0)),
      MIN(?,COALESCE((SELECT MAX(a.id) FROM session_attention_events a WHERE a.session_id=s.id AND a.event_key NOT LIKE 'person-stage:%'),0))
    FROM sessions s WHERE s.id=?
    ON CONFLICT(user_id,session_id) DO UPDATE SET message_id=MAX(session_read_state.message_id,excluded.message_id),
      attention_id=MAX(session_read_state.attention_id,excluded.attention_id)`)
    .run(userId, messageId, attentionId, sessionId)
}

/** Completion notices without a chat-message write still need a durable read receipt. */
export function recordSessionAttention(sessionId: string, eventKey: string): void {
  database().prepare(`INSERT OR IGNORE INTO session_attention_events(session_id,event_key)
    SELECT id,? FROM sessions WHERE id=?`).run(eventKey, sessionId)
}
