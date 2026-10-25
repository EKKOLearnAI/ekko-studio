import { StudioError, type ChatRunStartInput } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'

export function parseChatRunStart(value: unknown): ChatRunStartInput {
  const input = jsonCopy(value) as ChatRunStartInput
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['sessionId', 'input', 'idempotencyKey'].includes(key))
    || typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.sessionId.length > 256
    || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
    || typeof input.input !== 'string' || !input.input.trim() || input.input.length > 100_000) {
    throw new StudioError('INVALID_ARGUMENT', 'Expected a session id, text input and idempotency key')
  }
  // Commands can branch/delete sessions or change runtime configuration outside this scope.
  if (/^\s*\//.test(input.input)) throw new StudioError('CAPABILITY_UNSUPPORTED', 'Chat commands are not supported by this operation')
  return input
}
