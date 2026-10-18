import { randomUUID } from 'node:crypto'
import { getDb } from '../infrastructure/database'

export interface PushActor { userId: number; deviceId: string; studioDeviceId: string }
export type PushRunKind = 'chat' | 'group' | 'workflow'
export interface PushRunRef { kind: PushRunKind; profile: string; runId: string }
export interface RunPushTargetRecord {
  id: string; kind: PushRunKind; profile: string; run_id: string; subject_id: string
  user_id: number; device_id: string; platform: string; created_at: number
  studio_device_id: string; push_snapshot_ciphertext: string | null
}

// Immutable per-run notification snapshots. No current-device credential lookup.
// The gateway decides credential validity when sending, not a cached local expiry.
const initialized = new WeakSet<object>()
function database() {
  const db = getDb()
  if (!db) throw new Error('push_storage_unavailable')
  if (initialized.has(db)) return db
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_push_targets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, profile TEXT NOT NULL, run_id TEXT NOT NULL,
      subject_id TEXT NOT NULL, user_id INTEGER NOT NULL, device_id TEXT NOT NULL,
      platform TEXT NOT NULL, created_at INTEGER NOT NULL,
      studio_device_id TEXT NOT NULL, push_snapshot_ciphertext TEXT,
      UNIQUE(kind, profile, run_id)
    );
    CREATE TABLE IF NOT EXISTS run_push_links (
      kind TEXT NOT NULL, scope TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      PRIMARY KEY(kind, scope, source_id)
    );
  `)
  initialized.add(db)
  return db
}

export function getRunPushTarget(ref: PushRunRef): RunPushTargetRecord | null {
  if (!getDb()) return null
  return database().prepare('SELECT * FROM run_push_targets WHERE kind=? AND profile=? AND run_id=?')
    .get(ref.kind, ref.profile, ref.runId) as unknown as RunPushTargetRecord || null
}

export function getPushTargetById(id: string): RunPushTargetRecord | null {
  if (!id) return null
  return database().prepare('SELECT * FROM run_push_targets WHERE id=?').get(id) as unknown as RunPushTargetRecord || null
}

export function bindRunPushTarget(ref: PushRunRef, subjectId: string, actor: PushActor, snapshot: { ciphertext: string | null; platform: string } = { ciphertext: null, platform: 'unknown' }): RunPushTargetRecord {
  const db = database(), existing = getRunPushTarget(ref)
  if (existing) {
    if (existing.user_id !== actor.userId || existing.device_id !== actor.deviceId || existing.subject_id !== subjectId || existing.studio_device_id !== actor.studioDeviceId) {
      throw new Error('run_push_target_conflict')
    }
    return existing
  }
  db.prepare(`INSERT INTO run_push_targets (id,kind,profile,run_id,subject_id,user_id,device_id,platform,created_at,studio_device_id,push_snapshot_ciphertext)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), ref.kind, ref.profile, ref.runId, subjectId, actor.userId, actor.deviceId,
      snapshot.ciphertext ? snapshot.platform : 'unknown', Date.now(), actor.studioDeviceId, snapshot.ciphertext)
  return getRunPushTarget(ref)!
}

/** Immutable aliases correlate runtime IDs/messages to a root, never to the last viewer. */
export function linkPushRun(kind: string, scope: string, sourceId: string, target: RunPushTargetRecord): void {
  if (!sourceId) return
  const db = database()
  const old = db.prepare('SELECT target_id FROM run_push_links WHERE kind=? AND scope=? AND source_id=?').get(kind, scope, sourceId)
  if (old && old.target_id !== target.id) throw new Error('run_push_link_conflict')
  db.prepare('INSERT OR IGNORE INTO run_push_links (kind,scope,source_id,target_id) VALUES (?,?,?,?)')
    .run(kind, scope, sourceId, target.id)
}

export function findPushRunLink(kind: string, scope: string, sourceId: string): RunPushTargetRecord | null {
  if (!sourceId || !getDb()) return null
  return database().prepare(`SELECT t.* FROM run_push_links l JOIN run_push_targets t ON t.id=l.target_id
    WHERE l.kind=? AND l.scope=? AND l.source_id=?`).get(kind, scope, sourceId) as unknown as RunPushTargetRecord || null
}

export function pushRunTransaction<T>(work: () => T): T {
  const db = database()
  db.exec('SAVEPOINT push_run_binding')
  try { const result = work(); db.exec('RELEASE push_run_binding'); return result }
  catch (error) { db.exec('ROLLBACK TO push_run_binding'); db.exec('RELEASE push_run_binding'); throw error }
}
