import { StudioError, type AgentRunStartInput, type AgentRunRecord, type ExecutionScope } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'
import type { AgentCoordinator } from './coordinator'

/** Copy before authorization can yield; callers cannot change the accepted request in flight. */
export function parseAgentRunStart(value: unknown): AgentRunStartInput {
  const input = jsonCopy(value) as AgentRunStartInput
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['instanceId', 'input', 'idempotencyKey'].includes(key))) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid run start request')
  }
  if (typeof input.instanceId !== 'string' || !input.instanceId.trim() || input.instanceId.length > 256) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid Agent instance id')
  }
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
    throw new StudioError('INVALID_ARGUMENT', 'An idempotency key is required')
  }
  if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) {
    throw new StudioError('INVALID_ARGUMENT', 'Run input is required')
  }
  return input
}

/** Shared by HTTP and the execution context; no transport objects or local network calls. */
export function startStudioAgentRun(
  scope: ExecutionScope, request: AgentRunStartInput, signal: AbortSignal, coordinator: Pick<AgentCoordinator, 'start'>,
): AgentRunRecord {
  if (signal.aborted) throw new StudioError('CANCELLED', 'Run start was cancelled')
  // Instance runs do not yet carry session/workspace bindings or parent-run leases.
  // Dropping one of these constraints would silently widen the caller's authority.
  if (scope.sessionId !== undefined || scope.runId !== undefined || scope.workspaceId !== undefined) {
    throw new StudioError('CAPABILITY_UNSUPPORTED', 'Starting a run from a resource-bound scope is not supported yet')
  }
  const input = parseAgentRunStart(request)
  const current = jsonCopy(scope)
  Object.freeze(current.principal)
  Object.freeze(current)
  // The coordinator rechecks the principal, profile and instance owner synchronously,
  // then persists acceptance before scheduling. There is no await in this commit boundary.
  return coordinator.start(current, input.instanceId, input.input, input.idempotencyKey)
}
