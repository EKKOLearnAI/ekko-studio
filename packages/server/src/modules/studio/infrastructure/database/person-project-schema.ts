import type { DatabaseSync } from 'node:sqlite'

export function initPersonProjectTables(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_projects (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, name TEXT NOT NULL,
      workspace TEXT NOT NULL, repository TEXT NOT NULL DEFAULT '', worktree_root TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_person_projects_owner ON person_projects(owner_user_id);
    CREATE TABLE IF NOT EXISTS person_role_configuration (
      session_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, project_id TEXT NOT NULL DEFAULT '',
      instructions TEXT NOT NULL DEFAULT '', allowed_agents_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS person_resource_claims (
      execution_id TEXT NOT NULL, resource TEXT NOT NULL, mode TEXT NOT NULL,
      PRIMARY KEY(execution_id,resource)
    );
    CREATE INDEX IF NOT EXISTS idx_person_resources ON person_resource_claims(resource);
    CREATE TABLE IF NOT EXISTS person_message_projects (
      message_id INTEGER PRIMARY KEY, owner_user_id INTEGER NOT NULL, project_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_message_project ON person_message_projects(owner_user_id,project_id,message_id);
  `)
  if (!db.prepare('PRAGMA table_info(person_schedules)').all().some(column => column.name === 'project_id'))
    db.exec("ALTER TABLE person_schedules ADD COLUMN project_id TEXT NOT NULL DEFAULT ''")
  const columns = db.prepare('PRAGMA table_info(person_flows)').all()
  for (const [name, definition] of Object.entries({ project_id: "TEXT NOT NULL DEFAULT ''", kind: "TEXT NOT NULL DEFAULT 'business'" })) {
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE person_flows ADD COLUMN ${name} ${definition}`)
  }
}

export function initPersonProjectTriggers(db: DatabaseSync) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()) db.exec(`
    CREATE TRIGGER IF NOT EXISTS person_message_project_delete AFTER DELETE ON messages BEGIN
      DELETE FROM person_message_projects WHERE message_id=OLD.id;
    END;
  `)
  db.exec(`CREATE TRIGGER IF NOT EXISTS person_role_delete AFTER DELETE ON sessions BEGIN
    DELETE FROM person_role_configuration WHERE session_id=OLD.id;
  END;`)
}
