import type { DatabaseSync } from 'node:sqlite'

const initialized = new WeakSet<DatabaseSync>()
export function initSessionStateTables(db: DatabaseSync) {
  if (initialized.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS session_attention_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, event_key TEXT NOT NULL,
    UNIQUE(session_id,event_key),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS session_read_state (
    user_id INTEGER NOT NULL, session_id TEXT NOT NULL,
    message_id INTEGER NOT NULL DEFAULT 0, attention_id INTEGER NOT NULL DEFAULT 0,
    manual_unread INTEGER NOT NULL DEFAULT 0, unread_revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(user_id,session_id),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`)
  const columns = new Set(db.prepare('PRAGMA table_info(session_read_state)').all().map(column => column.name))
  for (const column of ['attention_id', 'manual_unread', 'unread_revision']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE session_read_state ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
  }
  initialized.add(db)
}
