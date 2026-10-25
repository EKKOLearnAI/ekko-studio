import { StudioError, type ExecutionScope } from '../../contracts/plugins'
import type { CommandCall } from '../../repositories/plugin-command-store'
import type { AgentRunCommandOrigin } from '../../repositories/agent-run-command-origin'
import { jsonCopy } from '../plugins/validation'

/** Authentication-owned provenance survives host context reconstruction but is
 * never serialized to a plugin or accepted from an API payload. */
export class CommandExecutionScopes {
  private readonly active = new Map<string, { scope: ExecutionScope; origin: AgentRunCommandOrigin; signal: AbortSignal; target?: { instanceId: string; instanceRevision: number } }>()
  bind(scope: ExecutionScope, call: CommandCall, signal: AbortSignal, target?: { instanceId: string; instanceRevision: number }): void {
    if (signal.aborted) throw new StudioError('CANCELLED', 'Command scope has ended')
    if (scope.scopeId !== call.id || scope.principal.id !== call.ownerId || scope.profileId !== call.profileId || scope.sessionId !== call.sessionId
      || scope.runId !== undefined || scope.workspaceId !== undefined || scope.surface !== 'chat') throw new StudioError('FORBIDDEN', 'Command scope does not match its receipt')
    if (call.inputMessageId === undefined) return
    if (target && (typeof target.instanceId !== 'string' || !target.instanceId || !Number.isSafeInteger(target.instanceRevision) || target.instanceRevision < 1)) throw new StudioError('INVALID_ARGUMENT', 'Invalid command instance binding')
    if (this.active.has(scope.scopeId)) throw new StudioError('REVISION_CONFLICT', 'Command scope is already active')
    if (this.active.size >= 32) throw new StudioError('RESOURCE_EXHAUSTED', 'Command scope limit reached')
    const entry = { scope: jsonCopy(scope), origin: { callId: call.id, messageId: call.inputMessageId }, signal, ...(target ? { target: { ...target } } : {}) }
    this.active.set(scope.scopeId, entry)
    signal.addEventListener('abort', () => { if (this.active.get(scope.scopeId) === entry) this.active.delete(scope.scopeId) }, { once: true })
  }
  origin(scope: ExecutionScope, target?: { instanceId: string; instanceRevision: number }): AgentRunCommandOrigin | undefined {
    const entry = this.active.get(scope.scopeId)
    if (!entry) return
    const original = entry.scope
    if (entry.signal.aborted || scope.principal.id !== original.principal.id || scope.principal.kind !== original.principal.kind
      || scope.profileId !== original.profileId || scope.sessionId !== original.sessionId || scope.runId !== original.runId
      || scope.workspaceId !== original.workspaceId || scope.surface !== original.surface || scope.traceId !== original.traceId) throw new StudioError('FORBIDDEN', 'Command provenance is outside the execution scope')
    if (entry.target && (entry.target.instanceId !== target?.instanceId || entry.target.instanceRevision !== target?.instanceRevision)) throw new StudioError('REVISION_CONFLICT', 'Command instance configuration changed')
    return { ...entry.origin }
  }
}
