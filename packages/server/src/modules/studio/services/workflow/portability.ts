import { createHash, randomUUID } from 'crypto'
import type { WorkflowRecord } from '../../repositories/workflow-store'

export const WORKFLOW_EXPORT_FORMAT = 'hermes-studio.workflow'
export const WORKFLOW_EXPORT_VERSION = 1
export const MAX_WORKFLOW_IMPORT_BYTES = 1024 * 1024
export const MAX_WORKFLOW_IMPORT_DEPTH = 20
export const MAX_WORKFLOW_IMPORT_NODES = 500
export const MAX_WORKFLOW_IMPORT_EDGES = 2000
const PREVIEW_TTL_MS = 5 * 60 * 1000
const MAX_PENDING_PREVIEWS = 1000
const CREDENTIAL_KEYS = new Set(['token', 'accesstoken', 'access_token', 'refreshtoken', 'refresh_token', 'apikey', 'api_key', 'password', 'secret', 'clientsecret', 'client_secret', 'privatekey', 'private_key', 'authorization', 'bearer', 'cookie', 'sessionid', 'session_id', 'runid', 'run_id'])
const NODE_KEYS = ['id', 'type', 'position']
const NODE_DATA_KEYS = ['title', 'agent', 'agentMode', 'agentPreset', 'input', 'skills', 'approvalRequired', 'orchestration']
const LEGACY_NODE_RUNTIME_BINDING_KEYS = ['provider', 'model', 'apiMode', 'reasoningEffort']
const IMPORT_NODE_DATA_KEYS = [...NODE_DATA_KEYS, ...LEGACY_NODE_RUNTIME_BINDING_KEYS, 'executionPolicy']
const DEFINITION_KEYS = ['name', 'nodes', 'edges', 'viewport']
const EDGE_KEYS = ['id', 'source', 'target', 'sourceHandle', 'targetHandle', 'type', 'animated', 'data']
const EDGE_DATA_KEYS = ['orchestration']
const NODE_ORCHESTRATION_KEYS = ['join']
const EDGE_ORCHESTRATION_KEYS = ['route', 'condition', 'feedback']
const CONDITION_KEYS = ['path', 'operator', 'value']
const FEEDBACK_KEYS = ['maxIterations', 'loopId']

type GraphValidator = (nodes: unknown[], edges: unknown[], starts?: string[]) => unknown
export interface WorkflowExportEnvelope { format: typeof WORKFLOW_EXPORT_FORMAT; version: 1; definition: { name: string; nodes: any[]; edges: any[]; viewport: Record<string, unknown> | null } }
export interface WorkflowImportOptions { ownerId: string; profile: string; environmentRevision?: string; now?: () => number; validateGraph: GraphValidator }
export interface ConsumedWorkflowImportPreview { ownerId: string; profile: string; environmentRevision: string; digest: string; expiresAt: number; definition: WorkflowExportEnvelope['definition'] }
interface PendingPreview { ownerId: string; profile: string; environmentRevision: string; digest: string; expiresAt: number; definition: WorkflowExportEnvelope['definition'] }
const pendingPreviews = new Map<string, PendingPreview>()

function purgePendingPreviews(now: number): void {
  for (const [token, preview] of pendingPreviews) if (now > preview.expiresAt) pendingPreviews.delete(token)
  while (pendingPreviews.size >= MAX_PENDING_PREVIEWS) {
    const oldest = pendingPreviews.keys().next().value
    if (!oldest) break
    pendingPreviews.delete(oldest)
  }
}

function cloneAllowed(record: Record<string, any>, keys: string[]): Record<string, any> {
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, structuredClone(record[key])]))
}
function allowedObject(value: unknown, keys: string[]): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? cloneAllowed(value as Record<string, any>, keys)
    : undefined
}

function exportNode(raw: any): any {
  const node = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data) ? node.data : {}
  const exportedData = cloneAllowed(data, NODE_DATA_KEYS)
  const orchestration = allowedObject(data.orchestration, NODE_ORCHESTRATION_KEYS)
  if (orchestration) exportedData.orchestration = orchestration
  return { ...cloneAllowed(node, NODE_KEYS), data: exportedData }
}
function exportEdge(raw: any): any {
  const edge = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const exported = cloneAllowed(edge, EDGE_KEYS)
  const data = allowedObject(edge.data, EDGE_DATA_KEYS)
  if (!data) return exported
  const sourceOrchestration = edge.data?.orchestration
  const orchestration = allowedObject(sourceOrchestration, EDGE_ORCHESTRATION_KEYS)
  if (orchestration) {
    const condition = allowedObject(sourceOrchestration?.condition, CONDITION_KEYS)
    const feedback = allowedObject(sourceOrchestration?.feedback, FEEDBACK_KEYS)
    if (condition) orchestration.condition = condition
    if (feedback) orchestration.feedback = feedback
    data.orchestration = orchestration
  }
  exported.data = data
  return exported
}
export function exportWorkflowDefinition(workflow: WorkflowRecord): WorkflowExportEnvelope {
  const envelope: WorkflowExportEnvelope = { format: WORKFLOW_EXPORT_FORMAT, version: WORKFLOW_EXPORT_VERSION, definition: {
    name: workflow.name, nodes: workflow.nodes.map(exportNode), edges: workflow.edges.map(exportEdge),
    viewport: workflow.viewport ? structuredClone(workflow.viewport) : null,
  } }
  assertDepthAndCredentials(envelope)
  return envelope
}
function assertAllowedKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unsupported = Object.keys(record).find(key => !allowedSet.has(key))
  if (unsupported) throw new Error(`workflow import contains unsupported ${label} field: ${unsupported}`)
}

function assertDefinitionAllowlist(definition: Record<string, any>): void {
  assertAllowedKeys(definition, DEFINITION_KEYS, 'definition')
  if (definition.viewport != null) {
    if (typeof definition.viewport !== 'object' || Array.isArray(definition.viewport)) throw new Error('workflow import viewport must be an object or null')
    assertAllowedKeys(definition.viewport, ['x', 'y', 'zoom'], 'viewport')
    if (![definition.viewport.x, definition.viewport.y, definition.viewport.zoom].every(Number.isFinite)) throw new Error('workflow import viewport must contain finite x, y, and zoom')
  }
  for (const node of definition.nodes || []) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue
    assertAllowedKeys(node, NODE_KEYS.concat('data'), 'node')
    if (!node.position || typeof node.position !== 'object' || Array.isArray(node.position)) throw new Error('workflow import node position is required')
    assertAllowedKeys(node.position, ['x', 'y'], 'node position')
    if (![node.position.x, node.position.y].every(Number.isFinite)) throw new Error('workflow import node position must contain finite x and y')
    if (node.data && typeof node.data === 'object' && !Array.isArray(node.data)) {
      // executionPolicy was present in prerelease Workflow exports; accept and discard it.
      assertAllowedKeys(node.data, IMPORT_NODE_DATA_KEYS, 'node data')
      if (node.data.orchestration != null) {
        if (typeof node.data.orchestration !== 'object' || Array.isArray(node.data.orchestration)) throw new Error('workflow import node orchestration must be an object')
        assertAllowedKeys(node.data.orchestration, NODE_ORCHESTRATION_KEYS, 'node orchestration')
      }
    }
  }
  for (const edge of definition.edges || []) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) continue
    assertAllowedKeys(edge, EDGE_KEYS, 'edge')
    if (edge.data && typeof edge.data === 'object' && !Array.isArray(edge.data)) {
      assertAllowedKeys(edge.data, EDGE_DATA_KEYS, 'edge data')
      if (edge.data.orchestration != null) {
        if (typeof edge.data.orchestration !== 'object' || Array.isArray(edge.data.orchestration)) throw new Error('workflow import edge orchestration must be an object')
        assertAllowedKeys(edge.data.orchestration, EDGE_ORCHESTRATION_KEYS, 'edge orchestration')
        if (edge.data.orchestration.condition != null) {
          if (typeof edge.data.orchestration.condition !== 'object' || Array.isArray(edge.data.orchestration.condition)) throw new Error('workflow import edge condition must be an object')
          assertAllowedKeys(edge.data.orchestration.condition, CONDITION_KEYS, 'edge condition')
        }
        if (edge.data.orchestration.feedback != null && edge.data.orchestration.feedback !== true) {
          if (typeof edge.data.orchestration.feedback !== 'object' || Array.isArray(edge.data.orchestration.feedback)) throw new Error('workflow import edge feedback must be an object')
          assertAllowedKeys(edge.data.orchestration.feedback, FEEDBACK_KEYS, 'edge feedback')
        }
      }
    }
  }
}

function assertDepthAndCredentials(value: unknown, depth = 0): void {
  if (depth > MAX_WORKFLOW_IMPORT_DEPTH) throw new Error(`workflow import exceeds maximum depth ${MAX_WORKFLOW_IMPORT_DEPTH}`)
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const item of value) assertDepthAndCredentials(item, depth + 1); return }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) throw new Error(`workflow import contains credential field: ${key}`)
    assertDepthAndCredentials(child, depth + 1)
  }
}

function parseAndValidate(raw: string, validateGraph: GraphValidator): WorkflowExportEnvelope['definition'] {
  if (Buffer.byteLength(raw, 'utf8') > MAX_WORKFLOW_IMPORT_BYTES) throw new Error(`workflow import exceeds ${MAX_WORKFLOW_IMPORT_BYTES} bytes`)
  let envelope: any
  try { envelope = JSON.parse(raw) } catch { throw new Error('workflow import is not valid JSON') }
  assertDepthAndCredentials(envelope)
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('workflow import envelope is required')
  assertAllowedKeys(envelope, ['format', 'version', 'definition'], 'envelope')
  if (envelope.format !== WORKFLOW_EXPORT_FORMAT) throw new Error('unsupported workflow import format')
  if (envelope.version !== WORKFLOW_EXPORT_VERSION) throw new Error('unsupported workflow import version')
  const definition = envelope.definition
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('workflow import definition is required')
  if (typeof definition.name !== 'string' || !definition.name.trim()) throw new Error('workflow import name is required')
  if (!Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) throw new Error('workflow import nodes and edges must be arrays')
  assertDefinitionAllowlist(definition)
  if (definition.nodes.length > MAX_WORKFLOW_IMPORT_NODES) throw new Error(`workflow import exceeds ${MAX_WORKFLOW_IMPORT_NODES} nodes`)
  if (definition.edges.length > MAX_WORKFLOW_IMPORT_EDGES) throw new Error(`workflow import exceeds ${MAX_WORKFLOW_IMPORT_EDGES} edges`)
  for (const node of definition.nodes) {
    if (!node || node.type !== 'agent') throw new Error('workflow import is Agent-only')
  }
  validateGraph(definition.nodes, definition.edges)
  return { name: definition.name.trim(), nodes: definition.nodes.map(exportNode), edges: definition.edges.map(exportEdge), viewport: definition.viewport && typeof definition.viewport === 'object' && !Array.isArray(definition.viewport) ? structuredClone(definition.viewport) : null }
}
export function inspectWorkflowImportDocument(raw: string, validateGraph: GraphValidator): WorkflowExportEnvelope['definition'] {
  return parseAndValidate(raw, validateGraph)
}

export function previewWorkflowImport(raw: string, options: WorkflowImportOptions) {
  const definition = parseAndValidate(raw, options.validateGraph)
  const digest = createHash('sha256').update(JSON.stringify(definition)).digest('hex')
  const token = randomUUID(), now = (options.now || Date.now)()
  purgePendingPreviews(now)
  pendingPreviews.set(token, { ownerId: options.ownerId, profile: options.profile, environmentRevision: options.environmentRevision || '', digest, expiresAt: now + PREVIEW_TTL_MS, definition })
  return { token, digest, expiresAt: now + PREVIEW_TTL_MS, summary: { name: definition.name, nodes: definition.nodes.length, edges: definition.edges.length } }
}
export function consumeWorkflowImportPreview(
  token: string,
  ownerId: string,
  profile: string,
  now: () => number = Date.now,
): ConsumedWorkflowImportPreview {
  const preview = pendingPreviews.get(token)
  if (!preview || preview.ownerId !== ownerId || preview.profile !== profile) throw new Error('workflow import preview is not available')
  pendingPreviews.delete(token)
  if (now() > preview.expiresAt) throw new Error('workflow import preview expired')
  return structuredClone(preview)
}

export function finalizeConsumedWorkflowImport(preview: ConsumedWorkflowImportPreview, options: WorkflowImportOptions) {
  if (preview.ownerId !== options.ownerId || preview.profile !== options.profile) throw new Error('workflow import preview is not available')
  if (preview.environmentRevision !== (options.environmentRevision || '')) throw new Error('workflow import target environment changed after preview')
  options.validateGraph(preview.definition.nodes, preview.definition.edges)
  const digest = createHash('sha256').update(JSON.stringify(preview.definition)).digest('hex')
  if (digest !== preview.digest) throw new Error('workflow import preview digest mismatch')
  const nodeIds = new Map<string, string>()
  const nodes = preview.definition.nodes.map(node => { const id = randomUUID(); nodeIds.set(node.id, id); return { ...structuredClone(node), id } })
  const edges = preview.definition.edges.map(edge => ({ ...structuredClone(edge), id: randomUUID(), source: nodeIds.get(edge.source), target: nodeIds.get(edge.target) }))
  options.validateGraph(nodes, edges)
  return { name: preview.definition.name, profile: options.profile, nodes, edges, viewport: structuredClone(preview.definition.viewport) }
}

export function confirmWorkflowImport(token: string, options: WorkflowImportOptions) {
  const preview = consumeWorkflowImportPreview(token, options.ownerId, options.profile, options.now || Date.now)
  return finalizeConsumedWorkflowImport(preview, options)
}

export function cancelWorkflowImport(token: string, ownerId: string, profile: string): boolean {
  const preview = pendingPreviews.get(token)
  if (!preview || preview.ownerId !== ownerId || preview.profile !== profile) return false
  pendingPreviews.delete(token)
  return true
}
