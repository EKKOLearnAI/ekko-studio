import type { AgentMessage, AgentToolDefinition, ModelReasoningEffort, ModelRequest } from '../../../../../../ekko-agent/src/model/types'
import { ModelApiError } from './errors'

function invalid(message: string, param = 'messages'): never { throw new ModelApiError(message, 400, param) }
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string') invalid(`${name} must be a string.`, name)
  return value as string
}

const ROLES = ['system', 'developer', 'user', 'assistant', 'tool']
const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export function validateChatBody(body: unknown): asserts body is Record<string, any> {
  if (!record(body)) invalid('Request body must be an object.', 'body')
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('model must be provider/model.', 'model')
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages must be a nonempty array.', 'messages')
  if (body.stream != null && typeof body.stream !== 'boolean') invalid('stream must be a boolean.', 'stream')
  if (body.n != null && body.n !== 1) invalid('Only n: 1 is supported.', 'n')
  for (const field of ['logprobs', 'top_logprobs', 'modalities', 'audio', 'prediction', 'web_search_options', 'functions', 'function_call']) {
    if (body[field] != null) invalid(`${field} is not supported.`, field)
  }
  if (body.response_format != null && (!record(body.response_format) || body.response_format.type !== 'text')) {
    invalid('Only text output is supported; omit response_format or send {"type":"text"}.', 'response_format')
  }
  // Accepted for client compatibility but never forwarded: the provider adapters do not
  // expose these knobs, so honouring them silently would misreport what the model did.
  if (body.stop != null) invalid('stop is not supported; end the prompt instead.', 'stop')
  if (body.temperature != null && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) {
    invalid('temperature must be between 0 and 2.', 'temperature')
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (maxTokens != null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) invalid('max_tokens must be a positive integer.', 'max_tokens')
  if (body.reasoning_effort != null && !REASONING_EFFORTS.includes(body.reasoning_effort)) invalid('Unsupported reasoning_effort.', 'reasoning_effort')
  if (body.tool_choice != null && !['auto', 'none', 'required'].includes(body.tool_choice)) {
    invalid('Only tool_choice auto, none or required is supported.', 'tool_choice')
  }
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be a boolean.', 'parallel_tool_calls')
  if (body.parallel_tool_calls === false) invalid('Disabling parallel tool calls is not supported.', 'parallel_tool_calls')
  if (body.tools != null && !Array.isArray(body.tools)) invalid('tools must be an array.', 'tools')
  for (const tool of body.tools || []) {
    // Accept the OpenAI shape; Responses-style flat functions are rejected so one body stays unambiguous.
    if (!record(tool) || tool.type !== 'function' || !record(tool.function)) invalid('Only type:function tools are supported.', 'tools')
    if (typeof tool.function.name !== 'string' || !tool.function.name.trim()) invalid('Tool function.name is required.', 'tools')
    if (tool.function.description != null && typeof tool.function.description !== 'string') invalid('Tool description must be a string.', 'tools')
    if (tool.function.parameters != null && !record(tool.function.parameters)) invalid('Tool parameters must be a JSON schema object.', 'tools')
    if (tool.function.strict === true) invalid('Strict tool schemas are not supported by every provider.', 'tools')
  }
}

function imagePart(url: unknown): { type: 'image'; mimeType: string; data: string } {
  const value = typeof url === 'string' ? url : record(url) ? url.url : undefined
  const match = typeof value === 'string' && /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value)
  if (!match) invalid('Images must use base64 data URLs; remote URLs and file IDs are not supported.', 'messages')
  return { type: 'image', mimeType: match[1], data: match[2] }
}

/** Flatten OpenAI message content (string or typed parts) into Ekko content. */
function content(value: unknown, role: string): Pick<AgentMessage, 'content' | 'contentParts'> {
  if (value == null) return { content: '' }
  if (typeof value === 'string') return { content: value }
  if (!Array.isArray(value)) invalid('Message content must be a string, null or an array.', 'messages')
  const parts: NonNullable<AgentMessage['contentParts']> = []
  for (const part of value) {
    if (!record(part)) invalid('Invalid content part.', 'messages')
    if (['text', 'input_text', 'output_text'].includes(part.type)) parts.push({ type: 'text', text: text(part.text, 'messages.content.text') })
    else if (part.type === 'image_url') parts.push(imagePart(part.image_url))
    else invalid(`Unsupported content part type: ${part.type}`, 'messages')
  }
  if (parts.some(part => part.type === 'image') && role !== 'user') invalid('Only user messages may contain images.', 'messages')
  const textOnly = parts.filter((part): part is { type: 'text'; text: string } => part.type === 'text').map(part => part.text).join('')
  return { content: textOnly, ...(parts.some(part => part.type === 'image') ? { contentParts: parts } : {}) }
}

function toolCalls(message: Record<string, any>): AgentMessage['toolCalls'] {
  if (!Array.isArray(message.tool_calls)) invalid('assistant.tool_calls must be an array.', 'messages')
  const seen = new Set<string>()
  return message.tool_calls.map((call: any, index: number) => {
    if (!record(call)) invalid('Each tool call must be an object.', 'messages')
    const name = text(call.function?.name, 'messages.tool_calls.function.name')
    const rawArguments = typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {})
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(rawArguments || '{}') } catch { invalid('Tool call arguments must be valid JSON.', 'messages') }
    if (!record(parsed)) invalid('Tool call arguments must be a JSON object.', 'messages')
    const id = typeof call.id === 'string' && call.id ? call.id : `call_${index}`
    if (seen.has(id)) invalid('Tool call IDs must be unique.', 'messages')
    seen.add(id)
    return { id, name, arguments: parsed, rawArguments }
  })
}

export function chatModelRequest(body: Record<string, any>, model: string, signal?: AbortSignal): ModelRequest {
  const messages: AgentMessage[] = []
  for (const message of body.messages) {
    if (!record(message)) invalid('Each message must be an object.', 'messages')
    const role = message.role
    if (!ROLES.includes(role)) invalid(`Unsupported message role: ${String(role)}`, 'messages')
    if (role === 'tool') {
      const toolCallId = text(message.tool_call_id, 'messages.tool_call_id')
      messages.push({ role: 'tool', toolCallId, ...content(message.content, 'tool') })
      continue
    }
    const mapped: AgentMessage = { role: role === 'developer' ? 'system' : role, ...content(message.content, role) }
    if (role === 'assistant') {
      const calls = message.tool_calls == null ? undefined : toolCalls(message)
      if (calls?.length) mapped.toolCalls = calls
    }
    messages.push(mapped)
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  const tools: AgentToolDefinition[] | undefined = body.tools?.length
    ? body.tools.map((tool: any) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters || {} }))
    : undefined
  return {
    model, messages, signal,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(maxTokens != null ? { maxTokens } : {}),
    ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort as ModelReasoningEffort } : {}),
    ...(tools ? { tools, toolChoice: body.tool_choice || 'auto' } : {}),
  }
}
