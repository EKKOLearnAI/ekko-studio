import { getDb } from '../infrastructure/database'

/**
 * Script invocation report bindings: one enrolled Hermes `no_agent` job whose generated wrapper
 * reports each invocation to one frozen session generation. A binding is immutable once active;
 * changing its target or destination means revoking it and enrolling again.
 */
export type ScriptReportBindingState = 'enrolling' | 'active' | 'failed' | 'revoked'

/** `sync`: the wrapper reports its own child. `detached`: the child hands the invocation to a worker that completes it. */
export type ScriptReportCompletion = 'sync' | 'detached'

/** Import result of one wrapper invocation. `incomplete` is never stored: it is a spool state. */
export type ScriptReportInvocationState = 'accepted' | 'silent' | 'rejected' | 'quarantined'

export interface ScriptReportBinding {
  binding_id: string
  revision: number
  namespace: string
  profile: string
  session_id: string
  session_generation: string
  account_id: number
  job_id: string | null
  job_name: string
  target_script: string
  wrapper_script: string
  completion: ScriptReportCompletion
  state: ScriptReportBindingState
  error: string | null
  created_at: number
  updated_at: number
}

export interface ScriptReportInvocation {
  binding_id: string
  invocation_id: string
  state: ScriptReportInvocationState
  outcome: string | null
  notification_id: number | null
  detail: string | null
  updated_at: number
}

/** Import result of one appended (nonterminal) notice of an invocation; keyed by its business event. */
export interface ScriptReportEvent {
  binding_id: string
  binding_revision: number
  event_id: string
  invocation_id: string
  sequence: number
  event_kind: string | null
  /** `pending`: the event identity is reserved for its slot; the inbox may or may not have its notice yet. */
  state: ScriptReportInvocationState | 'pending'
  notification_id: number | null
  detail: string | null
  submitted_sha256: string | null
  record_sha256: string | null
  updated_at: number
}

const initialized = new WeakSet<object>()
function database() {
  const db = getDb()
  if (!db) throw new Error('script_report_storage_unavailable')
  if (initialized.has(db)) return db
  db.exec(`
    CREATE TABLE IF NOT EXISTS script_report_bindings (
      binding_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, namespace TEXT NOT NULL,
      profile TEXT NOT NULL, session_id TEXT NOT NULL, session_generation TEXT NOT NULL,
      account_id INTEGER NOT NULL, job_id TEXT, job_name TEXT NOT NULL, target_script TEXT NOT NULL,
      wrapper_script TEXT NOT NULL, state TEXT NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_script_report_bindings_profile ON script_report_bindings(namespace, profile);
    CREATE TABLE IF NOT EXISTS script_report_invocations (
      binding_id TEXT NOT NULL, invocation_id TEXT NOT NULL, state TEXT NOT NULL, outcome TEXT,
      notification_id INTEGER, detail TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(binding_id, invocation_id)
    );
    CREATE TABLE IF NOT EXISTS script_report_events (
      binding_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, event_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, event_kind TEXT, state TEXT NOT NULL, notification_id INTEGER, detail TEXT,
      submitted_sha256 TEXT, record_sha256 TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY(binding_id, binding_revision, event_id), UNIQUE(binding_id, invocation_id, sequence)
    );
  `)
  const columns = new Set((db.prepare('PRAGMA table_info(script_report_bindings)').all() as Array<{ name: string }>).map(column => column.name))
  if (!columns.has('completion')) db.exec('ALTER TABLE script_report_bindings ADD COLUMN completion TEXT')
  initialized.add(db)
  return db
}

function toBinding(row: Record<string, unknown>): ScriptReportBinding {
  return {
    binding_id: String(row.binding_id),
    revision: Number(row.revision),
    namespace: String(row.namespace),
    profile: String(row.profile),
    session_id: String(row.session_id),
    session_generation: String(row.session_generation),
    account_id: Number(row.account_id),
    job_id: row.job_id == null ? null : String(row.job_id),
    job_name: String(row.job_name),
    target_script: String(row.target_script),
    wrapper_script: String(row.wrapper_script),
    completion: row.completion === 'detached' ? 'detached' : 'sync',
    state: String(row.state) as ScriptReportBindingState,
    error: row.error == null ? null : String(row.error),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  }
}

export function insertScriptReportBinding(binding: Omit<ScriptReportBinding, 'created_at' | 'updated_at' | 'state' | 'error' | 'job_id' | 'completion'>
  & { completion?: ScriptReportCompletion }): ScriptReportBinding {
  const now = Date.now()
  database().prepare(`INSERT INTO script_report_bindings
      (binding_id, revision, namespace, profile, session_id, session_generation, account_id, job_id, job_name,
       target_script, wrapper_script, state, error, created_at, updated_at, completion)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'enrolling', NULL, ?, ?, ?)`).run(binding.binding_id, binding.revision,
    binding.namespace, binding.profile, binding.session_id, binding.session_generation, binding.account_id,
    binding.job_name, binding.target_script, binding.wrapper_script, now, now, binding.completion === 'detached' ? 'detached' : null)
  return getScriptReportBinding(binding.binding_id)!
}

export function getScriptReportBinding(bindingId: string): ScriptReportBinding | null {
  const row = database().prepare('SELECT * FROM script_report_bindings WHERE binding_id=?').get(bindingId) as Record<string, unknown> | undefined
  return row ? toBinding(row) : null
}

export function listScriptReportBindings(namespace: string, profile?: string): ScriptReportBinding[] {
  const rows = (profile
    ? database().prepare('SELECT * FROM script_report_bindings WHERE namespace=? AND profile=? ORDER BY created_at').all(namespace, profile)
    : database().prepare('SELECT * FROM script_report_bindings WHERE namespace=? ORDER BY created_at').all(namespace)) as Record<string, unknown>[]
  return rows.map(toBinding)
}

/** Bindings whose spool the importer drains (revoked ones are drained to reject late reports). */
export function listImportableScriptReportBindings(namespace: string): ScriptReportBinding[] {
  if (!getDb()) return []
  const rows = database().prepare(`SELECT * FROM script_report_bindings WHERE namespace=? AND state IN ('active','revoked')
    ORDER BY created_at`).all(namespace) as Record<string, unknown>[]
  return rows.map(toBinding)
}

/** Move forward from an expected state only; returns false when the binding is elsewhere. */
export function transitionScriptReportBinding(bindingId: string, from: ScriptReportBindingState[], to: ScriptReportBindingState,
  fields: { job_id?: string; error?: string | null } = {}): boolean {
  const placeholders = from.map(() => '?').join(',')
  const result = database().prepare(`UPDATE script_report_bindings SET state=?, job_id=COALESCE(?, job_id),
      error=CASE WHEN ? THEN ? ELSE error END, updated_at=? WHERE binding_id=? AND state IN (${placeholders})`)
    .run(to, fields.job_id ?? null, fields.error !== undefined ? 1 : 0, fields.error ?? null, Date.now(), bindingId, ...from)
  return result.changes > 0
}

export function recordScriptReportBindingJob(bindingId: string, jobId: string): void {
  database().prepare('UPDATE script_report_bindings SET job_id=?, updated_at=? WHERE binding_id=? AND job_id IS NULL')
    .run(jobId, Date.now(), bindingId)
}

export function setScriptReportBindingError(bindingId: string, error: string | null): void {
  database().prepare('UPDATE script_report_bindings SET error=?, updated_at=? WHERE binding_id=?').run(error, Date.now(), bindingId)
}

export function getScriptReportInvocation(bindingId: string, invocationId: string): ScriptReportInvocation | null {
  const row = database().prepare('SELECT * FROM script_report_invocations WHERE binding_id=? AND invocation_id=?')
    .get(bindingId, invocationId) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    binding_id: String(row.binding_id),
    invocation_id: String(row.invocation_id),
    state: String(row.state) as ScriptReportInvocationState,
    outcome: row.outcome == null ? null : String(row.outcome),
    notification_id: row.notification_id == null ? null : Number(row.notification_id),
    detail: row.detail == null ? null : String(row.detail),
    updated_at: Number(row.updated_at),
  }
}

/** First disposition wins; a replayed report never rewrites an earlier import result. */
export function recordScriptReportInvocation(entry: Omit<ScriptReportInvocation, 'updated_at'>): void {
  database().prepare(`INSERT INTO script_report_invocations
      (binding_id, invocation_id, state, outcome, notification_id, detail, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(binding_id, invocation_id) DO NOTHING`)
    .run(entry.binding_id, entry.invocation_id, entry.state, entry.outcome, entry.notification_id, entry.detail, Date.now())
}

export function countScriptReportInvocations(bindingId: string): Record<ScriptReportInvocationState, number> {
  const counts: Record<ScriptReportInvocationState, number> = { accepted: 0, silent: 0, rejected: 0, quarantined: 0 }
  const rows = database().prepare('SELECT state, COUNT(*) AS n FROM script_report_invocations WHERE binding_id=? GROUP BY state')
    .all(bindingId) as Array<{ state: string; n: number }>
  for (const row of rows) {
    if (row.state in counts) counts[row.state as ScriptReportInvocationState] = Number(row.n)
  }
  return counts
}

function toEvent(row: Record<string, unknown>): ScriptReportEvent {
  const text = (value: unknown) => value == null ? null : String(value)
  return {
    binding_id: String(row.binding_id), binding_revision: Number(row.binding_revision), event_id: String(row.event_id),
    invocation_id: String(row.invocation_id), sequence: Number(row.sequence), event_kind: text(row.event_kind),
    state: String(row.state) as ScriptReportEvent['state'], notification_id: row.notification_id == null ? null : Number(row.notification_id),
    detail: text(row.detail), submitted_sha256: text(row.submitted_sha256), record_sha256: text(row.record_sha256), updated_at: Number(row.updated_at),
  }
}

export function getScriptReportEvent(bindingId: string, revision: number, eventId: string): ScriptReportEvent | null {
  const row = database().prepare('SELECT * FROM script_report_events WHERE binding_id=? AND binding_revision=? AND event_id=?')
    .get(bindingId, revision, eventId) as Record<string, unknown> | undefined
  return row ? toEvent(row) : null
}

export function getScriptReportEventAt(bindingId: string, invocationId: string, sequence: number): ScriptReportEvent | null {
  const row = database().prepare('SELECT * FROM script_report_events WHERE binding_id=? AND invocation_id=? AND sequence=?')
    .get(bindingId, invocationId, sequence) as Record<string, unknown> | undefined
  return row ? toEvent(row) : null
}

/** First disposition wins, per event and per invocation slot; a replay never rewrites it. */
export function recordScriptReportEvent(entry: Omit<ScriptReportEvent, 'updated_at'>): void {
  database().prepare(`INSERT INTO script_report_events (binding_id, binding_revision, event_id, invocation_id, sequence, event_kind,
      state, notification_id, detail, submitted_sha256, record_sha256, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(entry.binding_id, entry.binding_revision, entry.event_id, entry.invocation_id, entry.sequence, entry.event_kind, entry.state,
      entry.notification_id, entry.detail, entry.submitted_sha256, entry.record_sha256, Date.now())
}

/** Settle a reserved (`pending`) slot once; a settled disposition is never rewritten. */
export function settleScriptReportEvent(bindingId: string, invocationId: string, sequence: number,
  state: ScriptReportInvocationState, notificationId: number | null, detail: string | null): void {
  database().prepare(`UPDATE script_report_events SET state=?, notification_id=?, detail=?, updated_at=?
    WHERE binding_id=? AND invocation_id=? AND sequence=? AND state='pending'`)
    .run(state, notificationId, detail, Date.now(), bindingId, invocationId, sequence)
}
