import { StudioError, type AgentRunStartInput, type ExecutionContext, type AgentRunRecord, type ExecutionScope } from '../../contracts/plugins'
import { agentRunRequestHash } from '../../repositories/agent-execution-store'
import { PluginHookRegistry } from '../events/plugin-hooks'
import { jsonCopy } from '../plugins/validation'
import { AgentCoordinator } from './coordinator'
import { parseAgentRunStart } from './start'
import type { AgentRunTarget } from '../../repositories/agent-conversation-store'
import type { AgentRunCommandOrigin } from '../../repositories/agent-run-command-origin'

/** Read-only hook execution precedes the coordinator's synchronous acceptance transaction. */
export class AgentRunAdmission {
  private readonly pending = new Map<string, { hash: string; result: Promise<AgentRunRecord> }>()
  constructor(private readonly coordinator: AgentCoordinator, private readonly hooks: PluginHookRegistry,
    private readonly context: (scope: ExecutionScope, signal: AbortSignal) => ExecutionContext) {}

  async start(inputScope: ExecutionScope, value: AgentRunStartInput, signal: AbortSignal): Promise<AgentRunRecord> {
    return this.startTarget(inputScope, value, signal)
  }

  /** Called by the chat application adapter, not exposed through ctx.runs.start. */
  async startInChat(inputScope: ExecutionScope, sessionId: string, value: AgentRunStartInput, signal: AbortSignal, command?: AgentRunCommandOrigin): Promise<AgentRunRecord> {
    return this.startTarget(inputScope, value, signal, { kind: 'chat', sessionId, ...(command ? { command } : {}) })
  }

  private async startTarget(inputScope: ExecutionScope, value: AgentRunStartInput, signal: AbortSignal, target?: AgentRunTarget): Promise<AgentRunRecord> {
    const request = parseAgentRunStart(value)
    let scope = jsonCopy(inputScope)
    target = target ? jsonCopy(target) : undefined
    if (signal.aborted) throw new StudioError('CANCELLED', 'Run start was cancelled')
    const inspected = this.coordinator.inspectStart(scope, request.instanceId, request.input, request.idempotencyKey, target)
    if (inspected.previous) return inspected.previous
    if (target) scope = { ...scope, sessionId: target.sessionId, surface: scope.surface === 'api' ? 'chat' : scope.surface }
    const key = JSON.stringify([scope.principal.id, scope.profileId, request.idempotencyKey]), hash = agentRunRequestHash(request.instanceId, request.input, target)
    const pending = this.pending.get(key)
    if (pending) {
      if (pending.hash !== hash) throw new StudioError('REVISION_CONFLICT', 'Pending idempotency key identifies different input')
      const result = await pending.result
      return this.coordinator.get(scope, result.id)
    }
    if (this.pending.size >= 128) throw new StudioError('RESOURCE_EXHAUSTED', 'Agent admission queue is full')
    const result = (async () => {
      const accepted = await this.hooks.run('runs.start', request, this.context(scope, signal))
      if (signal.aborted) throw new StudioError('CANCELLED', 'Run start was cancelled')
      return this.coordinator.start(scope, request.instanceId, accepted.input.input, request.idempotencyKey, {
        originalInput: request.input, hooks: accepted.snapshot, expectedProvider: inspected.provider!, expectedRevision: inspected.instance.revision,
      }, target)
    })()
    this.pending.set(key, { hash, result })
    try { return await result } finally { if (this.pending.get(key)?.result === result) this.pending.delete(key) }
  }
}
