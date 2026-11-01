import type { DatabaseSync } from 'node:sqlite'
import { initPersonContextTables } from './person-context-schema'
import { initPersonStageTables } from './person-stage-schema'
import { initPersonProjectTables } from './person-project-schema'

/** Models and goals belong to a conversation; memory and execution presets belong to the account. */
export function initPersonTables(db: DatabaseSync): void {
  // Person has not shipped. Discard the former worker-only schedules instead of
  // carrying a second scheduling contract or guessing a new execution mode.
  const scheduleColumns = db.prepare('PRAGMA table_info(person_schedules)').all()
  if (scheduleColumns.length && !scheduleColumns.some(column => column.name === 'mode')) {
    db.exec('DROP TABLE IF EXISTS person_occurrences; DROP TABLE person_schedules;')
    db.exec("DELETE FROM person_operations WHERE operation_key LIKE 'schedule:%'")
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_person_goals ON session_tasks(owner_user_id, bot_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_person_session_goals ON session_tasks(owner_user_id, bot_id, session_id, updated_at, id);
    CREATE TABLE IF NOT EXISTS person_accounts (
      user_id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS person_conversation_settings (
      session_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, settings_json TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_person_execution_session ON person_executions(session_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_person_task_state ON person_executions(owner_user_id, task_id, state);
    CREATE INDEX IF NOT EXISTS idx_person_execution_order ON person_executions(owner_user_id, task_id,
      CASE WHEN state IN ('finished','failed','interrupted') THEN 2 WHEN state='pending' THEN 1 ELSE 0 END, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_person_conversation_latest ON person_executions(session_id, owner_user_id, task_id, created_at);
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
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, mode TEXT NOT NULL,
      task_id TEXT, session_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
      kind TEXT NOT NULL, expression TEXT NOT NULL, timezone TEXT NOT NULL, next_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', revision INTEGER NOT NULL DEFAULT 0,
      misfire TEXT NOT NULL DEFAULT 'skip', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_occurrences (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, revision INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
      state TEXT NOT NULL, execution_id TEXT, flow_id TEXT, UNIQUE(schedule_id, revision, scheduled_at)
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
  const executionColumns = db.prepare('PRAGMA table_info(person_executions)').all()
  for (const [name, definition] of Object.entries({
    queue_priority: 'INTEGER NOT NULL DEFAULT 0',
    insertion_queue_id: "TEXT NOT NULL DEFAULT ''",
    insertion_phase: "TEXT NOT NULL DEFAULT ''",
    insertion_error: "TEXT NOT NULL DEFAULT ''",
  })) {
    if (!executionColumns.some(column => column.name === name)) db.exec(`ALTER TABLE person_executions ADD COLUMN ${name} ${definition}`)
  }
  initPersonContextTables(db)
  initPersonStageTables(db)
  initPersonProjectTables(db)
  // Discard account-wide model choices; never copy them into conversations.
  db.exec(`UPDATE person_accounts
    SET settings_json=json_remove(settings_json,'$.model','$.reasoningEffort','$.contextTokens'),revision=revision+1
    WHERE json_type(settings_json,'$.model') IS NOT NULL
      OR json_type(settings_json,'$.reasoningEffort') IS NOT NULL
      OR json_type(settings_json,'$.contextTokens') IS NOT NULL`)
  // Discard obsolete account-only tasks. There is no implicit reassignment or migration.
  if (db.prepare('PRAGMA table_info(session_tasks)').all().some(column => column.name === 'session_id')) {
    const obsolete = db.prepare("SELECT id FROM session_tasks WHERE owner_user_id IS NOT NULL AND bot_id LIKE 'person:%' AND session_id IS NULL").all()
    for (const task of obsolete) {
      const workers = db.prepare('SELECT DISTINCT session_id FROM person_executions WHERE task_id=?').all(task.id)
      db.prepare("DELETE FROM person_operations WHERE json_extract(result_json,'$.task.id')=? OR json_extract(result_json,'$.task_id')=?").run(task.id, task.id)
      db.prepare('DELETE FROM person_occurrences WHERE schedule_id IN (SELECT id FROM person_schedules WHERE task_id=?)').run(task.id)
      for (const table of ['person_task_returns', 'person_deliveries', 'person_events'])
        db.prepare(`DELETE FROM ${table} WHERE execution_id IN (SELECT id FROM person_executions WHERE task_id=?)`).run(task.id)
      for (const table of ['person_interactions', 'person_schedules', 'person_task_origins', 'person_executions'])
        db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(task.id)
      for (const worker of workers) {
        for (const table of ['messages', 'task_plans', 'chat_compression_snapshots', 'run_usage', 'session_uploads', 'workspace_run_change_files', 'workspace_run_changes']) {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(worker.session_id)
        }
        db.prepare('DELETE FROM session_tasks WHERE session_id=?').run(worker.session_id)
        db.prepare('DELETE FROM sessions WHERE id=?').run(worker.session_id)
      }
      db.prepare('DELETE FROM session_tasks WHERE id=?').run(task.id)
    }
  }
}
