import { authenticatedPushActor, prepareRunPushSnapshot } from '../services/notifications/push-registration'
import type { Context } from 'koa'
import { assertWorkflowNodeSkillDependencies, getWorkflowManager, preflightWorkflowExecutionDefinition, preflightWorkflowRerunDefinition, type WorkflowRerunFromNodeInput, type WorkflowRunNowInput, type WorkflowUpdateInput, compileWorkflowGraphPreflight } from '../services/workflow/manager'
import { getWorkflowRunWithEvidence, listWorkflowRunsWithEvidence, createWorkflowSchedule, deleteWorkflowSchedule, getWorkflowSchedule, listWorkflowSchedules, updateWorkflowSchedule } from '../public/workflows'
import { listUserProfiles } from '../public/users'
import { logger } from '../public/logging'
import { cancelWorkflowImport, consumeWorkflowImportPreview, exportWorkflowDefinition, finalizeConsumedWorkflowImport, previewWorkflowImport } from '../services/workflow/portability'
import { assertWorkflowImportCapabilities } from '../services/workflow/import-capabilities'
import { getWorkflowAvailableModelGroups } from '../public/workflow-runtime'
import { assertWorkflowScheduleCron, nextWorkflowScheduleAt, normalizeWorkflowSchedule } from '../services/workflow/schedule'

const MAX_BATCH_DELETE = 200

function bodyRecord(ctx: Context): Record<string, unknown> {
  const body = ctx.request.body
  return body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
}

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function profileName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default'
}

function requestedProfile(ctx: Context, body?: Record<string, unknown>): string | null {
  const bodyProfile = body && typeof body.profile === 'string' ? body.profile.trim() : ''
  const queryProfile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  const stateProfile = ctx.state?.profile?.name || ''
  return stateProfile || bodyProfile || queryProfile || null
}

function explicitListProfile(ctx: Context): string | null {
  const profile = firstQueryValue(ctx.query.profile as string | string[] | undefined)?.trim() || ''
  return profile || null
}

function allowedProfileSet(ctx: Context): Set<string> | null {
  const user = ctx.state?.user
  if (!user || user.role === 'super_admin') return null
  return new Set(listUserProfiles(user.id).map(profile => profile.profile_name))
}

function canAccessProfile(ctx: Context, profile: string | null | undefined): boolean {
  const allowed = allowedProfileSet(ctx)
  return !allowed || allowed.has(profileName(profile))
}

function denyProfileAccess(ctx: Context, profile: string | null | undefined): boolean {
  if (canAccessProfile(ctx, profile)) return false
  ctx.status = 403
  ctx.body = { error: `Profile "${profileName(profile)}" is not available for this user` }
  return true
}

function filterByAllowedProfiles<T extends { profile: string }>(ctx: Context, items: T[]): T[] {
  const allowed = allowedProfileSet(ctx)
  if (!allowed) return items
  return items.filter(item => allowed.has(profileName(item.profile)))
}

function requiredId(ctx: Context): string | null {
  const id = typeof ctx.params?.id === 'string' ? ctx.params.id.trim() : ''
  if (id) return id
  ctx.status = 400
  ctx.body = { error: 'id is required' }
  return null
}

function optionalJsonArray(value: unknown, name: string): { value?: unknown[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value)) return { error: `${name} must be an array` }
  return { value }
}

function optionalNullableString(value: unknown, name: string): { value?: string | null; error?: string } {
  if (value === undefined) return {}
  if (value === null) return { value: null }
  if (typeof value !== 'string') return { error: `${name} must be a string` }
  return { value }
}

function optionalJsonObject(value: unknown, name: string): { value?: Record<string, unknown> | null; error?: string } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return { error: `${name} must be an object` }
  return { value: value as Record<string, unknown> }
}

function optionalStringArray(value: unknown, name: string): { value?: string[]; error?: string } {
  if (value === undefined || value === null) return {}
  if (!Array.isArray(value)) return { error: `${name} must be an array` }
  const strings = value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
  return { value: strings }
}

function rejectBadRequest(ctx: Context, error?: string): boolean {
  if (!error) return false
  ctx.status = 400
  ctx.body = { error }
  return true
}

function optionalWorkflowTimeoutMs(value: unknown): { value?: number; error?: string } {
  if (value === undefined || value === null) return {}
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 1_000 || numberValue > 86_400_000) {
    return { error: 'timeout_ms must be an integer from 1000 to 86400000 milliseconds' }
  }
  return { value: numberValue }
}

function optionalBoolean(value: unknown, name: string): { value?: boolean; error?: string } {
  if (value === undefined || value === null) return {}
  if (typeof value === 'boolean') return { value }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return { value: true }
    if (normalized === 'false') return { value: false }
  }
  return { error: `${name} must be a boolean` }
}

function importOwnerId(ctx: Context): string {
  return String(ctx.state?.user?.id || 'anonymous')
}

async function assertWorkflowExecutionCapabilities(profile: string, nodes: unknown[]): Promise<void> {
  const capabilityGroups = await getWorkflowAvailableModelGroups(profile)
  assertWorkflowImportCapabilities(nodes, capabilityGroups)
}

function validateWorkflowDefinitionMutation(nodes: unknown[], edges: unknown[]): void {
  if (nodes.length === 0) {
    if (edges.length > 0) throw new Error('workflow edges require Agent nodes')
    return
  }
  compileWorkflowGraphPreflight(nodes, edges)
}


function scheduleId(ctx: Context): string {
  return String(ctx.params?.scheduleId || '').trim()
}

function scheduleOwnerUserId(ctx: Context): number | null {
  const value = Number(ctx.state?.user?.id)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function workflowScheduleInput(body: Record<string, unknown>, workflow: { profile: string }) {
  const schedule = normalizeWorkflowSchedule(String(body.schedule || ''))
  const timezone = String(body.timezone || 'UTC').trim()
  if (!schedule) throw new Error('schedule is required')
  assertWorkflowScheduleCron(schedule)
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }) } catch { throw new Error('timezone must be an IANA timezone') }
  const start = optionalStringArray(body.start_node_ids ?? body.startNodeIds, 'start_node_ids')
  const input = optionalNullableString(body.input, 'input')
  const timeout = optionalWorkflowTimeoutMs(body.timeout_ms ?? body.timeoutMs)
  const enabled = optionalBoolean(body.enabled, 'enabled')
  if (start.error || input.error || timeout.error || enabled.error) throw new Error(start.error || input.error || timeout.error || enabled.error)
  return { profile: workflow.profile, schedule, timezone, enabled: enabled.value ?? true, input: input.value ?? null, start_node_ids: start.value ?? [], timeout_ms: timeout.value ?? null, next_run_at: nextWorkflowScheduleAt(schedule, timezone, Date.now()) }
}

export async function listSchedules(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const workflow = getWorkflowManager().get(id)
  if (!workflow) { ctx.status = 404; ctx.body = { error: 'workflow not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  ctx.body = { schedules: listWorkflowSchedules(id) }
}

export async function createSchedule(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const workflow = getWorkflowManager().get(id)
  if (!workflow) { ctx.status = 404; ctx.body = { error: 'workflow not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  try {
    const value = workflowScheduleInput(bodyRecord(ctx), workflow)
    ctx.status = 201
    ctx.body = { schedule: createWorkflowSchedule({ workflow_id: id, owner_user_id: scheduleOwnerUserId(ctx), ...value }) }
  } catch (err: any) { ctx.status = 400; ctx.body = { error: err?.message || 'invalid schedule' } }
}

export async function updateSchedule(ctx: Context) {
  const id = requiredId(ctx)
  const sid = scheduleId(ctx)
  if (!id || !sid) return
  const workflow = getWorkflowManager().get(id)
  const current = getWorkflowSchedule(sid)
  if (!workflow || !current || current.workflow_id !== id) { ctx.status = 404; ctx.body = { error: 'workflow schedule not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  try {
    const value = workflowScheduleInput({ ...current, ...bodyRecord(ctx) }, workflow)
    ctx.body = { schedule: updateWorkflowSchedule(sid, value) }
  } catch (err: any) { ctx.status = 400; ctx.body = { error: err?.message || 'invalid schedule' } }
}

export async function removeSchedule(ctx: Context) {
  const id = requiredId(ctx)
  const sid = scheduleId(ctx)
  if (!id || !sid) return
  const workflow = getWorkflowManager().get(id)
  const current = getWorkflowSchedule(sid)
  if (!workflow || !current || current.workflow_id !== id) { ctx.status = 404; ctx.body = { error: 'workflow schedule not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  deleteWorkflowSchedule(sid)
  ctx.body = { ok: true }
}

export async function exportDefinition(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const workflow = getWorkflowManager().get(id)
  if (!workflow) { ctx.status = 404; ctx.body = { error: 'workflow not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  ctx.body = exportWorkflowDefinition(workflow)
}

export async function previewImport(ctx: Context) {
  const body = bodyRecord(ctx)
  const profile = requestedProfile(ctx, body) || 'default'
  if (denyProfileAccess(ctx, profile)) return
  if (typeof body.document !== 'string') { ctx.status = 400; ctx.body = { error: 'document must be a JSON string' }; return }
  try {
    const validateGraph = (nodes: unknown[], edges: unknown[], starts?: string[]) => compileWorkflowGraphPreflight(nodes, edges, starts)
    const preview = previewWorkflowImport(body.document, {
      ownerId: importOwnerId(ctx), profile, validateGraph,
    })
    ctx.body = { ok: true, preview }
  } catch (err: any) { ctx.status = err?.status === 409 ? 409 : 400; ctx.body = { error: err?.message || 'invalid workflow import' } }
}

export async function cancelImport(ctx: Context) {
  const body = bodyRecord(ctx)
  const profile = requestedProfile(ctx, body) || 'default'
  if (denyProfileAccess(ctx, profile)) return
  if (typeof body.token !== 'string' || !body.token.trim()) { ctx.status = 400; ctx.body = { error: 'token is required' }; return }
  cancelWorkflowImport(body.token.trim(), importOwnerId(ctx), profile)
  ctx.body = { ok: true }
}

export async function confirmImport(ctx: Context) {
  const body = bodyRecord(ctx)
  const profile = requestedProfile(ctx, body) || 'default'
  if (denyProfileAccess(ctx, profile)) return
  if (typeof body.token !== 'string' || !body.token.trim()) { ctx.status = 400; ctx.body = { error: 'token is required' }; return }
  try {
    const consumed = consumeWorkflowImportPreview(body.token.trim(), importOwnerId(ctx), profile)
    const validateGraph = (nodes: unknown[], edges: unknown[], starts?: string[]) => compileWorkflowGraphPreflight(nodes, edges, starts)
    const input = finalizeConsumedWorkflowImport(consumed, {
      ownerId: importOwnerId(ctx), profile, validateGraph,
    })
    const workflow = getWorkflowManager().create(input)
    ctx.status = 201
    ctx.body = { ok: true, workflow }
  } catch (err: any) { ctx.status = 409; ctx.body = { error: err?.message || 'workflow import confirmation failed' } }
}

export async function list(ctx: Context) {
  const profile = explicitListProfile(ctx)
  if (profile && denyProfileAccess(ctx, profile)) return
  const workflows = filterByAllowedProfiles(ctx, getWorkflowManager().list(profile))
  ctx.body = { workflows }
}

export async function get(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return
  ctx.body = { workflow }
}

export async function listRuns(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const limitValue = firstQueryValue(ctx.query.limit as string | string[] | undefined)
  const limit = limitValue ? Number(limitValue) : 100
  const runs = listWorkflowRunsWithEvidence(id, Number.isFinite(limit) ? limit : 100)
  ctx.body = { runs }
}

export async function getRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) { ctx.status = 400; ctx.body = { error: 'runId is required' }; return }
  const workflow = getWorkflowManager().get(id)
  if (!workflow) { ctx.status = 404; ctx.body = { error: 'workflow not found' }; return }
  if (denyProfileAccess(ctx, workflow.profile)) return
  const run = getWorkflowRunWithEvidence(runId)
  if (!run || run.workflow_id !== id) { ctx.status = 404; ctx.body = { error: 'workflow run not found' }; return }
  ctx.body = { run }
}

export async function stopRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const run = await getWorkflowManager().stopRun(id, runId, 'Workflow run canceled by user')
  if (!run) {
    ctx.status = 404
    ctx.body = { error: 'workflow run not found' }
    return
  }
  ctx.body = { ok: true, run }
}

export async function deleteRun(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const deleted = await getWorkflowManager().deleteRun(id, runId)
  if (!deleted) {
    ctx.status = 404
    ctx.body = { error: 'workflow run not found' }
    return
  }
  ctx.body = { ok: true }
}

export async function approveNode(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  const nodeId = typeof ctx.params?.nodeId === 'string' ? ctx.params.nodeId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }
  if (!nodeId) {
    ctx.status = 400
    ctx.body = { error: 'nodeId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const body = bodyRecord(ctx)
  const approved = optionalBoolean(body.approved, 'approved')
  if (rejectBadRequest(ctx, approved.error)) return

  const executionId = typeof body.executionId === 'string' && body.executionId.trim() ? body.executionId.trim() : undefined
  const manager = getWorkflowManager()
  const approvedValue = approved.value ?? true
  const accepted = manager.approveNode(id, runId, nodeId, approvedValue, executionId)
  if (!accepted) {
    ctx.status = 409
    ctx.body = { error: 'workflow node approval is not pending' }
    return
  }
  ctx.body = { ok: true }
}

export async function rerunFromNode(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return
  const runId = typeof ctx.params?.runId === 'string' ? ctx.params.runId.trim() : ''
  if (!runId) {
    ctx.status = 400
    ctx.body = { error: 'runId is required' }
    return
  }

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const body = bodyRecord(ctx)
  const nodeId = typeof (body.node_id ?? body.nodeId) === 'string' ? String(body.node_id ?? body.nodeId).trim() : ''
  if (!nodeId) {
    ctx.status = 400
    ctx.body = { error: 'node_id is required' }
    return
  }
  const preserveStartNode = optionalBoolean(body.preserve_start_node ?? body.preserveStartNode, 'preserve_start_node')
  const timeoutMs = optionalWorkflowTimeoutMs(body.timeout_ms ?? body.timeoutMs)
  if (rejectBadRequest(ctx, preserveStartNode.error || timeoutMs.error)) return

  const runInput: WorkflowRerunFromNodeInput = {
    profile: workflow.profile,
    user: ctx.state?.user,
  }
  if (preserveStartNode.value !== undefined) runInput.preserveStartNode = preserveStartNode.value
  if (timeoutMs.value !== undefined) runInput.timeoutMs = timeoutMs.value

  const manager = getWorkflowManager()
  try {
    const frozenRun = getWorkflowRunWithEvidence(runId)
    if (!frozenRun || frozenRun.workflow_id !== id) {
      ctx.status = 404
      ctx.body = { error: 'workflow run not found' }
      return
    }
    if (frozenRun.status === 'queued' || frozenRun.status === 'running') {
      ctx.status = 409
      ctx.body = { error: 'workflow run is still active' }
      return
    }
    const preflight = await preflightWorkflowRerunDefinition({
      run: frozenRun,
      nodeId,
      profile: frozenRun.profile,
      preserveStartNode: runInput.preserveStartNode,
    })
    await assertWorkflowExecutionCapabilities(frozenRun.profile, preflight.activeNodes)
    let accept!: (run: unknown) => void
    const accepted = new Promise<{ kind: 'accepted' }>(resolve => {
      accept = () => resolve({ kind: 'accepted' })
    })
    const execution = manager.rerunFromNode(id, runId, nodeId, {
      ...runInput, onAccepted: accept,
    })
    const outcome = await Promise.race([
      accepted,
      execution.then(() => ({ kind: 'completed-before-acceptance' as const })),
    ])
    if (outcome.kind !== 'accepted') {
      throw Object.assign(new Error('workflow rerun completed before durable acceptance'), { status: 500 })
    }
    void execution.catch((err: any) => {
      const message = err?.message || 'failed to rerun workflow'
      logger.error(err, '[workflow] async rerun failed for workflow %s run %s node %s', id, runId, nodeId)
      const currentStatus = manager.getRuntimeStatus(id)
      manager.setRuntimeStatus(id, {
        status: 'failed', runId, completedAt: Date.now(), error: message,
        nodeStatuses: { ...currentStatus.nodeStatuses },
      })
    })
  } catch (err: any) {
    ctx.status = typeof err?.status === 'number' && err.status >= 400 && err.status <= 599 ? err.status : 400
    ctx.body = { error: err?.message || 'workflow rerun preflight failed' }
    return
  }

  ctx.status = 202
  ctx.body = { ok: true, status: 'accepted' }
}

export async function create(ctx: Context) {
  const body = bodyRecord(ctx)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    ctx.status = 400
    ctx.body = { error: 'name is required' }
    return
  }

  const profile = requestedProfile(ctx, body) || 'default'
  if (denyProfileAccess(ctx, profile)) return

  const workspace = optionalNullableString(body.workspace, 'workspace')
  const nodes = optionalJsonArray(body.nodes, 'nodes')
  const edges = optionalJsonArray(body.edges, 'edges')
  const viewport = optionalJsonObject(body.viewport, 'viewport')
  if (rejectBadRequest(ctx, workspace.error || nodes.error || edges.error || viewport.error)) return

  try {
    validateWorkflowDefinitionMutation(nodes.value || [], edges.value || [])
    const workflow = getWorkflowManager().create({
      name,
      profile,
      workspace: workspace.value,
      nodes: nodes.value || [],
      edges: edges.value || [],
      viewport: viewport.value || null,
    })
    ctx.status = 201
    ctx.body = { workflow }
  } catch (err: any) {
    ctx.status = err?.status === 409 ? 409 : 400
    ctx.body = { error: err?.message || 'failed to create workflow' }
  }
}

export async function update(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const existing = getWorkflowManager().get(id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, existing.profile)) return

  const body = bodyRecord(ctx)
  const patch: WorkflowUpdateInput = {}
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      ctx.status = 400
      ctx.body = { error: 'name must be a non-empty string' }
      return
    }
    patch.name = body.name
  }
  const workspace = optionalNullableString(body.workspace, 'workspace')
  const nodes = optionalJsonArray(body.nodes, 'nodes')
  const edges = optionalJsonArray(body.edges, 'edges')
  const viewport = optionalJsonObject(body.viewport, 'viewport')
  if (rejectBadRequest(ctx, workspace.error || nodes.error || edges.error || viewport.error)) return
  if (workspace.value !== undefined) patch.workspace = workspace.value
  if (nodes.value !== undefined) patch.nodes = nodes.value
  if (edges.value !== undefined) patch.edges = edges.value
  if (viewport.value !== undefined) patch.viewport = viewport.value

  try {
    validateWorkflowDefinitionMutation(
      (patch.nodes ?? existing.nodes) as unknown[],
      (patch.edges ?? existing.edges) as unknown[],
    )
  } catch (err: any) {
    ctx.status = 400
    ctx.body = { error: err?.message || 'invalid workflow definition' }
    return
  }
  const workflow = getWorkflowManager().update(id, patch)
  ctx.body = { workflow }
}

export async function remove(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  await getWorkflowManager().delete(id)
  ctx.body = { ok: true }
}

export async function batchRemove(ctx: Context) {
  const body = bodyRecord(ctx)
  const ids = Array.isArray(body.ids)
    ? body.ids.map(id => typeof id === 'string' ? id.trim() : '').filter(Boolean)
    : []
  if (ids.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'ids is required' }
    return
  }
  if (ids.length > MAX_BATCH_DELETE) {
    ctx.status = 400
    ctx.body = { error: `ids must contain at most ${MAX_BATCH_DELETE} items` }
    return
  }

  const uniqueIds = [...new Set(ids)]
  const errors: Array<{ id: string; error: string }> = []
  let deleted = 0
  for (const id of uniqueIds) {
    const workflow = getWorkflowManager().get(id)
    if (!workflow) {
      errors.push({ id, error: 'workflow not found' })
      continue
    }
    if (!canAccessProfile(ctx, workflow.profile)) {
      errors.push({ id, error: `Profile "${profileName(workflow.profile)}" is not available for this user` })
      continue
    }
    if (await getWorkflowManager().delete(id)) deleted += 1
    else errors.push({ id, error: 'workflow not found' })
  }

  ctx.body = {
    deleted,
    failed: errors.length,
    errors,
  }
}

export async function runNow(ctx: Context) {
  const id = requiredId(ctx)
  if (!id) return

  const workflow = getWorkflowManager().get(id)
  if (!workflow) {
    ctx.status = 404
    ctx.body = { error: 'workflow not found' }
    return
  }
  if (denyProfileAccess(ctx, workflow.profile)) return

  const body = bodyRecord(ctx)
  const startNodeIds = optionalStringArray(body.start_node_ids ?? body.startNodeIds, 'start_node_ids')
  const input = optionalNullableString(body.input, 'input')
  const timeoutMs = optionalWorkflowTimeoutMs(body.timeout_ms ?? body.timeoutMs)
  if (rejectBadRequest(ctx, startNodeIds.error || input.error || timeoutMs.error)) return

  const runInput: WorkflowRunNowInput = {
    profile: workflow.profile,
    user: ctx.state?.user,
  }
  if (startNodeIds.value !== undefined) runInput.startNodeIds = startNodeIds.value
  if (input.value !== undefined) runInput.input = input.value
  if (timeoutMs.value !== undefined) runInput.timeoutMs = timeoutMs.value

  const manager = getWorkflowManager()
  try {
    const preflight = await preflightWorkflowExecutionDefinition(workflow.nodes, workflow.edges, workflow.profile, runInput.startNodeIds || [])
    await assertWorkflowExecutionCapabilities(workflow.profile, preflight.activeNodes)
    let accept!: (run: unknown) => void
    const accepted = new Promise<{ kind: 'accepted' }>(resolve => {
      accept = () => resolve({ kind: 'accepted' })
    })
    const auth = ctx.get('authorization')
    const pushActor = await authenticatedPushActor(auth.startsWith('Bearer ') ? auth.slice(7) : '')
    const execution = manager.runNow(id, { ...runInput, ...(pushActor ? { pushActor, pushSnapshot: { ciphertext: prepareRunPushSnapshot(pushActor, body.push_snapshot), platform: String((body.push_snapshot as any)?.platform || 'unknown') } } : {}), onAccepted: accept })
    const outcome = await Promise.race([
      accepted,
      execution.then(() => ({ kind: 'completed-before-acceptance' as const })),
    ])
    if (outcome.kind !== 'accepted') {
      throw Object.assign(new Error('workflow execution completed before durable acceptance'), { status: 500 })
    }
    void execution.catch((err: any) => {
      const message = err?.message || 'failed to run workflow'
      logger.error(err, '[workflow] async run failed for workflow %s', id)
      manager.setRuntimeStatus(id, { status: 'failed', completedAt: Date.now(), error: message })
    })
  } catch (err: any) {
    ctx.status = typeof err?.status === 'number' && err.status >= 400 && err.status <= 599 ? err.status : 400
    ctx.body = { error: err?.message || 'workflow preflight failed' }
    return
  }

  ctx.status = 202
  ctx.body = { ok: true, status: 'accepted' }
}
