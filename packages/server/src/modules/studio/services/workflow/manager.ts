import { bindRunPushTarget, pushRunTransaction, type PushActor } from '../../repositories/run-push-store'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowCreateInput,
  type WorkflowRecord,
  type WorkflowUpdateInput,
} from '../../repositories/workflow-store'
import {
  createWorkflowRun,
  createWorkflowRunEdgeEvaluation,
  createWorkflowRunLoopEpoch,
  createWorkflowRunRecoveryLoopEpoch,
  createWorkflowRunNodeSession,
  deleteWorkflowRun,
  getWorkflowRun,
  listWorkflowRunNodeSessions,
  listWorkflowRunEdgeEvaluations,
  listWorkflowRunLoopEpochs,
  listActiveWorkflowRuns,
  listAllWorkflowRuns,
  listWorkflowRuns,
  updateWorkflowRun,
  updateWorkflowRunNodeSession,
  type WorkflowRunEdgeEvaluationRecord,
  type WorkflowRunNodeSessionRecord,
  type WorkflowRunNodeStatus,
  type WorkflowRunRecord,
} from '../../repositories/workflow-run-store'
import { createSession, deleteSession, getSession, getSessionDetail } from '../../repositories/session-store'
import type { ContentBlock } from '../../contracts/runs/session'
import type { AuthenticatedUser } from '../../public/auth'
import { resolveWorkflowSkillContent } from './skill-resolver'
import {
  abortWorkflowSession,
  deleteWorkflowPrimaryAgentSession,
  isWorkflowRunCoordinatorAvailable,
  runWorkflowAndWait,
  stopWorkflowAgentRun,
} from '../../public/workflow-runtime'
import { logger } from '../../public/logging'
import { assertAgentAvailable } from '../agent-availability'

export type { WorkflowCreateInput, WorkflowRecord, WorkflowUpdateInput }

export type WorkflowRuntimeState = 'idle' | 'queued' | 'running' | 'pending_approval' | 'completed' | 'skipped' | 'failed' | 'approval_rejected' | 'canceled'
export type WorkflowRunType = 'workflow'
export type WorkflowNodeAgent = 'hermes' | 'ekko-agent' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'

export interface WorkflowNodeRunTarget {
  type: WorkflowRunType
  source: 'workflow'
  agent: 'hermes' | 'ekko-agent' | 'claude' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
  codingAgentId?: 'ekko-agent' | 'claude-code' | 'codex' | 'pi' | 'grok' | 'opencode' | 'dsh' | 'cursor'
}

export interface WorkflowRuntimeStatus {
  workflowId: string
  status: WorkflowRuntimeState
  runId: string | null
  startedAt: number | null
  updatedAt: number
  completedAt: number | null
  error: string | null
  nodeStatuses: Record<string, WorkflowRuntimeState>
  pendingApprovals: Array<{ nodeId: string; executionId: string }>
}

export interface WorkflowExecutionPreflightResult {
  compiled: CompiledWorkflowGraph
  activeNodeIds: Set<string>
  activeNodes: WorkflowNodeSnapshot[]
  schedulerStartNodeIds: string[]
}

export interface WorkflowRunNowInput {
  pushActor?: PushActor
  pushSnapshot?: { ciphertext: string | null; platform: string }
  profile?: string | null
  startNodeIds?: string[]
  input?: string | null
  user?: AuthenticatedUser
  timeoutMs?: number
  triggerSource?: 'manual' | 'scheduled'
  scheduledAt?: number
  /** Resolves only after the normalized frozen Run is durably persisted. */
  onAccepted?: (run: WorkflowRunRecord) => void
}

export interface WorkflowRerunFromNodeInput {
  profile?: string | null
  preserveStartNode?: boolean
  user?: AuthenticatedUser
  timeoutMs?: number
  /** Resolves only after the rerun lifecycle reset is durably persisted. */
  onAccepted?: (run: WorkflowRunRecord) => void
}

export interface WorkflowRunNowResult {
  run: WorkflowRunRecord
  nodeSessions: WorkflowRunNodeSessionRecord[]
}

export interface WorkflowNodeSnapshot {
  id: string
  type: string
  position?: { x: number; y: number }
  data: {
    title: string
    agent: string
    agentMode: 'scoped' | 'global'
    agentPreset?: string
    provider: string
    model: string
    apiMode: string
    reasoningEffort: string
    input: string
    skills: string[]
    images: string[]
    approvalRequired: boolean
    orchestration: { join: 'all' | 'any' }
  }
}

export function assertWorkflowAgentDependencies(nodes: WorkflowNodeSnapshot[]): void {
  for (const node of nodes) assertAgentAvailable(node.data.agent)
}

type WorkflowEdgeRoute = 'success' | 'failure' | 'always'
type WorkflowConditionOperator =
  | 'exists' | 'not_exists'
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal'
  | 'in' | 'not_in'

interface WorkflowEdgeCondition {
  path: string
  operator: WorkflowConditionOperator
  value?: unknown
}

export const DEFAULT_WORKFLOW_LOOP_ITERATIONS = 3
export const MAX_WORKFLOW_LOOP_ITERATIONS = 100
export const MAX_WORKFLOW_RUN_EXECUTIONS = 1000

interface WorkflowEdgeOrchestration {
  route: WorkflowEdgeRoute
  condition?: WorkflowEdgeCondition
  feedback?: { maxIterations: number; loopId?: string }
}

export interface WorkflowEdgeSnapshot {
  id?: string
  source: string
  target: string
  orchestration: WorkflowEdgeOrchestration
}

function workflowRunSnapshotGraph(
  rawNodes: unknown[],
  rawEdges: unknown[],
  compiled: CompiledWorkflowGraph,
): { nodes: unknown[]; edges: unknown[] } {
  const authoredNodeById = new Map(rawNodes.flatMap(raw => {
    const record = raw && typeof raw === 'object' ? raw as Record<string, any> : null
    return record && typeof record.id === 'string' ? [[record.id, record] as const] : []
  }))
  const authoredEdgeById = new Map(rawEdges.flatMap(raw => {
    const record = raw && typeof raw === 'object' ? raw as Record<string, any> : null
    if (!record || typeof record.source !== 'string' || typeof record.target !== 'string') return []
    return [[typeof record.id === 'string' && record.id ? record.id : `${record.source}->${record.target}`, record] as const]
  }))

  const nodes = compiled.nodes.map(node => {
    const authored = authoredNodeById.get(node.id) || {}
    const position = authored.position && typeof authored.position === 'object'
      && Number.isFinite(authored.position.x) && Number.isFinite(authored.position.y)
      ? { x: Number(authored.position.x), y: Number(authored.position.y) }
      : node.position
    return {
      ...node,
      ...(position ? { position } : {}),
      ...(typeof authored.dragHandle === 'string' ? { dragHandle: authored.dragHandle } : {}),
      ...(authored.style && typeof authored.style === 'object' ? { style: { ...authored.style } } : {}),
    }
  })
  const edges = compiled.edges.map(edge => {
    const edgeId = edge.id || `${edge.source}->${edge.target}`
    const authored = authoredEdgeById.get(edgeId) || {}
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(typeof authored.sourceHandle === 'string' ? { sourceHandle: authored.sourceHandle } : {}),
      ...(typeof authored.targetHandle === 'string' ? { targetHandle: authored.targetHandle } : {}),
      ...(typeof authored.type === 'string' ? { type: authored.type } : {}),
      ...(typeof authored.animated === 'boolean' ? { animated: authored.animated } : {}),
      ...(typeof authored.label === 'string' ? { label: authored.label } : {}),
      data: { orchestration: edge.orchestration },
    }
  })
  return { nodes, edges }
}

type WorkflowManagerEvents = {
  status: [WorkflowRuntimeStatus]
}

type WorkflowStatusListener = (status: WorkflowRuntimeStatus) => void

type PendingNodeApproval = {
  workflowId: string
  runId: string
  nodeId: string
  executionId: string
  resolve: (approved: boolean) => void
}

function idleStatus(workflowId: string): WorkflowRuntimeStatus {
  return {
    workflowId,
    status: 'idle',
    runId: null,
    startedAt: null,
    updatedAt: Date.now(),
    completedAt: null,
    error: null,
    nodeStatuses: {},
    pendingApprovals: [],
  }
}

export function resolveWorkflowNodeRunTarget(agent?: string | null): WorkflowNodeRunTarget {
  if (agent === 'ekko-agent') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'ekko-agent',
      codingAgentId: 'ekko-agent',
    }
  }
  if (agent === 'claude-code') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'claude',
      codingAgentId: 'claude-code',
    }
  }
  if (agent === 'codex') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'codex',
      codingAgentId: 'codex',
    }
  }
  if (agent === 'pi') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'pi',
      codingAgentId: 'pi',
    }
  }
  if (agent === 'grok') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'grok',
      codingAgentId: 'grok',
    }
  }
  if (agent === 'cursor') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'cursor',
      codingAgentId: 'cursor',
    }
  }
  if (agent === 'opencode' || agent === 'dsh') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent,
      codingAgentId: agent,
    }
  }
  if (agent === 'hermes') {
    return {
      type: 'workflow',
      source: 'workflow',
      agent: 'hermes',
    }
  }
  throw new Error(`unsupported workflow Agent runtime: ${String(agent || '')}`)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []
}

const WORKFLOW_REASONING_EFFORTS = new Set(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const WORKFLOW_API_MODES = new Set(['chat_completions', 'codex_responses', 'anthropic_messages'])
export function normalizeWorkflowNode(raw: unknown): WorkflowNodeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : ''
  if (!id) return null
  const type = typeof record.type === 'string' && record.type ? record.type : 'agent'
  if (type !== 'agent') throw new Error(`workflow node ${id} must be an Agent node`)
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : {}
  let join: 'all' | 'any' = 'all'
  if (Object.prototype.hasOwnProperty.call(data, 'orchestration')) {
    const orchestration = data.orchestration
    if (!orchestration || typeof orchestration !== 'object' || Array.isArray(orchestration)
      || (orchestration.join !== 'all' && orchestration.join !== 'any')) {
      throw new Error(`workflow node ${id} has invalid orchestration join`)
    }
    join = orchestration.join
  }
  const agent = typeof data.agent === 'string' && data.agent.trim() ? data.agent.trim() : 'hermes'
  if (agent !== 'hermes' && agent !== 'ekko-agent' && agent !== 'claude-code' && agent !== 'codex' && agent !== 'pi' && agent !== 'grok' && agent !== 'cursor' && (agent !== 'opencode' && agent !== 'dsh')) {
    throw new Error(`workflow node ${id} has unsupported agent runtime`)
  }
  const agentMode = agent === 'cursor' ? 'global' : data.agentMode === 'global' ? 'global' : 'scoped'
  if (agentMode === 'global' && agent !== 'claude-code' && agent !== 'codex' && agent !== 'pi' && agent !== 'grok' && agent !== 'cursor' && (agent !== 'opencode' && agent !== 'dsh')) {
    throw new Error(`workflow node ${id} cannot use global mode with this agent runtime`)
  }
  const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
  const model = typeof data.model === 'string' ? data.model.trim() : ''
  const apiMode = typeof data.apiMode === 'string' ? data.apiMode.trim() : ''
  const targetFieldCount = [provider, model, apiMode].filter(Boolean).length
  if (targetFieldCount !== 0 && targetFieldCount !== 3) {
    throw new Error(`workflow node ${id} target must set provider, model, and apiMode together`)
  }
  if (apiMode && !WORKFLOW_API_MODES.has(apiMode)) {
    throw new Error(`workflow node ${id} has invalid apiMode`)
  }
  const reasoningEffort = typeof data.reasoningEffort === 'string' && data.reasoningEffort.trim()
    ? data.reasoningEffort.trim()
    : 'default'
  if (!WORKFLOW_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`workflow node ${id} has invalid reasoningEffort`)
  }
  const rawPosition = record.position && typeof record.position === 'object' && !Array.isArray(record.position)
    ? record.position as Record<string, unknown>
    : null
  const position = rawPosition && Number.isFinite(rawPosition.x) && Number.isFinite(rawPosition.y)
    ? { x: Number(rawPosition.x), y: Number(rawPosition.y) }
    : undefined
  return {
    id,
    type,
    ...(position ? { position } : {}),
    data: {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : id,
      agent,
      agentMode,
      provider,
      model,
      apiMode,
      reasoningEffort,
      ...(typeof data.agentPreset === 'string' && data.agentPreset ? { agentPreset: data.agentPreset } : {}),
      input: typeof data.input === 'string' ? data.input : '',
      skills: stringArray(data.skills),
      images: stringArray(data.images),
      approvalRequired: data.approvalRequired === true,
      orchestration: { join },
    },
  }
}

export async function assertWorkflowNodeSkillDependencies(
  nodes: Array<{ id: string; data: { agent?: string; skills?: string[] } }>,
  profile: string,
): Promise<void> {
  for (const node of nodes) {
    for (const skillName of node.data.skills || []) {
      const skill = await resolveWorkflowSkillContent({ agent: node.data.agent, profile, skillName })
      if (!skill) {
        const err = new Error(`workflow node ${node.id} requires unavailable skill: ${skillName}`)
        ;(err as any).status = 409
        throw err
      }
    }
  }
}

function latestNodeSessionsByNode(sessions: WorkflowRunNodeSessionRecord[]): Map<string, WorkflowRunNodeSessionRecord> {
  const latest = new Map<string, WorkflowRunNodeSessionRecord>()
  for (const session of sessions) {
    const existing = latest.get(session.node_id)
    if (!existing || session.sequence > existing.sequence) latest.set(session.node_id, session)
  }
  return latest
}


function latestPersistedEdgeEvaluation(
  edge: WorkflowEdgeSnapshot,
  latestSessionByNode: Map<string, WorkflowRunNodeSessionRecord>,
  evaluations: WorkflowRunEdgeEvaluationRecord[],
): WorkflowRunEdgeEvaluationRecord | undefined {
  const sourceExecutionId = latestSessionByNode.get(edge.source)?.execution_id
  if (!sourceExecutionId) return undefined
  const edgeId = edge.id || `${edge.source}->${edge.target}`
  return [...evaluations].reverse().find(item => (
    item.edge_id === edgeId
    && item.source_node_id === edge.source
    && item.source_execution_id === sourceExecutionId
    && item.target_node_id === edge.target
  ))
}

function workflowDecisionFromEvidence(evidence: WorkflowRunEdgeEvaluationRecord): WorkflowEdgeDecision {
  if (evidence.status === 'taken') {
    return {
      status: 'taken',
      routeMatched: true,
      ...(evidence.condition_evaluation ? { condition: evidence.condition_evaluation as WorkflowConditionEvaluation } : {}),
    }
  }
  if (evidence.status === 'not_taken' && evidence.reason === 'route_not_matched') {
    return { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' }
  }
  if (evidence.status === 'not_taken' && evidence.reason === 'condition_not_matched' && evidence.condition_evaluation) {
    return {
      status: 'not_taken', routeMatched: true, reason: 'condition_not_matched',
      condition: evidence.condition_evaluation as WorkflowConditionEvaluation,
    }
  }
  if (evidence.status === 'not_taken' && evidence.reason === 'iteration_limit_reached') {
    return { status: 'not_taken', routeMatched: true, reason: 'iteration_limit_reached' }
  }
  throw Object.assign(new Error(`workflow edge ${evidence.edge_id} has unusable persisted evidence`), { status: 409 })
}

export async function preflightWorkflowExecutionDefinition(
  rawNodes: unknown[],
  rawEdges: unknown[],
  profile: string,
  startNodeIds: string[] = [],
): Promise<WorkflowExecutionPreflightResult> {
  const compiled = compileWorkflowGraphPreflight(rawNodes, rawEdges, startNodeIds)
  const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
  for (const node of compiled.nodes) outgoing.set(node.id, [])
  for (const edge of compiled.edges) outgoing.get(edge.source)!.push(edge)
  const activeNodeIds = reachableFrom(compiled.startNodeIds, outgoing)
  assertWorkflowRunExecutionBudget(activeNodeIds, compiled.loops)
  const activeNodes = compiled.nodes.filter(node => activeNodeIds.has(node.id))
  assertWorkflowAgentDependencies(activeNodes)
  await assertWorkflowNodeSkillDependencies(activeNodes, profile)
  return { compiled, activeNodeIds, activeNodes, schedulerStartNodeIds: compiled.startNodeIds }
}

export async function preflightWorkflowRerunDefinition(args: {
  run: WorkflowRunRecord
  nodeId: string
  profile: string
  preserveStartNode?: boolean
}): Promise<WorkflowExecutionPreflightResult> {
  const snapshotEdges = args.run.snapshot_edges.map(raw => {
    const edge = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
    if (!Object.prototype.hasOwnProperty.call(edge, 'orchestration')) return raw
    const { orchestration, ...rest } = edge
    if (rest.data && typeof rest.data === 'object' && Object.prototype.hasOwnProperty.call(rest.data, 'orchestration')) {
      throw Object.assign(new Error(`workflow edge ${String(edge.id || `${edge.source || '?'}->${edge.target || '?'}`)} has ambiguous frozen orchestration`), { status: 409 })
    }
    return { ...rest, data: { ...(rest.data && typeof rest.data === 'object' ? rest.data : {}), orchestration } }
  })
  const compiled = compileWorkflowGraphPreflight(args.run.snapshot_nodes, snapshotEdges, args.run.start_node_ids)
  const nodeById = new Map(compiled.nodes.map(node => [node.id, node]))
  const targetNodeId = args.nodeId.trim()
  if (!targetNodeId || !nodeById.has(targetNodeId)) throw Object.assign(new Error('workflow node not found in run snapshot'), { status: 404 })
  const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
  const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
  for (const node of compiled.nodes) { incoming.set(node.id, []); outgoing.set(node.id, []) }
  for (const edge of compiled.edges) { incoming.get(edge.target)!.push(edge); outgoing.get(edge.source)!.push(edge) }
  const existingSessions = listWorkflowRunNodeSessions(args.run.id)
  const latestSessionByNode = latestNodeSessionsByNode(existingSessions)
  const edgeEvaluations = listWorkflowRunEdgeEvaluations(args.run.id)
  if (args.preserveStartNode) {
    const startSession = latestSessionByNode.get(targetNodeId)
    if (!startSession || startSession.status !== 'completed') throw Object.assign(new Error('workflow node has no completed output to preserve'), { status: 409 })
  }
  const downstreamStartIds = args.preserveStartNode
    ? (outgoing.get(targetNodeId) || []).filter(edge => {
        const evidence = latestPersistedEdgeEvaluation(edge, latestSessionByNode, edgeEvaluations)
        if (!evidence) throw Object.assign(new Error(`workflow edge ${edge.id || `${edge.source}->${edge.target}`} has no persisted decision for latest source execution`), { status: 409 })
        return workflowDecisionFromEvidence(evidence).status === 'taken'
      }).map(edge => edge.target)
    : (outgoing.get(targetNodeId) || []).map(edge => edge.target)
  const activeNodeIds = args.preserveStartNode
    ? reachableFrom(downstreamStartIds, outgoing)
    : reachableFrom([targetNodeId], outgoing)
  let expanded = true
  while (expanded) {
    expanded = false
    for (const activeNodeId of [...activeNodeIds]) {
      for (const edge of incoming.get(activeNodeId) || []) {
        if (activeNodeIds.has(edge.source)) continue
        if (!args.preserveStartNode && activeNodeId === targetNodeId) continue
        if (latestSessionByNode.get(edge.source)?.status === 'completed') {
          const evidence = latestPersistedEdgeEvaluation(edge, latestSessionByNode, edgeEvaluations)
          if (!evidence) throw Object.assign(new Error(`workflow edge ${edge.id || `${edge.source}->${edge.target}`} has no persisted decision for latest source execution`), { status: 409 })
          workflowDecisionFromEvidence(evidence)
          continue
        }
        activeNodeIds.add(edge.source)
        expanded = true
      }
    }
  }
  if (activeNodeIds.size === 0) {
    const message = args.preserveStartNode
      ? 'workflow node has no taken downstream route to rerun'
      : 'workflow node has no downstream nodes to rerun'
    throw Object.assign(new Error(message), { status: 400 })
  }
  assertWorkflowRunExecutionBudget(activeNodeIds, compiled.loops)
  const activeNodes = compiled.nodes.filter(node => activeNodeIds.has(node.id))
  assertWorkflowAgentDependencies(activeNodes)
  await assertWorkflowNodeSkillDependencies(activeNodes, args.profile)
  return { compiled, activeNodeIds, activeNodes, schedulerStartNodeIds: args.preserveStartNode ? downstreamStartIds : [targetNodeId] }
}

export function workflowNodeRequiresApproval(node: { data?: { approvalRequired?: unknown } }): boolean {
  return node.data?.approvalRequired === true
}

function isUnfinishedWorkflowNodeStatus(status: WorkflowRuntimeState | undefined): boolean {
  return status === 'queued' || status === 'running' || status === 'pending_approval'
}

export type WorkflowConditionEvaluation =
  | { status: 'matched'; actual?: unknown; reason?: 'path_not_found' }
  | { status: 'not_matched'; actual?: unknown; reason?: 'path_not_found' | 'not_equal' }

const FORBIDDEN_WORKFLOW_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])

export function evaluateWorkflowEdgeCondition(
  condition: WorkflowEdgeCondition,
  context: unknown,
): WorkflowConditionEvaluation {
  const segments = condition.path.split('.')
  for (const segment of segments) {
    if (FORBIDDEN_WORKFLOW_PATH_SEGMENTS.has(segment)) {
      throw new Error(`workflow condition path contains forbidden segment: ${condition.path}`)
    }
  }

  let current: unknown = context
  for (const segment of segments) {
    if (!segment || (typeof current !== 'object' && typeof current !== 'function') || current === null) {
      return condition.operator === 'not_exists'
        ? { status: 'matched', reason: 'path_not_found' }
        : { status: 'not_matched', reason: 'path_not_found' }
    }
    const record = current as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return condition.operator === 'not_exists'
        ? { status: 'matched', reason: 'path_not_found' }
        : { status: 'not_matched', reason: 'path_not_found' }
    }
    current = record[segment]
  }

  const operator = condition.operator
  const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value')
  if (operator === 'exists') return { status: 'matched', actual: current }
  if (operator === 'not_exists') return { status: 'not_matched', actual: current }
  if (!hasValue) throw new Error(`workflow condition operator ${operator} requires value`)

  let matched: boolean
  switch (operator) {
    case 'equals': matched = Object.is(current, condition.value); break
    case 'not_equals': matched = !Object.is(current, condition.value); break
    case 'contains':
      matched = typeof current === 'string'
        ? typeof condition.value === 'string' && current.includes(condition.value)
        : Array.isArray(current) && current.some(item => Object.is(item, condition.value))
      break
    case 'not_contains':
      matched = typeof current === 'string'
        ? typeof condition.value === 'string' && !current.includes(condition.value)
        : Array.isArray(current) && !current.some(item => Object.is(item, condition.value))
      break
    case 'greater_than': matched = typeof current === 'number' && typeof condition.value === 'number' && current > condition.value; break
    case 'greater_than_or_equal': matched = typeof current === 'number' && typeof condition.value === 'number' && current >= condition.value; break
    case 'less_than': matched = typeof current === 'number' && typeof condition.value === 'number' && current < condition.value; break
    case 'less_than_or_equal': matched = typeof current === 'number' && typeof condition.value === 'number' && current <= condition.value; break
    case 'in': matched = Array.isArray(condition.value) && condition.value.some(item => Object.is(item, current)); break
    case 'not_in': matched = Array.isArray(condition.value) && !condition.value.some(item => Object.is(item, current)); break
    default: throw new Error(`unsupported workflow condition operator: ${operator}`)
  }
  return matched
    ? { status: 'matched', actual: current }
    : { status: 'not_matched', actual: current, reason: 'not_equal' }
}

export type WorkflowEdgeDecision =
  | { status: 'taken'; routeMatched: true; condition?: WorkflowConditionEvaluation }
  | { status: 'not_taken'; routeMatched: false; reason: 'route_not_matched' }
  | { status: 'not_taken'; routeMatched: true; reason: 'condition_not_matched'; condition: WorkflowConditionEvaluation }
  | { status: 'not_taken'; routeMatched: true; reason: 'iteration_limit_reached' }

export function evaluateWorkflowEdgeRoute(
  orchestration: WorkflowEdgeOrchestration,
  sourceOutcome: 'success' | 'failure',
  context: unknown,
): WorkflowEdgeDecision {
  const routeMatched = orchestration.route === 'always' || orchestration.route === sourceOutcome
  if (!routeMatched) return { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' }
  if (!orchestration.condition) return { status: 'taken', routeMatched: true }
  const condition = evaluateWorkflowEdgeCondition(orchestration.condition, context)
  return condition.status === 'matched'
    ? { status: 'taken', routeMatched: true, condition }
    : { status: 'not_taken', routeMatched: true, reason: 'condition_not_matched', condition }
}

export type WorkflowNodeJoinDecision = 'pending' | 'ready' | 'skipped'

export function evaluateWorkflowNodeJoin(
  join: 'all' | 'any',
  decisions: Array<WorkflowEdgeDecision | undefined>,
): WorkflowNodeJoinDecision {
  if (decisions.length === 0) return 'ready'
  if (join === 'any') {
    if (decisions.some(decision => decision?.status === 'taken')) return 'ready'
    return decisions.every(Boolean) ? 'skipped' : 'pending'
  }
  if (decisions.some(decision => decision?.status === 'not_taken')) return 'skipped'
  return decisions.every(decision => decision?.status === 'taken') ? 'ready' : 'pending'
}

function workflowEdgeId(edge: Pick<WorkflowEdgeSnapshot, 'id' | 'source' | 'target'>): string {
  return edge.id || `${edge.source}->${edge.target}`
}

export function normalizeWorkflowEdge(raw: unknown): WorkflowEdgeSnapshot | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const source = typeof record.source === 'string' && record.source.trim() ? record.source.trim() : ''
  const target = typeof record.target === 'string' && record.target.trim() ? record.target.trim() : ''
  if (!source || !target) return null

  const id = typeof record.id === 'string' ? record.id : undefined
  const edgeLabel = id || `${source}->${target}`
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, any> : null
  const hasExplicitOrchestration = Boolean(data && Object.prototype.hasOwnProperty.call(data, 'orchestration'))
  if (!hasExplicitOrchestration) {
    return { id, source, target, orchestration: { route: 'success' } }
  }

  const rawOrchestration = data!.orchestration
  if (!rawOrchestration || typeof rawOrchestration !== 'object' || Array.isArray(rawOrchestration)) {
    throw new Error(`workflow edge ${edgeLabel} has invalid orchestration`)
  }
  const orchestrationRecord = rawOrchestration as Record<string, any>
  const unsupportedOrchestrationKey = Object.keys(orchestrationRecord).find(key => !['route', 'condition', 'feedback'].includes(key))
  if (unsupportedOrchestrationKey) throw new Error(`workflow edge ${edgeLabel} has unsupported orchestration field: ${unsupportedOrchestrationKey}`)
  const route = orchestrationRecord.route
  if (route !== 'success' && route !== 'failure' && route !== 'always') {
    throw new Error(`workflow edge ${edgeLabel} has invalid orchestration route`)
  }

  const orchestration: WorkflowEdgeOrchestration = { route }
  if (Object.prototype.hasOwnProperty.call(orchestrationRecord, 'feedback')) {
    const rawFeedback = orchestrationRecord.feedback
    if (rawFeedback === true) {
      orchestration.feedback = { maxIterations: DEFAULT_WORKFLOW_LOOP_ITERATIONS }
    } else if (rawFeedback && typeof rawFeedback === 'object' && !Array.isArray(rawFeedback)) {
      const feedbackRecord = rawFeedback as Record<string, unknown>
      const unsupportedFeedbackKey = Object.keys(feedbackRecord).find(key => !['maxIterations', 'loopId'].includes(key))
      if (unsupportedFeedbackKey) throw new Error(`workflow edge ${edgeLabel} has unsupported feedback field: ${unsupportedFeedbackKey}`)
      const maxIterations = feedbackRecord.maxIterations
      if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1 || (maxIterations as number) > MAX_WORKFLOW_LOOP_ITERATIONS) {
        throw new Error(`workflow edge ${edgeLabel} has invalid feedback maxIterations`)
      }
      const loopId = typeof feedbackRecord.loopId === 'string' ? feedbackRecord.loopId.trim() : ''
      if (Object.prototype.hasOwnProperty.call(feedbackRecord, 'loopId') && (!loopId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(loopId))) {
        throw new Error(`workflow edge ${edgeLabel} has invalid feedback loopId`)
      }
      orchestration.feedback = { maxIterations: maxIterations as number, ...(loopId ? { loopId } : {}) }
    } else {
      throw new Error(`workflow edge ${edgeLabel} has invalid feedback`)
    }
  }
  if (Object.prototype.hasOwnProperty.call(orchestrationRecord, 'condition')) {
    const rawCondition = orchestrationRecord.condition
    if (!rawCondition || typeof rawCondition !== 'object' || Array.isArray(rawCondition)) {
      throw new Error(`workflow edge ${edgeLabel} has invalid condition`)
    }
    const conditionRecord = rawCondition as Record<string, any>
    const unsupportedConditionKey = Object.keys(conditionRecord).find(key => !['path', 'operator', 'value'].includes(key))
    if (unsupportedConditionKey) throw new Error(`workflow edge ${edgeLabel} has unsupported condition field: ${unsupportedConditionKey}`)
    const path = typeof conditionRecord.path === 'string' ? conditionRecord.path.trim() : ''
    const operator = conditionRecord.operator
    if (!path) throw new Error(`workflow edge ${edgeLabel} condition requires path`)
    const pathSegments = path.split('.')
    if (pathSegments.some(segment => !segment || FORBIDDEN_WORKFLOW_PATH_SEGMENTS.has(segment))) {
      throw new Error(`workflow edge ${edgeLabel} has invalid condition path`)
    }
    const supportedOperators: WorkflowConditionOperator[] = [
      'exists', 'not_exists', 'equals', 'not_equals', 'contains', 'not_contains',
      'greater_than', 'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'in', 'not_in',
    ]
    if (!supportedOperators.includes(operator)) throw new Error(`workflow edge ${edgeLabel} has invalid condition operator`)
    const hasValue = Object.prototype.hasOwnProperty.call(conditionRecord, 'value')
    if (operator !== 'exists' && operator !== 'not_exists' && !hasValue) {
      throw new Error(`workflow edge ${edgeLabel} condition operator ${operator} requires value`)
    }
    orchestration.condition = hasValue
      ? { path, operator, value: conditionRecord.value }
      : { path, operator }
  }

  return { id, source, target, orchestration }
}

export interface CompiledWorkflowLoop {
  id: string
  feedbackEdgeId: string
  headerNodeId: string
  latchNodeId: string
  bodyNodeIds: string[]
  maxIterations: number
  parentLoopId: string | null
}

export function validateLaminarWorkflowLoops(loops: CompiledWorkflowLoop[]): CompiledWorkflowLoop[] {
  const sets = new Map(loops.map(loop => [loop.id, new Set(loop.bodyNodeIds)]))
  const contains = (outer: Set<string>, inner: Set<string>) => [...inner].every(id => outer.has(id))
  for (let i = 0; i < loops.length; i += 1) {
    for (let j = i + 1; j < loops.length; j += 1) {
      const left = loops[i], right = loops[j]
      const leftSet = sets.get(left.id)!, rightSet = sets.get(right.id)!
      const intersects = [...leftSet].some(id => rightSet.has(id))
      if (!intersects) continue
      const leftContainsRight = contains(leftSet, rightSet)
      const rightContainsLeft = contains(rightSet, leftSet)
      if (leftContainsRight && rightContainsLeft) {
        throw new Error(`workflow loops ${left.id} and ${right.id} have identical bodies`)
      }
      if (!leftContainsRight && !rightContainsLeft) {
        throw new Error(`workflow loops ${left.id} and ${right.id} partially overlap`)
      }
    }
  }
  for (const loop of loops) {
    const body = sets.get(loop.id)!
    const parents = loops.filter(candidate => candidate.id !== loop.id && contains(sets.get(candidate.id)!, body))
      .sort((left, right) => left.bodyNodeIds.length - right.bodyNodeIds.length || left.id.localeCompare(right.id))
    loop.parentLoopId = parents[0]?.id || null
  }
  return loops
}

export function compileWorkflowLoops(nodeIds: string[], edges: WorkflowEdgeSnapshot[]): CompiledWorkflowLoop[] {
  const nodeSet = new Set(nodeIds)
  const forwardEdges = edges.filter(edge => !edge.orchestration.feedback)
  const outgoing = new Map(nodeIds.map(id => [id, [] as string[]]))
  const incoming = new Map(nodeIds.map(id => [id, [] as string[]]))
  const indegree = new Map(nodeIds.map(id => [id, 0]))
  for (const edge of forwardEdges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
    indegree.set(edge.target, indegree.get(edge.target)! + 1)
  }
  const queue = nodeIds.filter(id => indegree.get(id) === 0)
  const topological: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]
    topological.push(id)
    for (const target of outgoing.get(id) || []) {
      indegree.set(target, indegree.get(target)! - 1)
      if (indegree.get(target) === 0) queue.push(target)
    }
  }
  if (topological.length !== nodeIds.length) throw new Error('workflow forward graph must be acyclic')

  const walk = (starts: string[], adjacency: Map<string, string[]>): Set<string> => {
    const visited = new Set<string>()
    const stack = [...starts]
    while (stack.length) {
      const id = stack.pop()!
      if (visited.has(id)) continue
      visited.add(id)
      for (const next of adjacency.get(id) || []) stack.push(next)
    }
    return visited
  }
  const starts = nodeIds.filter(id => (incoming.get(id) || []).length === 0)
  const dominators = new Map<string, Set<string>>()
  for (const id of topological) {
    const predecessors = incoming.get(id) || []
    if (starts.includes(id) || predecessors.length === 0) dominators.set(id, new Set([id]))
    else {
      const intersection = new Set(dominators.get(predecessors[0]) || [])
      for (const predecessor of predecessors.slice(1)) {
        const candidate = dominators.get(predecessor) || new Set<string>()
        for (const value of [...intersection]) if (!candidate.has(value)) intersection.delete(value)
      }
      intersection.add(id)
      dominators.set(id, intersection)
    }
  }

  const loops = edges.filter(edge => edge.orchestration.feedback).map(edge => {
    const edgeId = edge.id || `${edge.source}->${edge.target}`
    const reachableFromHeader = walk([edge.target], outgoing)
    if (!reachableFromHeader.has(edge.source)) {
      throw new Error(`feedback edge ${edgeId} has no forward path from ${edge.target} to ${edge.source}`)
    }
    if (!dominators.get(edge.source)?.has(edge.target)) {
      throw new Error(`feedback edge ${edgeId} does not form a single-entry natural loop`)
    }
    const canReachLatch = walk([edge.source], incoming)
    const bodyNodeIds = nodeIds.filter(id => reachableFromHeader.has(id) && canReachLatch.has(id))
    return {
      id: edge.orchestration.feedback!.loopId || `loop:${edgeId}`, feedbackEdgeId: edgeId, headerNodeId: edge.target, latchNodeId: edge.source,
      bodyNodeIds, maxIterations: edge.orchestration.feedback!.maxIterations, parentLoopId: null,
    }
  })
  const loopIds = new Set<string>()
  for (const loop of loops) {
    if (loopIds.has(loop.id)) throw new Error(`workflow has duplicate loop id: ${loop.id}`)
    loopIds.add(loop.id)
  }
  return validateLaminarWorkflowLoops(loops)
}

export interface CompiledWorkflowGraph {
  nodes: WorkflowNodeSnapshot[]
  edges: WorkflowEdgeSnapshot[]
  loops: CompiledWorkflowLoop[]
  startNodeIds: string[]
}

export function compileWorkflowGraphPreflight(
  rawNodes: unknown[], rawEdges: unknown[], requestedStartNodeIds: string[] = [],
): CompiledWorkflowGraph {
  const nodes = rawNodes.map((raw, index) => {
    const node = normalizeWorkflowNode(raw)
    if (!node) throw new Error(`workflow node at index ${index} is invalid`)
    return node
  })
  if (nodes.length === 0) throw new Error('workflow has no nodes')
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) throw new Error(`workflow has duplicate node id: ${node.id}`)
    nodeIds.add(node.id)
  }
  const edges = rawEdges.map((raw, index) => {
    const edge = normalizeWorkflowEdge(raw)
    if (!edge) throw new Error(`workflow edge at index ${index} is invalid`)
    return edge
  })
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    const edgeId = edge.id || `${edge.source}->${edge.target}`
    if (edgeIds.has(edgeId)) throw new Error(`workflow has duplicate edge id: ${edgeId}`)
    edgeIds.add(edgeId)
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(`workflow edge ${edgeId} references missing node`)
    }
  }
  const loops = compileWorkflowLoops(nodes.map(node => node.id), edges)
  const forwardIncoming = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of edges) if (!edge.orchestration.feedback) forwardIncoming.set(edge.target, forwardIncoming.get(edge.target)! + 1)
  let startNodeIds: string[]
  if (requestedStartNodeIds.length > 0) {
    const unique = new Set<string>()
    startNodeIds = requestedStartNodeIds.map(id => id.trim()).filter(id => {
      if (!id || unique.has(id)) return false
      unique.add(id)
      return true
    })
    for (const id of startNodeIds) if (!nodeIds.has(id)) throw new Error(`workflow start node does not exist: ${id}`)
  } else startNodeIds = nodes.filter(node => forwardIncoming.get(node.id) === 0).map(node => node.id)
  if (startNodeIds.length === 0) throw new Error('workflow has no start nodes')
  return { nodes, edges, loops, startNodeIds }
}

function workflowAttachmentBlock(path: string): ContentBlock {
  const name = path.split(/[\\/]/).pop() || path
  const extension = name.split('.').pop()?.toLowerCase() || ''
  const mediaTypes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
    csv: 'text/csv', zip: 'application/zip', doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  }
  const mediaType = mediaTypes[extension] || 'application/octet-stream'
  return mediaType.startsWith('image/')
    ? { type: 'image', name, path, media_type: mediaType }
    : { type: 'file', name, path, media_type: mediaType }
}

function lastAssistantOutput(sessionId: string, fallback?: string | null): string {
  const detail = getSessionDetail(sessionId)
  const messages = detail?.messages || []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role === 'assistant' && String(message.content || '').trim()) return String(message.content || '')
  }
  return String(fallback || '')
}

export function parseWorkflowStructuredOutput(output: string): unknown | undefined {
  const trimmed = output.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    // Agent responses commonly wrap a machine-readable result in one JSON fence.
  }

  const fenceOpenings = [...trimmed.matchAll(/```json\b/gi)]
  if (fenceOpenings.length !== 1) return undefined
  const fencedJson = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)]
  if (fencedJson.length !== 1) return undefined
  try {
    return JSON.parse(fencedJson[0][1].trim())
  } catch {
    return undefined
  }
}

function workflowOutputConditionContext(output: string, edges: WorkflowEdgeSnapshot[]): { output: string; outputJson?: unknown } {
  const needsStructuredOutput = edges.some((edge) => {
    const path = edge.orchestration.condition?.path
    return path === 'outputJson' || path?.startsWith('outputJson.')
  })
  if (!needsStructuredOutput) return { output }
  const outputJson = parseWorkflowStructuredOutput(output)
  return outputJson === undefined ? { output } : { output, outputJson }
}

function isWorkflowCodingAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  const agent = String(session?.agent || '').trim()
  return agent === 'ekko-agent' || agent === 'claude' || agent === 'codex' || agent === 'pi' || agent === 'grok' || agent === 'cursor' || (agent === 'opencode' || agent === 'dsh') || Boolean(session?.agent_session_id)
}

async function deleteHermesSessionIfPresent(sessionId: string, profile: string): Promise<void> {
  const targetProfile = profile || 'default'
  try {
    const deleted = await deleteWorkflowPrimaryAgentSession(sessionId, targetProfile)
    if (!deleted) {
      logger.warn({ sessionId, profile: targetProfile }, '[workflow] failed to delete Hermes session for workflow run node')
    }
  } catch (err) {
    logger.warn({ err, sessionId, profile: targetProfile }, '[workflow] skipped Hermes session delete for workflow run node')
  }
}

function reachableFrom(startIds: string[], outgoing: Map<string, WorkflowEdgeSnapshot[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [...startIds]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const edge of outgoing.get(id) || []) stack.push(edge.target)
  }
  return visited
}

export function calculateWorkflowStaticExecutionBound(
  activeNodeIds: Iterable<string>,
  loops: CompiledWorkflowLoop[],
): number {
  let total = 0
  for (const nodeId of activeNodeIds) {
    let visits = 1
    for (const loop of loops) {
      if (!loop.bodyNodeIds.includes(nodeId)) continue
      visits *= loop.maxIterations
      if (!Number.isSafeInteger(visits) || visits > MAX_WORKFLOW_RUN_EXECUTIONS) return visits
    }
    total += visits
    if (!Number.isSafeInteger(total) || total > MAX_WORKFLOW_RUN_EXECUTIONS) return total
  }
  return total
}

export function assertWorkflowRunExecutionBudget(activeNodeIds: Iterable<string>, loops: CompiledWorkflowLoop[]): void {
  const bound = calculateWorkflowStaticExecutionBound(activeNodeIds, loops)
  if (!Number.isSafeInteger(bound) || bound > MAX_WORKFLOW_RUN_EXECUTIONS) {
    throw new Error(`workflow static execution bound ${bound} exceeds run budget ${MAX_WORKFLOW_RUN_EXECUTIONS}`)
  }
}

function isChatRunWaitTimeout(message: string, timeoutMs?: number): boolean {
  return typeof timeoutMs === 'number' && timeoutMs > 0 && message === `chat-run timed out after ${timeoutMs}ms`
}

export async function withinWorkflowRunDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number | null,
  timeoutError: string | null,
): Promise<T> {
  if (deadlineAt === null) return operation()
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0) throw new Error(timeoutError || 'Workflow run timed out')
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(timeoutError || 'Workflow run timed out')),
          remainingMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function withoutRemovedWorkflowNodePolicy(nodes: unknown[] | undefined): unknown[] | undefined {
  return nodes?.map(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node
    const record = node as Record<string, unknown>
    if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) return node
    const { executionPolicy: _removed, ...data } = record.data as Record<string, unknown>
    return { ...record, data }
  })
}

function withoutRemovedWorkflowEdgeNodePolicy(edges: unknown[] | undefined): unknown[] | undefined {
  return edges?.map(edge => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return edge
    const record = edge as Record<string, unknown>
    const sourceNode = withoutRemovedWorkflowNodePolicy([record.sourceNode])?.[0]
    const targetNode = withoutRemovedWorkflowNodePolicy([record.targetNode])?.[0]
    return {
      ...record,
      ...(record.sourceNode === undefined ? {} : { sourceNode }),
      ...(record.targetNode === undefined ? {} : { targetNode }),
    }
  })
}

function withoutRemovedWorkflowRecordPolicy(workflow: WorkflowRecord): WorkflowRecord {
  return {
    ...workflow,
    nodes: withoutRemovedWorkflowNodePolicy(workflow.nodes) || [],
    edges: withoutRemovedWorkflowEdgeNodePolicy(workflow.edges) || [],
  }
}

export class WorkflowManager extends EventEmitter<WorkflowManagerEvents> {
  private readonly runtimeStatuses = new Map<string, WorkflowRuntimeStatus>()
  private readonly canceledRunIds = new Set<string>()
  private readonly pendingNodeApprovals = new Map<string, PendingNodeApproval>()
  private readonly runAdmissionTails = new Map<string, Promise<void>>()

  private async acquireRunAdmission(workflowId: string): Promise<() => void> {
    const previous = this.runAdmissionTails.get(workflowId) || Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => { releaseCurrent = resolve })
    const tail = previous.then(() => current)
    this.runAdmissionTails.set(workflowId, tail)
    await previous
    return () => {
      releaseCurrent()
      if (this.runAdmissionTails.get(workflowId) === tail) this.runAdmissionTails.delete(workflowId)
    }
  }

  list(profile?: string | null): WorkflowRecord[] {
    return listWorkflows(profile).map(withoutRemovedWorkflowRecordPolicy)
  }

  get(id: string): WorkflowRecord | null {
    const workflow = getWorkflow(id)
    return workflow ? withoutRemovedWorkflowRecordPolicy(workflow) : null
  }

  create(input: WorkflowCreateInput): WorkflowRecord {
    return createWorkflow({
      ...input,
      nodes: withoutRemovedWorkflowNodePolicy(input.nodes),
      edges: withoutRemovedWorkflowEdgeNodePolicy(input.edges),
    })
  }

  update(id: string, input: WorkflowUpdateInput): WorkflowRecord | null {
    const existing = getWorkflow(id)
    if (!existing) return null
    return updateWorkflow(id, {
      ...input,
      nodes: withoutRemovedWorkflowNodePolicy(input.nodes ?? existing.nodes),
      edges: withoutRemovedWorkflowEdgeNodePolicy(input.edges ?? existing.edges),
    })
  }

  async delete(id: string): Promise<boolean> {
    const workflow = getWorkflow(id)
    if (!workflow) return false
    const { deleteWorkflowSchedules } = await import('../../repositories/workflow-schedule-store')
    deleteWorkflowSchedules(id)
    const runs = listAllWorkflowRuns(id)
    for (const run of runs) {
      await this.deleteRun(id, run.id)
    }
    const deleted = deleteWorkflow(id)
    if (deleted) this.runtimeStatuses.delete(id)
    return deleted
  }

  async recoverActiveRuns(workflowId?: string): Promise<{ runs: number; sessions: number }> {
    const activeRuns = listActiveWorkflowRuns().filter(run => !workflowId || run.workflow_id === workflowId)
    if (activeRuns.length === 0) return { runs: 0, sessions: 0 }
    const reason = 'Workflow runtime cannot safely resume because the server restarted'
    const finishedAt = Date.now()
    const sessionIds = new Set<string>()
    for (const run of activeRuns) {
      updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: reason })
      const activeSessions = listWorkflowRunNodeSessions(run.id).filter(session => session.status === 'queued' || session.status === 'running')
      for (const session of activeSessions) {
        updateWorkflowRunNodeSession(session.id, { status: 'failed', finished_at: finishedAt, error: reason })
        if (session.session_id) sessionIds.add(session.session_id)
      }
      let sequence = Math.max(
        -1,
        ...listWorkflowRunNodeSessions(run.id).map(session => session.sequence),
        ...listWorkflowRunEdgeEvaluations(run.id).map(edge => edge.sequence),
        ...listWorkflowRunLoopEpochs(run.id).map(epoch => epoch.sequence),
      ) + 1
      const activeLoopIterations = new Map<string, { iteration: number; iterationPath: unknown[] }>()
      for (const session of activeSessions) {
        for (const entry of Array.isArray(session.iteration_path) ? session.iteration_path : []) {
          if (!entry || typeof entry !== 'object') continue
          const loopId = String((entry as any).loopId || '')
          const iteration = Number((entry as any).iteration)
          if (!loopId || !Number.isSafeInteger(iteration) || iteration < 0) continue
          activeLoopIterations.set(`${loopId}:${iteration}`, { iteration, iterationPath: session.iteration_path })
        }
      }
      for (const [key, active] of [...activeLoopIterations.entries()].sort((left, right) => (
        JSON.stringify(left[1].iterationPath).localeCompare(JSON.stringify(right[1].iterationPath))
      ))) {
        createWorkflowRunRecoveryLoopEpoch({
          run_id: run.id, workflow_id: run.workflow_id, loop_id: key.slice(0, key.lastIndexOf(':')),
          iteration: active.iteration, iteration_path: active.iterationPath, status: 'failed', exit_reason: reason,
          sequence: sequence++, started_at: run.started_at || run.created_at, finished_at: finishedAt,
        })
      }
      this.setRuntimeStatus(run.workflow_id, {
        status: 'failed', runId: run.id, startedAt: run.started_at,
        completedAt: finishedAt, error: reason, nodeStatuses: {},
      })
    }
    const abortResults = await Promise.allSettled([...sessionIds].map(async (sessionId) => {
      await abortWorkflowSession(sessionId, reason)
    }))
    for (const result of abortResults) {
      if (result.status === 'rejected') logger.warn('Failed to abort recovered workflow session: %s', result.reason instanceof Error ? result.reason.message : String(result.reason))
    }
    return { runs: activeRuns.length, sessions: sessionIds.size }
  }

  async stopRun(workflowId: string, runId: string, reason = 'Workflow run canceled'): Promise<WorkflowRunRecord | null> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return null
    if (run.status !== 'queued' && run.status !== 'running') return run
    this.canceledRunIds.add(runId)
    this.cancelPendingNodeApprovals(runId)
    const finishedAt = Date.now()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    const activeSessionIds = new Set<string>()
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const session of nodeSessions) {
      const wasActive = session.status === 'queued' || session.status === 'running'
      const status: WorkflowRunNodeStatus = wasActive ? 'canceled' : session.status
      nodeStatuses[session.node_id] = status === 'blocked' ? 'failed' : status
      if (wasActive) {
        updateWorkflowRunNodeSession(session.id, {
          status: 'canceled', finished_at: finishedAt, error: reason,
        })
        if (session.session_id) activeSessionIds.add(session.session_id)
      }
    }
    const stopped = updateWorkflowRun(runId, {
      status: 'canceled', finished_at: finishedAt, error: reason,
    }) || run
    this.setRuntimeStatus(workflowId, {
      status: 'canceled', runId, completedAt: finishedAt, error: reason, nodeStatuses,
    })
    const abortResults = await Promise.allSettled([...activeSessionIds].map(async sessionId => {
      await abortWorkflowSession(sessionId, reason)
    }))
    for (const result of abortResults) {
      if (result.status === 'rejected') logger.warn('Failed to abort canceled workflow session: %s', result.reason instanceof Error ? result.reason.message : String(result.reason))
    }
    return stopped
  }

  approveNode(workflowId: string, runId: string, nodeId: string, approved = true, executionId?: string): boolean {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    const matches = [...this.pendingNodeApprovals.entries()].filter(([, pending]) => (
      pending.workflowId === workflowId && pending.runId === runId && pending.nodeId === nodeId
      && (!executionId || pending.executionId === executionId)
    ))
    if (matches.length !== 1) return false
    const [key, pending] = matches[0]
    this.pendingNodeApprovals.delete(key)
    pending.resolve(approved)
    return true
  }

  async deleteRun(workflowId: string, runId: string): Promise<boolean> {
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) return false
    if (run.status === 'queued' || run.status === 'running') {
      await this.stopRun(workflowId, runId, 'Workflow run deleted')
    }
    const nodeSessions = listWorkflowRunNodeSessions(runId)
    for (const nodeSession of nodeSessions) {
      await this.deleteNodeSessionArtifacts(nodeSession.session_id, nodeSession.profile, nodeSession.agent)
    }
    this.canceledRunIds.delete(runId)
    return deleteWorkflowRun(runId)
  }

  private async deleteNodeSessionArtifacts(sessionId: string, profile: string, agent: string): Promise<void> {
    if (!sessionId) return
    const existing = getSession(sessionId)
    if (isWorkflowCodingAgentSession(existing)) {
      stopWorkflowAgentRun(sessionId)
    } else if (agent === 'hermes') {
      await deleteHermesSessionIfPresent(sessionId, profile || existing?.profile || 'default')
    }
    if (existing) {
      deleteSession(sessionId)
    }
  }

  getRuntimeStatus(workflowId: string): WorkflowRuntimeStatus {
    return this.runtimeStatuses.get(workflowId) || idleStatus(workflowId)
  }

  listRuntimeStatuses(): WorkflowRuntimeStatus[] {
    return [...this.runtimeStatuses.values()]
  }

  setRuntimeStatus(
    workflowId: string,
    patch: Partial<Omit<WorkflowRuntimeStatus, 'workflowId' | 'updatedAt'>>,
  ): WorkflowRuntimeStatus {
    const previous = this.getRuntimeStatus(workflowId)
    const status: WorkflowRuntimeStatus = {
      ...previous,
      ...patch,
      nodeStatuses: patch.nodeStatuses || previous.nodeStatuses || {},
      pendingApprovals: [...this.pendingNodeApprovals.values()]
        .filter(pending => pending.workflowId === workflowId && (!patch.runId || pending.runId === patch.runId))
        .map(({ nodeId, executionId }) => ({ nodeId, executionId })),
      workflowId,
      updatedAt: Date.now(),
    }
    this.runtimeStatuses.set(workflowId, status)
    this.emit('status', status)
    return status
  }

  onRuntimeStatus(listener: WorkflowStatusListener): () => void {
    this.on('status', listener)
    return () => this.off('status', listener)
  }

  private nodeApprovalKey(runId: string, executionId: string): string {
    return `${runId}:${executionId}`
  }

  private cancelPendingNodeApprovals(runId: string): void {
    for (const [key, pending] of this.pendingNodeApprovals) {
      if (pending.runId !== runId) continue
      this.pendingNodeApprovals.delete(key)
      pending.resolve(false)
    }
  }

  private async waitForNodeApproval(args: {
    workflowId: string
    runId: string
    node: WorkflowNodeSnapshot
    nodeStatuses: Record<string, WorkflowRuntimeState>
    timeoutMs?: number
    timeoutError?: string
    executionId?: string
  }): Promise<boolean> {
    if (!workflowNodeRequiresApproval(args.node)) return true
    if (this.canceledRunIds.has(args.runId) || getWorkflowRun(args.runId)?.status === 'canceled') return false

    args.nodeStatuses[args.node.id] = 'pending_approval'
    this.setRuntimeStatus(args.workflowId, {
      status: 'running',
      runId: args.runId,
      nodeStatuses: { ...args.nodeStatuses },
    })

    let resolveApproval: (approved: boolean) => void = () => {}
    const approval = new Promise<boolean>((resolve) => {
      resolveApproval = resolve
    })
    const executionId = args.executionId || args.node.id
    const key = this.nodeApprovalKey(args.runId, executionId)
    this.pendingNodeApprovals.set(key, {
      workflowId: args.workflowId,
      runId: args.runId,
      nodeId: args.node.id,
      executionId,
      resolve: resolveApproval,
    })
    this.setRuntimeStatus(args.workflowId, {
      status: 'running', runId: args.runId, nodeStatuses: { ...args.nodeStatuses },
    })

    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const approved = args.timeoutMs !== undefined
        ? await Promise.race([
            approval,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(args.timeoutError || 'Workflow node approval timed out')), args.timeoutMs)
            }),
          ])
        : await approval
      return approved && !this.canceledRunIds.has(args.runId) && getWorkflowRun(args.runId)?.status !== 'canceled'
    } finally {
      if (timer) clearTimeout(timer)
      this.pendingNodeApprovals.delete(key)
      this.setRuntimeStatus(args.workflowId, {
        status: 'running', runId: args.runId, nodeStatuses: { ...args.nodeStatuses },
      })
    }
  }

  private ensureWorkflowNodeSession(args: {
    sessionId: string
    profile: string
    workspace: string | null
    node: WorkflowNodeSnapshot
    target: WorkflowNodeRunTarget
  }): void {
    if (getSession(args.sessionId)) return
    const isGlobalCodingAgent = args.node.data.agent !== 'hermes' && args.node.data.agentMode === 'global'
    createSession({
      id: args.sessionId,
      profile: args.profile,
      source: 'workflow',
      agent: args.target.agent,
      agent_mode: args.node.data.agent === 'hermes' ? '' : args.node.data.agentMode,
      model: isGlobalCodingAgent ? '' : args.node.data.model,
      provider: isGlobalCodingAgent ? 'global' : args.node.data.provider,
      ...(args.node.data.agent === 'hermes' || isGlobalCodingAgent ? {} : { api_mode: args.node.data.apiMode }),
      title: args.node.data.title,
      workspace: args.workspace || undefined,
    })
  }

  private async executeRecursiveCompiledWorkflowRun(args: {
    workflowId: string
    workspace: string | null
    run: WorkflowRunRecord
    profile: string
    nodes: WorkflowNodeSnapshot[]
    edges: WorkflowEdgeSnapshot[]
    loops: CompiledWorkflowLoop[]
    startNodeIds: string[]
    activeIds: Set<string>
    input?: string | null
    user?: AuthenticatedUser
    runDeadline: number | null
    runTimeoutMessage: string | null
    initialNodeStatuses?: Record<string, WorkflowRuntimeState>
    initialOutputs?: Map<string, string>
    executionScope?: string
    ignoreHistoricalIncomingForStartNodes?: boolean
  }): Promise<WorkflowRunNowResult> {
    const { workflowId, workspace, run, profile, nodes, edges, loops, startNodeIds, activeIds, runDeadline, runTimeoutMessage } = args
    const executionScope = args.executionScope?.trim() || ''
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = edges.filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {
      ...(args.initialNodeStatuses || {}),
      ...Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const])),
    }
    const publishRunningStatus = () => this.setRuntimeStatus(workflowId, {
      status: 'running', runId: run.id, nodeStatuses: { ...nodeStatuses },
    })
    const loopById = new Map(loops.map(loop => [loop.id, loop]))
    const feedbackIds = new Set(loops.map(loop => loop.feedbackEdgeId))
    const forwardEdges = edges.filter(edge => !feedbackIds.has(workflowEdgeId(edge)))
    const promptEdges = edges.filter(edge => activeIds.has(edge.target))
    const outputs = new Map<string, string>(args.initialOutputs || [])
    const ignoreHistoricalIncoming = (edge: WorkflowEdgeSnapshot) => Boolean(
      args.ignoreHistoricalIncomingForStartNodes
      && startNodeIds.includes(edge.target)
      && !activeIds.has(edge.source)
    )
    let historySequence = Math.max(
      -1,
      ...listWorkflowRunNodeSessions(run.id).map(item => item.sequence),
      ...listWorkflowRunEdgeEvaluations(run.id).map(item => item.sequence),
      ...listWorkflowRunLoopEpochs(run.id).map(item => item.sequence),
    ) + 1
    const latestEdgeDecisions = new Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>()
    const edgeEvidenceByEdge = new Map<WorkflowEdgeSnapshot, ReturnType<typeof createWorkflowRunEdgeEvaluation>>()
    const persistedEdgeEvidence = listWorkflowRunEdgeEvaluations(run.id)
    const latestPersistedSessionByNode = latestNodeSessionsByNode(listWorkflowRunNodeSessions(run.id))
    const evidenceForEdge = (edge: WorkflowEdgeSnapshot) => edgeEvidenceByEdge.get(edge)
      || latestPersistedEdgeEvaluation(edge, latestPersistedSessionByNode, persistedEdgeEvidence)
    for (const edge of edges.filter(edge => (
      activeIds.has(edge.target)
      && !activeIds.has(edge.source)
      && outputs.has(edge.source)
      && !ignoreHistoricalIncoming(edge)
    ))) {
      const evidence = evidenceForEdge(edge)
      if (!evidence) throw new Error(`workflow edge ${edge.id || `${edge.source}->${edge.target}`} has no persisted decision for latest source execution`)
      latestEdgeDecisions.set(edge, workflowDecisionFromEvidence(evidence))
    }
    let executionCount = 0
    const nodeFailuresByPath = new Map<string, { count: number; lastError: string }>()
    const firstNodeFailure: { value: { node: WorkflowNodeSnapshot; error: string } | null } = { value: null }
    const pathKey = (path: Array<{ loopId: string; iteration: number; executionScope?: string }>) => JSON.stringify(path)
    const recordNodeFailureForPath = (path: Array<{ loopId: string; iteration: number; executionScope?: string }>, error: string) => {
      for (let depth = 1; depth <= path.length; depth += 1) {
        const key = pathKey(path.slice(0, depth))
        const previous = nodeFailuresByPath.get(key)
        nodeFailuresByPath.set(key, { count: (previous?.count || 0) + 1, lastError: error })
      }
    }

    const pathExecutionId = (nodeId: string, path: Array<{ loopId: string; iteration: number; executionScope?: string }>) => (
      `${nodeId}${executionScope ? `@${executionScope}` : ''}${path.length === 0 ? '' : `@${path.map(item => `${item.loopId}:${item.iteration}`).join('/')}`}`
    )
    const isCanceled = () => this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
    const persistDecision = (
      edge: WorkflowEdgeSnapshot,
      sourceOutcome: 'success' | 'failure' | 'skipped',
      decision: WorkflowEdgeDecision,
      path: Array<{ loopId: string; iteration: number }>,
    ) => {
      const evidence = createWorkflowRunEdgeEvaluation({
        run_id: run.id, workflow_id: workflowId, edge_id: edge.id || `${edge.source}->${edge.target}`,
        source_node_id: edge.source, source_execution_id: pathExecutionId(edge.source, path), iteration_path: path,
        target_node_id: edge.target, source_outcome: sourceOutcome, status: decision.status,
        route: edge.orchestration.route, reason: 'reason' in decision ? decision.reason : null,
        sequence: historySequence++, orchestration: edge.orchestration,
        condition_evaluation: 'condition' in decision ? decision.condition : null,
      })
      latestEdgeDecisions.set(edge, decision)
      edgeEvidenceByEdge.set(edge, evidence)
    }
    const skipNode = (
      node: WorkflowNodeSnapshot,
      path: Array<{ loopId: string; iteration: number }>,
      decisions: Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>,
    ) => {
      nodeStatuses[node.id] = 'skipped'
      for (const edge of forwardEdges.filter(item => activeIds.has(item.target) && item.source === node.id)) {
        const decision: WorkflowEdgeDecision = { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' }
        persistDecision(edge, 'skipped', decision, path)
        decisions.set(edge, decision)
      }
    }
    const executeNode = async (
      node: WorkflowNodeSnapshot,
      path: Array<{ loopId: string; iteration: number }>,
      decisions: Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>,
    ) => {
      if (isCanceled()) throw new Error(getWorkflowRun(run.id)?.error || 'Workflow run canceled')
      executionCount += 1
      if (executionCount > MAX_WORKFLOW_RUN_EXECUTIONS) throw new Error(`workflow run execution budget exceeded: ${MAX_WORKFLOW_RUN_EXECUTIONS}`)
      const sessionId = randomUUID()
      const executionId = pathExecutionId(node.id, path)
      const target = resolveWorkflowNodeRunTarget(node.data.agent)
      const consumedIncoming = promptEdges.filter(edge => !ignoreHistoricalIncoming(edge) && edge.target === node.id && (
        (!activeIds.has(edge.source) && outputs.has(edge.source) && Boolean(evidenceForEdge(edge)))
        || latestEdgeDecisions.get(edge)?.status === 'taken'
      ))
      let assembledInput: string | ContentBlock[]
      try {
        assembledInput = await withinWorkflowRunDeadline(() => this.buildNodeUserMessage({
          node, incomingEdges: consumedIncoming, nodeById, outputs,
          overrideInput: path.every(item => item.iteration === 0) && startNodeIds.includes(node.id) ? args.input : undefined, profile,
        }), runDeadline, runTimeoutMessage)
      } catch (err) {
        nodeStatuses[node.id] = 'failed'
        publishRunningStatus()
        throw err
      }
      const nodeStartedAt = Date.now()
      const remainingTimeoutMs = runDeadline === null ? undefined : runDeadline - nodeStartedAt
      if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) throw new Error(runTimeoutMessage!)
      this.ensureWorkflowNodeSession({ sessionId, profile, workspace, node, target })
      const nodeSession = createWorkflowRunNodeSession({
        run_id: run.id, workflow_id: workflowId, node_id: node.id, execution_id: executionId,
        iteration_path: path,
        consumed_edge_evaluation_ids: consumedIncoming.flatMap(edge => evidenceForEdge(edge)?.id ? [evidenceForEdge(edge)!.id] : []),
        session_id: sessionId, profile, agent: target.agent,
        agent_mode: node.data.agent === 'hermes' ? '' : node.data.agentMode, status: 'running',
        sequence: historySequence++, remaining_timeout_ms_at_start: remainingTimeoutMs ?? null,
        started_at: nodeStartedAt,
      })
      nodeStatuses[node.id] = 'running'
      publishRunningStatus()
      try {
        const runResult = await runWorkflowAndWait({
          session_id: sessionId, source: 'workflow', session_source: 'workflow', input: assembledInput,
          workflow_id: workflowId, workflow_node_id: node.id,
          profile, workspace: workspace,
          ...(node.data.agentMode === 'global' ? {} : {
            model: node.data.model || undefined,
            provider: node.data.provider || undefined,
          }),
          mode: node.data.agent === 'hermes' ? undefined : node.data.agentMode,
          coding_agent_id: target.codingAgentId, agent_id: target.codingAgentId,
          ...((node.data.agent === 'hermes' || node.data.agent === 'ekko-agent')
            ? { background_delegation_enabled: false }
            : {}),
          ...(node.data.agentPreset ? { agent_preset: node.data.agentPreset } : {}),
          ...(node.data.agent === 'hermes' || node.data.agentMode === 'global' ? {} : { apiMode: node.data.apiMode || undefined }),
          one_shot_model: true,
          ...(node.data.agentMode !== 'global' && node.data.reasoningEffort !== 'default'
            ? { reasoning_effort: node.data.reasoningEffort }
            : {}),
        }, { profile, user: args.user, timeoutMs: remainingTimeoutMs, approvalChoice: 'once', pushRoot: { kind: 'workflow', profile, runId: run.id } })
        if (isCanceled()) throw new Error(getWorkflowRun(run.id)?.error || 'Workflow run canceled')
        if (!runResult.ok) {
          const rawError = runResult.error || `node ${node.id} failed`
          if (runTimeoutMessage && isChatRunWaitTimeout(rawError, remainingTimeoutMs)) {
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error: rawError })
            nodeStatuses[node.id] = 'failed'
            const timeoutError = new Error(rawError)
            ;(timeoutError as any).workflowTimeout = true
            throw timeoutError
          }
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error: rawError })
          nodeStatuses[node.id] = 'failed'
          if (path.length === 0) firstNodeFailure.value ||= { node, error: rawError }
          recordNodeFailureForPath(path, rawError)
          for (const edge of forwardEdges.filter(item => activeIds.has(item.target) && item.source === node.id)) {
            const decision = evaluateWorkflowEdgeRoute(edge.orchestration, 'failure', { error: rawError })
            persistDecision(edge, 'failure', decision, path)
            decisions.set(edge, decision)
          }
          publishRunningStatus()
          return
        }
        const output = lastAssistantOutput(sessionId, runResult.output)
        const approvalTimeoutMs = runDeadline === null ? undefined : runDeadline - Date.now()
        if (approvalTimeoutMs !== undefined && approvalTimeoutMs <= 0) throw new Error(runTimeoutMessage!)
        const approved = await this.waitForNodeApproval({
          workflowId: workflowId, runId: run.id, node, nodeStatuses, executionId,
          timeoutMs: approvalTimeoutMs, timeoutError: runTimeoutMessage || undefined,
        })
        if (isCanceled()) throw new Error(getWorkflowRun(run.id)?.error || 'Workflow run canceled')
        if (!approved) throw new Error('Workflow node approval rejected')
        outputs.set(node.id, output)
        updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
        nodeStatuses[node.id] = 'completed'
        const outgoingEdges = forwardEdges.filter(item => activeIds.has(item.target) && item.source === node.id)
        const conditionContext = workflowOutputConditionContext(output, outgoingEdges)
        for (const edge of outgoingEdges) {
          const decision = evaluateWorkflowEdgeRoute(edge.orchestration, 'success', conditionContext)
          persistDecision(edge, 'success', decision, path)
          decisions.set(edge, decision)
        }
        publishRunningStatus()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const canceled = isCanceled()
        const approvalRejected = !canceled && message === 'Workflow node approval rejected'
        updateWorkflowRunNodeSession(nodeSession.id, {
          status: canceled ? 'canceled' : approvalRejected ? 'approval_rejected' : 'failed',
          finished_at: Date.now(), error: canceled ? (getWorkflowRun(run.id)?.error || message) : message,
        })
        nodeStatuses[node.id] = canceled ? 'canceled' : approvalRejected ? 'approval_rejected' : 'failed'
        publishRunningStatus()
        throw err
      }
    }

    const executeRegion = async (
      loop: CompiledWorkflowLoop | null,
      parentPath: Array<{ loopId: string; iteration: number; executionScope?: string }>,
    ): Promise<Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>> => {
      const regionIds = new Set(loop ? loop.bodyNodeIds : activeNodes.map(node => node.id))
      const children = loops.filter(candidate => candidate.parentLoopId === loop?.id || (!loop && candidate.parentLoopId === null))
      const childSets = new Map(children.map(child => [child.id, new Set(child.bodyNodeIds)]))
      const unitFor = (nodeId: string) => children.find(child => childSets.get(child.id)!.has(nodeId))?.id || `node:${nodeId}`
      const directNodes = activeNodes.filter(node => regionIds.has(node.id) && !children.some(child => childSets.get(child.id)!.has(node.id)))
      const units = [...directNodes.map(node => `node:${node.id}`), ...children.map(child => child.id)]
      const unitSet = new Set(units)
      const indegree = new Map(units.map(unit => [unit, 0]))
      const unitOutgoing = new Map(units.map(unit => [unit, new Set<string>()]))
      for (const edge of forwardEdges) {
        if (!regionIds.has(edge.source) || !regionIds.has(edge.target)) continue
        const sourceUnit = unitFor(edge.source), targetUnit = unitFor(edge.target)
        if (sourceUnit === targetUnit || !unitSet.has(sourceUnit) || !unitSet.has(targetUnit)) continue
        if (!unitOutgoing.get(sourceUnit)!.has(targetUnit)) {
          unitOutgoing.get(sourceUnit)!.add(targetUnit)
          indegree.set(targetUnit, indegree.get(targetUnit)! + 1)
        }
      }
      const ordered: string[] = []
      const queue = units.filter(unit => indegree.get(unit) === 0)
      for (let index = 0; index < queue.length; index += 1) {
        const unit = queue[index]
        ordered.push(unit)
        for (const target of unitOutgoing.get(unit) || []) {
          indegree.set(target, indegree.get(target)! - 1)
          if (indegree.get(target) === 0) queue.push(target)
        }
      }
      if (ordered.length !== units.length) throw new Error(`workflow loop region ${loop?.id || 'root'} contains blocked units`)

      const runPass = async (
        path: Array<{ loopId: string; iteration: number; executionScope?: string }>,
        carriedOutputs: Map<string, string> = new Map(),
      ) => {
        const decisions = new Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>()
        for (const nodeId of regionIds) outputs.delete(nodeId)
        for (const [nodeId, output] of carriedOutputs) outputs.set(nodeId, output)
        for (const edge of forwardEdges) {
          if (regionIds.has(edge.source) && regionIds.has(edge.target)) latestEdgeDecisions.delete(edge)
        }
        const startedUnits = new Set<string>()
        const finishedUnits = new Set<string>()
        const inFlight = new Map<string, Promise<{ unit: string; decisions?: Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision> }>>()

        const unitReadiness = (unit: string): WorkflowNodeJoinDecision => {
          const child = loopById.get(unit)
          if (child) {
            const childSet = childSets.get(child.id)!
            const entering = forwardEdges.filter(edge => (
              !ignoreHistoricalIncoming(edge)
              && edge.target === child.headerNodeId
              && ((!activeIds.has(edge.source) && outputs.has(edge.source))
                || (regionIds.has(edge.source) && !childSet.has(edge.source)))
            ))
            return evaluateWorkflowNodeJoin(nodeById.get(child.headerNodeId)!.data.orchestration.join, entering.map(edge => decisions.get(edge) || latestEdgeDecisions.get(edge)))
          }
          const node = nodeById.get(unit.slice(5))!
          const incoming = forwardEdges.filter(edge => !ignoreHistoricalIncoming(edge) && edge.target === node.id && (
            (!activeIds.has(edge.source) && outputs.has(edge.source)) || (activeIds.has(edge.source) && regionIds.has(edge.source))
          ))
          return evaluateWorkflowNodeJoin(node.data.orchestration.join, incoming.map(edge => decisions.get(edge) || latestEdgeDecisions.get(edge)))
        }

        const skipUnit = (unit: string) => {
          const child = loopById.get(unit)
          if (!child) {
            skipNode(nodeById.get(unit.slice(5))!, path, decisions)
            return
          }
          const childSet = childSets.get(child.id)!
          for (const nodeId of child.bodyNodeIds) nodeStatuses[nodeId] = 'skipped'
          for (const edge of activeEdges.filter(edge => childSet.has(edge.source))) {
            const decision: WorkflowEdgeDecision = { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' }
            persistDecision(edge, 'skipped', decision, path)
            decisions.set(edge, decision)
          }
        }

        const launchUnit = (unit: string) => {
          const child = loopById.get(unit)
          const execution = child
            ? executeRegion(child, path).then(childDecisions => ({ unit, decisions: childDecisions }))
            : executeNode(nodeById.get(unit.slice(5))!, path, decisions).then(() => ({ unit }))
          startedUnits.add(unit)
          inFlight.set(unit, execution)
        }

        try {
          while (finishedUnits.size < units.length) {
            let progressed = false
            for (const unit of units) {
              if (startedUnits.has(unit) || finishedUnits.has(unit)) continue
              const readiness = unitReadiness(unit)
              if (readiness === 'skipped') {
                startedUnits.add(unit)
                skipUnit(unit)
                finishedUnits.add(unit)
                progressed = true
              } else if (readiness === 'ready') {
                launchUnit(unit)
                progressed = true
              }
            }
            if (inFlight.size === 0) {
              if (finishedUnits.size === units.length) break
              if (!progressed) throw new Error(`workflow loop region ${loop?.id || 'root'} contains blocked units`)
              continue
            }
            const settled = await Promise.race(inFlight.values())
            inFlight.delete(settled.unit)
            if (settled.decisions) {
              for (const [edge, decision] of settled.decisions) decisions.set(edge, decision)
            }
            finishedUnits.add(settled.unit)
          }
          if (inFlight.size > 0) await Promise.all(inFlight.values())
          return decisions
        } catch (err) {
          if (inFlight.size > 0) await Promise.allSettled(inFlight.values())
          throw err
        }
      }

      if (!loop) return runPass(parentPath)
      const feedback = activeEdges.find(edge => workflowEdgeId(edge) === loop.feedbackEdgeId)
      if (!feedback) throw new Error(`workflow loop ${loop.id} feedback edge is unavailable in active graph`)
      let finalDecisions = new Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>()
      let feedbackCarry = new Map<string, string>()
      for (let iteration = 0; iteration < loop.maxIterations; iteration += 1) {
        const path = [...parentPath, { loopId: loop.id, iteration, ...(executionScope ? { executionScope } : {}) }]
        const epochStartedAt = Date.now()
        const currentPathKey = pathKey(path)
        const failuresBeforeIteration = nodeFailuresByPath.get(currentPathKey)?.count || 0
        try {
          finalDecisions = await runPass(path, feedbackCarry)
          const pathFailure = nodeFailuresByPath.get(currentPathKey)
          const iterationFailed = (pathFailure?.count || 0) > failuresBeforeIteration
          const latchSkipped = nodeStatuses[loop.latchNodeId] === 'skipped'
          const sourceOutcome = iterationFailed ? 'failure' : latchSkipped ? 'skipped' : 'success'
          const routeDecision = sourceOutcome === 'skipped'
            ? { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' } as WorkflowEdgeDecision
            : evaluateWorkflowEdgeRoute(
                feedback.orchestration,
                sourceOutcome,
                iterationFailed
                  ? { error: pathFailure?.lastError || 'loop iteration failed' }
                  : workflowOutputConditionContext(outputs.get(loop.latchNodeId) || '', [feedback]),
              )
          const decision: WorkflowEdgeDecision = routeDecision.status === 'taken' && iteration + 1 >= loop.maxIterations
            ? { status: 'not_taken', routeMatched: true, reason: 'iteration_limit_reached' }
            : routeDecision
          persistDecision(feedback, sourceOutcome, decision, path)
          feedbackCarry = decision.status === 'taken'
            ? new Map([[loop.latchNodeId, outputs.get(loop.latchNodeId) || '']])
            : new Map()
          createWorkflowRunLoopEpoch({
            run_id: run.id, workflow_id: workflowId, loop_id: loop.id, iteration, iteration_path: path,
            status: iterationFailed ? 'failed' : 'completed',
            exit_reason: iterationFailed ? pathFailure?.lastError || 'loop iteration failed' : decision.status === 'taken' ? 'feedback_taken' : decision.reason,
            sequence: historySequence++, started_at: epochStartedAt, finished_at: Date.now(),
          })
          if (iterationFailed && decision.status === 'taken') {
            const resolvedFailures = (pathFailure?.count || 0) - failuresBeforeIteration
            for (let depth = 1; depth <= path.length && resolvedFailures > 0; depth += 1) {
              const key = pathKey(path.slice(0, depth))
              const previous = nodeFailuresByPath.get(key)
              if (!previous) continue
              const remaining = previous.count - resolvedFailures
              if (remaining > 0) nodeFailuresByPath.set(key, { ...previous, count: remaining })
              else nodeFailuresByPath.delete(key)
            }
          } else if (iterationFailed && parentPath.length === 0) {
            firstNodeFailure.value ||= { node: nodeById.get(loop.latchNodeId)!, error: pathFailure?.lastError || 'loop iteration failed' }
          }
          if (decision.status !== 'taken') break
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const canceled = isCanceled()
          const timedOut = !canceled && (message === runTimeoutMessage || Boolean((err as any)?.workflowTimeout))
          const approvalRejected = !canceled && message === 'Workflow node approval rejected'
          try {
            createWorkflowRunLoopEpoch({
              run_id: run.id, workflow_id: workflowId, loop_id: loop.id, iteration, iteration_path: path,
              status: canceled ? 'canceled' : timedOut ? 'timed_out' : approvalRejected ? 'approval_rejected' : 'failed',
              exit_reason: canceled ? (getWorkflowRun(run.id)?.error || message) : message,
              sequence: historySequence++, started_at: epochStartedAt, finished_at: Date.now(),
            })
          } catch (evidenceError) {
            const evidenceMessage = evidenceError instanceof Error ? evidenceError.message : String(evidenceError)
            this.canceledRunIds.delete(run.id)
            updateWorkflowRun(run.id, { status: 'failed', finished_at: Date.now(), error: evidenceMessage, allow_terminal_reset: true })
            ;(evidenceError as any).workflowEvidenceFailure = true
            throw evidenceError
          }
          throw err
        }
      }
      return finalDecisions
    }

    try {
      await executeRegion(null, [])
      const finishedAt = Date.now()
      if (firstNodeFailure.value) {
        const message = firstNodeFailure.value.error
        const failedRun = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || run
        this.setRuntimeStatus(workflowId, { status: 'failed', runId: run.id, completedAt: finishedAt, error: message, nodeStatuses: { ...nodeStatuses } })
        return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
      }
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || run
      this.setRuntimeStatus(workflowId, { status: 'completed', runId: run.id, completedAt: finishedAt, error: null, nodeStatuses: { ...nodeStatuses } })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const finishedAt = Date.now()
      const evidenceFailure = Boolean((err as any)?.workflowEvidenceFailure)
      const canceled = !evidenceFailure && isCanceled()
      const persistedRun = getWorkflowRun(run.id)
      const finalMessage = canceled ? (persistedRun?.error || message) : message
      const finalRun = canceled
        ? (persistedRun || run)
        : (updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: finalMessage }) || run)
      this.setRuntimeStatus(workflowId, {
        status: canceled ? 'canceled' : 'failed', runId: run.id, completedAt: finishedAt,
        error: finalMessage, nodeStatuses: { ...nodeStatuses },
      })
      return { run: finalRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    }
  }

  private async executeCompletionDrivenDagRun(args: {
    workflowId: string
    workspace: string | null
    run: WorkflowRunRecord
    profile: string
    nodes: WorkflowNodeSnapshot[]
    edges: WorkflowEdgeSnapshot[]
    startNodeIds: string[]
    activeIds: Set<string>
    input?: string | null
    user?: AuthenticatedUser
    runDeadline: number | null
    runTimeoutMessage: string | null
    initialNodeStatuses?: Record<string, WorkflowRuntimeState>
    initialOutputs?: Map<string, string>
    executionScope?: string
    ignoreHistoricalIncomingForStartNodes?: boolean
  }): Promise<WorkflowRunNowResult> {
    const { workflowId, workspace, run, profile, nodes, edges, startNodeIds, activeIds, runDeadline, runTimeoutMessage } = args
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const activeNodes = nodes.filter(node => activeIds.has(node.id))
    const activeEdges = edges.filter(edge => activeIds.has(edge.source) && activeIds.has(edge.target))
    const boundaryEdges = edges.filter(edge => (
      activeIds.has(edge.target)
      && !activeIds.has(edge.source)
      && args.initialOutputs?.has(edge.source)
      && !(args.ignoreHistoricalIncomingForStartNodes && startNodeIds.includes(edge.target))
    ))
    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    const outgoing = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of activeNodes) { incoming.set(node.id, []); outgoing.set(node.id, []) }
    for (const edge of activeEdges) { incoming.get(edge.target)!.push(edge); outgoing.get(edge.source)!.push(edge) }
    for (const edge of boundaryEdges) incoming.get(edge.target)!.push(edge)
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {
      ...(args.initialNodeStatuses || {}),
      ...Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const])),
    }
    const completed = new Set<string>()
    const runningOrDone = new Set<string>()
    const edgeDecisions = new Map<WorkflowEdgeSnapshot, WorkflowEdgeDecision>()
    const edgeEvidenceByEdge = new Map<WorkflowEdgeSnapshot, ReturnType<typeof createWorkflowRunEdgeEvaluation>>()
    const persistedEdgeEvidence = listWorkflowRunEdgeEvaluations(run.id)
    const latestPersistedSessionByNode = latestNodeSessionsByNode(listWorkflowRunNodeSessions(run.id))
    const evidenceForEdge = (edge: WorkflowEdgeSnapshot) => edgeEvidenceByEdge.get(edge)
      || latestPersistedEdgeEvaluation(edge, latestPersistedSessionByNode, persistedEdgeEvidence)
    for (const edge of boundaryEdges) {
      const evidence = evidenceForEdge(edge)
      if (!evidence) throw new Error(`workflow edge ${edge.id || `${edge.source}->${edge.target}`} has no persisted decision for latest source execution`)
      edgeDecisions.set(edge, workflowDecisionFromEvidence(evidence))
    }
    const outputs = new Map<string, string>(args.initialOutputs || [])
    const nodeSessionRecordIds = new Map<string, string>()
    let historySequence = Math.max(
      -1,
      ...listWorkflowRunNodeSessions(run.id).map(item => item.sequence),
      ...listWorkflowRunEdgeEvaluations(run.id).map(item => item.sequence),
      ...listWorkflowRunLoopEpochs(run.id).map(item => item.sequence),
    ) + 1
    const executionPath = args.executionScope ? [{ executionScope: args.executionScope }] : []
    const executionIdFor = (nodeId: string) => args.executionScope ? `${nodeId}@${args.executionScope}` : nodeId
    const recordEdgeDecision = (
      edge: WorkflowEdgeSnapshot,
      sourceOutcome: 'success' | 'failure' | 'skipped',
      decision: WorkflowEdgeDecision,
    ) => {
      const evidence = createWorkflowRunEdgeEvaluation({
        run_id: run.id,
        workflow_id: workflowId,
        edge_id: edge.id || `${edge.source}->${edge.target}`,
        source_node_id: edge.source,
        source_execution_id: executionIdFor(edge.source),
        iteration_path: executionPath,
        target_node_id: edge.target,
        source_outcome: sourceOutcome,
        status: decision.status,
        route: edge.orchestration.route,
        reason: 'reason' in decision ? decision.reason : null,
        sequence: historySequence++,
        orchestration: edge.orchestration,
        condition_evaluation: 'condition' in decision ? decision.condition : null,
      })
      edgeDecisions.set(edge, decision)
      edgeEvidenceByEdge.set(edge, evidence)
    }
    const inFlight = new Map<string, Promise<any>>()
    let firstNodeFailure: { node: WorkflowNodeSnapshot; error: string } | null = null

    const failRun = (message: string) => {
      if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
        const finishedAt = Date.now()
        for (const node of activeNodes) {
          if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
        }
        const canceled = updateWorkflowRun(run.id, { status: 'canceled', finished_at: finishedAt, error: message }) || run
        this.setRuntimeStatus(workflowId, {
          status: 'canceled',
          runId: run.id,
          completedAt: finishedAt,
          error: message,
          nodeStatuses: { ...nodeStatuses },
        })
        return canceled
      }
      const finishedAt = Date.now()
      const failed = updateWorkflowRun(run.id, { status: 'failed', finished_at: finishedAt, error: message }) || run
      this.setRuntimeStatus(workflowId, {
        status: 'failed',
        runId: run.id,
        completedAt: finishedAt,
        error: message,
        nodeStatuses: { ...nodeStatuses },
      })
      return failed
    }

    try {
      while (completed.size < activeNodes.length) {
        let propagatedSkip = true
        while (propagatedSkip) {
          propagatedSkip = false
          for (const node of activeNodes) {
            if (runningOrDone.has(node.id)) continue
            const dependencies = incoming.get(node.id) || []
            const joinDecision = evaluateWorkflowNodeJoin(
              node.data.orchestration.join,
              dependencies.map(edge => edgeDecisions.get(edge)),
            )
            if (joinDecision === 'skipped') {
              runningOrDone.add(node.id)
              completed.add(node.id)
              nodeStatuses[node.id] = 'skipped'
              for (const edge of outgoing.get(node.id) || []) {
                recordEdgeDecision(edge, 'skipped', { status: 'not_taken', routeMatched: false, reason: 'route_not_matched' })
              }
              propagatedSkip = true
            }
          }
        }
        if (completed.size === activeNodes.length) break
        const ready = activeNodes.filter(node => {
          if (runningOrDone.has(node.id)) return false
          const dependencies = incoming.get(node.id) || []
          return evaluateWorkflowNodeJoin(
            node.data.orchestration.join,
            dependencies.map(edge => edgeDecisions.get(edge)),
          ) === 'ready'
        })
        if (ready.length === 0 && inFlight.size === 0) {
          throw new Error('workflow graph contains a cycle or blocked dependency')
        }
        for (const node of ready) nodeStatuses[node.id] = 'running'
        this.setRuntimeStatus(workflowId, {
          status: 'running',
          runId: run.id,
          nodeStatuses: { ...nodeStatuses },
        })

        for (const node of ready) {
          const execution = (async () => {
          const nodeSessionId = randomUUID()
          runningOrDone.add(node.id)
          const target = resolveWorkflowNodeRunTarget(node.data.agent)
          const consumedIncoming = edges.filter(edge => edge.target === node.id && (
            (!activeIds.has(edge.source) && outputs.has(edge.source) && Boolean(evidenceForEdge(edge)))
            || edgeDecisions.get(edge)?.status === 'taken'
          ))
          let assembledInput: string | ContentBlock[]
          try {
            assembledInput = await withinWorkflowRunDeadline(() => this.buildNodeUserMessage({
              node,
              incomingEdges: consumedIncoming,
              nodeById,
              outputs,
              overrideInput: startNodeIds.includes(node.id) ? args.input : undefined,
              profile,
            }), runDeadline, runTimeoutMessage)
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            nodeStatuses[node.id] = 'failed'
            return { node, ok: false, deadlineExceeded: error === runTimeoutMessage, error }
          }
          const nodeStartedAt = Date.now()
          const remainingTimeoutMs = runDeadline === null ? undefined : runDeadline - nodeStartedAt
          if (remainingTimeoutMs !== undefined && remainingTimeoutMs <= 0) {
            return { node, ok: false, deadlineExceeded: true, error: runTimeoutMessage! }
          }
          this.ensureWorkflowNodeSession({ sessionId: nodeSessionId, profile, workspace, node, target })
          const nodeSession = createWorkflowRunNodeSession({
            run_id: run.id,
            workflow_id: workflowId,
            node_id: node.id,
            execution_id: executionIdFor(node.id),
            iteration_path: executionPath,
            consumed_edge_evaluation_ids: consumedIncoming.flatMap(edge => evidenceForEdge(edge)?.id ? [evidenceForEdge(edge)!.id] : []),
            session_id: nodeSessionId,
            profile,
            agent: target.agent,
            agent_mode: node.data.agent === 'hermes' ? '' : node.data.agentMode,
            status: 'running',
            sequence: historySequence++,
            remaining_timeout_ms_at_start: remainingTimeoutMs ?? null,
            started_at: nodeStartedAt,
          })
          nodeSessionRecordIds.set(node.id, nodeSession.id)
          const runResult = await runWorkflowAndWait({
            session_id: nodeSessionId,
            source: 'workflow',
            session_source: 'workflow',
            workflow_id: workflowId,
            workflow_node_id: node.id,
            input: assembledInput,
            profile,
            workspace: workspace,
            ...(node.data.agentMode === 'global' ? {} : {
              model: node.data.model || undefined,
              provider: node.data.provider || undefined,
            }),
            mode: node.data.agent === 'hermes' ? undefined : node.data.agentMode,
            coding_agent_id: target.codingAgentId,
            agent_id: target.codingAgentId,
            ...((node.data.agent === 'hermes' || node.data.agent === 'ekko-agent')
              ? { background_delegation_enabled: false }
              : {}),
            ...(node.data.agentPreset ? { agent_preset: node.data.agentPreset } : {}),
            ...(node.data.agent === 'hermes' || node.data.agentMode === 'global' ? {} : { apiMode: node.data.apiMode || undefined }),
            one_shot_model: true,
            ...(node.data.agentMode !== 'global' && node.data.reasoningEffort !== 'default'
              ? { reasoning_effort: node.data.reasoningEffort }
              : {}),
          }, {
            profile,
            user: args.user,
            timeoutMs: remainingTimeoutMs,
            approvalChoice: 'once',
            pushRoot: { kind: 'workflow', profile, runId: run.id },
          })
          if (!runResult.ok) {
            const error = runResult.error || `node ${node.id} failed`
            const deadlineExceeded = runTimeoutMessage !== null && isChatRunWaitTimeout(error, remainingTimeoutMs)
            if (deadlineExceeded) {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error: runTimeoutMessage })
              nodeStatuses[node.id] = 'failed'
              return { node, ok: false, deadlineExceeded: true, error: runTimeoutMessage }
            }
            if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
              updateWorkflowRunNodeSession(nodeSession.id, { status: 'canceled', finished_at: Date.now(), error })
              nodeStatuses[node.id] = 'canceled'
              this.setRuntimeStatus(workflowId, {
                status: 'canceled',
                runId: run.id,
                error,
                nodeStatuses: { ...nodeStatuses },
              })
              return { node, ok: false, canceled: true, error }
            }
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            completed.add(node.id)
            if (!firstNodeFailure) firstNodeFailure = { node, error }
            for (const edge of outgoing.get(node.id) || []) {
              recordEdgeDecision(edge, 'failure', evaluateWorkflowEdgeRoute(edge.orchestration, 'failure', { error }))
            }
            this.setRuntimeStatus(workflowId, {
              status: 'running',
              runId: run.id,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, handledFailure: true, error }
          }
          const output = lastAssistantOutput(nodeSessionId, runResult.output)
          const approvalTimeoutMs = runDeadline === null ? undefined : runDeadline - Date.now()
          if (approvalTimeoutMs !== undefined && approvalTimeoutMs <= 0) {
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error: runTimeoutMessage })
            nodeStatuses[node.id] = 'failed'
            return { node, ok: false, deadlineExceeded: true, error: runTimeoutMessage! }
          }
          let approved: boolean
          try {
            approved = await this.waitForNodeApproval({
              workflowId: workflowId, runId: run.id, node, nodeStatuses,
              executionId: executionIdFor(node.id),
              timeoutMs: approvalTimeoutMs, timeoutError: runTimeoutMessage || undefined,
            })
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'failed', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'failed'
            return { node, ok: false, deadlineExceeded: error === runTimeoutMessage, error }
          }
          if (this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled') {
            const error = getWorkflowRun(run.id)?.error || 'Workflow run canceled'
            nodeStatuses[node.id] = 'canceled'
            return { node, ok: false, canceled: true, error }
          }
          if (!approved) {
            const error = 'Workflow node approval rejected'
            updateWorkflowRunNodeSession(nodeSession.id, { status: 'approval_rejected', finished_at: Date.now(), error })
            nodeStatuses[node.id] = 'approval_rejected'
            this.setRuntimeStatus(workflowId, {
              status: 'running',
              runId: run.id,
              error,
              nodeStatuses: { ...nodeStatuses },
            })
            return { node, ok: false, approvalRejected: true, error }
          }
          outputs.set(node.id, output)
          const outgoingEdges = outgoing.get(node.id) || []
          const conditionContext = workflowOutputConditionContext(output, outgoingEdges)
          for (const edge of outgoingEdges) {
            recordEdgeDecision(edge, 'success', evaluateWorkflowEdgeRoute(edge.orchestration, 'success', conditionContext))
          }
          completed.add(node.id)
          nodeStatuses[node.id] = 'completed'
          this.setRuntimeStatus(workflowId, {
            status: 'running',
            runId: run.id,
            nodeStatuses: { ...nodeStatuses },
          })
          updateWorkflowRunNodeSession(nodeSession.id, { status: 'completed', finished_at: Date.now(), error: null })
          return { node, ok: true }
          })()
          inFlight.set(node.id, execution)
        }
        if (inFlight.size === 0) continue
        const settled = await Promise.race(inFlight.values())
        inFlight.delete(settled.node.id)
        const results = [settled]

        const failed = results.find(result => !result.ok && !('handledFailure' in result && result.handledFailure))
        if (failed) {
          if (inFlight.size > 0) {
            await Promise.allSettled(inFlight.values())
            inFlight.clear()
          }
          for (const node of activeNodes) {
            if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
          }
          if ('canceled' in failed && failed.canceled) {
            const canceledRun = failRun(failed.error || 'Workflow run canceled')
            return { run: canceledRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          if ('deadlineExceeded' in failed && failed.deadlineExceeded) {
            const failedRun = failRun(failed.error || runTimeoutMessage || 'workflow run timed out')
            return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          if ('approvalRejected' in failed && failed.approvalRejected) {
            const message = `Node ${failed.node.data.title || failed.node.id} approval rejected`
            const failedRun = failRun(message)
            return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
          }
          nodeStatuses[failed.node.id] = 'failed'
          const message = `Node ${failed.node.data.title || failed.node.id} failed: ${failed.error}`
          const failedRun = failRun(message)
          return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
        }
      }

      if (firstNodeFailure) {
        const failure = firstNodeFailure as { node: WorkflowNodeSnapshot; error: string }
        const message = `Node ${failure.node.data.title || failure.node.id} failed: ${failure.error}`
        const failedRun = failRun(message)
        return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
      }
      const finishedAt = Date.now()
      const completedRun = updateWorkflowRun(run.id, { status: 'completed', finished_at: finishedAt, error: null }) || run
      this.setRuntimeStatus(workflowId, {
        status: 'completed',
        runId: run.id,
        completedAt: finishedAt,
        error: null,
        nodeStatuses: { ...nodeStatuses },
      })
      return { run: completedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const canceled = this.canceledRunIds.has(run.id) || getWorkflowRun(run.id)?.status === 'canceled'
      for (const [nodeId, recordId] of nodeSessionRecordIds) {
        if (!completed.has(nodeId)) {
          nodeStatuses[nodeId] = canceled ? 'canceled' : 'failed'
          updateWorkflowRunNodeSession(recordId, { status: canceled ? 'canceled' : 'failed', finished_at: Date.now(), error: message })
        }
      }
      for (const node of activeNodes) {
        if (isUnfinishedWorkflowNodeStatus(nodeStatuses[node.id])) nodeStatuses[node.id] = 'canceled'
      }
      const failedRun = failRun(message)
      return { run: failedRun, nodeSessions: listWorkflowRunNodeSessions(run.id) }
    }
  }

  async runNow(workflowId: string, input: WorkflowRunNowInput = {}): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    if (!isWorkflowRunCoordinatorAvailable()) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }
    const releaseAdmission = await this.acquireRunAdmission(workflowId)
    let run: WorkflowRunRecord
    let profile: string
    let executionPreflight: Awaited<ReturnType<typeof preflightWorkflowExecutionDefinition>>
    try {
      if (listActiveWorkflowRuns().some(activeRun => activeRun.workflow_id === workflowId)) {
        const err = new Error('workflow is already running')
        ;(err as any).status = 409
        throw err
      }

      profile = input.profile?.trim() || workflow.profile || 'default'
      executionPreflight = await preflightWorkflowExecutionDefinition(workflow.nodes, workflow.edges, profile, input.startNodeIds || [])
      const startedAt = Date.now()
      const runDeadline = input.timeoutMs && input.timeoutMs > 0 ? startedAt + input.timeoutMs : null
      const snapshot = workflowRunSnapshotGraph(workflow.nodes, workflow.edges, executionPreflight.compiled)
      const createRun = () => {
        const created = createWorkflowRun({
        workflow_id: workflow.id,
        user_id: input.user?.id ?? input.pushActor?.userId ?? null,
        profile,
        workspace: workflow.workspace,
        start_node_ids: executionPreflight.schedulerStartNodeIds,
        status: 'running',
        // Freeze authored visual fields together with the validated execution
        // target and canonical orchestration used by the scheduler below.
        snapshot_nodes: snapshot.nodes,
        snapshot_edges: snapshot.edges,
        compiled_loops: executionPreflight.compiled.loops,
        requested_timeout_ms: input.timeoutMs ?? null,
        deadline_at: runDeadline,
        started_at: startedAt,
        trigger_source: input.triggerSource === 'scheduled' ? 'scheduled' : 'manual',
        scheduled_at: input.triggerSource === 'scheduled' ? input.scheduledAt ?? null : null,
      })
        if (input.pushActor) bindRunPushTarget({ kind: 'workflow', profile, runId: created.id }, workflow.id, input.pushActor, input.pushSnapshot)
        return created
      }
      run = input.pushActor ? pushRunTransaction(createRun) : createRun()
    } finally {
      releaseAdmission()
    }
    const compiledGraph = executionPreflight.compiled
    const nodes = compiledGraph.nodes
    const edges = compiledGraph.edges
    const startNodeIds = executionPreflight.schedulerStartNodeIds
    const activeIds = executionPreflight.activeNodeIds
    const activeNodes = executionPreflight.activeNodes

    const startedAt = run.started_at || Date.now()
    const runDeadline = run.deadline_at
    const runTimeoutMessage = input.timeoutMs && input.timeoutMs > 0
      ? `workflow run timed out after ${input.timeoutMs}ms`
      : null
    this.canceledRunIds.delete(run.id)
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const])),
    })
    input.onAccepted?.(run)

    const nodeStatuses: Record<string, WorkflowRuntimeState> = Object.fromEntries(activeNodes.map(node => [node.id, 'queued' as const]))

    const activeLoops = compiledGraph.loops.filter(loop => loop.bodyNodeIds.some(nodeId => activeIds.has(nodeId)))
    if (activeLoops.length > 0) {
      return this.executeRecursiveCompiledWorkflowRun({
        workflowId: workflow.id, workspace: workflow.workspace, run, profile, nodes, edges,
        loops: activeLoops, startNodeIds, activeIds, input: input.input, user: input.user,
        runDeadline, runTimeoutMessage,
      })
    }

    return this.executeCompletionDrivenDagRun({
      workflowId: workflow.id, workspace: workflow.workspace, run, profile, nodes, edges,
      startNodeIds, activeIds, input: input.input, user: input.user, runDeadline, runTimeoutMessage,
    })
  }

  async rerunFromNode(
    workflowId: string,
    runId: string,
    nodeId: string,
    input: WorkflowRerunFromNodeInput = {},
  ): Promise<WorkflowRunNowResult> {
    const workflow = this.get(workflowId)
    if (!workflow) {
      const err = new Error('workflow not found')
      ;(err as any).status = 404
      throw err
    }
    const run = getWorkflowRun(runId)
    if (!run || run.workflow_id !== workflowId) {
      const err = new Error('workflow run not found')
      ;(err as any).status = 404
      throw err
    }
    if (run.status === 'queued' || run.status === 'running') {
      const err = new Error('workflow run is still active')
      ;(err as any).status = 409
      throw err
    }

    if (!isWorkflowRunCoordinatorAvailable()) {
      const err = new Error('chat-run server is not available')
      ;(err as any).status = 503
      throw err
    }

    const profile = input.profile?.trim() || run.profile || workflow.profile || 'default'
    const rerunPreflight = await preflightWorkflowRerunDefinition({ run, nodeId, profile, preserveStartNode: input.preserveStartNode })
    const acceptedRun = getWorkflowRun(runId)
    if (!acceptedRun || acceptedRun.workflow_id !== workflowId) {
      throw Object.assign(new Error('workflow run not found'), { status: 404 })
    }
    if (acceptedRun.status === 'queued' || acceptedRun.status === 'running') {
      throw Object.assign(new Error('workflow run is still active'), { status: 409 })
    }
    if (acceptedRun.started_at !== run.started_at || acceptedRun.finished_at !== run.finished_at) {
      throw Object.assign(new Error('workflow run changed during rerun preflight'), { status: 409 })
    }
    const compiledGraph = rerunPreflight.compiled
    const nodes = compiledGraph.nodes
    const edges = compiledGraph.edges
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const targetNodeId = nodeId.trim()
    if (!targetNodeId || !nodeById.has(targetNodeId)) {
      const err = new Error('workflow node not found in run snapshot')
      ;(err as any).status = 404
      throw err
    }

    const incoming = new Map<string, WorkflowEdgeSnapshot[]>()
    for (const node of nodes) incoming.set(node.id, [])
    for (const edge of edges) incoming.get(edge.target)!.push(edge)

    const existingNodeSessions = listWorkflowRunNodeSessions(run.id)
    const existingSessionByNode = latestNodeSessionsByNode(existingNodeSessions)
    const preserveStartNode = Boolean(input.preserveStartNode)
    const activeIds = rerunPreflight.activeNodeIds
    const activeNodes = rerunPreflight.activeNodes
    const downstreamStartIds = rerunPreflight.schedulerStartNodeIds
    const outputs = new Map<string, string>()
    const nodeStatuses: Record<string, WorkflowRuntimeState> = {}
    for (const session of existingNodeSessions) {
      if (activeIds.has(session.node_id)) continue
      nodeStatuses[session.node_id] = session.status === 'blocked' ? 'failed' : session.status
      if (session.status === 'completed') {
        outputs.set(session.node_id, lastAssistantOutput(session.session_id))
      }
    }

    for (const node of activeNodes) {
      for (const edge of incoming.get(node.id) || []) {
        if (activeIds.has(edge.source)) continue
        const upstreamSession = existingSessionByNode.get(edge.source)
        if (!upstreamSession || upstreamSession.status !== 'completed') {
          const upstream = nodeById.get(edge.source)
          const err = new Error(`Upstream node ${upstream?.data.title || edge.source} has no completed output`)
          ;(err as any).status = 409
          throw err
        }
      }
    }

    const startedAt = Math.max(Date.now(), (run.started_at || 0) + 1)
    const runDeadline = input.timeoutMs && input.timeoutMs > 0 ? startedAt + input.timeoutMs : null
    const runTimeoutMessage = input.timeoutMs && input.timeoutMs > 0
      ? `workflow run timed out after ${input.timeoutMs}ms`
      : null
    const updatedRun = updateWorkflowRun(run.id, {
      status: 'running',
      requested_timeout_ms: input.timeoutMs ?? null,
      deadline_at: runDeadline,
      started_at: startedAt,
      finished_at: null,
      error: null,
      allow_terminal_reset: true,
    }) || run
    this.canceledRunIds.delete(run.id)
    for (const node of activeNodes) nodeStatuses[node.id] = 'queued'
    this.setRuntimeStatus(workflow.id, {
      status: 'running',
      runId: run.id,
      startedAt,
      completedAt: null,
      error: null,
      nodeStatuses: { ...nodeStatuses },
    })
    input.onAccepted?.(updatedRun)

    const sharedSchedulerArgs = {
      workflowId: workflow.id, workspace: run.workspace, run: updatedRun, profile, nodes, edges,
      startNodeIds: downstreamStartIds, activeIds,
      user: input.user, runDeadline, runTimeoutMessage,
      initialNodeStatuses: nodeStatuses, initialOutputs: outputs,
      executionScope: `rerun:${startedAt}`,
      ignoreHistoricalIncomingForStartNodes: !preserveStartNode,
    }
    const activeLoops = compiledGraph.loops.filter(loop => loop.bodyNodeIds.some(activeNodeId => activeIds.has(activeNodeId)))
    return activeLoops.length > 0
      ? this.executeRecursiveCompiledWorkflowRun({ ...sharedSchedulerArgs, loops: activeLoops })
      : this.executeCompletionDrivenDagRun(sharedSchedulerArgs)
  }

  private async buildNodeUserMessage(args: {
    node: WorkflowNodeSnapshot
    incomingEdges: WorkflowEdgeSnapshot[]
    nodeById: Map<string, WorkflowNodeSnapshot>
    outputs: Map<string, string>
    overrideInput?: string | null
    profile: string
  }): Promise<string | ContentBlock[]> {
    const parts: string[] = []
    if (args.incomingEdges.length > 0) {
      parts.push('[Workflow upstream results]')
      for (const edge of args.incomingEdges) {
        const upstream = args.nodeById.get(edge.source)
        parts.push(`\n[Upstream: ${upstream?.data.title || edge.source}]\n${args.outputs.get(edge.source) || ''}`)
      }
    }

    if (args.node.data.skills.length > 0) {
      parts.push('\n[Workflow selected skills]')
      for (const skillName of args.node.data.skills) {
        const skill = await resolveWorkflowSkillContent({
          agent: args.node.data.agent,
          profile: args.profile,
          skillName,
        })
        if (!skill) throw new Error(`Skill "${skillName}" not found for ${args.node.data.agent || 'hermes'}`)
        parts.push(`\n[Skill: ${skill.name}]\n${skill.content}`)
      }
    }

    const currentTask = args.overrideInput ?? args.node.data.input
    parts.push(`\n[Current task]\n${currentTask || 'Execute the current workflow node.'}`)
    const text = parts.join('\n').trim()
    if (args.node.data.images.length === 0) return text
    return [
      { type: 'text', text },
      ...args.node.data.images.map(workflowAttachmentBlock),
    ]
  }
}

let singleton: WorkflowManager | null = null

export function getWorkflowManager(): WorkflowManager {
  if (!singleton) singleton = new WorkflowManager()
  return singleton
}
