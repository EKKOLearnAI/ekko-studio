import type { DatabaseSync } from 'node:sqlite'

/** Additive schema; the triggers cover every application completion writer, including session goals. */
export function initPersonAcceptanceTables(db: DatabaseSync) {
  db.exec('SAVEPOINT person_acceptance_schema')
  try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_acceptance (
      execution_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL,
      snapshot_json TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, deadline INTEGER NOT NULL DEFAULT 0,
      active_session_id TEXT NOT NULL DEFAULT '', worker_output TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_acceptance_task ON person_acceptance(task_id);
    CREATE TABLE IF NOT EXISTS person_acceptance_attempts (
      id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      session_id TEXT NOT NULL UNIQUE, selection_json TEXT NOT NULL, run_id TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL, report_json TEXT NOT NULL DEFAULT '', raw_output TEXT NOT NULL DEFAULT '',
      evidence_json TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(execution_id,ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_person_verifier_run ON person_acceptance_attempts(run_id) WHERE run_id!='';
    CREATE TABLE IF NOT EXISTS person_acceptance_tasks (
      development_task_id TEXT PRIMARY KEY, verification_task_id TEXT NOT NULL UNIQUE
    );
  `)
  for (const [table,column,definition] of [
    ['person_acceptance','orchestration',"TEXT NOT NULL DEFAULT 'legacy'"],
    ['person_acceptance','cycle_id',"TEXT NOT NULL DEFAULT ''"],
    ['person_acceptance_attempts','verification_execution_id',"TEXT NOT NULL DEFAULT ''"],
    ['person_acceptance_attempts','report_protocol',"TEXT NOT NULL DEFAULT 'agent_json'"],
    ['person_acceptance_attempts','decision_json',"TEXT NOT NULL DEFAULT ''"],
    ['person_acceptance_attempts','decision_attempts',"INTEGER NOT NULL DEFAULT 0"],
  ]) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row=>row.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  db.exec(`
    DROP TRIGGER IF EXISTS person_acceptance_execution_gate;
    DROP VIEW IF EXISTS person_acceptance_passes;
    CREATE VIEW person_acceptance_passes AS
      SELECT a.execution_id,a.task_id FROM person_acceptance a
      JOIN person_acceptance_attempts v ON v.execution_id=a.execution_id AND v.ordinal=a.attempt
      WHERE a.state='passed' AND v.state='passed' AND v.run_id!=''
        AND (v.report_protocol='agent_json' OR (v.report_protocol='bot_review' AND CASE WHEN json_valid(v.decision_json) THEN
          json_extract(v.decision_json,'$.verification_execution_id')=v.verification_execution_id
          AND json_extract(v.decision_json,'$.session_id')=COALESCE(json_extract(a.snapshot_json,'$.requirements.acceptance.reviewer_session_id'),(SELECT session_id FROM session_tasks WHERE id=a.task_id))
        ELSE 0 END))
        AND (a.orchestration='legacy' OR EXISTS (
          SELECT 1 FROM person_executions e JOIN session_tasks t ON t.id=e.task_id
          JOIN person_acceptance_tasks l ON l.verification_task_id=t.id AND l.development_task_id=a.task_id
          WHERE e.id=v.verification_execution_id AND e.state='finished' AND e.session_id=v.session_id
            AND e.owner_user_id=(SELECT owner_user_id FROM person_executions WHERE id=a.execution_id)
        ))
        AND CASE WHEN json_valid(v.report_json) AND json_valid(v.evidence_json) THEN
          json_extract(v.report_json,'$.verdict')='passed'
          AND json_array_length(v.report_json,'$.checks')>0
          AND json_type(v.report_json,'$.checks')='array'
          AND json_array_length(v.report_json,'$.checks')=json_array_length(a.snapshot_json,'$.requirements.acceptance.criteria')
          AND json_array_length(v.evidence_json)>=json_array_length(v.report_json,'$.checks')
          AND NOT EXISTS(SELECT 1 FROM json_each(v.report_json,'$.checks') c
            WHERE COALESCE(json_extract(c.value,'$.status'),'')!='passed' OR COALESCE(json_array_length(c.value,'$.evidence'),0)<1)
          AND NOT EXISTS(SELECT 1 FROM json_each(v.report_json,'$.checks') c JOIN json_each(c.value,'$.issues') i WHERE json_extract(i.value,'$.disposition')='repair')
          AND (v.report_protocol='agent_json' OR CASE WHEN json_valid(v.decision_json) THEN COALESCE(json_extract(v.decision_json,'$.version'),1)<2 OR NOT EXISTS(
            SELECT 1 FROM json_each(v.report_json,'$.checks') c WHERE COALESCE(json_type(c.value,'$.issues'),'')!='array') ELSE 0 END)
        ELSE 0 END;
    CREATE TRIGGER IF NOT EXISTS person_acceptance_execution_gate
    BEFORE UPDATE OF state ON person_executions
    WHEN NEW.state='finished' AND COALESCE((SELECT orchestration FROM person_acceptance WHERE execution_id=NEW.id),'legacy')!='bot_tasks' AND EXISTS (
      SELECT 1 FROM session_tasks t WHERE t.id=NEW.task_id AND json_extract(t.requirements_json,'$.acceptance.enabled')=1
    ) AND NOT EXISTS (SELECT 1 FROM person_acceptance_passes a WHERE a.execution_id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'Acceptance must pass before execution completion'); END;
    CREATE TRIGGER IF NOT EXISTS person_acceptance_task_gate
    BEFORE UPDATE OF status ON session_tasks
    WHEN NEW.status='completed' AND json_extract(NEW.requirements_json,'$.acceptance.enabled')=1 AND (
      NOT EXISTS (
        SELECT 1 FROM person_executions e JOIN person_acceptance_passes a ON a.execution_id=e.id
        WHERE e.task_id=NEW.id AND e.requirements_revision=NEW.requirements_revision AND e.state='finished'
        AND e.rowid=(SELECT MAX(last.rowid) FROM person_executions last WHERE last.task_id=NEW.id)
      ) OR EXISTS (SELECT 1 FROM person_executions e WHERE e.task_id=NEW.id
        AND e.state IN ('pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'))
    ) BEGIN SELECT RAISE(ABORT,'Acceptance must pass before task completion'); END;
    CREATE TRIGGER IF NOT EXISTS person_verification_task_gate
    BEFORE UPDATE OF status ON session_tasks
    WHEN NEW.status='completed' AND json_extract(NEW.requirements_json,'$.verification_for.task_id') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM person_acceptance_passes a JOIN person_acceptance_attempts v ON v.execution_id=a.execution_id
        JOIN person_executions e ON e.id=v.verification_execution_id
        WHERE e.task_id=NEW.id AND e.rowid=(SELECT MAX(rowid) FROM person_executions WHERE task_id=NEW.id)
          AND a.task_id=json_extract(NEW.requirements_json,'$.verification_for.task_id')
      )
    BEGIN SELECT RAISE(ABORT,'Independent verification must pass before its task completes'); END;
  `)
  db.exec('RELEASE person_acceptance_schema')
  } catch(error) {db.exec('ROLLBACK TO person_acceptance_schema; RELEASE person_acceptance_schema');throw error}
}
