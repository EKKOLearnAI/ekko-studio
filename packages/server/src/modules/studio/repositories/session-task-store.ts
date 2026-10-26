import { randomUUID } from 'node:crypto'
import { getDb, isSqliteAvailable } from '../infrastructure/database'
import { MESSAGES_TABLE, SESSIONS_TABLE, SESSION_TASKS_TABLE } from '../infrastructure/database/schemas'
import type { SessionTask, SessionTasksSnapshot, SessionTaskChange } from '../contracts/session-task'
import type { SessionTaskListPage, SessionTaskListQuery } from '../contracts/session-task'
import type { SessionTaskStatus } from '../contracts/session-task'
import { SESSION_PREVIEW_SQL, sessionDisplayTitle } from './session-display'

/** Profile filtering happens in SQL, before counting or paginating. */
export function listSessionTaskItems(query: SessionTaskListQuery): SessionTaskListPage {
  const empty = { tasks: [], total: 0, has_more: false }
  const db = getDb()
  if (!db || !query.profiles.length) return empty
  const where = [
    `s.profile IN (${query.profiles.map(() => '?').join(',')})`,
    `s.source IN ('api_server', 'cli', 'desktop', 'builtin_agent', 'coding_agent')`,
  ]
  const args: (string | number)[] = [...query.profiles]
  if (query.excludeSessionIds?.length) {
    where.push(`s.id NOT IN (${query.excludeSessionIds.map(() => '?').join(',')})`)
    args.push(...query.excludeSessionIds)
  }
  if (query.status) { where.push('t.status = ?'); args.push(query.status) }
  if (query.search) {
    // instr treats %, _ and backslashes as literal search text.
    where.push(`(instr(lower(t.title), lower(?)) > 0 OR instr(lower(t.summary), lower(?)) > 0 OR instr(lower(COALESCE(NULLIF(s.title, ''), ${SESSION_PREVIEW_SQL})), lower(?)) > 0)`)
    args.push(query.search, query.search, query.search)
  }
  const from = `FROM ${SESSION_TASKS_TABLE} t JOIN ${SESSIONS_TABLE} s ON s.id = t.session_id WHERE ${where.join(' AND ')}`
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from} LIMIT 100)`).get(...args) as { n: number }).n)
  if (query.offset >= total) return { ...empty, total }
  const rows = db.prepare(`SELECT t.*, s.title AS session_title, ${SESSION_PREVIEW_SQL} AS session_preview, s.profile, s.source, s.agent,
    (SELECT m.id FROM ${MESSAGES_TABLE} m WHERE m.session_id = t.session_id
      AND m.role = 'user' AND COALESCE(m.display_role, m.role) = 'user' AND m.content NOT LIKE '/%'
      AND m.id <= CASE WHEN t.status = 'completed' THEN COALESCE(t.evidence_message_id, t.source_message_id) ELSE t.source_message_id END
      ORDER BY m.id DESC LIMIT 1) AS message_id
    ${from} ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
      t.updated_at ${query.order === 'oldest' ? 'ASC' : 'DESC'}, t.id ASC LIMIT ? OFFSET ?`)
    .all(...args, Math.min(query.limit, total - query.offset), query.offset) as unknown as Array<SessionTaskListPage['tasks'][number] & { session_preview: string }>
  const tasks = rows.map(({ session_preview, ...task }) => ({
    ...task, session_title: sessionDisplayTitle(task.session_title, session_preview),
  }))
  return { tasks, total, has_more: query.offset + tasks.length < total }
}

export interface SessionTasksState {
  session_id: string
  profile: string
  source: string
  history_revision: number
  revision: number
  updated_at: number
}
export function getSessionTasksState(sessionId: string): SessionTasksState | null {
  if (!isSqliteAvailable()) return null
  return getDb()!.prepare(`SELECT id AS session_id, profile, source, history_revision, task_summary_revision AS revision, task_summary_updated_at AS updated_at
    FROM ${SESSIONS_TABLE} WHERE id = ?`).get(sessionId) as unknown as SessionTasksState || null
}

export function getSessionTasks(sessionId: string): SessionTasksSnapshot {
  const state = getSessionTasksState(sessionId)
  const tasks = state ? getDb()!.prepare(`SELECT id, title, summary, status, source_message_id,
    evidence_message_id, completion_evidence, created_at, updated_at, completed_at
    FROM ${SESSION_TASKS_TABLE} WHERE session_id = ? ORDER BY created_at, id`).all(sessionId) as unknown as SessionTask[] : []
  return { session_id: sessionId, revision: state?.revision || 0, updated_at: state?.updated_at || 0, tasks }
}

const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/\s+/g, '').trim()

/** Revision checks and upserts commit together. Omitted goals are retained. */
export function commitSessionTasks(
  expected: SessionTasksState, changes: SessionTaskChange[],
): SessionTasksSnapshot | null {
  const db = getDb()
  if (!db) return null
  const current = getSessionTasksState(expected.session_id)
  if (!current || current.profile !== expected.profile || current.history_revision !== expected.history_revision
    || current.revision !== expected.revision) return null
  const source = db.prepare(`SELECT id FROM ${MESSAGES_TABLE} WHERE session_id = ?
    AND role = 'user' AND COALESCE(display_role, role) = 'user' AND content NOT LIKE '/%' ORDER BY id DESC LIMIT 1`)
    .get(expected.session_id) as { id: number } | undefined
  if (!source) throw new Error('Session goals require a user request')
  const anchor = db.prepare(`SELECT MAX(id) AS id FROM ${MESSAGES_TABLE} WHERE session_id = ?`)
    .get(expected.session_id) as { id: number }
  const previous = getSessionTasks(expected.session_id).tasks
  const byId = new Map(previous.map(task => [task.id, task]))
  const byTitle = new Map(previous.map(task => [titleKey(task.title), task]))
  const seen = new Set<string>()
  const now = Math.max(Date.now(), ...previous.map(task => task.updated_at + 1))
  const tasks: SessionTask[] = []
  for (const change of changes) {
    const old = change.id ? byId.get(change.id) : byTitle.get(titleKey(change.title))
    if (change.id && !old) throw new Error('Unknown session goal id')
    if (old?.status === 'closed') throw new Error('This goal was closed by the user; only the user can reopen it from the task list')
    const sameTitle = byTitle.get(titleKey(change.title))
    if (sameTitle && old && sameTitle.id !== old.id) throw new Error('Goal title belongs to another goal')
    const id = old?.id || randomUUID()
    if (seen.has(id) || tasks.some(task => titleKey(task.title) === titleKey(change.title))) throw new Error('Duplicate goal in summary')
    seen.add(id)
    const status = change.status
    const evidence = status === 'completed' ? change.completion_evidence?.trim() || old?.completion_evidence || '' : ''
    if (status === 'completed' && !evidence) throw new Error('Completed goals require completion_evidence describing verified delivery')
    const evidenceId = status === 'completed'
      ? (old?.status === 'completed' && evidence === old.completion_evidence ? old.evidence_message_id : anchor.id) : null
    const task: SessionTask = {
      id, title: change.title, summary: change.summary, status,
      source_message_id: old?.source_message_id || source.id,
      evidence_message_id: status === 'completed' ? evidenceId : null,
      completion_evidence: status === 'completed' ? evidence : '',
      created_at: old?.created_at || now, updated_at: now,
      completed_at: status === 'completed' ? old?.completed_at || now : null,
    }
    tasks.push(task)
    byTitle.set(titleKey(task.title), task)
  }
  if (previous.length + tasks.filter(task => !byId.has(task.id)).length > 200) throw new Error('Session goal limit exceeded')
  db.exec('BEGIN')
  try {
    const claimed = db.prepare(`UPDATE ${SESSIONS_TABLE} SET task_summary_revision = task_summary_revision + 1, task_summary_updated_at = ?
      WHERE id = ? AND profile = ? AND history_revision = ? AND task_summary_revision = ?`)
      .run(now, expected.session_id, expected.profile, expected.history_revision, expected.revision)
    if (!claimed.changes) { db.exec('ROLLBACK'); return null }
    const save = db.prepare(`INSERT INTO ${SESSION_TASKS_TABLE}
      (id, session_id, title, summary, status, source_message_id, evidence_message_id, completion_evidence, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, summary = excluded.summary, status = excluded.status,
      evidence_message_id = excluded.evidence_message_id, completion_evidence = excluded.completion_evidence,
      updated_at = excluded.updated_at, completed_at = excluded.completed_at`)
    for (const task of tasks) save.run(task.id, expected.session_id, task.title, task.summary, task.status,
      task.source_message_id, task.evidence_message_id, task.completion_evidence, task.created_at, task.updated_at, task.completed_at)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return getSessionTasks(expected.session_id)
}

/** A user changes one existing task; stale list rows cannot overwrite newer work. */
export function commitSessionTaskStatus(
  expected: SessionTasksState, taskId: string, status: SessionTaskStatus, expectedUpdatedAt: number,
): SessionTasksSnapshot | null {
  const db = getDb()
  if (!db) return null
  db.exec('BEGIN')
  try {
    const current = getSessionTasksState(expected.session_id)
    const task = getSessionTasks(expected.session_id).tasks.find(item => item.id === taskId)
    if (!current || current.profile !== expected.profile || current.history_revision !== expected.history_revision
      || current.revision !== expected.revision || !task || task.updated_at !== expectedUpdatedAt) {
      db.exec('ROLLBACK')
      return null
    }
    if (task.status !== status) {
      const now = Math.max(Date.now(), current.updated_at + 1, task.updated_at + 1)
      const completed = status === 'completed'
      db.prepare(`UPDATE ${SESSION_TASKS_TABLE} SET status = ?, updated_at = ?, completed_at = ?,
        completion_evidence = ?, evidence_message_id = ? WHERE session_id = ? AND id = ?`)
        .run(status, now, completed ? now : null,
          completed ? 'Manually marked completed by the user.' : '',
          completed ? task.source_message_id : null, expected.session_id, taskId)
      db.prepare(`UPDATE ${SESSIONS_TABLE} SET task_summary_revision = task_summary_revision + 1,
        task_summary_updated_at = ? WHERE id = ?`).run(now, expected.session_id)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  return getSessionTasks(expected.session_id)
}
