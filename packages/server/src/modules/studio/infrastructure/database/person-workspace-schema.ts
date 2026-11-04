import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { getWebUiHome } from '../../public/config'

/** Preserve legacy bindings without moving files or changing historical directories. */
export function initPersonWorkspaceBindings(db: DatabaseSync) {
  db.exec('SAVEPOINT person_workspace_bindings')
  try {
    migrateBindings(db)
    db.exec('RELEASE person_workspace_bindings')
  } catch (error) {
    db.exec('ROLLBACK TO person_workspace_bindings; RELEASE person_workspace_bindings')
    throw error
  }
}

function migrateBindings(db: DatabaseSync) {
  const conversations = db.prepare(`SELECT s.id,s.studio_user_id,s.workspace,a.settings_json AS account_settings,
    c.settings_json AS conversation_settings FROM sessions s
    LEFT JOIN person_accounts a ON a.user_id=CAST(s.studio_user_id AS INTEGER)
    LEFT JOIN person_conversation_settings c ON c.session_id=s.id
    WHERE s.id LIKE 'person-main-%'`).all()
  for (const row of conversations) {
    const userId = Number(row.studio_user_id)
    if (!Number.isSafeInteger(userId) || userId < 1) continue
    const local = JSON.parse(String(row.conversation_settings || '{}'))
    if (Object.hasOwn(local, 'workspace')) continue
    const account = JSON.parse(String(row.account_settings || '{}'))
    local.workspace = String(row.workspace || account.workspace || join(getWebUiHome(), 'person', String(userId), 'workspace'))
    db.prepare(`INSERT INTO person_conversation_settings VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET settings_json=excluded.settings_json`).run(row.id, userId, JSON.stringify(local))
  }
  if (!db.prepare('PRAGMA table_info(person_executions)').all().some(row => row.name === 'workspace')) {
    db.exec(`ALTER TABLE person_executions ADD COLUMN workspace TEXT NOT NULL DEFAULT '';
      UPDATE person_executions SET workspace=COALESCE(
        (SELECT NULLIF(s.workspace,'') FROM sessions s WHERE s.id=person_executions.session_id),
        (SELECT t.workspace FROM session_tasks t WHERE t.id=person_executions.task_id),'');`)
  }
  if (!db.prepare('PRAGMA table_info(person_flows)').all().some(row => row.name === 'workspace')) {
    db.exec(`ALTER TABLE person_flows ADD COLUMN workspace TEXT NOT NULL DEFAULT '';
      UPDATE person_flows SET workspace=COALESCE(
        (SELECT json_extract(c.settings_json,'$.workspace') FROM person_conversation_settings c WHERE c.session_id=person_flows.creator_session_id),'');`)
  }
}
