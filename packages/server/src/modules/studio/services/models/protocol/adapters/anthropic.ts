// Shared Anthropic payload translation for Coding Agent provider proxies.
import { anthropicImageSourceToUrl } from './multimodal'

export interface AnthropicAdapterTarget {
  provider: string
  model: string
  baseUrl: string
}

export function targetReasoningEffort(target: any): string {
  const effort = String(target?.reasoningEffort || '').trim()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : ''
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'text' in item) return String((item as any).text || '')
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
  }
  if (value == null) return ''
  return JSON.stringify(value)
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

type ToolInputSchema = Record<string, any>
export type AnthropicToolInputSchemas = Map<string, ToolInputSchema>

export function createAnthropicToolInputSchemas(tools: unknown): AnthropicToolInputSchemas {
  const schemas: AnthropicToolInputSchemas = new Map()
  if (!Array.isArray(tools)) return schemas
  for (const tool of tools) {
    const name = String(tool?.name || '').trim()
    const schema = tool?.input_schema
    if (name && schema && typeof schema === 'object' && !Array.isArray(schema)) {
      schemas.set(name, schema)
    }
  }
  return schemas
}

function schemaExplicitlyUsesValue(schema: ToolInputSchema | undefined, value: unknown): boolean {
  if (!schema) return false
  if (Object.prototype.hasOwnProperty.call(schema, 'default') && Object.is(schema.default, value)) return true
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && Object.is(schema.const, value)) return true
  if (Array.isArray(schema.enum) && schema.enum.some((entry: unknown) => Object.is(entry, value))) return true
  return ['anyOf', 'oneOf', 'allOf'].some(key => (
    Array.isArray(schema[key]) &&
    schema[key].some((entry: unknown) => (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      schemaExplicitlyUsesValue(entry as ToolInputSchema, value)
    ))
  ))
}

function schemaAcceptsNull(schema: ToolInputSchema | undefined): boolean {
  if (!schema) return false
  if (schema.type === 'null' || (Array.isArray(schema.type) && schema.type.includes('null'))) return true
  if (schemaExplicitlyUsesValue(schema, null)) return true
  return ['anyOf', 'oneOf'].some(key => (
    Array.isArray(schema[key]) &&
    schema[key].some((entry: unknown) => (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      schemaAcceptsNull(entry as ToolInputSchema)
    ))
  ))
}

function normalizeOptionalToolInput(value: unknown, schema: ToolInputSchema | undefined): unknown {
  if (Array.isArray(value)) {
    const itemSchema = schema?.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
      ? schema.items as ToolInputSchema
      : undefined
    return value.map(item => normalizeOptionalToolInput(item, itemSchema))
  }
  if (!value || typeof value !== 'object') return value

  const properties = schema?.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, ToolInputSchema>
    : {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(String) : [])
  const normalized: Record<string, unknown> = {}

  for (const [key, entry] of Object.entries(value)) {
    const propertySchema = properties[key]
    const optional = !required.has(key)
    // Responses-compatible models sometimes materialize an omitted optional
    // argument as "" or null. Claude tools distinguish that placeholder from
    // an absent field, so remove it unless the schema gives it explicit meaning.
    const isUnusedEmptyString = entry === '' && !schemaExplicitlyUsesValue(propertySchema, '')
    const isUnusedNull = entry === null && !schemaAcceptsNull(propertySchema)
    if (optional && (isUnusedEmptyString || isUnusedNull)) continue
    normalized[key] = normalizeOptionalToolInput(entry, propertySchema)
  }
  return normalized
}

export function normalizeAnthropicToolArguments(
  rawArguments: string,
  toolName: string,
  schemas: AnthropicToolInputSchemas,
): string {
  const schema = schemas.get(toolName)
  if (!schema || !rawArguments) return rawArguments
  try {
    const parsed = JSON.parse(rawArguments)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return rawArguments
    return JSON.stringify(normalizeOptionalToolInput(parsed, schema))
  } catch {
    return rawArguments
  }
}

export function shouldPreserveReasoningContent(target: AnthropicAdapterTarget): boolean {
  const identifier = `${target.provider} ${target.model} ${target.baseUrl}`.toLowerCase()
  return [
    'deepseek',
    'moonshot',
    'kimi',
    'mimo',
    'xiaomimimo',
  ].some(part => identifier.includes(part))
}

function anthropicToolResultToOpenAiChat(
  content: unknown,
  toolUseId: string,
): { toolContent: string; imageMessageContent: any[] } {
  if (!Array.isArray(content)) {
    return { toolContent: stringifyContent(content), imageMessageContent: [] }
  }

  const textParts: string[] = []
  const imageParts: any[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block)
      continue
    }
    if (block?.type === 'text' || (block && typeof block === 'object' && 'text' in block)) {
      textParts.push(String(block.text || ''))
      continue
    }
    if (block?.type === 'image') {
      const url = anthropicImageSourceToUrl(block.source)
      if (url) imageParts.push({ type: 'image_url', image_url: { url } })
      continue
    }
    const text = stringifyContent(block)
    if (text) textParts.push(text)
  }

  const text = textParts.filter(Boolean).join('\n')
  if (!imageParts.length) {
    return { toolContent: text, imageMessageContent: [] }
  }
  return {
    toolContent: text || '[Image output attached.]',
    imageMessageContent: [
      { type: 'text', text: `[Image output from tool ${toolUseId}]` },
      ...imageParts,
    ],
  }
}

function anthropicContentToOpenAiMessages(
  message: any,
  preserveReasoningContent = false,
): any[] {
  const content = message?.content
  if (!Array.isArray(content)) {
    return [{ role: message.role, content: stringifyContent(content) }]
  }

  if (message.role === 'assistant') {
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls: any[] = []
    for (const block of content) {
      if (block?.type === 'text') textParts.push(String(block.text || ''))
      if (block?.type === 'thinking' && block.thinking) reasoningParts.push(String(block.thinking))
      if (block?.type === 'redacted_thinking' && preserveReasoningContent) reasoningParts.push('[redacted thinking]')
      if (block?.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id || `tool_${toolCalls.length}`),
          type: 'function',
          function: {
            name: String(block.name || 'tool'),
            arguments: JSON.stringify(block.input || {}),
          },
        })
      }
    }
    const openAiMessage: any = {
      role: 'assistant',
      content: textParts.join('\n') || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
    if (preserveReasoningContent && (reasoningParts.length || toolCalls.length)) {
      openAiMessage.reasoning_content = reasoningParts.join('\n') || 'tool call'
    }
    return [openAiMessage]
  }

  const messages: any[] = []
  const contentParts: any[] = []
  const toolImageContent: any[] = []
  let hasImage = false
  const flushUserContent = () => {
    if (!contentParts.length) return
    messages.push({
      role: message.role || 'user',
      content: hasImage
        ? contentParts.splice(0)
        : contentParts.splice(0).map(part => String(part.text || '')).filter(Boolean).join('\n'),
    })
    hasImage = false
  }
  for (const block of content) {
    if (block?.type === 'text') {
      contentParts.push({ type: 'text', text: String(block.text || '') })
    }
    if (block?.type === 'image') {
      const url = anthropicImageSourceToUrl(block.source)
      if (url) {
        hasImage = true
        contentParts.push({ type: 'image_url', image_url: { url } })
      }
    }
    if (block?.type === 'tool_result') {
      flushUserContent()
      const toolUseId = String(block.tool_use_id || '')
      const converted = anthropicToolResultToOpenAiChat(block.content, toolUseId)
      messages.push({
        role: 'tool',
        tool_call_id: toolUseId,
        content: converted.toolContent,
      })
      toolImageContent.push(...converted.imageMessageContent)
    }
  }
  flushUserContent()
  if (toolImageContent.length) messages.push({ role: 'user', content: toolImageContent })
  return messages.length ? messages : [{ role: message.role || 'user', content: '' }]
}

// Claude Code (2.1.x) sends its primary prompt as the top-level `system` field
// and additional system prompts (e.g. the ToolSearch deferred-tools notice,
// injected mid-conversation) as `role: 'system'` messages inside `messages`.
// Converting the top-level field to the leading system message and keeping the
// rest in place leaves a second system message mid-conversation. Some providers
// (notably vLLM) reject that with 400 "System message must be at the beginning."
// Fix: keep exactly one leading system message — merging any additional ones
// into it in original order (top-level field first, then in-message systems).
function consolidateAnthropicChatSystemMessages(messages: any[]): any[] {
  const systemMessages: any[] = []
  const rest: any[] = []
  for (const message of messages) {
    if (message?.role === 'system') systemMessages.push(message)
    else rest.push(message)
  }
  if (systemMessages.length === 0) return messages
  // Exactly one system message: keep its content verbatim (string or image
  // parts) and only relocate it to the front if it was mid-conversation.
  if (systemMessages.length === 1) {
    const only = systemMessages[0]
    if (messages[0] === only) return messages
    return [only, ...rest]
  }
  // Multiple system messages (top-level field + in-message systems): merge
  // their text into one leading system message.
  const parts = systemMessages
    .map(message => (typeof message.content === 'string' ? message.content : stringifyContent(message.content)))
    .filter(Boolean)
  return [{ role: 'system', content: parts.join('\n\n') }, ...rest]
}

export function anthropicToOpenAiChat(body: any, target: AnthropicAdapterTarget, stream = false): any {
  const messages: any[] = []
  const preserveReasoningContent = shouldPreserveReasoningContent(target)
  const system = body?.system
  if (system) messages.push({ role: 'system', content: stringifyContent(system) })
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    messages.push(...anthropicContentToOpenAiMessages(message, preserveReasoningContent))
  }

  const reasoningEffort = targetReasoningEffort(target)
  const tools = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => ({
      type: 'function',
      function: {
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    })).filter((tool: any) => tool.function.name)
    : undefined

  return {
    model: target.model,
    messages: consolidateAnthropicChatSystemMessages(messages),
    ...(typeof body?.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  }
}

function anthropicToOpenAiResponsesInput(message: any): any[] {
  const content = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: stringifyContent(message?.content) }]

  if (message.role === 'assistant') {
    const items: any[] = []
    const textParts: string[] = []
    for (const block of content) {
      if (block?.type === 'text') textParts.push(String(block.text || ''))
      if (block?.type === 'tool_use') {
        if (textParts.length) {
          items.push({ role: 'assistant', content: textParts.splice(0).join('\n') })
        }
        items.push({
          type: 'function_call',
          call_id: String(block.id || `tool_${items.length}`),
          name: String(block.name || 'tool'),
          arguments: JSON.stringify(block.input || {}),
        })
      }
    }
    if (textParts.length) items.push({ role: 'assistant', content: textParts.join('\n') })
    return items
  }

  const items: any[] = []
  const contentParts: any[] = []
  let hasImage = false
  const flushUserContent = () => {
    if (!contentParts.length) return
    items.push({
      role: message.role || 'user',
      content: hasImage
        ? contentParts.splice(0)
        : contentParts.splice(0).map(part => String(part.text || '')).filter(Boolean).join('\n'),
    })
    hasImage = false
  }
  for (const block of content) {
    if (block?.type === 'text') {
      contentParts.push({ type: 'input_text', text: String(block.text || '') })
    }
    if (block?.type === 'image') {
      const url = anthropicImageSourceToUrl(block.source)
      if (url) {
        hasImage = true
        contentParts.push({ type: 'input_image', image_url: url })
      }
    }
    if (block?.type === 'tool_result') {
      flushUserContent()
      items.push({
        type: 'function_call_output',
        call_id: String(block.tool_use_id || ''),
        output: anthropicToolResultToResponsesOutput(block.content),
      })
    }
  }
  flushUserContent()
  return items.length ? items : [{ role: message.role || 'user', content: '' }]
}

function anthropicToolResultToResponsesOutput(content: unknown): string | any[] {
  if (!Array.isArray(content)) return stringifyContent(content)

  const parts: any[] = []
  let hasImage = false
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push({ type: 'input_text', text: block })
      continue
    }
    if (block?.type === 'text' || (block && typeof block === 'object' && 'text' in block)) {
      parts.push({ type: 'input_text', text: String(block.text || '') })
      continue
    }
    if (block?.type === 'image') {
      const url = anthropicImageSourceToUrl(block.source)
      if (url) {
        hasImage = true
        parts.push({ type: 'input_image', image_url: url })
      }
      continue
    }
    const text = stringifyContent(block)
    if (text) parts.push({ type: 'input_text', text })
  }
  if (hasImage) return parts
  return parts.map(part => String(part.text || '')).filter(Boolean).join('\n')
}

export function anthropicToOpenAiResponses(body: any, target: AnthropicAdapterTarget, stream = false): any {
  const input: any[] = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    input.push(...anthropicToOpenAiResponsesInput(message))
  }

  const reasoningEffort = targetReasoningEffort(target)
  const tools = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => ({
      type: 'function',
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    })).filter((tool: any) => tool.name)
    : undefined

  return {
    model: target.model,
    input,
    ...(body?.system ? { instructions: stringifyContent(body.system) } : {}),
    ...(typeof body?.max_tokens === 'number' ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
    store: false,
  }
}

export function mapStopReason(reason: string | null | undefined, hasTools: boolean): string {
  if (hasTools) return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'stop_sequence'
  return 'end_turn'
}

export function openAiToAnthropicMessage(data: any, target: AnthropicAdapterTarget): any {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const content: any[] = []
  if (shouldPreserveReasoningContent(target) && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(message.reasoning_content) })
  }
  if (message.content) content.push({ type: 'text', text: String(message.content) })
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: String(call.id || `toolu_${content.length}`),
      name: String(call.function?.name || 'tool'),
      input: safeJsonParse(String(call.function?.arguments || '{}')),
    })
  }

  const hasTools = content.some(block => block.type === 'tool_use')
  return {
    id: String(data?.id || `msg_${Date.now()}`),
    type: 'message',
    role: 'assistant',
    model: target.model,
    content,
    stop_reason: mapStopReason(choice.finish_reason, hasTools),
    stop_sequence: null,
    usage: {
      input_tokens: Number(data?.usage?.prompt_tokens || 0),
      output_tokens: Number(data?.usage?.completion_tokens || 0),
    },
  }
}

function responseOutputText(item: any): string {
  if (item?.type === 'output_text') return String(item.text || '')
  if (item?.type === 'message' && Array.isArray(item.content)) {
    return item.content
      .map((part: any) => {
        if (part?.type === 'output_text' || part?.type === 'text') return String(part.text || '')
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

export function openAiResponsesToAnthropicMessage(
  data: any,
  target: AnthropicAdapterTarget,
  anthropicTools?: unknown,
): any {
  const content: any[] = []
  const output = Array.isArray(data?.output) ? data.output : []
  const toolInputSchemas = createAnthropicToolInputSchemas(anthropicTools)

  for (const item of output) {
    const text = responseOutputText(item)
    if (text) content.push({ type: 'text', text })
    if (item?.type === 'function_call') {
      const name = String(item.name || 'tool')
      content.push({
        type: 'tool_use',
        id: String(item.call_id || item.id || `toolu_${content.length}`),
        name,
        input: safeJsonParse(normalizeAnthropicToolArguments(
          String(item.arguments || '{}'),
          name,
          toolInputSchemas,
        )),
      })
    }
  }

  if (!content.length && data?.output_text) {
    content.push({ type: 'text', text: String(data.output_text) })
  }

  const hasTools = content.some(block => block.type === 'tool_use')
  return {
    id: String(data?.id || `msg_${Date.now()}`),
    type: 'message',
    role: 'assistant',
    model: target.model,
    content,
    stop_reason: hasTools ? 'tool_use' : (data?.status === 'incomplete' ? 'max_tokens' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: Number(data?.usage?.input_tokens || 0),
      output_tokens: Number(data?.usage?.output_tokens || 0),
    },
  }
}
