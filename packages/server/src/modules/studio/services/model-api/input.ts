import type { AgentMessage, AgentReasoning, ModelRequest } from '../../../../../../ekko-agent/src/model/types'
import { ModelApiError } from './errors'
import type { ReasoningCodec } from './reasoning'

function invalid(message: string, param = 'input'): never { throw new ModelApiError(message, 400, param) }
function text(value: unknown, name: string): string {
  if (typeof value !== 'string') invalid(`${name} must be a string.`, name)
  return value as string
}
function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validateResponsesBody(body: unknown): asserts body is Record<string, any> {
  if (!record(body)) invalid('Request body must be an object.', 'body')
  if (typeof body.model !== 'string' || !body.model.trim()) invalid('model must be provider/model.', 'model')
  if (typeof body.input !== 'string' && !Array.isArray(body.input)) invalid('input must be a string or an array.')
  for (const field of ['previous_response_id', 'conversation', 'background', 'prompt', 'context_management']) {
    if (body[field] != null && body[field] !== false) invalid(`${field} is not supported; send the full input history.`, field)
  }
  if (body.store != null && body.store !== false) invalid('Only store: false is supported.', 'store')
  if (body.stream != null && typeof body.stream !== 'boolean') invalid('stream must be a boolean.', 'stream')
  if (body.parallel_tool_calls != null && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be a boolean.', 'parallel_tool_calls')
  if (body.include != null && (!Array.isArray(body.include) || body.include.some((item: unknown) => item !== 'reasoning.encrypted_content'))) invalid('Only reasoning.encrypted_content may be included.', 'include')
  if (body.metadata != null && (!record(body.metadata) || Object.keys(body.metadata).length > 16 || Object.entries(body.metadata).some(([key, value]) => key.length > 64 || typeof value !== 'string' || value.length > 512))) invalid('metadata must contain at most 16 string values (keys <= 64, values <= 512 characters).', 'metadata')
  if (body.text != null && (!record(body.text) || (body.text.format != null && !record(body.text.format)))) invalid('text and text.format must be objects.', 'text')
  if (body.text?.format?.type && body.text.format.type !== 'text') invalid('Only text output is supported.', 'text.format')
  if (body.tool_choice != null && !['auto', 'none', 'required'].includes(body.tool_choice)) invalid('Unsupported tool_choice.', 'tool_choice')
  if (body.parallel_tool_calls === false) invalid('Disabling parallel tool calls is not supported.', 'parallel_tool_calls')
  for (const field of ['top_p', 'truncation', 'max_tool_calls', 'service_tier']) {
    if (body[field] != null && !(field === 'truncation' && body[field] === 'disabled')) invalid(`${field} is not supported.`, field)
  }
  if (body.max_output_tokens != null && (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens <= 0)) invalid('max_output_tokens must be a positive integer.', 'max_output_tokens')
  if (body.temperature != null && (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2)) invalid('temperature must be between 0 and 2.', 'temperature')
  if (body.reasoning != null && !record(body.reasoning)) invalid('reasoning must be an object.', 'reasoning')
  if (body.reasoning?.effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning.effort)) invalid('Unsupported reasoning effort.', 'reasoning.effort')
  if (body.reasoning?.summary != null && !['auto', 'concise', 'detailed'].includes(body.reasoning.summary)) invalid('Unsupported reasoning summary.', 'reasoning.summary')
  if (body.tools != null && !Array.isArray(body.tools)) invalid('tools must be an array.', 'tools')
  for (const tool of body.tools || []) {
    if (!record(tool) || tool.type !== 'function' || typeof tool.name !== 'string' || !tool.name.trim()) invalid('Only named function tools are supported.', 'tools')
    if (tool.parameters != null && !record(tool.parameters)) invalid('Tool parameters must be a JSON schema object.', 'tools')
    if (tool.description != null && typeof tool.description !== 'string') invalid('Tool description must be a string.', 'tools')
    if (tool.strict != null && typeof tool.strict !== 'boolean') invalid('Tool strict must be a boolean.', 'tools')
    if (tool.strict === true) invalid('Strict tool schemas are not supported by every provider.', 'tools')
  }
}

function content(value: unknown): Pick<AgentMessage, 'content' | 'contentParts'> {
  if (typeof value === 'string') return { content: value }
  if (!Array.isArray(value)) invalid('Message content must be a string or array.')
  const parts: NonNullable<AgentMessage['contentParts']> = []
  for (const part of value) {
    if (!record(part)) invalid('Invalid content part.')
    if (['input_text', 'output_text', 'text'].includes(part.type)) parts.push({ type: 'text', text: text(part.text, 'input.content.text') })
    else if (part.type === 'input_image') {
      const match = typeof part.image_url === 'string' && /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(part.image_url)
      if (!match) invalid('Images must use base64 data URLs; file IDs and remote URLs are not supported.')
      parts.push({ type: 'image', mimeType: match[1], data: match[2] })
    } else invalid(`Unsupported content type: ${part.type}`)
  }
  return { content: parts.filter(part => part.type === 'text').map(part => part.text).join(''), ...(parts.some(part => part.type === 'image') ? { contentParts: parts } : {}) }
}

export function responsesModelRequest(body: Record<string, any>, model: string, codec: ReasoningCodec, signal?: AbortSignal): ModelRequest {
  const messages: AgentMessage[] = []
  if (body.instructions != null) messages.push({ role: 'system', content: text(body.instructions, 'instructions') })
  let assistant: AgentMessage | undefined
  let reasoning: AgentReasoning | undefined
  const pendingCalls = new Set<string>()
  const allCalls = new Set<string>()
  const flush = () => { if (assistant) messages.push(assistant); assistant = undefined }
  const flushReasoning = () => {
    if (reasoning) { assistant = { role: 'assistant', content: '', reasoning }; reasoning = undefined }
  }
  const input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input
  for (const item of input) {
    if (!record(item)) invalid('Each input item must be an object.')
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? item.summary.map((p: any) => text(p?.text, 'input.summary')).join('') : ''
      const decoded = codec.decode(item.encrypted_content) || (summary ? { text: summary } : undefined)
      // Some providers deliver native signatures only at stream completion, after tool calls.
      if (assistant && !assistant.reasoning) assistant.reasoning = decoded
      else { flush(); reasoning = decoded }
    } else if (item.type === 'function_call') {
      if (pendingCalls.size && !assistant) invalid('Resolve the preceding tool calls before starting another assistant turn.')
      const id = text(item.call_id, 'call_id')
      if (!id || allCalls.has(id)) invalid('Function call IDs must be nonempty and unique.')
      const args = text(item.arguments, 'arguments')
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(args) } catch { invalid('Function arguments must be valid JSON.') }
      if (!record(parsed)) invalid('Function arguments must be a JSON object.')
      if (!assistant) { flushReasoning(); assistant ||= { role: 'assistant', content: '' } }
      assistant.toolCalls ||= []
      assistant.toolCalls.push({ id, name: text(item.name, 'name'), arguments: parsed, rawArguments: args })
      pendingCalls.add(id); allCalls.add(id)
    } else if (item.type === 'function_call_output') {
      flush()
      const id = text(item.call_id, 'call_id')
      if (!pendingCalls.delete(id)) invalid('Function output must match an earlier unresolved call_id.')
      messages.push({ role: 'tool', toolCallId: id, ...content(item.output) })
    } else if (!item.type || item.type === 'message') {
      if (pendingCalls.size) invalid('Resolve tool calls before adding another message.')
      flush()
      const role = item.role === 'developer' ? 'system' : item.role
      if (!['system', 'user', 'assistant'].includes(role)) invalid('Unsupported message role.')
      const message: AgentMessage = { role, ...content(item.content) }
      if (message.contentParts?.length && role !== 'user') invalid('Only user messages and tool outputs may contain images.')
      if (role === 'assistant') {
        assistant = { ...message, ...(reasoning ? { reasoning } : {}) }
        reasoning = undefined
      } else { reasoning = undefined; messages.push(message) }
    } else invalid(`Unsupported input item type: ${item.type}`)
  }
  if (!assistant) flushReasoning()
  flush()
  if (pendingCalls.size) invalid('Every function call must have a matching function_call_output before continuing.')
  return {
    model, messages, signal,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.max_output_tokens != null ? { maxTokens: body.max_output_tokens } : {}),
    ...(body.reasoning?.effort ? { reasoningEffort: body.reasoning.effort } : {}),
    ...(body.reasoning?.summary ? { reasoningSummary: body.reasoning.summary } : {}),
    ...(body.tools?.length ? { tools: body.tools.map((tool: any) => ({ name: tool.name, description: tool.description, parameters: tool.parameters || {} })), toolChoice: body.tool_choice || 'auto' } : {}),
  }
}
