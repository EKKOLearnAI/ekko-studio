import { request } from '../client'

export interface WorkflowViewport {
  x: number
  y: number
  zoom: number
}

export interface WorkflowRecord {
  id: string
  name: string
  profile: string
  workspace: string | null
  nodes: unknown[]
  edges: unknown[]
  viewport: WorkflowViewport | Record<string, unknown> | null
  created_at: number
  updated_at: number
}

export interface WorkflowCreateRequest {
  name: string
  profile?: string | null
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: WorkflowViewport
}

export interface WorkflowUpdateRequest {
  name?: string
  workspace?: string | null
  nodes?: unknown[]
  edges?: unknown[]
  viewport?: WorkflowViewport
}

export interface WorkflowBatchDeleteResult {
  deleted: number
  failed: number
  errors: Array<{ id: string; error: string }>
}

export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
export type WorkflowRunNodeStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'approval_rejected' | 'canceled'

export interface WorkflowRunRecord {
  id: string
  workflow_id: string
  profile: string
  workspace: string | null
  start_node_ids: string[]
  status: WorkflowRunStatus
  snapshot_nodes: unknown[]
  snapshot_edges: unknown[]
  compiled_loops: unknown[]
  requested_timeout_ms?: number | null
  deadline_at?: number | null
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at?: number
  error: string | null
  trigger_source?: 'manual' | 'scheduled'
  scheduled_at?: number | null
  node_sessions?: WorkflowRunNodeSessionRecord[]
  edge_evaluations?: WorkflowRunEdgeEvaluationRecord[]
  loop_epochs?: WorkflowRunLoopEpochRecord[]
  quality_evaluations?: WorkflowRunQualityEvaluationRecord[]
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
  remaining_timeout_ms_at_start?: number | null
  started_at: number | null
  finished_at: number | null
  created_at: number
  updated_at: number
  error: string | null
}

export interface WorkflowRunQualityEvaluationRecord {
  id: string; run_id: string; workflow_id: string; node_session_id: string; node_id: string; execution_id: string
  iteration_path: unknown[]; input_hash: string; config_hash: string; status: 'completed' | 'skipped'
  decision: 'pass' | 'needs_improvement' | 'unknown'
  criteria: Array<{ id: string; decision: 'pass' | 'needs_improvement' | 'unknown'; confidence?: number; evidenceRefs: string[] }>
  reason_code: string; duration_ms: number; created_at: number
}

export interface WorkflowRunEdgeEvaluationRecord {
  id: string
  run_id: string
  workflow_id: string
  edge_id: string
  source_node_id: string
  source_execution_id: string
  iteration_path: unknown[]
  target_node_id: string
  source_outcome: 'success' | 'failure' | 'skipped'
  status: 'taken' | 'not_taken' | 'error'
  route: 'success' | 'failure' | 'always'
  reason: string | null
  sequence: number
  orchestration: unknown
  condition_evaluation: unknown | null
  evaluated_at: number
}

export interface WorkflowRunLoopEpochRecord {
  id: string
  run_id: string
  workflow_id: string
  loop_id: string
  iteration: number
  iteration_path: unknown[]
  status: 'completed' | 'failed' | 'canceled' | 'timed_out' | 'approval_rejected'
  exit_reason: string | null
  sequence: number
  started_at: number
  finished_at: number
}

export interface WorkflowExportEnvelope {
  format: 'hermes-studio.workflow'
  version: 1
  definition: { name: string; nodes: unknown[]; edges: unknown[]; viewport: WorkflowViewport | Record<string, unknown> | null }
}

export interface WorkflowImportPreview {
  token: string
  digest: string
  expiresAt: number
  summary: { name: string; nodes: number; edges: number }
}

export interface WorkflowRunNowRequest {
  start_node_ids?: string[]
  input?: string | null
  timeout_ms?: number
}

export interface WorkflowRerunFromNodeRequest {
  preserve_start_node?: boolean
  timeout_ms?: number
}

export interface WorkflowRunNowResult {
  run: WorkflowRunRecord
  nodeSessions: WorkflowRunNodeSessionRecord[]
}

export interface WorkflowRunStartResult {
  ok: true
  status: 'accepted'
}

function appendProfile(path: string, profile?: string | null): string {
  if (!profile) return path
  const params = new URLSearchParams()
  params.set('profile', profile)
  return `${path}?${params}`
}

export async function listWorkflows(profile?: string | null): Promise<WorkflowRecord[]> {
  const path = appendProfile('/api/studio/workflows', profile)
  const res = await request<{ workflows: WorkflowRecord[] }>(path)
  return res.workflows
}

export async function fetchWorkflow(id: string): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>(`/api/studio/workflows/${encodeURIComponent(id)}`)
  return res.workflow
}

export async function createWorkflow(input: WorkflowCreateRequest): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>('/api/studio/workflows', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.workflow
}

export async function updateWorkflow(id: string, patch: WorkflowUpdateRequest): Promise<WorkflowRecord> {
  const res = await request<{ workflow: WorkflowRecord }>(`/api/studio/workflows/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  return res.workflow
}

export async function deleteWorkflow(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/studio/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function batchDeleteWorkflows(ids: string[]): Promise<WorkflowBatchDeleteResult> {
  return request<WorkflowBatchDeleteResult>('/api/studio/workflows/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export async function exportWorkflow(id: string): Promise<WorkflowExportEnvelope> {
  return request<WorkflowExportEnvelope>(`/api/studio/workflows/${encodeURIComponent(id)}/export`)
}

export async function previewWorkflowImport(document: string, profile?: string | null): Promise<WorkflowImportPreview> {
  const res = await request<{ ok: true; preview: WorkflowImportPreview }>('/api/studio/workflows/import/preview', {
    method: 'POST', body: JSON.stringify({ document, profile }),
  })
  return res.preview
}

export async function cancelWorkflowImport(token: string, profile?: string | null): Promise<void> {
  await request<{ ok: true }>('/api/studio/workflows/import/cancel', {
    method: 'POST', body: JSON.stringify({ token, profile }),
  })
}

export async function confirmWorkflowImport(token: string, profile?: string | null): Promise<WorkflowRecord> {
  const res = await request<{ ok: true; workflow: WorkflowRecord }>('/api/studio/workflows/import/confirm', {
    method: 'POST', body: JSON.stringify({ token, profile }),
  })
  return res.workflow
}

export async function listWorkflowRuns(id: string, limit = 100): Promise<WorkflowRunRecord[]> {
  const params = new URLSearchParams()
  params.set('limit', String(limit))
  const res = await request<{ runs: WorkflowRunRecord[] }>(`/api/studio/workflows/${encodeURIComponent(id)}/runs?${params}`)
  return res.runs
}

export async function fetchWorkflowRun(id: string, runId: string): Promise<WorkflowRunRecord> {
  const res = await request<{ run: WorkflowRunRecord }>(
    `/api/studio/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
  )
  return res.run
}

export async function stopWorkflowRun(id: string, runId: string): Promise<WorkflowRunRecord> {
  const res = await request<{ ok: true; run: WorkflowRunRecord }>(
    `/api/studio/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/stop`,
    { method: 'POST' },
  )
  return res.run
}

export async function deleteWorkflowRun(id: string, runId: string): Promise<void> {
  await request<{ ok: true }>(
    `/api/studio/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
  )
}

export async function approveWorkflowNode(id: string, runId: string, nodeId: string, approved: boolean, executionId?: string): Promise<void> {
  await request<{ ok: true }>(
    `/api/studio/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
    {
      method: 'POST',
      body: JSON.stringify({ approved, ...(executionId ? { executionId } : {}) }),
    },
  )
}

export async function runWorkflowNow(id: string, input: WorkflowRunNowRequest = {}): Promise<WorkflowRunStartResult> {
  return request<WorkflowRunStartResult>(`/api/studio/workflows/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function rerunWorkflowRunFromNode(
  id: string,
  runId: string,
  nodeId: string,
  input: WorkflowRerunFromNodeRequest = {},
): Promise<WorkflowRunStartResult> {
  return request<WorkflowRunStartResult>(
    `/api/studio/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/rerun-from-node`,
    {
      method: 'POST',
      body: JSON.stringify({
        ...input,
        node_id: nodeId,
      }),
    },
  )
}

export interface WorkflowScheduleRecord {
  id: string
  workflow_id: string
  profile: string
  schedule: string
  timezone: string
  enabled: boolean
  input: string | null
  start_node_ids: string[]
  timeout_ms: number | null
  concurrency_policy: 'skip'
  misfire_policy: 'skip'
  last_scheduled_at: number | null
  next_run_at: number | null
  last_run_id: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface WorkflowScheduleRequest {
  schedule: string
  timezone: string
  enabled?: boolean
  input?: string | null
  start_node_ids?: string[]
  timeout_ms?: number | null
}

export async function listWorkflowSchedules(id: string): Promise<WorkflowScheduleRecord[]> {
  const res = await request<{ schedules: WorkflowScheduleRecord[] }>(`/api/studio/workflows/${encodeURIComponent(id)}/schedules`)
  return res.schedules
}

export async function createWorkflowSchedule(id: string, input: WorkflowScheduleRequest): Promise<WorkflowScheduleRecord> {
  const res = await request<{ schedule: WorkflowScheduleRecord }>(`/api/studio/workflows/${encodeURIComponent(id)}/schedules`, { method: 'POST', body: JSON.stringify(input) })
  return res.schedule
}

export async function updateWorkflowSchedule(id: string, scheduleId: string, input: Partial<WorkflowScheduleRequest>): Promise<WorkflowScheduleRecord> {
  const res = await request<{ schedule: WorkflowScheduleRecord }>(`/api/studio/workflows/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: 'PATCH', body: JSON.stringify(input) })
  return res.schedule
}

export async function deleteWorkflowSchedule(id: string, scheduleId: string): Promise<void> {
  await request<{ ok: true }>(`/api/studio/workflows/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' })
}
