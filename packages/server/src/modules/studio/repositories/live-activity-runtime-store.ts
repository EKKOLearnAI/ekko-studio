import { getDb } from '../infrastructure/database'

export interface LiveActivityRunRecord {
  run_key: string; destination_id: string; activity_ref: string; revision: number; started: number; terminal: number
  title: string; completed: number; total: number; updated_at: number
}
const initialized = new WeakSet<object>()
function database() {
  const db = getDb(); if (!db) throw new Error('live_activity_storage_unavailable')
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS live_activity_runs (
      run_key TEXT PRIMARY KEY, destination_id TEXT NOT NULL, activity_ref TEXT NOT NULL,
      revision INTEGER NOT NULL, started INTEGER NOT NULL, terminal INTEGER NOT NULL,
      title TEXT NOT NULL, completed INTEGER NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS live_activity_runs_destination ON live_activity_runs(destination_id, terminal);
    CREATE TABLE IF NOT EXISTS live_activity_start_budget (
      destination_id TEXT PRIMARY KEY, last_start_at INTEGER NOT NULL
    );`)
    initialized.add(db)
  }
  return db
}
export function getLiveActivityRun(key: string): LiveActivityRunRecord | null {
  if (!getDb()) return null
  return database().prepare('SELECT * FROM live_activity_runs WHERE run_key=?').get(key) as unknown as LiveActivityRunRecord || null
}
export function listActiveLiveActivityRuns(destinationId: string): LiveActivityRunRecord[] {
  if (!getDb()) return []
  return database().prepare('SELECT * FROM live_activity_runs WHERE destination_id=? AND started=1 AND terminal=0')
    .all(destinationId) as unknown as LiveActivityRunRecord[]
}
export function saveLiveActivityRun(value: LiveActivityRunRecord): void {
  database().prepare(`INSERT INTO live_activity_runs
    (run_key,destination_id,activity_ref,revision,started,terminal,title,completed,total,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_key) DO UPDATE SET
    revision=excluded.revision,started=excluded.started,terminal=excluded.terminal,title=excluded.title,
    completed=excluded.completed,total=excluded.total,updated_at=excluded.updated_at`)
    .run(value.run_key,value.destination_id,value.activity_ref,value.revision,value.started,value.terminal,
      value.title,value.completed,value.total,value.updated_at)
}
export function getLiveActivityLastStart(destinationId: string): number {
  if (!getDb()) return 0
  const row=database().prepare('SELECT last_start_at FROM live_activity_start_budget WHERE destination_id=?').get(destinationId) as {last_start_at:number}|undefined
  return row?.last_start_at || 0
}
export function recordLiveActivityStart(destinationId: string, at: number): void {
  database().prepare(`INSERT INTO live_activity_start_budget (destination_id,last_start_at) VALUES (?,?)
    ON CONFLICT(destination_id) DO UPDATE SET last_start_at=excluded.last_start_at`).run(destinationId,at)
}
export function countActiveLiveActivityRuns(destinationId: string): number {
  if (!getDb()) return 0
  const row=database().prepare('SELECT COUNT(*) total FROM live_activity_runs WHERE destination_id=? AND started=1 AND terminal=0').get(destinationId) as {total:number}
  return Number(row.total)||0
}
