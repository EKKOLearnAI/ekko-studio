import type { DatabaseSync } from 'node:sqlite'

export function initPersonStageTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_flows (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, creator_session_id TEXT NOT NULL,
      title TEXT NOT NULL, goal TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
      current_position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_flows_owner ON person_flows(owner_user_id,updated_at);
    CREATE TABLE IF NOT EXISTS person_stages (
      id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, position INTEGER NOT NULL, group_position INTEGER NOT NULL DEFAULT 0, session_id TEXT NOT NULL,
      goal TEXT NOT NULL, return_expectation TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      result_message_id INTEGER, completion_run_id TEXT NOT NULL DEFAULT '', UNIQUE(flow_id,position)
    );
    CREATE TABLE IF NOT EXISTS person_stage_tasks (
      task_id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, generation INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS person_stage_deliveries (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, flow_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL, UNIQUE(stage_id,generation)
    );
    CREATE INDEX IF NOT EXISTS idx_person_stage_session ON person_stages(session_id,flow_id);
    CREATE INDEX IF NOT EXISTS idx_person_stage_tasks_stage ON person_stage_tasks(stage_id);
    CREATE INDEX IF NOT EXISTS idx_person_stage_delivery_pending ON person_stage_deliveries(state,updated_at);
  `)
  if (!db.prepare('PRAGMA table_info(person_stages)').all().some(column => column.name === 'group_position')) {
    db.exec('ALTER TABLE person_stages ADD COLUMN group_position INTEGER NOT NULL DEFAULT 0; UPDATE person_stages SET group_position=position;')
  }
}
