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
    CREATE TABLE IF NOT EXISTS person_stage_results (
      stage_id TEXT NOT NULL, round_number INTEGER NOT NULL, result_message_id INTEGER NOT NULL,
      PRIMARY KEY(stage_id,round_number),
      FOREIGN KEY(stage_id) REFERENCES person_stages(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS person_stage_confirmations (
      stage_id TEXT NOT NULL, generation INTEGER NOT NULL, run_id TEXT NOT NULL,
      message_id INTEGER, source_hash TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'running',
      attempts INTEGER NOT NULL DEFAULT 0, claim TEXT NOT NULL DEFAULT '',
      lease_until INTEGER NOT NULL DEFAULT 0, decision_pending INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY(stage_id,generation),
      FOREIGN KEY(stage_id) REFERENCES person_stages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_person_stage_confirmations_pending ON person_stage_confirmations(state,updated_at);
  `)
  if (!db.prepare('PRAGMA table_info(person_stage_confirmations)').all().some(column => column.name === 'source_hash'))
    db.exec("ALTER TABLE person_stage_confirmations ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''")
  const columns = new Set(db.prepare('PRAGMA table_info(person_flows)').all().map(column => column.name))
  for (const [name, value] of [['round_limit',1],['round_number',1],['round_generation',0]] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE person_flows ADD COLUMN ${name} INTEGER NOT NULL DEFAULT ${value}`)
  }
  if (!db.prepare('PRAGMA table_info(person_stages)').all().some(column => column.name === 'group_position')) {
    db.exec('ALTER TABLE person_stages ADD COLUMN group_position INTEGER NOT NULL DEFAULT 0; UPDATE person_stages SET group_position=position;')
  }
}
