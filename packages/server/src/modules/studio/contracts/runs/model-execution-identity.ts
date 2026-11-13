export type ExecutionApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages'

export interface ModelExecutionIdentity {
  provider: string
  model: string
  apiMode: ExecutionApiMode
}

const API_MODES = new Set<ExecutionApiMode>([
  'chat_completions',
  'codex_responses',
  'anthropic_messages',
])

const CORRECT_REQUEST = '{"provider":"custom:your-provider","model":"your-model","apiMode":"codex_responses"}'

function badRequest(message: string): Error {
  const error = new Error(message)
  ;(error as any).status = 400
  return error
}

export async function resolveModelExecutionIdentity(input: {
  profile: string
  provider?: unknown
  model?: unknown
  apiMode?: unknown
}): Promise<ModelExecutionIdentity> {
  const provider = String(input.provider || '').trim()
  const model = String(input.model || '').trim()
  const apiMode = String(input.apiMode || '').trim()

  if (!provider || !model || !apiMode) {
    throw badRequest(
      `provider, model, and apiMode are required together for coding-agent runs; ` +
      `Profile defaults are not used. Correct request fields: ${CORRECT_REQUEST}`,
    )
  }
  if (!API_MODES.has(apiMode as ExecutionApiMode)) {
    throw badRequest(
      `Unsupported apiMode "${apiMode}". Allowed values: chat_completions, codex_responses, ` +
      `anthropic_messages. For OpenAI Responses use "apiMode":"codex_responses".`,
    )
  }

  return { provider, model, apiMode: apiMode as ExecutionApiMode }
}
