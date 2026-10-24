import { StudioError, type ModelStreamInput } from '../../contracts/plugins'
import { jsonCopy } from '../plugins/validation'
import { validateResponsesBody } from '../model-api/input'

export function parseModelStreamInput(value: unknown): ModelStreamInput {
  const input = jsonCopy(value) as ModelStreamInput
  const keys = ['idempotencyKey', 'model', 'input', 'instructions', 'tools', 'toolChoice', 'maxOutputTokens', 'temperature', 'reasoning', 'timeoutMs']
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new StudioError('INVALID_ARGUMENT', 'Invalid model input')
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid model idempotency key')
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 600_000)) throw new StudioError('INVALID_ARGUMENT', 'Model timeout must be between 100 and 600000 ms')
  try { validateResponsesBody(modelResponseBody(input)) } catch { throw new StudioError('INVALID_ARGUMENT', 'Invalid model request') }
  return input
}

export function modelResponseBody(input: ModelStreamInput) {
  return { model: input.model, input: input.input, stream: true,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(input.toolChoice === undefined ? {} : { tool_choice: input.toolChoice }),
    ...(input.maxOutputTokens === undefined ? {} : { max_output_tokens: input.maxOutputTokens }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
  }
}
