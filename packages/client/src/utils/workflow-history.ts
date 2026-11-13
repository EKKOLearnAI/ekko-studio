import type { WorkflowRunNodeSessionRecord, WorkflowRunRecord } from '@/api/studio/workflows'

export type WorkflowEvidenceKind = 'node' | 'edge' | 'loop'
export interface WorkflowEvidenceRow {
  kind: WorkflowEvidenceKind
  sequence: number
  technicalId: string
  evaluationId?: string
  consumed?: boolean
  status: string
  iterationPath: string
  nodeTitle?: string
  sourceTitle?: string
  targetTitle?: string
  route?: string
  reason?: string | null
  sourceOutcome?: string
  conditionPath?: string
  conditionOperator?: string
  expectedValue?: string
  conditionActualValue?: string
  conditionMatched?: boolean
  businessDecision?: string
  businessGate?: string
  businessReason?: string
  loopTitle?: string
  iteration?: number
  exitReason?: string | null
  error?: string | null
}

export interface WorkflowEvidenceSummary {
  businessDecision?: string
  businessGate?: string
  businessReason?: string
  takenEdges: WorkflowEvidenceRow[]
  actualPathEdges: WorkflowEvidenceRow[]
  notTakenEdges: WorkflowEvidenceRow[]
  supplementalRows: WorkflowEvidenceRow[]
  otherRows: WorkflowEvidenceRow[]
}

export type WorkflowEdgePlaybackState =
  | 'idle' | 'inactive'
  | 'flowing' | 'completed'
  | 'blocked-flowing' | 'blocked'
  | 'failed-flowing' | 'failed'

export function formatIterationPath(raw: unknown, loopTitles = new Map<string, string>()): string {
  if (!Array.isArray(raw) || raw.length === 0) return '—'
  const values = raw.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : {})
  const scopes = [...new Set(values.flatMap(value => typeof value.executionScope === 'string' ? [value.executionScope] : []))]
  const path = values.flatMap(value => {
    if (typeof value.loopId !== 'string') return []
    const iteration = Number.isInteger(value.iteration) ? Number(value.iteration) + 1 : '?'
    const loopId = value.loopId
    return [`${loopTitles.get(loopId) || loopId}#${iteration}`]
  }).join(' / ')
  if (scopes.length > 0 && path) return `${scopes.join(' / ')} · ${path}`
  return scopes.length > 0 ? scopes.join(' / ') : path || '—'
}

export function latestWorkflowNodeSession(
  sessions: WorkflowRunNodeSessionRecord[] | undefined,
  nodeId: string,
): WorkflowRunNodeSessionRecord | undefined {
  return (sessions || []).reduce<WorkflowRunNodeSessionRecord | undefined>((latest, session) => {
    if (session.node_id !== nodeId) return latest
    if (!latest || session.sequence > latest.sequence) return session
    return latest
  }, undefined)
}

export function workflowNodeSessionByExecution(
  sessions: WorkflowRunNodeSessionRecord[] | undefined,
  nodeId: string,
  executionId: string,
): WorkflowRunNodeSessionRecord | undefined {
  return (sessions || []).find(session => session.node_id === nodeId && session.execution_id === executionId)
}

function workflowNodeTitleMap(snapshotNodes: unknown[] | undefined): Map<string, string> {
  const titles = new Map<string, string>()
  for (const raw of snapshotNodes || []) {
    if (!raw || typeof raw !== 'object') continue
    const node = raw as Record<string, unknown>
    if (typeof node.id !== 'string') continue
    const data = node.data && typeof node.data === 'object' ? node.data as Record<string, unknown> : {}
    const title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : undefined
    if (title) titles.set(node.id, title)
  }
  return titles
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function workflowLoopTitleMap(snapshotNodes: unknown[] | undefined, compiledLoops: unknown[] | undefined): Map<string, string> {
  const nodeTitles = workflowNodeTitleMap(snapshotNodes)
  const titles = new Map<string, string>()
  for (const raw of compiledLoops || []) {
    const loop = recordValue(raw)
    const loopId = nonEmptyText(loop?.id)
    if (!loopId) continue
    const selectedNodeId = nodeTitles.has(loopId) ? loopId : nonEmptyText(loop?.headerNodeId)
    const title = selectedNodeId ? nodeTitles.get(selectedNodeId) : undefined
    if (title) titles.set(loopId, title)
  }
  return titles
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedSummaryText(value: unknown, maxLength = 600): string | undefined {
  const raw = nonEmptyText(value)
  if (!raw) return undefined
  const normalized = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function displayValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}...` : normalized
  }
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return undefined
    return serialized.length > 240 ? `${serialized.slice(0, 237)}...` : serialized
  } catch {
    return String(value)
  }
}

function parseBusinessResult(value: unknown): Record<string, unknown> | null {
  const direct = recordValue(value)
  if (direct) return direct
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return recordValue(JSON.parse(trimmed))
  } catch {
    // Match the runtime contract for one explicit JSON fence.
  }

  const fenceOpenings = [...trimmed.matchAll(/```json\b/gi)]
  if (fenceOpenings.length !== 1) return null
  const fencedJson = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (fencedJson.length !== 1) return null
  try {
    return recordValue(JSON.parse(fencedJson[0][1].trim()))
  } catch {
    return null
  }
}

function businessReason(result: Record<string, unknown> | null): string | undefined {
  if (!result) return undefined
  const direct = boundedSummaryText(result.reason) || boundedSummaryText(result.root_cause) || boundedSummaryText(result.message) || boundedSummaryText(result.error)
  if (direct) return direct
  if (Array.isArray(result.blocking_reasons)) {
    const reasons = result.blocking_reasons
      .map(item => boundedSummaryText(item, 200))
      .filter((item): item is string => Boolean(item))
    if (reasons.length > 0) return boundedSummaryText(reasons.join('; '))
  }
  return undefined
}

export function buildWorkflowEvidenceRows(
  run: Pick<WorkflowRunRecord, 'snapshot_nodes' | 'node_sessions' | 'edge_evaluations' | 'loop_epochs'>
    & Partial<Pick<WorkflowRunRecord, 'compiled_loops' | 'started_at'>>,
): WorkflowEvidenceRow[] {
  const rows: WorkflowEvidenceRow[] = []
  const nodeTitles = workflowNodeTitleMap(run.snapshot_nodes)
  const loopTitles = workflowLoopTitleMap(run.snapshot_nodes, run.compiled_loops)
  const nodeTitle = (nodeId: string) => nodeTitles.get(nodeId)
  const currentEpochSessions = (run.node_sessions || []).filter(session => (
    run.started_at == null || (session.started_at != null && session.started_at >= run.started_at)
  ))
  const consumedEdgeEvaluationIds = new Set(currentEpochSessions.flatMap(
    session => session.consumed_edge_evaluation_ids || [],
  ))
  const hasConsumptionEvidence = consumedEdgeEvaluationIds.size > 0
  const exceptionalNodeStatuses = new Set(['failed', 'blocked', 'approval_rejected', 'canceled'])
  for (const node of currentEpochSessions) {
    if (!exceptionalNodeStatuses.has(node.status)) continue
    rows.push({
      kind: 'node', sequence: node.sequence, technicalId: node.execution_id, status: node.status,
      nodeTitle: nodeTitle(node.node_id), error: node.error, iterationPath: formatIterationPath(node.iteration_path, loopTitles),
    })
  }
  const currentEpochEdges = (run.edge_evaluations || []).filter(edge => (
    consumedEdgeEvaluationIds.has(edge.id)
    || run.started_at == null
    || edge.evaluated_at == null
    || edge.evaluated_at >= run.started_at
  ))
  for (const edge of currentEpochEdges) {
    const orchestration = recordValue(edge.orchestration)
    const condition = recordValue(orchestration?.condition)
    const evaluation = recordValue(edge.condition_evaluation)
    const actual = evaluation?.actual
    const hasConditionActual = Boolean(evaluation && Object.prototype.hasOwnProperty.call(evaluation, 'actual'))
    const result = parseBusinessResult(actual)
    const conditionPath = nonEmptyText(condition?.path)
    const decisionField = conditionPath === 'outputJson.decision' || conditionPath === 'outputJson.route_marker'
    const decision = decisionField
      ? boundedSummaryText(actual, 80)
      : boundedSummaryText(result?.decision, 80)
    const evaluationStatus = nonEmptyText(evaluation?.status)
    rows.push({
      kind: 'edge', sequence: edge.sequence, technicalId: edge.edge_id, status: edge.status,
      evaluationId: edge.id,
      consumed: edge.id && hasConsumptionEvidence
        ? consumedEdgeEvaluationIds.has(edge.id)
        : currentEpochSessions.length > 0 && !currentEpochSessions.some(session => (
            session.node_id === edge.target_node_id
          ))
          ? false
          : undefined,
      sourceTitle: nodeTitle(edge.source_node_id), targetTitle: nodeTitle(edge.target_node_id),
      route: edge.route, reason: edge.reason, sourceOutcome: edge.source_outcome,
      conditionPath, conditionOperator: nonEmptyText(condition?.operator),
      expectedValue: displayValue(condition?.value),
      conditionActualValue: hasConditionActual ? (actual === undefined ? 'undefined' : displayValue(actual)) : undefined,
      conditionMatched: evaluationStatus === 'matched' ? true : evaluationStatus === 'not_matched' ? false : undefined,
      businessDecision: decision,
      businessGate: boundedSummaryText(result?.failed_gate, 120),
      businessReason: businessReason(result),
      iterationPath: formatIterationPath(edge.iteration_path, loopTitles),
    })
  }
  const currentEpochLoops = (run.loop_epochs || []).filter(loop => (
    run.started_at == null || loop.started_at == null || loop.started_at >= run.started_at
  ))
  for (const loop of currentEpochLoops) rows.push({
    kind: 'loop', sequence: loop.sequence, technicalId: loop.loop_id, status: loop.status,
    loopTitle: loopTitles.get(loop.loop_id), iteration: loop.iteration, exitReason: loop.exit_reason,
    iterationPath: formatIterationPath(loop.iteration_path, loopTitles),
  })
  return rows.sort((a, b) => a.sequence - b.sequence || a.kind.localeCompare(b.kind) || a.technicalId.localeCompare(b.technicalId))
}

export function summarizeWorkflowEvidenceRows(rows: WorkflowEvidenceRow[]): WorkflowEvidenceSummary {
  const edgeRows = rows.filter(row => row.kind === 'edge')
  const takenEdges = edgeRows.filter(row => row.consumed === true || (row.consumed === undefined && row.status === 'taken'))
  const notTakenEdges = edgeRows.filter(row => !takenEdges.includes(row))
  const nonEdgeRows = rows.filter(row => row.kind !== 'edge')
  const actualPathEdges = takenEdges
  const businessRow = takenEdges.find(row => row.businessDecision || row.businessGate || row.businessReason)
    || notTakenEdges.find(row => row.businessDecision || row.businessGate || row.businessReason)
    || nonEdgeRows.find(row => row.businessDecision || row.businessGate || row.businessReason)
  return {
    businessDecision: businessRow?.businessDecision,
    businessGate: businessRow?.businessGate,
    businessReason: businessRow?.businessReason,
    takenEdges,
    actualPathEdges,
    notTakenEdges,
    supplementalRows: nonEdgeRows,
    otherRows: [...notTakenEdges, ...nonEdgeRows],
  }
}

export function workflowEdgePlaybackState(
  edgeId: string,
  targetNodeStatus: string,
  runStatus: string,
  rows: WorkflowEvidenceRow[],
): WorkflowEdgePlaybackState {
  const evidenceRows = rows.filter(row => row.kind === 'edge' && row.technicalId === edgeId)
  if (evidenceRows.length === 0) return 'idle'
  const takenRows = evidenceRows.filter(row => row.consumed === true || (row.consumed === undefined && row.status === 'taken'))
  if (takenRows.length === 0) return evidenceRows.some(row => row.status === 'error') ? 'failed' : 'inactive'

  const latestTaken = takenRows[takenRows.length - 1]
  const summary = summarizeWorkflowEvidenceRows(rows)
  const businessBlocked = summary.businessGate || summary.businessDecision?.trim().toUpperCase() === 'BLOCKED'
  const failedPath = latestTaken.sourceOutcome === 'failure'
    || ['failed', 'blocked', 'approval_rejected', 'canceled'].includes(targetNodeStatus)
  const active = ['queued', 'running', 'pending_approval'].includes(targetNodeStatus)
    || (targetNodeStatus === 'idle' && (runStatus === 'queued' || runStatus === 'running'))
  if (active) return failedPath ? 'failed-flowing' : businessBlocked ? 'blocked-flowing' : 'flowing'
  return failedPath ? 'failed' : businessBlocked ? 'blocked' : 'completed'
}
