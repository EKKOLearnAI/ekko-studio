import { StudioError, type AgentRunStartInput, type AgentRunRecord, type ExecutionScope } from '../../contracts/plugins'
import type { AgentRunAdmission } from './admission'
import type { AgentChats } from './chats'
import type { AgentCoordinator } from './coordinator'
import type { AgentExecutionStore } from '../../repositories/agent-execution-store'
import type { CommandExecutionScopes } from '../commands/scopes'
import { jsonCopy } from '../plugins/validation'
import { parseAgentRunStart } from './start'

/** Domain port for SDK Run admission. Resource bindings are honored rather
 * than dropped to turn a chat command into an independent instance request. */
export class AgentContextRuns {
  constructor(private readonly deps: {
    admission: Pick<AgentRunAdmission, 'start'>
    chats: Pick<AgentChats, 'ownedBinding' | 'start'>
    commands: CommandExecutionScopes
    executions: Pick<AgentExecutionStore, 'commands'>
    coordinator: Pick<AgentCoordinator, 'get' | 'cancel' | 'waitForCleanup'>
    follow?(scope: ExecutionScope, sessionId: string, run: AgentRunRecord, key: string): void
  }) {}
  async start(inputScope: ExecutionScope, value: AgentRunStartInput, signal: AbortSignal): Promise<AgentRunRecord> {
    const scope = jsonCopy(inputScope), input = parseAgentRunStart(value)
    if (signal.aborted) throw new StudioError('CANCELLED', 'Run start was cancelled')
    if (scope.runId !== undefined || scope.workspaceId !== undefined) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Parent Run and workspace execution require a dedicated adapter')
    if (scope.sessionId === undefined) return this.deps.admission.start(scope, input, signal)
    const { instance } = this.deps.chats.ownedBinding(scope, scope.sessionId)
    if (input.instanceId !== instance.id) throw new StudioError('FORBIDDEN', 'Run must use the selected chat instance')
    const origin = this.deps.commands.origin(scope, { instanceId: instance.id, instanceRevision: instance.revision })
    const run = await this.deps.chats.start(scope, scope.sessionId, input.input, input.idempotencyKey, signal, origin)
    this.deps.follow?.(scope, scope.sessionId, run, input.idempotencyKey)
    return run
  }
  async cancelCommand(scope: ExecutionScope, callId: string): Promise<void> {
    for (const id of this.deps.executions.commands.runs(callId)) {
      const run = this.deps.coordinator.get(scope, id)
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) await this.deps.coordinator.cancel(scope, id)
      const stopped = await this.deps.coordinator.waitForCleanup(scope, id)
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(stopped.status)) throw new StudioError('RUNTIME_UNAVAILABLE', 'Command Run did not finish cancellation')
    }
  }
}
