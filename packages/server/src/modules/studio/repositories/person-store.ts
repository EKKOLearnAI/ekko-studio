import { personUpdated } from './person-updates'
import { personSessionId } from '../contracts/person-session'
import { recordPersonOutcome } from './person-presence-store'
import { createHash, randomUUID } from 'node:crypto'
import { getDb } from '../infrastructure/database'
import { PERSON_DEFAULTS, personError } from '../contracts/person'
import type { PersonExecution, PersonInteraction, PersonRunState, PersonSchedule, PersonSelection, PersonSettings, PersonTask } from '../contracts/person'

export function personDb() {
  const db = getDb()
  if (!db) throw personError('Person requires SQLite', 503)
  return db
}
export function personTransaction<T>(work: () => T): T {
  const db = personDb(); db.exec('BEGIN IMMEDIATE')
  try { const result = work(); db.exec('COMMIT'); return result }
  catch (error) { db.exec('ROLLBACK'); throw error }
}
export function replayPersonOperation<T>(userId: number, key: string, input: unknown): T | undefined {
  const old = personDb().prepare('SELECT request_hash,result_json FROM person_operations WHERE owner_user_id=? AND operation_key=?').get(userId,key) as {request_hash:string;result_json:string} | undefined
  if (!old) return undefined
  if (old.request_hash !== createHash('sha256').update(JSON.stringify(input)).digest('hex')) throw personError('Idempotency key already used for another operation',409)
  return JSON.parse(old.result_json) as T
}
export function personOperation<T>(userId: number, key: string, input: unknown, work: () => T): T {
  personUpdated(userId)
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return personTransaction(() => {
    const db = personDb()
    const old = db.prepare('SELECT request_hash,result_json FROM person_operations WHERE owner_user_id=? AND operation_key=?').get(userId, key) as { request_hash: string; result_json: string } | undefined
    if (old) {
      if (old.request_hash !== hash) throw personError('Idempotency key already used for another operation', 409)
      return JSON.parse(old.result_json) as T
    }
    const result = work()
    db.prepare('INSERT INTO person_operations VALUES (?,?,?,?)').run(userId, key, hash, JSON.stringify(result))
    return result
  })
}
export function personSettings(userId: number): { settings: PersonSettings; revision: number } {
  const row = personDb().prepare('SELECT * FROM person_accounts WHERE user_id=?').get(userId) as { settings_json: string; revision: number } | undefined
  // Historical fixed budgets must not cap the selected model's context window.
  const { contextTokens: _legacyBudget, ...saved } = row ? JSON.parse(row.settings_json) : {}
  return { settings: { ...PERSON_DEFAULTS, ...saved }, revision: row?.revision || 0 }
}
export function savePersonSettings(userId: number, settings: PersonSettings, revision: number, workspace?: string) {
  return personTransaction(() => {
    if (personSettings(userId).revision !== revision) throw personError('Settings changed; reload and retry', 409)
    personDb().prepare('INSERT INTO person_accounts VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision')
      .run(userId, JSON.stringify(settings), revision + 1)
    if (workspace) {
      personDb().prepare('UPDATE session_tasks SET workspace=? WHERE owner_user_id=? AND bot_id=?').run(workspace, userId, `person:${userId}`)
      personDb().prepare(`UPDATE sessions SET workspace=? WHERE CAST(studio_user_id AS TEXT)=? AND
        (id=? OR id IN (SELECT 'person-task-' || id FROM session_tasks WHERE owner_user_id=? AND bot_id=?))`)
        .run(workspace, String(userId), personSessionId(userId), userId, `person:${userId}`)
    }
    personUpdated(userId)
    return personSettings(userId)
  })
}
const taskExecutionColumns = `
  (SELECT id FROM person_executions e WHERE e.task_id=t.id ORDER BY created_at DESC,rowid DESC LIMIT 1) AS execution_id,
  COALESCE((SELECT state FROM person_executions e WHERE e.task_id=t.id ORDER BY created_at DESC,rowid DESC LIMIT 1),'idle') AS execution_state,
  EXISTS(SELECT 1 FROM person_executions e WHERE e.task_id=t.id AND e.state IN ('queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'))
    OR EXISTS(SELECT 1 FROM person_deliveries d JOIN person_executions e ON e.id=d.execution_id WHERE e.task_id=t.id AND d.state IN ('pending','queued')) AS running`
export function getPersonTask(userId: number, id: string): PersonTask {
  const task = personDb().prepare(`SELECT t.*, ${taskExecutionColumns} FROM session_tasks t WHERE id=? AND owner_user_id=? AND bot_id=?`).get(id, userId, `person:${userId}`) as unknown as PersonTask | undefined
  if (!task) throw personError('Task not found', 404)
  return task
}
export function listPersonTasks(userId: number, search = '', offset = 0, options: { status?: string; order?: string; limit?: number } = {}): PersonTask[] {
  return personDb().prepare(`SELECT t.*, ${taskExecutionColumns}
    FROM session_tasks t WHERE owner_user_id=? AND bot_id=? AND (instr(lower(title),lower(?))>0 OR instr(lower(summary),lower(?))>0)
    AND (?='' OR status=?) ORDER BY updated_at ${options.order === 'oldest' ? 'ASC' : 'DESC'},id LIMIT ? OFFSET ?`).all(userId, `person:${userId}`, search, search, options.status || '', options.status || '', Math.max(1, Math.min(100, Number(options.limit) || 20)), offset) as unknown as PersonTask[]
}
export function createPersonTask(userId: number, title: string, requirements: string, selection: PersonSelection, workspace: string): PersonTask {
  const db = personDb(); const id = randomUUID(); const now = Date.now()
  db.prepare(`INSERT INTO session_tasks(id,title,summary,owner_user_id,bot_id,requirements_json,selection_json,workspace,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, title, requirements.slice(0,1000), userId, `person:${userId}`, JSON.stringify({ goal: requirements }), JSON.stringify(selection), workspace, now, now)
  return getPersonTask(userId, id)
}
export function updatePersonTask(userId: number, id: string, revision: number, requirements: string) {
  const changed = personDb().prepare(`UPDATE session_tasks SET summary=?, requirements_json=?,revision=revision+1,requirements_revision=requirements_revision+1,updated_at=?
    WHERE id=? AND owner_user_id=? AND bot_id=? AND revision=? AND status='open'`)
    .run(requirements.slice(0,1000), JSON.stringify({ ...JSON.parse(getPersonTask(userId,id).requirements_json), goal: requirements }), Date.now(), id, userId, `person:${userId}`, revision)
  if (!changed.changes) throw personError('Task changed or is closed', 409)
  return getPersonTask(userId, id)
}
export function enqueuePersonExecution(task: PersonTask, occurrence: string | null = null, input?: import('../contracts/runs/session').ContentBlock[]): PersonExecution {
  if (task.status !== 'open') throw personError('Task must be open', 409)
  const id = randomUUID(); const now = Date.now()
  const active = personDb().prepare("SELECT id FROM person_executions WHERE task_id=? AND state IN ('queued','starting','stopping','running','waiting_person','waiting_user','waiting_approval')").get(task.id)
  if (active) throw personError('Task already has an active execution', 409)
  personDb().prepare(`INSERT INTO person_executions(id,task_id,owner_user_id,requirements_revision,state,session_id,selection_json,created_at,updated_at,occurrence_id,input_json)
    VALUES (?,?,?,?,'queued',?,?,?,?,?,?)`).run(id, task.id, task.owner_user_id, task.requirements_revision, `person-task-${task.id}`, task.selection_json, now, now, occurrence, input ? JSON.stringify(input) : '')
  personDb().prepare(`INSERT INTO person_deliveries(execution_id,owner_user_id,origin_json,updated_at)
    SELECT ?,owner_user_id,origin_json,? FROM person_task_origins WHERE task_id=?`).run(id, now, task.id)
  return getPersonExecution(task.owner_user_id, id)
}
export function getPersonExecution(userId: number, id: string): PersonExecution {
  const row = personDb().prepare('SELECT * FROM person_executions WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as PersonExecution | undefined
  if (!row) throw personError('Execution not found', 404)
  return row
}
export function taskPersonExecutions(userId: number, taskId: string): PersonExecution[] {
  getPersonTask(userId, taskId)
  return personDb().prepare('SELECT * FROM person_executions WHERE owner_user_id=? AND task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(userId, taskId) as unknown as PersonExecution[]
}
export function setPersonExecution(run: PersonExecution, state: PersonRunState, extra: { output?: string; error?: string } = {}): boolean {
  personUpdated(run.owner_user_id)
  const changed = !!personDb().prepare(`UPDATE person_executions SET state=?,output=?,error=?,updated_at=?
    WHERE id=? AND owner_user_id=? AND generation=? AND state NOT IN ('interrupted','stopping','finished','failed')`)
    .run(state, extra.output ?? run.output, extra.error ?? run.error, Date.now(), run.id, run.owner_user_id, run.generation).changes
  if (changed && (state === 'finished' || state === 'failed')) recordPersonOutcome(run.owner_user_id, `task:${run.id}`, state === 'finished' ? 'done' : 'error')
  return changed
}
export function personEvent(run: PersonExecution, kind: string, payload: unknown) {
  const json = JSON.stringify(payload, (key, value) => /token|secret|authorization|api[_-]?key/i.test(key) ? '[redacted]' : value) || '{}'
  const bounded = json.length <= 32000 ? json : JSON.stringify({ truncated: true, preview: 'Event too large; inspect the task artifact' })
  personDb().prepare('INSERT INTO person_events(owner_user_id,execution_id,kind,payload,created_at) VALUES (?,?,?,?,?)').run(run.owner_user_id, run.id, kind, bounded, Date.now())
}
export function personEvents(userId: number, execution: string, after = 0) {
  getPersonExecution(userId, execution)
  return personDb().prepare('SELECT * FROM person_events WHERE owner_user_id=? AND execution_id=? AND id>? ORDER BY id LIMIT 30').all(userId, execution, after)
}
export function addPersonInteraction(userId: number, run: PersonExecution, nativeId: string, question: string, choices: string[], kind: 'question' | 'approval' = 'question'): PersonInteraction {
  const db = personDb(); const id = randomUUID()
  db.prepare(`INSERT OR IGNORE INTO person_interactions(id,owner_user_id,task_id,execution_id,native_id,kind,question,choices_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, run.task_id, run.id, nativeId, kind, question, JSON.stringify(choices), Date.now())
  personUpdated(userId)
  return db.prepare('SELECT * FROM person_interactions WHERE execution_id=? AND native_id=?').get(run.id, nativeId) as unknown as PersonInteraction
}
export function personInteractions(userId: number): PersonInteraction[] {
  return personDb().prepare("SELECT * FROM person_interactions WHERE owner_user_id=? AND state='pending' ORDER BY created_at LIMIT 30").all(userId) as unknown as PersonInteraction[]
}
export function answerPersonInteraction(userId: number, id: string, revision: number, answer: string, actor: 'user' | 'person'): PersonInteraction {
  const db = personDb()
  const question = db.prepare('SELECT * FROM person_interactions WHERE owner_user_id=? AND id=?').get(userId, id) as unknown as PersonInteraction | undefined
  if (!question) throw personError('Question not found', 404)
  if (actor === 'person' && question.kind === 'approval') throw personError('Person cannot grant new approval', 403)
  if (!db.prepare("UPDATE person_interactions SET state='answered',answer=?,answered_by=?,revision=revision+1 WHERE owner_user_id=? AND id=? AND revision=? AND state='pending'")
    .run(answer, actor, userId, id, revision).changes) throw personError('Question expired or already answered', 409)
  personUpdated(userId)
  return { ...question, answer, answered_by: actor, revision: revision + 1, state: 'answered' }
}
export function listPersonSchedules(userId: number): PersonSchedule[] {
  return personDb().prepare('SELECT * FROM person_schedules WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 50').all(userId) as unknown as PersonSchedule[]
}

/** Existing goals with recorded account ownership can be assigned to Person without making a duplicate. */
export function listAssignablePersonGoals(userId: number, search = '') {
  return personDb().prepare(`SELECT t.id,t.title,t.summary,t.status,t.updated_at AS revision,t.session_id,s.profile FROM session_tasks t JOIN sessions s ON s.id=t.session_id
    WHERE s.id NOT LIKE 'person-task-%' AND s.id NOT LIKE 'person-main-%' AND CAST(s.studio_user_id AS TEXT)=? AND t.owner_user_id IS NULL AND t.status='open'
    AND (instr(lower(t.title),lower(?))>0 OR instr(lower(t.summary),lower(?))>0)
    ORDER BY t.updated_at DESC LIMIT 10`).all(String(userId), search, search)
}
export function adoptPersonGoal(userId: number, id: string, revision: number, selection: PersonSelection, workspace: string, goal: string) {
  const original = personDb().prepare(`SELECT t.*,s.profile FROM session_tasks t JOIN sessions s ON s.id=t.session_id WHERE s.id NOT LIKE 'person-task-%' AND s.id NOT LIKE 'person-main-%' AND t.id=? AND CAST(s.studio_user_id AS TEXT)=? AND t.owner_user_id IS NULL AND t.status='open'`).get(id,String(userId)) as Record<string, any> | undefined
  if (!original || original.updated_at !== revision) throw personError('Goal is unavailable or changed',409)
  personDb().prepare(`UPDATE session_tasks SET session_id=NULL,source_message_id=NULL,evidence_message_id=NULL,owner_user_id=?,bot_id=?,requirements_json=?,selection_json=?,workspace=?,revision=revision+1,requirements_revision=requirements_revision+1,updated_at=? WHERE id=?`).run(userId,`person:${userId}`,JSON.stringify({goal,origin:{session_id:original.session_id,source_message_id:original.source_message_id,summary:original.summary}}),JSON.stringify(selection),workspace,Date.now(),id)
  personDb().prepare('UPDATE sessions SET task_summary_revision=task_summary_revision+1,task_summary_updated_at=? WHERE id=?').run(Date.now(),original.session_id)
  return getPersonTask(userId,id)
}

/** Pending work includes completed workers whose result has not reached the parent yet. */
export function personBackgroundPendingCount(sessionId: string, reportingExecutionId = ''): number {
  if (!sessionId.startsWith('person-main-')) return 0
  const db = getDb()
  if (!db) return 0
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM person_deliveries d
    JOIN person_executions e ON e.id=d.execution_id
    JOIN session_tasks t ON t.id=e.task_id
    WHERE json_extract(d.origin_json,'$.sessionId')=? AND d.execution_id!=?
      AND d.state IN ('waiting','pending','queued') AND e.state NOT IN ('interrupted','stopping')
      AND t.status!='closed' AND t.requirements_revision=e.requirements_revision`)
    .get(sessionId, reportingExecutionId) as { n: number }).n)
}
export function personTaskRunning(taskId: string): boolean {
  return !!personDb().prepare(`SELECT 1 FROM person_executions e WHERE e.task_id=? AND
    (e.state IN ('queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval')
      OR EXISTS(SELECT 1 FROM person_deliveries d WHERE d.execution_id=e.id AND d.state IN ('pending','queued'))) LIMIT 1`).get(taskId)
}
