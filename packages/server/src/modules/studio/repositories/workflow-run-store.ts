import { randomUUID } from 'crypto'
import { getDb, jsonDelete, jsonGet, jsonGetAll, jsonSet } from '../infrastructure/database'
import { WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, WORKFLOW_RUN_LOOP_EPOCHS_TABLE, WORKFLOW_RUN_NODE_SESSIONS_TABLE, WORKFLOW_RUNS_TABLE } from '../infrastructure/database/schemas'

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type WorkflowRunNodeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'approval_rejected' | 'canceled'

export interface WorkflowRunRecord {
  id: string
  workflow_id: string
  user_id: number | null
  profile: string
  workspace: string | null
  start_node_ids: string[]
  status: WorkflowRunStatus
  snapshot_nodes: unknown[]
  snapshot_edges: unknown[]
  compiled_loops: unknown[]
  requested_timeout_ms: number | null
  deadline_at: number | null
  started_at: number | null
  finished_at: number | null
  created_at: number
  error: string | null
  trigger_source: 'manual' | 'scheduled'
  scheduled_at: number | null
}

export interface WorkflowRunEdgeEvaluationRecord {
  id: string; run_id: string; workflow_id: string; edge_id: string; source_node_id: string; source_execution_id: string; iteration_path: unknown[]; target_node_id: string
  source_outcome: 'success' | 'failure' | 'skipped'; status: 'taken' | 'not_taken' | 'error'; route: 'success' | 'failure' | 'always'
  reason: string | null; sequence: number; orchestration: unknown; condition_evaluation: unknown | null; evaluated_at: number
}

export interface WorkflowRunLoopEpochRecord {
  id: string; run_id: string; workflow_id: string; loop_id: string; iteration: number; iteration_path: unknown[]
  status: 'completed' | 'failed' | 'canceled' | 'timed_out' | 'approval_rejected'; exit_reason: string | null; sequence: number; started_at: number; finished_at: number
}

export interface WorkflowRunWithEvidenceRecord extends WorkflowRunRecord {
  node_sessions: WorkflowRunNodeSessionRecord[]
  edge_evaluations: WorkflowRunEdgeEvaluationRecord[]
  loop_epochs: WorkflowRunLoopEpochRecord[]
}

export interface WorkflowRunNodeSessionRecord {
  id: string
  run_id: string
  workflow_id: string
  node_id: string
  execution_id: string
  iteration_path: unknown[]
  consumed_edge_evaluation_ids: string[]
  session_id: string
  profile: string
  agent: string
  agent_mode: string
  status: WorkflowRunNodeStatus
  sequence: number
  remaining_timeout_ms_at_start: number | null
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
  error: string | null
}

function profileName(value?: string | null): string {
  return value?.trim() || 'default'
}

function parseArrayJson(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function rowToRunRecord(row: Record<string, any>): WorkflowRunRecord {
  return {
    id: String(row.id || ''),
    workflow_id: String(row.workflow_id || ''),
    user_id: row.user_id == null ? null : Number(row.user_id),
    profile: profileName(row.profile),
    workspace: row.workspace == null || row.workspace === '' ? null : String(row.workspace),
    start_node_ids: parseArrayJson(row.start_node_ids_json ?? row.start_node_ids).map(String),
    status: String(row.status || 'queued') as WorkflowRunStatus,
    snapshot_nodes: parseArrayJson(row.snapshot_nodes_json ?? row.snapshot_nodes),
    snapshot_edges: parseArrayJson(row.snapshot_edges_json ?? row.snapshot_edges),
    compiled_loops: parseArrayJson(row.compiled_loops_json ?? row.compiled_loops),
    requested_timeout_ms: row.requested_timeout_ms == null ? null : Number(row.requested_timeout_ms),
    deadline_at: row.deadline_at == null ? null : Number(row.deadline_at),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at || 0),
    error: row.error == null || row.error === '' ? null : String(row.error),
    trigger_source: row.trigger_source === 'scheduled' ? 'scheduled' : 'manual',
    scheduled_at: row.scheduled_at == null ? null : Number(row.scheduled_at),
  }
}

function rowToNodeSessionRecord(row: Record<string, any>): WorkflowRunNodeSessionRecord {
  return {
    id: String(row.id || ''),
    run_id: String(row.run_id || ''),
    workflow_id: String(row.workflow_id || ''),
    node_id: String(row.node_id || ''),
    execution_id: String(row.execution_id || row.node_id || ''),
    iteration_path: parseArrayJson(row.iteration_path_json ?? row.iteration_path),
    consumed_edge_evaluation_ids: parseArrayJson(row.consumed_edge_evaluation_ids_json ?? row.consumed_edge_evaluation_ids).map(String),
    session_id: String(row.session_id || ''),
    profile: profileName(row.profile),
    agent: String(row.agent || ''),
    agent_mode: String(row.agent_mode || ''),
    status: String(row.status || 'queued') as WorkflowRunNodeStatus,
    sequence: Number(row.sequence || 0),
    remaining_timeout_ms_at_start: row.remaining_timeout_ms_at_start == null ? null : Number(row.remaining_timeout_ms_at_start),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    error: row.error == null || row.error === '' ? null : String(row.error),
  }
}

function parseObjectJson(value: unknown): unknown {
  if (value == null || value === '') return null
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return null }
}

function rowToEdgeEvaluationRecord(row: Record<string, any>): WorkflowRunEdgeEvaluationRecord {
  return { id: String(row.id), run_id: String(row.run_id), workflow_id: String(row.workflow_id), edge_id: String(row.edge_id),
    source_node_id: String(row.source_node_id), source_execution_id: String(row.source_execution_id || row.source_node_id),
    iteration_path: parseArrayJson(row.iteration_path_json ?? row.iteration_path), target_node_id: String(row.target_node_id), source_outcome: row.source_outcome,
    status: row.status, route: row.route, reason: row.reason == null ? null : String(row.reason), sequence: Number(row.sequence),
    orchestration: parseObjectJson(row.orchestration_json ?? row.orchestration),
    condition_evaluation: parseObjectJson(row.condition_evaluation_json ?? row.condition_evaluation), evaluated_at: Number(row.evaluated_at) }
}

export function createWorkflowRunEdgeEvaluation(input: Omit<WorkflowRunEdgeEvaluationRecord, 'id' | 'evaluated_at' | 'source_execution_id' | 'iteration_path'> & { id?: string; evaluated_at?: number; source_execution_id?: string; iteration_path?: unknown[] }): WorkflowRunEdgeEvaluationRecord {
  const run = getWorkflowRun(input.run_id)
  if (!run) throw new Error(`cannot append edge evidence to missing workflow run ${input.run_id}`)
  if (run.status !== 'queued' && run.status !== 'running') throw new Error(`cannot append edge evidence to terminal workflow run ${input.run_id}`)
  const record = { ...input, id: input.id?.trim() || randomUUID(), source_execution_id: input.source_execution_id?.trim() || input.source_node_id, iteration_path: input.iteration_path || [], reason: input.reason ?? null, evaluated_at: input.evaluated_at ?? Date.now() } as WorkflowRunEdgeEvaluationRecord
  const row = { ...record, iteration_path_json: JSON.stringify(record.iteration_path), orchestration_json: JSON.stringify(record.orchestration), condition_evaluation_json: record.condition_evaluation == null ? null : JSON.stringify(record.condition_evaluation) }
  const db = getDb()
  if (!db) { jsonSet(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, record.id, row as any); return record }
  db.prepare(`INSERT INTO ${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE} (id, run_id, workflow_id, edge_id, source_node_id, source_execution_id, iteration_path_json, target_node_id, source_outcome, status, route, reason, sequence, orchestration_json, condition_evaluation_json, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.run_id, record.workflow_id, record.edge_id, record.source_node_id, record.source_execution_id, row.iteration_path_json, record.target_node_id, record.source_outcome, record.status, record.route, record.reason, record.sequence, row.orchestration_json, row.condition_evaluation_json, record.evaluated_at)
  return record
}

export function listWorkflowRunEdgeEvaluations(runId: string): WorkflowRunEdgeEvaluationRecord[] {
  const db = getDb()
  if (!db) return Object.values(jsonGetAll(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE)).map(rowToEdgeEvaluationRecord).filter(item => item.run_id === runId).sort((a,b) => a.sequence - b.sequence)
  return (db.prepare(`SELECT * FROM ${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE} WHERE run_id = ? ORDER BY sequence ASC`).all(runId) as Record<string, any>[]).map(rowToEdgeEvaluationRecord)
}

function rowToLoopEpochRecord(row: Record<string, any>): WorkflowRunLoopEpochRecord {
  return { id: String(row.id), run_id: String(row.run_id), workflow_id: String(row.workflow_id), loop_id: String(row.loop_id),
    iteration: Number(row.iteration), iteration_path: parseArrayJson(row.iteration_path_json ?? row.iteration_path), status: row.status,
    exit_reason: row.exit_reason == null ? null : String(row.exit_reason), sequence: Number(row.sequence),
    started_at: Number(row.started_at), finished_at: Number(row.finished_at) }
}

type WorkflowRunLoopEpochInput = Omit<WorkflowRunLoopEpochRecord, 'id'> & { id?: string }

function insertWorkflowRunLoopEpoch(input: WorkflowRunLoopEpochInput): WorkflowRunLoopEpochRecord {
  const record = { ...input, id: input.id?.trim() || randomUUID(), exit_reason: input.exit_reason ?? null } as WorkflowRunLoopEpochRecord
  const row = { ...record, iteration_path_json: JSON.stringify(record.iteration_path) }
  const db = getDb()
  if (!db) { jsonSet(WORKFLOW_RUN_LOOP_EPOCHS_TABLE, record.id, row as any); return record }
  db.prepare(`INSERT INTO ${WORKFLOW_RUN_LOOP_EPOCHS_TABLE} (id, run_id, workflow_id, loop_id, iteration, iteration_path_json, status, exit_reason, sequence, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.id, record.run_id, record.workflow_id, record.loop_id, record.iteration, row.iteration_path_json, record.status, record.exit_reason, record.sequence, record.started_at, record.finished_at)
  return record
}

export function createWorkflowRunLoopEpoch(input: WorkflowRunLoopEpochInput): WorkflowRunLoopEpochRecord {
  const run = getWorkflowRun(input.run_id)
  if (!run) throw new Error(`cannot append loop evidence to missing workflow run ${input.run_id}`)
  const isCanceledTerminalEvidence = run.status === 'canceled' && input.status === 'canceled'
  if (run.status !== 'queued' && run.status !== 'running' && !isCanceledTerminalEvidence) throw new Error(`cannot append loop evidence to terminal workflow run ${input.run_id}`)
  return insertWorkflowRunLoopEpoch(input)
}

export function createWorkflowRunRecoveryLoopEpoch(input: WorkflowRunLoopEpochInput): WorkflowRunLoopEpochRecord {
  if (!getWorkflowRun(input.run_id)) throw new Error(`cannot append recovery loop evidence to missing workflow run ${input.run_id}`)
  return insertWorkflowRunLoopEpoch(input)
}

export function listWorkflowRunLoopEpochs(runId: string): WorkflowRunLoopEpochRecord[] {
  const db = getDb()
  if (!db) return Object.values(jsonGetAll(WORKFLOW_RUN_LOOP_EPOCHS_TABLE)).map(rowToLoopEpochRecord).filter(item => item.run_id === runId).sort((a,b) => a.sequence - b.sequence)
  return (db.prepare(`SELECT * FROM ${WORKFLOW_RUN_LOOP_EPOCHS_TABLE} WHERE run_id = ? ORDER BY sequence ASC`).all(runId) as Record<string, any>[]).map(rowToLoopEpochRecord)
}

export function createWorkflowRun(input: {
  id?: string
  workflow_id: string
  user_id?: number | null
  profile?: string | null
  workspace?: string | null
  start_node_ids?: string[]
  status?: WorkflowRunStatus
  snapshot_nodes?: unknown[]
  snapshot_edges?: unknown[]
  compiled_loops?: unknown[]
  requested_timeout_ms?: number | null
  deadline_at?: number | null
  started_at?: number | null
  error?: string | null
  trigger_source?: 'manual' | 'scheduled'
  scheduled_at?: number | null
}): WorkflowRunRecord {
  const now = Date.now()
  const record: WorkflowRunRecord = {
    id: input.id?.trim() || randomUUID(),
    workflow_id: input.workflow_id,
    user_id: input.user_id ?? null,
    profile: profileName(input.profile),
    workspace: input.workspace?.trim() || null,
    start_node_ids: input.start_node_ids || [],
    status: input.status || 'queued',
    snapshot_nodes: input.snapshot_nodes || [],
    snapshot_edges: input.snapshot_edges || [],
    compiled_loops: input.compiled_loops || [],
    requested_timeout_ms: input.requested_timeout_ms ?? null,
    deadline_at: input.deadline_at ?? null,
    started_at: input.started_at ?? null,
    finished_at: null,
    created_at: now,
    error: input.error || null,
    trigger_source: input.trigger_source === 'scheduled' ? 'scheduled' : 'manual',
    scheduled_at: input.scheduled_at ?? null,
  }
  const row = {
    id: record.id,
    workflow_id: record.workflow_id,
    user_id: record.user_id,
    profile: record.profile,
    workspace: record.workspace,
    start_node_ids_json: JSON.stringify(record.start_node_ids),
    status: record.status,
    snapshot_nodes_json: JSON.stringify(record.snapshot_nodes),
    snapshot_edges_json: JSON.stringify(record.snapshot_edges),
    compiled_loops_json: JSON.stringify(record.compiled_loops),
    requested_timeout_ms: record.requested_timeout_ms,
    deadline_at: record.deadline_at,
    started_at: record.started_at,
    finished_at: record.finished_at,
    created_at: record.created_at,
    error: record.error,
    trigger_source: record.trigger_source,
    scheduled_at: record.scheduled_at,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, record.id, row as any)
    return record
  }
  db.prepare(`
    INSERT INTO ${WORKFLOW_RUNS_TABLE} (
      id, workflow_id, profile, workspace, start_node_ids_json, status,
      snapshot_nodes_json, snapshot_edges_json, compiled_loops_json, requested_timeout_ms, deadline_at,
      started_at, finished_at, created_at, error, trigger_source, scheduled_at, user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.workflow_id,
    row.profile,
    row.workspace,
    row.start_node_ids_json,
    row.status,
    row.snapshot_nodes_json,
    row.snapshot_edges_json,
    row.compiled_loops_json,
    row.requested_timeout_ms,
    row.deadline_at,
    row.started_at,
    row.finished_at,
    row.created_at,
    row.error,
    row.trigger_source,
    row.scheduled_at,
    row.user_id,
  )
  return record
}

export function updateWorkflowRun(id: string, patch: {
  status?: WorkflowRunStatus
  requested_timeout_ms?: number | null
  deadline_at?: number | null
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
  allow_terminal_reset?: boolean
}): WorkflowRunRecord | null {
  const existing = getWorkflowRun(id)
  if (!existing) return null
  const terminalStatuses: WorkflowRunStatus[] = ['completed', 'failed', 'canceled']
  if (patch.status && terminalStatuses.includes(existing.status) && patch.status !== existing.status && !patch.allow_terminal_reset) return existing
  const next: WorkflowRunRecord = {
    ...existing,
    status: patch.status ?? existing.status,
    requested_timeout_ms: patch.requested_timeout_ms === undefined ? existing.requested_timeout_ms : patch.requested_timeout_ms,
    deadline_at: patch.deadline_at === undefined ? existing.deadline_at : patch.deadline_at,
    started_at: patch.started_at === undefined ? existing.started_at : patch.started_at,
    finished_at: patch.finished_at === undefined ? existing.finished_at : patch.finished_at,
    error: patch.error === undefined ? existing.error : patch.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUNS_TABLE, id, {
      ...next,
      start_node_ids_json: JSON.stringify(next.start_node_ids),
      snapshot_nodes_json: JSON.stringify(next.snapshot_nodes),
      snapshot_edges_json: JSON.stringify(next.snapshot_edges),
      compiled_loops_json: JSON.stringify(next.compiled_loops),
    } as any)
    return next
  }
  db.prepare(`
    UPDATE ${WORKFLOW_RUNS_TABLE}
    SET status = ?, requested_timeout_ms = ?, deadline_at = ?, started_at = ?, finished_at = ?, error = ?
    WHERE id = ?
  `).run(next.status, next.requested_timeout_ms, next.deadline_at, next.started_at, next.finished_at, next.error, id)
  return next
}

export function getWorkflowRun(id: string): WorkflowRunRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOW_RUNS_TABLE, id)
    return row ? rowToRunRecord(row) : null
  }
  const row = db.prepare(`SELECT * FROM ${WORKFLOW_RUNS_TABLE} WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToRunRecord(row) : null
}

/** Node sessions retain their root owner even when a node uses another Profile. */
export function getWorkflowRunForSession(sessionId: string, profile: string): WorkflowRunRecord | null {
  const db = getDb()
  if (!db) {
    const node = Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE))
      .map(rowToNodeSessionRecord).find(item => item.session_id === sessionId && item.profile === profile)
    return node ? getWorkflowRun(node.run_id) : null
  }
  const row = db.prepare(`SELECT r.* FROM ${WORKFLOW_RUNS_TABLE} r
    JOIN ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} n ON n.run_id = r.id
    WHERE n.session_id = ? AND n.profile = ? LIMIT 1`).get(sessionId, profile) as Record<string, any> | undefined
  return row ? rowToRunRecord(row) : null
}

/** Load the complete append-only execution evidence contract or fail the read. */
export function getWorkflowRunWithEvidence(id: string): WorkflowRunWithEvidenceRecord | null {
  const run = getWorkflowRun(id)
  if (!run) return null
  return {
    ...run,
    node_sessions: listWorkflowRunNodeSessions(id),
    edge_evaluations: listWorkflowRunEdgeEvaluations(id),
    loop_epochs: listWorkflowRunLoopEpochs(id),
  }
}

export function listWorkflowRunsWithEvidence(workflowId?: string | null, limit = 100): WorkflowRunWithEvidenceRecord[] {
  return listWorkflowRuns(workflowId, limit).map(run => {
    const hydrated = getWorkflowRunWithEvidence(run.id)
    if (!hydrated) throw new Error(`workflow run ${run.id} disappeared while loading evidence`)
    return hydrated
  })
}

export function deleteWorkflowRun(id: string): boolean {
  const existing = getWorkflowRun(id)
  if (!existing) return false
  const db = getDb()
  if (!db) {
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE)).map(rowToEdgeEvaluationRecord)) {
      if (record.run_id === id) jsonDelete(WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE, record.id)
    }
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_LOOP_EPOCHS_TABLE)).map(rowToLoopEpochRecord)) {
      if (record.run_id === id) jsonDelete(WORKFLOW_RUN_LOOP_EPOCHS_TABLE, record.id)
    }
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE)).map(rowToNodeSessionRecord)) {
      if (record.run_id === id) jsonDelete(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id)
    }
    jsonDelete(WORKFLOW_RUNS_TABLE, id)
    return true
  }
  db.exec('BEGIN')
  try {
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_EDGE_EVALUATIONS_TABLE} WHERE run_id = ?`).run(id)
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_LOOP_EPOCHS_TABLE} WHERE run_id = ?`).run(id)
    db.prepare(`DELETE FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} WHERE run_id = ?`).run(id)
    db.prepare(`DELETE FROM ${WORKFLOW_RUNS_TABLE} WHERE id = ?`).run(id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return true
}

export function listAllWorkflowRuns(workflowId?: string | null): WorkflowRunRecord[] {
  const normalizedWorkflowId = workflowId?.trim() || ''
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUNS_TABLE))
      .map(rowToRunRecord)
      .filter(record => !normalizedWorkflowId || record.workflow_id === normalizedWorkflowId)
      .sort((a, b) => b.created_at - a.created_at)
  }
  const rows = normalizedWorkflowId
    ? db.prepare(`SELECT * FROM ${WORKFLOW_RUNS_TABLE} WHERE workflow_id = ? ORDER BY created_at DESC`).all(normalizedWorkflowId)
    : db.prepare(`SELECT * FROM ${WORKFLOW_RUNS_TABLE} ORDER BY created_at DESC`).all()
  return (rows as Record<string, any>[]).map(rowToRunRecord)
}

export function listActiveWorkflowRuns(): WorkflowRunRecord[] {
  const db = getDb()
  if (!db) return listAllWorkflowRuns().filter(run => run.status === 'queued' || run.status === 'running')
  const rows = db.prepare(`SELECT * FROM ${WORKFLOW_RUNS_TABLE} WHERE status IN ('queued', 'running') ORDER BY created_at DESC`).all() as Record<string, any>[]
  return rows.map(rowToRunRecord)
}

export function listWorkflowRuns(workflowId?: string | null, limit = 100): WorkflowRunRecord[] {
  const normalizedWorkflowId = workflowId?.trim() || ''
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit) || 100))
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUNS_TABLE))
      .map(rowToRunRecord)
      .filter(record => !normalizedWorkflowId || record.workflow_id === normalizedWorkflowId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, safeLimit)
  }
  if (normalizedWorkflowId) {
    const rows = db.prepare(`
      SELECT * FROM ${WORKFLOW_RUNS_TABLE}
      WHERE workflow_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(normalizedWorkflowId, safeLimit) as Record<string, any>[]
    return rows.map(rowToRunRecord)
  }
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUNS_TABLE}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(safeLimit) as Record<string, any>[]
  return rows.map(rowToRunRecord)
}

export function createWorkflowRunNodeSession(input: {
  id?: string
  run_id: string
  workflow_id: string
  node_id: string
  execution_id?: string
  iteration_path?: unknown[]
  consumed_edge_evaluation_ids?: string[]
  session_id: string
  profile?: string | null
  agent?: string | null
  agent_mode?: string | null
  status?: WorkflowRunNodeStatus
  sequence?: number
  remaining_timeout_ms_at_start?: number | null
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunNodeSessionRecord {
  const run = getWorkflowRun(input.run_id)
  if (!run) throw new Error(`cannot create node execution for missing workflow run ${input.run_id}`)
  if (run.status !== 'queued' && run.status !== 'running') {
    throw new Error(`cannot create node execution for terminal workflow run ${input.run_id}`)
  }
  const now = Date.now()
  const record: WorkflowRunNodeSessionRecord = {
    id: input.id?.trim() || randomUUID(),
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    node_id: input.node_id,
    execution_id: input.execution_id?.trim() || input.node_id,
    iteration_path: input.iteration_path || [],
    consumed_edge_evaluation_ids: input.consumed_edge_evaluation_ids || [],
    session_id: input.session_id,
    profile: profileName(input.profile),
    agent: input.agent?.trim() || '',
    agent_mode: input.agent_mode?.trim() || '',
    status: input.status || 'queued',
    sequence: input.sequence || 0,
    remaining_timeout_ms_at_start: input.remaining_timeout_ms_at_start ?? null,
    started_at: input.started_at ?? null,
    finished_at: input.finished_at ?? null,
    created_at: now,
    updated_at: now,
    error: input.error || null,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id, record as any)
    return record
  }
  db.prepare(`
    INSERT INTO ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} (
      id, run_id, workflow_id, node_id, execution_id, iteration_path_json, consumed_edge_evaluation_ids_json, session_id, profile, agent, agent_mode,
      status, sequence, remaining_timeout_ms_at_start, started_at, finished_at, created_at, updated_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.run_id,
    record.workflow_id,
    record.node_id,
    record.execution_id,
    JSON.stringify(record.iteration_path),
    JSON.stringify(record.consumed_edge_evaluation_ids),
    record.session_id,
    record.profile,
    record.agent,
    record.agent_mode,
    record.status,
    record.sequence,
    record.remaining_timeout_ms_at_start,
    record.started_at,
    record.finished_at,
    record.created_at,
    record.updated_at,
    record.error,
  )
  return record
}

export function updateWorkflowRunNodeSession(id: string, patch: {
  status?: WorkflowRunNodeStatus
  started_at?: number | null
  finished_at?: number | null
  error?: string | null
}): WorkflowRunNodeSessionRecord | null {
  const existing = getWorkflowRunNodeSession(id)
  if (!existing) return null
  const terminalStatuses: WorkflowRunNodeStatus[] = ['completed', 'failed', 'blocked', 'approval_rejected', 'canceled']
  if (patch.status && terminalStatuses.includes(existing.status) && patch.status !== existing.status) return existing
  const next: WorkflowRunNodeSessionRecord = {
    ...existing,
    status: patch.status ?? existing.status,
    started_at: patch.started_at === undefined ? existing.started_at : patch.started_at,
    finished_at: patch.finished_at === undefined ? existing.finished_at : patch.finished_at,
    updated_at: Date.now(),
    error: patch.error === undefined ? existing.error : patch.error,
  }
  const db = getDb()
  if (!db) {
    jsonSet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, id, next as any)
    return next
  }
  db.prepare(`
    UPDATE ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    SET status = ?, started_at = ?, finished_at = ?, updated_at = ?, error = ?
    WHERE id = ?
  `).run(next.status, next.started_at, next.finished_at, next.updated_at, next.error, id)
  return next
}

export function getWorkflowRunNodeSession(id: string): WorkflowRunNodeSessionRecord | null {
  const db = getDb()
  if (!db) {
    const row = jsonGet(WORKFLOW_RUN_NODE_SESSIONS_TABLE, id)
    return row ? rowToNodeSessionRecord(row) : null
  }
  const row = db.prepare(`SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE} WHERE id = ?`).get(id) as Record<string, any> | undefined
  return row ? rowToNodeSessionRecord(row) : null
}

export function listWorkflowRunNodeSessions(runId: string): WorkflowRunNodeSessionRecord[] {
  const db = getDb()
  if (!db) {
    return Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE))
      .map(rowToNodeSessionRecord)
      .filter(record => record.run_id === runId)
      .sort((a, b) => a.sequence - b.sequence)
  }
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ?
    ORDER BY sequence ASC
  `).all(runId) as Record<string, any>[]
  return rows.map(rowToNodeSessionRecord)
}

export function deleteWorkflowRunNodeSessions(runId: string, nodeIds: string[]): WorkflowRunNodeSessionRecord[] {
  const normalizedRunId = runId.trim()
  const nodeIdSet = new Set(nodeIds.map(id => id.trim()).filter(Boolean))
  if (!normalizedRunId || nodeIdSet.size === 0) return []

  const db = getDb()
  if (!db) {
    const deleted: WorkflowRunNodeSessionRecord[] = []
    for (const record of Object.values(jsonGetAll(WORKFLOW_RUN_NODE_SESSIONS_TABLE)).map(rowToNodeSessionRecord)) {
      if (record.run_id !== normalizedRunId || !nodeIdSet.has(record.node_id)) continue
      deleted.push(record)
      jsonDelete(WORKFLOW_RUN_NODE_SESSIONS_TABLE, record.id)
    }
    return deleted.sort((a, b) => a.sequence - b.sequence)
  }

  const placeholders = [...nodeIdSet].map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT * FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ? AND node_id IN (${placeholders})
    ORDER BY sequence ASC
  `).all(normalizedRunId, ...nodeIdSet) as Record<string, any>[]
  db.prepare(`
    DELETE FROM ${WORKFLOW_RUN_NODE_SESSIONS_TABLE}
    WHERE run_id = ? AND node_id IN (${placeholders})
  `).run(normalizedRunId, ...nodeIdSet)
  return rows.map(rowToNodeSessionRecord)
}
