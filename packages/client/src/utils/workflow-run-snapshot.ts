import { MarkerType, type EdgeMarkerType } from '@vue-flow/core'
import { normalizeWorkflowHandleId, workflowEdgeVisualType } from './workflow-edge-authoring'
import { isGlobalOnlyCodingAgent } from './agent-catalog'

export interface WorkflowRunNodeModelDetails {
  id: string
  title: string
  agent: string
  agentMode: 'scoped' | 'global'
  provider: string
  model: string | null
  reasoningEffort: string | null
}

// Read the run's configuration directly; authoring defaults and today's model
// catalog must not fill in fields that an older run did not record.
export function workflowRunNodeModelDetails(nodes: unknown[]): WorkflowRunNodeModelDetails[] {
  return nodes.flatMap(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const record = raw as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id || (record.type && record.type !== 'agent')) return []
    const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown> : {}
    const agent = typeof data.agent === 'string' && data.agent ? data.agent : 'hermes'
    return [{
      id: record.id,
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : record.id,
      agent,
      agentMode: data.agentMode === 'global' || isGlobalOnlyCodingAgent(agent) ? 'global' : 'scoped',
      provider: typeof data.provider === 'string' ? data.provider : '',
      model: typeof data.model === 'string' ? data.model : null,
      reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : null,
    }]
  })
}

export interface WorkflowRunEdgeOrchestration {
  route: 'success' | 'failure' | 'always'
  condition?: { path: string; operator: string; value?: unknown }
  feedback?: { maxIterations: number; loopId?: string }
}

export interface WorkflowRunPlaybackEdge {
  id: string
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  type: 'smoothstep' | 'workflow-self-loop'
  animated: boolean
  markerEnd: EdgeMarkerType
  label?: string
  data?: { orchestration?: WorkflowRunEdgeOrchestration; [key: string]: unknown }
}

export function normalizeWorkflowRunNodeTargets<
  T extends { data: D },
  D extends object,
>(
  nodes: T[],
  frozen: boolean,
  normalize: (data: D) => Partial<D>,
): T[] {
  if (frozen) return nodes
  return nodes.map(node => ({
    ...node,
    data: { ...node.data, ...normalize(node.data) },
  }))
}

export function workflowRunEdgeCanvasLabel(
  authoredLabel: unknown,
  derivedLabel: string,
  frozen: boolean,
): string {
  return frozen && typeof authoredLabel === 'string' ? authoredLabel : derivedLabel
}

export function normalizeWorkflowRunEdge(raw: unknown): WorkflowRunPlaybackEdge | null {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  if (typeof record.source !== 'string' || typeof record.target !== 'string') return null
  const authoredData = record.data && typeof record.data === 'object' ? { ...record.data } : undefined
  const legacyOrchestration = record.orchestration && typeof record.orchestration === 'object'
    ? { ...record.orchestration } as WorkflowRunEdgeOrchestration
    : undefined
  const data = authoredData?.orchestration || !legacyOrchestration
    ? authoredData
    : { ...(authoredData || {}), orchestration: legacyOrchestration }
  return {
    id: typeof record.id === 'string' && record.id ? record.id : `${record.source}-${record.target}`,
    source: record.source,
    target: record.target,
    sourceHandle: normalizeWorkflowHandleId(record.sourceHandle, 'source'),
    targetHandle: normalizeWorkflowHandleId(record.targetHandle, 'target'),
    type: workflowEdgeVisualType(record.source, record.target),
    animated: Boolean(record.animated),
    markerEnd: MarkerType.ArrowClosed,
    ...(typeof record.label === 'string' ? { label: record.label } : {}),
    data,
  }
}
