import { getDb, isSqliteAvailable } from '../infrastructure/database'
import {
  WORKSPACE_RUN_CHANGES_TABLE,
  WORKSPACE_RUN_CHANGE_FILES_TABLE,
} from '../infrastructure/database/schemas'

export interface WorkspaceRunChangeFileSummary {
  id: number
  change_id: string
  session_id: string
  path: string
  old_path: string | null
  change_type: 'added' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  size_before: number | null
  size_after: number | null
  patch_bytes: number
  truncated: boolean
  binary: boolean
  created_at: number
}

export interface WorkspaceRunChangeFileDetail extends WorkspaceRunChangeFileSummary {
  patch: string | null
}

export interface WorkspaceRunChangeSummary {
  change_id: string
  room_id: string
  message_id: string
  assistant_message_id: string
  session_id: string
  run_id: string
  source: 'run'
  workspace: string
  workspace_kind: 'git' | 'filesystem'
  started_at: number
  finished_at: number
  files_changed: number
  additions: number
  deletions: number
  truncated: boolean
  total_patch_bytes: number
  created_at: number
  files: WorkspaceRunChangeFileSummary[]
}

export interface SaveWorkspaceRunChangeInput {
  change_id: string
  room_id?: string
  message_id?: string
  assistant_message_id?: string
  session_id: string
  run_id?: string
  source?: 'run'
  workspace: string
  workspace_kind?: 'git' | 'filesystem'
  started_at: number
  finished_at: number
  files_changed: number
  additions: number
  deletions: number
  truncated?: boolean
  total_patch_bytes: number
  files: Array<{
    path: string
    old_path?: string | null
    change_type: 'added' | 'modified' | 'deleted' | 'renamed'
    additions: number
    deletions: number
    size_before?: number | null
    size_after?: number | null
    patch?: string | null
    patch_bytes: number
    truncated?: boolean
    binary?: boolean
  }>
}

function mapFileSummary(row: Record<string, unknown>): WorkspaceRunChangeFileSummary {
  return {
    id: Number(row.id || 0),
    change_id: String(row.change_id || ''),
    session_id: String(row.session_id || ''),
    path: String(row.path || ''),
    old_path: row.old_path != null ? String(row.old_path) : null,
    change_type: String(row.change_type || 'modified') as WorkspaceRunChangeFileSummary['change_type'],
    additions: Number(row.additions || 0),
    deletions: Number(row.deletions || 0),
    size_before: row.size_before != null ? Number(row.size_before) : null,
    size_after: row.size_after != null ? Number(row.size_after) : null,
    patch_bytes: Number(row.patch_bytes || 0),
    truncated: Number(row.truncated || 0) !== 0,
    binary: Number(row.binary || 0) !== 0,
    created_at: Number(row.created_at || 0),
  }
}

function mapFileDetail(row: Record<string, unknown>): WorkspaceRunChangeFileDetail {
  return {
    ...mapFileSummary(row),
    patch: row.patch != null ? String(row.patch) : null,
  }
}

function mapSummary(row: Record<string, unknown>, files: WorkspaceRunChangeFileSummary[]): WorkspaceRunChangeSummary {
  return {
    change_id: String(row.change_id || ''),
    room_id: String(row.room_id || ''),
    message_id: String(row.message_id || ''),
    assistant_message_id: String(row.assistant_message_id || ''),
    session_id: String(row.session_id || ''),
    run_id: String(row.run_id || ''),
    source: 'run',
    workspace: String(row.workspace || ''),
    workspace_kind: String(row.workspace_kind || 'git') as WorkspaceRunChangeSummary['workspace_kind'],
    started_at: Number(row.started_at || 0),
    finished_at: Number(row.finished_at || 0),
    files_changed: Number(row.files_changed || 0),
    additions: Number(row.additions || 0),
    deletions: Number(row.deletions || 0),
    truncated: Number(row.truncated || 0) !== 0,
    total_patch_bytes: Number(row.total_patch_bytes || 0),
    created_at: Number(row.created_at || 0),
    files,
  }
}

type HermesDb = NonNullable<ReturnType<typeof getDb>>

function readWorkspaceRunChange(db: HermesDb, sessionId: string, changeId: string): WorkspaceRunChangeSummary | null {
  const row = db.prepare(
    `SELECT * FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ? AND change_id = ?`,
  ).get(sessionId, changeId) as Record<string, unknown> | undefined
  if (!row) return null
  const files = db.prepare(
    `SELECT id, change_id, session_id, path, old_path, change_type, additions, deletions,
      size_before, size_after, patch_bytes, truncated, binary, created_at
     FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE}
     WHERE session_id = ? AND change_id = ?
     ORDER BY path COLLATE NOCASE ASC`,
  ).all(sessionId, changeId) as Record<string, unknown>[]
  return mapSummary(row, files.map(mapFileSummary))
}

export function insertWorkspaceRunChange(db: HermesDb, change: SaveWorkspaceRunChangeInput): WorkspaceRunChangeSummary | null {
  const createdAt = Math.floor(Date.now() / 1000)
  db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE change_id = ?`).run(change.change_id)
  db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE change_id = ?`).run(change.change_id)
  db.prepare(
    `INSERT INTO ${WORKSPACE_RUN_CHANGES_TABLE} (
      change_id, room_id, message_id, assistant_message_id, session_id, run_id, source, workspace, workspace_kind, started_at, finished_at,
      files_changed, additions, deletions, truncated, total_patch_bytes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    change.change_id,
    change.room_id || '',
    change.message_id || '',
    change.assistant_message_id || '',
    change.session_id,
    change.run_id || '',
    change.source || 'run',
    change.workspace,
    change.workspace_kind || 'git',
    change.started_at,
    change.finished_at,
    change.files_changed,
    change.additions,
    change.deletions,
    change.truncated ? 1 : 0,
    change.total_patch_bytes,
    createdAt,
  )

  const insertFile = db.prepare(
    `INSERT INTO ${WORKSPACE_RUN_CHANGE_FILES_TABLE} (
      change_id, session_id, path, old_path, change_type, additions, deletions,
      size_before, size_after, patch, patch_bytes, truncated, binary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const file of change.files) {
    insertFile.run(
      change.change_id,
      change.session_id,
      file.path,
      file.old_path || null,
      file.change_type,
      file.additions,
      file.deletions,
      file.size_before ?? null,
      file.size_after ?? null,
      file.patch || null,
      file.patch_bytes,
      file.truncated ? 1 : 0,
      file.binary ? 1 : 0,
      createdAt,
    )
  }
  return readWorkspaceRunChange(db, change.session_id, change.change_id)
}

export function saveWorkspaceRunChange(change: SaveWorkspaceRunChangeInput): WorkspaceRunChangeSummary | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null

  db.exec('BEGIN')
  try {
    insertWorkspaceRunChange(db, change)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  return getWorkspaceRunChange(change.session_id, change.change_id)
}

export function getWorkspaceRunChange(sessionId: string, changeId: string): WorkspaceRunChangeSummary | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null
  return readWorkspaceRunChange(db, sessionId, changeId)
}

export function listWorkspaceRunChangesForSession(sessionId: string): WorkspaceRunChangeSummary[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()
  if (!db) return []
  const rows = db.prepare(
    `SELECT * FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ? ORDER BY created_at ASC`,
  ).all(sessionId) as Record<string, unknown>[]
  return readWorkspaceRunChangeRows(db, sessionId, rows)
}

export function listWorkspaceRunChangesForAssistantMessages(
  sessionId: string,
  assistantMessageIds: Array<string | number>,
): WorkspaceRunChangeSummary[] {
  if (!isSqliteAvailable()) return []
  const db = getDb()
  if (!db) return []
  const ids = [...new Set(
    assistantMessageIds
      .map(id => String(id).trim())
      .filter(Boolean),
  )]
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM ${WORKSPACE_RUN_CHANGES_TABLE}
     WHERE session_id = ? AND assistant_message_id IN (${placeholders})
     ORDER BY created_at ASC, change_id ASC`,
  ).all(sessionId, ...ids) as Record<string, unknown>[]
  return readWorkspaceRunChangeRows(db, sessionId, rows)
}

function readWorkspaceRunChangeRows(
  db: HermesDb,
  sessionId: string,
  rows: Record<string, unknown>[],
): WorkspaceRunChangeSummary[] {
  if (rows.length === 0) return []
  const changeIds = rows.map(row => String(row.change_id || '')).filter(Boolean)
  const placeholders = changeIds.map(() => '?').join(',')
  const fileRows = db.prepare(
    `SELECT id, change_id, session_id, path, old_path, change_type, additions, deletions,
      size_before, size_after, patch_bytes, truncated, binary, created_at
     FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE}
     WHERE session_id = ? AND change_id IN (${placeholders})
     ORDER BY path COLLATE NOCASE ASC`,
  ).all(sessionId, ...changeIds) as Record<string, unknown>[]
  const byChangeId = new Map<string, WorkspaceRunChangeFileSummary[]>()
  for (const row of fileRows) {
    const file = mapFileSummary(row)
    const list = byChangeId.get(file.change_id) || []
    list.push(file)
    byChangeId.set(file.change_id, list)
  }
  return rows.map(row => mapSummary(row, byChangeId.get(String(row.change_id || '')) || []))
}

export function getWorkspaceRunChangeFile(
  sessionId: string,
  changeId: string,
  fileId: number,
): WorkspaceRunChangeFileDetail | null {
  if (!isSqliteAvailable()) return null
  const db = getDb()
  if (!db) return null
  const row = db.prepare(
    `SELECT * FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE}
     WHERE session_id = ? AND change_id = ? AND id = ?`,
  ).get(sessionId, changeId, fileId) as Record<string, unknown> | undefined
  return row ? mapFileDetail(row) : null
}

export function deleteWorkspaceRunChangesForSession(sessionId: string): void {
  if (!isSqliteAvailable()) return
  let db
  try {
    db = getDb()
  } catch (err) {
    if (isOptionalCleanupSqliteError(err)) return
    throw err
  }
  if (!db) return
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE session_id = ?`).run(sessionId)
    db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE session_id = ?`).run(sessionId)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    if (isOptionalCleanupSqliteError(err)) return
    throw err
  }
}

export function deleteWorkspaceRunChangesForRoom(db: any, roomId: string, beforeTimestamp?: number): void {
  const room = String(roomId || '').trim()
  if (!room) return
  const rows = beforeTimestamp == null
    ? db.prepare(`SELECT change_id FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE room_id = ?`).all(room)
    : db.prepare(
      `SELECT c.change_id
       FROM ${WORKSPACE_RUN_CHANGES_TABLE} c
       INNER JOIN gc_messages m ON m.id = c.message_id AND m.roomId = c.room_id
       WHERE c.room_id = ? AND m.timestamp < ?`,
    ).all(room, beforeTimestamp)
  const ids = rows.map((row: any) => String(row.change_id || '').trim()).filter(Boolean)
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE change_id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE change_id IN (${placeholders})`).run(...ids)
}

export function deleteWorkspaceRunChangesByChangeIds(db: any, changeIds: string[]): void {
  const ids = [...new Set(changeIds.map(id => String(id || '').trim()).filter(Boolean))]
  if (!ids.length) return
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGE_FILES_TABLE} WHERE change_id IN (${placeholders})`).run(...ids)
  db.prepare(`DELETE FROM ${WORKSPACE_RUN_CHANGES_TABLE} WHERE change_id IN (${placeholders})`).run(...ids)
}

function isOptionalCleanupSqliteError(err: unknown): boolean {
  return err instanceof Error && /(no such table|database is locked)/i.test(err.message)
}
