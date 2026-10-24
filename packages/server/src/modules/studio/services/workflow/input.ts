import { createHash } from 'node:crypto'
import { StudioError, type WorkflowRunStartInput } from '../../contracts/plugins'
import type { WorkflowRequestIdentity } from '../../repositories/workflow-request-store'
import { jsonCopy } from '../plugins/validation'

export function parseWorkflowRunStart(value: unknown): WorkflowRunStartInput {
  const input = jsonCopy(value) as WorkflowRunStartInput
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['workflowId', 'idempotencyKey', 'input', 'startNodeIds', 'timeoutMs'].includes(key))
    || typeof input.workflowId !== 'string' || !input.workflowId.trim() || input.workflowId.length > 256
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
    || (input.input !== undefined && (typeof input.input !== 'string' || input.input.length > 100_000))
    || (input.startNodeIds !== undefined && (!Array.isArray(input.startNodeIds) || input.startNodeIds.length > 1000 || input.startNodeIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)))
    || (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 86_400_000))) {
    throw new StudioError('INVALID_ARGUMENT', 'Invalid workflow run request')
  }
  return input
}

export function workflowRequestIdentity(ownerId: string, profileId: string, input: WorkflowRunStartInput): WorkflowRequestIdentity {
  return { ownerId, profileId, key: input.idempotencyKey, hash: createHash('sha256')
    .update(JSON.stringify([input.workflowId, input.input ?? null, input.startNodeIds ?? [], input.timeoutMs ?? null])).digest('hex') }
}

