import { StudioError } from '../../contracts/plugins'
import { getWorkflowAvailableModelGroups } from '../../public/workflow-runtime'
import { getWorkflowRun, type WorkflowRunRecord } from '../../repositories/workflow-run-store'
import { workflowRequestStore } from '../../repositories/workflow-request-store'
import { assertWorkflowImportCapabilities } from './import-capabilities'
import { getWorkflowManager, preflightWorkflowExecutionDefinition, type WorkflowRunNowInput } from './manager'
import { logger } from '../../public/logging'

/** HTTP and SDK share preflight, durable acceptance and detached execution. */
export async function startWorkflowExecution(id: string, input: Omit<WorkflowRunNowInput, 'onAccepted' | 'assertCanStart' | 'definitionSnapshot'>, options: {
  authorize(profile: string): void | Promise<void>
  signal?: AbortSignal
}): Promise<WorkflowRunRecord> {
  const manager = getWorkflowManager(), workflow = manager.get(id)
  if (!workflow) throw Object.assign(new Error('workflow not found'), { status: 404 })
  // Snapshot data before authorization; callers cannot mutate identity during preflight.
  const request: WorkflowRunNowInput = structuredClone(input)
  const snapshot = JSON.stringify(workflow)
  const authorize = async () => {
    if (options.signal?.aborted) throw new StudioError('CANCELLED', 'Workflow admission was cancelled')
    await options.authorize(workflow.profile)
    if (options.signal?.aborted) throw new StudioError('CANCELLED', 'Workflow admission was cancelled')
    if (JSON.stringify(manager.get(id)) !== snapshot) throw new StudioError('REVISION_CONFLICT', 'Workflow changed during admission')
  }
  await authorize()
  if (request.requestIdentity) {
    if (request.requestIdentity.profileId !== workflow.profile || request.requestIdentity.ownerId !== String(request.user?.id)) {
      throw new StudioError('FORBIDDEN', 'Workflow request identity is unavailable')
    }
    const previousId = workflowRequestStore().find(request.requestIdentity)
    if (previousId) {
      const previous = getWorkflowRun(previousId)
      if (!previous) throw new StudioError('NOT_FOUND', 'Accepted workflow run was removed')
      return previous
    }
  }
  const preflight = await preflightWorkflowExecutionDefinition(workflow.nodes, workflow.edges, workflow.profile, request.startNodeIds || [])
  assertWorkflowImportCapabilities(preflight.activeNodes, await getWorkflowAvailableModelGroups(workflow.profile))
  await authorize()
  let accept!: (run: WorkflowRunRecord) => void
  const accepted = new Promise<WorkflowRunRecord>(resolve => { accept = resolve })
  const execution = manager.runNow(id, { ...request, profile: workflow.profile, assertCanStart: authorize, definitionSnapshot: snapshot, onAccepted: accept })
  const result = await Promise.race([
    accepted,
    execution.then(() => { throw Object.assign(new Error('workflow execution completed before durable acceptance'), { status: 500 }) }),
  ])
  void execution.catch(error => {
    logger.error(error, '[workflow] async run failed for workflow %s', id)
    manager.setRuntimeStatus(id, { status: 'failed', completedAt: Date.now(), error: error instanceof Error ? error.message : 'failed to run workflow' })
  })
  return result
}
