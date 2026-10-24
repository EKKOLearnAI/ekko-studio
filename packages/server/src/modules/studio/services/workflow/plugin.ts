import { StudioError, type ExecutionScope, type WorkflowRunReceipt, type WorkflowRunStartInput } from '../../contracts/plugins'
import { findUserById } from '../../repositories/users-store'
import { getWorkflowRun, type WorkflowRunRecord } from '../../repositories/workflow-run-store'
import { getWorkflowManager } from './manager'
import { startWorkflowExecution } from './start'
import { parseWorkflowRunStart, workflowRequestIdentity } from './input'

const receipt = (run: WorkflowRunRecord): WorkflowRunReceipt => ({ id: run.id, workflowId: run.workflow_id, profileId: run.profile,
  ownerId: String(run.user_id), status: run.status, createdAt: run.created_at, startedAt: run.started_at, finishedAt: run.finished_at })

export class PluginWorkflows {
  constructor(private readonly authorize: (scope: ExecutionScope) => void) {}

  private check(scope: ExecutionScope): void {
    this.authorize(scope)
    if (scope.principal.kind !== 'user') throw new StudioError('FORBIDDEN', 'Workflow execution requires a user')
    if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) {
      throw new StudioError('CAPABILITY_UNSUPPORTED', 'Independent workflows require an unbound scope')
    }
  }
  async run(scope: ExecutionScope, value: WorkflowRunStartInput, signal: AbortSignal): Promise<WorkflowRunReceipt> {
    const input = parseWorkflowRunStart(value)
    this.check(scope)
    const user = findUserById(scope.principal.id)
    if (!user || user.status !== 'active') throw new StudioError('FORBIDDEN', 'Workflow owner is unavailable')
    try {
      return receipt(await startWorkflowExecution(input.workflowId, {
        user: { id: user.id, username: user.username, role: user.role }, profile: scope.profileId,
        ...(input.input === undefined ? {} : { input: input.input }),
        ...(input.startNodeIds === undefined ? {} : { startNodeIds: input.startNodeIds }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        requestIdentity: workflowRequestIdentity(scope.principal.id, scope.profileId, input),
      }, { signal, authorize: profile => {
        this.check(scope)
        if (profile !== scope.profileId) throw new StudioError('FORBIDDEN', 'Workflow is outside the execution profile')
      } }))
    } catch (error) {
      if (error instanceof StudioError) throw error
      const status = (error as { status?: number })?.status
      throw new StudioError(status === 404 ? 'NOT_FOUND' : status === 409 ? 'REVISION_CONFLICT' : status === 503 ? 'RUNTIME_UNAVAILABLE' : 'INVALID_ARGUMENT', 'Workflow could not be started')
    }
  }
  private ownedRun(scope: ExecutionScope, id: string): WorkflowRunRecord {
    this.check(scope)
    if (typeof id !== 'string' || !id.trim() || id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid workflow run id')
    const run = getWorkflowRun(id)
    if (!run || run.profile !== scope.profileId || run.user_id === null || String(run.user_id) !== scope.principal.id) throw new StudioError('NOT_FOUND', 'Workflow run is unavailable')
    return run
  }
  get(scope: ExecutionScope, id: string): WorkflowRunReceipt { return receipt(this.ownedRun(scope, id)) }
  async cancel(scope: ExecutionScope, id: string): Promise<WorkflowRunReceipt> {
    const run = this.ownedRun(scope, id)
    await getWorkflowManager().stopRun(run.workflow_id, id, 'Workflow run canceled by owner')
    return receipt(this.ownedRun(scope, id))
  }
}
