import type { DatabaseSync } from 'node:sqlite'

/** Derived Person data only. No triggers, columns or writes on shared chat tables. */
export function initPersonContextTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_context_progress (
      session_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL,
      history_revision INTEGER NOT NULL, message_id INTEGER NOT NULL DEFAULT 0,
      source_offset INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS person_context_chunks (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL,
      message_id INTEGER NOT NULL, source_offset INTEGER NOT NULL,
      content TEXT NOT NULL, terms TEXT NOT NULL,
      UNIQUE(session_id, message_id, source_offset)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS person_context_search USING fts5(
      scope, terms, content='person_context_chunks', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS person_context_chunks_insert AFTER INSERT ON person_context_chunks BEGIN
      INSERT INTO person_context_search(rowid,scope,terms) VALUES(new.id,new.scope,new.terms);
    END;
    CREATE TRIGGER IF NOT EXISTS person_context_chunks_delete AFTER DELETE ON person_context_chunks BEGIN
      INSERT INTO person_context_search(person_context_search,rowid,scope,terms) VALUES('delete',old.id,old.scope,old.terms);
    END;
    CREATE TABLE IF NOT EXISTS person_context_summaries (
      session_id TEXT NOT NULL, history_revision INTEGER NOT NULL, cache_key TEXT NOT NULL,
      summary TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,history_revision,cache_key)
    );
  `)
}
