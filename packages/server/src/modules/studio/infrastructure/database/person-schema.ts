import type { DatabaseSync } from 'node:sqlite'
import { initPersonContextTables } from './person-context-schema'

/** Account-owned goals share session_tasks, but do not depend on a chat's lifetime. */
export function initPersonTables(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_person_goals ON session_tasks(owner_user_id, bot_id, updated_at);
    CREATE TABLE IF NOT EXISTS person_accounts (
      user_id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS person_presence (
      user_id INTEGER PRIMARY KEY, last_activity_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_presence_feedback (
      user_id INTEGER PRIMARY KEY, event_id TEXT NOT NULL, state TEXT NOT NULL,
      started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    DROP TABLE IF EXISTS person_memories;
    CREATE TABLE IF NOT EXISTS person_executions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, owner_user_id INTEGER NOT NULL, requirements_revision INTEGER NOT NULL,
      state TEXT NOT NULL, session_id TEXT NOT NULL, selection_json TEXT NOT NULL,
      input_json TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, occurrence_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_person_runs ON person_executions(owner_user_id, task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_person_presence_runs ON person_executions(owner_user_id)
      WHERE state IN ('starting','running','stopping');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_person_active_run ON person_executions(task_id)
      WHERE state IN ('queued','starting','stopping','running','waiting_person','waiting_user','waiting_approval');
    CREATE TABLE IF NOT EXISTS person_interactions (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, task_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      native_id TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL, choices_json TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'pending', answer TEXT NOT NULL DEFAULT '', answered_by TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(execution_id, native_id)
    );
    CREATE TABLE IF NOT EXISTS person_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL, execution_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_events ON person_events(owner_user_id, execution_id, id);
    CREATE TABLE IF NOT EXISTS person_schedules (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, task_id TEXT NOT NULL,
      kind TEXT NOT NULL, expression TEXT NOT NULL, timezone TEXT NOT NULL, next_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0,
      misfire TEXT NOT NULL DEFAULT 'skip', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_occurrences (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, revision INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
      state TEXT NOT NULL, execution_id TEXT, UNIQUE(schedule_id, revision, scheduled_at)
    );
    CREATE TABLE IF NOT EXISTS person_operations (
      owner_user_id INTEGER NOT NULL, operation_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL, PRIMARY KEY(owner_user_id, operation_key)
    );
    CREATE TABLE IF NOT EXISTS person_task_origins (
      task_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, origin_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_deliveries (
      execution_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, origin_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting', updated_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS person_task_returns (
      session_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
      execution_id TEXT NOT NULL, owner_user_id INTEGER NOT NULL,
      title TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(session_id, assistant_message_id)
    );
  `)
  initPersonContextTables(db)
}
