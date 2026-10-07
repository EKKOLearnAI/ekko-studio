import type {
  AgentMessage,
  AgentToolCall,
  AgentToolDefinition,
  FetchLike,
  ModelCapabilities,
  ModelClient,
  ModelClientOptions,
  ModelEvent,
  ModelProviderConfig,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from '../types'
import { ModelProviderError } from '../errors'
import { isPlainRecord, parseJson, postJson, postStream, providerUrl, readServerSentEvents, modelRequestHeaders, modelRequestUrl } from '../http'
import { agentReasoningText, normalizeAgentReasoning } from '../messages'

interface AnthropicPayload {
  model: string
  system?: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: Array<AnthropicContentBlock>
  }>
  max_tokens: number
  temperature?: number
  tools?: Array<{
    name: string
    description?: string
    input_schema?: Record<string, unknown>
  }>
  tool_choice?: { type: 'auto' | 'none' | 'any' }
  stream?: boolean
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | Array<AnthropicToolResultContent> }

type AnthropicToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

interface AnthropicResponse {
  id?: string
  model?: string
  content?: AnthropicContentBlock[]
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
  stop_reason?: string
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  jsonMode: false,
  systemPrompt: true,
}

export class AnthropicMessagesModelClient implements ModelClient {
  readonly supportsContextTransport = true
  get defaultModel(): string { return this.config.defaultModel }
  readonly provider: string
  readonly requestStyle = 'anthropic-messages'
  readonly capabilities: ModelCapabilities

  private readonly config: ModelProviderConfig
  private readonly fetchImpl: FetchLike

  constructor(config: ModelProviderConfig, options: ModelClientOptions = {}) {
    this.config = config
    this.provider = config.id
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.capabilities = { ...capabilities, ...config.capabilities }
  }

  requestTarget(): string {
    return anthropicUrl(this.config)
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const response = await postJson<AnthropicResponse>(
      this.config,
      this.fetchImpl,
      modelRequestUrl(anthropicUrl(this.config), request),
      toAnthropicMessagesPayload(this.config, { ...request, stream: false }),
      anthropicHeaders(this.config, request),
      request.signal,
    )
    assertAnthropicSuccess(this.config, response)
    return normalizeAnthropicResponse(response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      modelRequestUrl(anthropicUrl(this.config), request),
      toAnthropicMessagesPayload(this.config, { ...request, stream: true }),
      anthropicHeaders(this.config, request),
      request.signal,
    )

    const toolCallBlocks = new Map<number, { id: string; name: string; argumentsText: string }>()
    const reasoningBlocks = new Map<number, AnthropicContentBlock>()
    let finishReason: string | undefined
    let usage: ModelUsage | undefined

    for await (const event of readServerSentEvents(response)) {
      const chunk = parseJson<Record<string, unknown>>(event)
      if (!chunk) continue

      if (chunk.type === 'message_start' && isPlainRecord(chunk.message) && isPlainRecord(chunk.message.usage)) {
        usage = mergeUsage(usage, normalizeUsage(chunk.message.usage as NonNullable<AnthropicResponse['usage']>))
      }

      if (chunk.type === 'message_delta' && isPlainRecord(chunk.usage)) {
        usage = mergeUsage(usage, normalizeUsage(chunk.usage as NonNullable<AnthropicResponse['usage']>))
      }

      if (chunk.type === 'content_block_start' && isPlainRecord(chunk.content_block)) {
        const index = typeof chunk.index === 'number' ? chunk.index : 0
        const block = chunk.content_block
        if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
          toolCallBlocks.set(index, { id: block.id, name: block.name, argumentsText: '' })
        }
        if (block.type === 'thinking') {
          reasoningBlocks.set(index, {
            type: 'thinking',
            thinking: typeof block.thinking === 'string' ? block.thinking : '',
            ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          })
        }
        if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
          reasoningBlocks.set(index, { type: 'redacted_thinking', data: block.data })
        }
      }

      if (chunk.type === 'content_block_delta' && isPlainRecord(chunk.delta)) {
        if (chunk.delta.type === 'text_delta' && typeof chunk.delta.text === 'string') {
          yield { type: 'text-delta', text: chunk.delta.text }
        }
        if (chunk.delta.type === 'thinking_delta' && typeof chunk.delta.thinking === 'string') {
          const index = typeof chunk.index === 'number' ? chunk.index : 0
          const current = reasoningBlocks.get(index)
          if (current?.type === 'thinking') current.thinking += chunk.delta.thinking
          yield { type: 'reasoning-delta', text: chunk.delta.thinking }
        }
        if (chunk.delta.type === 'signature_delta' && typeof chunk.delta.signature === 'string') {
          const index = typeof chunk.index === 'number' ? chunk.index : 0
          const current = reasoningBlocks.get(index)
          if (current?.type === 'thinking') {
            current.signature = `${current.signature || ''}${chunk.delta.signature}`
          }
        }
        if (chunk.delta.type === 'input_json_delta' && typeof chunk.delta.partial_json === 'string') {
          const index = typeof chunk.index === 'number' ? chunk.index : 0
          const current = toolCallBlocks.get(index)
          if (current) current.argumentsText += chunk.delta.partial_json
        }
      }

      if (chunk.type === 'message_delta' && isPlainRecord(chunk.delta) && typeof chunk.delta.stop_reason === 'string') {
        finishReason = chunk.delta.stop_reason
      }

      if (chunk.type === 'message_stop') {
        for (const toolCall of toolCallBlocks.values()) {
          yield { type: 'tool-call', toolCall: normalizeToolCall(toolCall.id, toolCall.name, toolCall.argumentsText) }
        }
        if (usage) yield { type: 'usage', usage }
        yield {
          type: 'done',
          response: {
            finishReason,
            reasoning: normalizeAgentReasoning(
              undefined,
              anthropicReasoningDetails([...reasoningBlocks.values()]),
            ),
          },
        }
        return
      }
    }
  }
}

export function toAnthropicMessagesPayload(config: ModelProviderConfig, request: ModelRequest): AnthropicPayload {
  const tools = request.tools?.length ? request.tools.map(toAnthropicTool) : undefined
  return {
    model: request.model ?? config.defaultModel,
    system: request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n') || undefined,
    messages: request.messages
      .filter(message => message.role !== 'system')
      .map(message => toAnthropicMessage(message, config, request.model ?? config.defaultModel)),
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature,
    ...(tools
      ? {
          tools,
          ...(request.toolChoice
            ? { tool_choice: { type: request.toolChoice === 'required' ? 'any' : request.toolChoice } }
            : {}),
        }
      : {}),
    stream: request.stream,
  }
}

export function normalizeAnthropicResponse(response: AnthropicResponse): ModelResponse {
  return {
    id: response.id,
    model: response.model,
    content: response.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? '',
    reasoning: normalizeAgentReasoning(
      response.content?.filter(block => block.type === 'thinking').map(block => block.thinking).join('') || undefined,
      anthropicReasoningDetails(response.content),
    ),
    toolCalls: response.content?.filter(block => block.type === 'tool_use').map(block => ({
      id: block.id,
      name: block.name,
      arguments: block.input,
      rawArguments: JSON.stringify(block.input),
    })),
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: response.stop_reason,
    raw: response,
  }
}

function toAnthropicMessage(
  message: AgentMessage,
  config: ModelProviderConfig,
  model: string,
): AnthropicPayload['messages'][number] {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: [
        ...anthropicReasoningBlocks(message, config, model),
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.toolCalls?.map(toolCall => ({
          type: 'tool_use' as const,
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments,
        })) ?? []),
      ],
    }
  }

  if (message.role === 'tool') {
    const images = message.contentParts?.filter(part => part.type === 'image') ?? []
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: images.length
          ? [
              { type: 'text', text: message.content },
              ...images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mimeType, data: image.data } })),
            ]
          : message.content,
      }],
    }
  }

  const images = message.contentParts?.filter(part => part.type === 'image') ?? []
  return {
    role: 'user',
    content: [
      ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ...images.map(image => ({
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: image.mimeType,
          data: image.data,
        },
      })),
    ],
  }
}

function anthropicReasoningBlocks(
  message: AgentMessage,
  config: ModelProviderConfig,
  model: string,
): AnthropicContentBlock[] {
  if (message.role !== 'assistant') return []
  const nativeBlocks = message.reasoning?.native?.format === 'anthropic-thinking-blocks' &&
    Array.isArray(message.reasoning.native.data)
    ? message.reasoning.native.data.filter(isAnthropicReasoningBlock)
    : []
  if (isClaudeModel(config, model)) {
    return nativeBlocks.filter(block =>
      block.type === 'redacted_thinking' ||
      (block.type === 'thinking' && typeof block.signature === 'string' && !!block.signature))
  }
  const unsignedBlocks = nativeBlocks.filter(block =>
    block.type === 'thinking' && !block.signature)
  if (unsignedBlocks.length) return unsignedBlocks
  const text = agentReasoningText(message.reasoning)
  return text ? [{ type: 'thinking', thinking: text }] : []
}

function anthropicReasoningDetails(content: AnthropicResponse['content'] | AnthropicContentBlock[]) {
  const blocks = content?.filter(isAnthropicReasoningBlock) ?? []
  return blocks.length
    ? {
        format: 'anthropic-thinking-blocks' as const,
        data: blocks,
      }
    : undefined
}

function isAnthropicReasoningBlock(value: unknown): value is Extract<
  AnthropicContentBlock,
  { type: 'thinking' | 'redacted_thinking' }
> {
  if (!isPlainRecord(value)) return false
  if (value.type === 'thinking') {
    return typeof value.thinking === 'string' &&
      (value.signature === undefined || typeof value.signature === 'string')
  }
  return value.type === 'redacted_thinking' && typeof value.data === 'string'
}

function isClaudeModel(config: ModelProviderConfig, model: string): boolean {
  const identifier = `${config.id} ${model}`.toLowerCase()
  return identifier.includes('claude') ||
    (
      (config.id.toLowerCase().includes('anthropic') || config.id === 'claude-oauth') &&
      ['sonnet', 'opus', 'haiku'].some(part => identifier.includes(part))
    )
}

function toAnthropicTool(tool: AgentToolDefinition): NonNullable<AnthropicPayload['tools']>[number] {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }
}

function normalizeToolCall(id: string, name: string, argumentsText: string): AgentToolCall {
  const parsedArguments = parseJson<unknown>(argumentsText)
  return {
    id,
    name,
    arguments: isPlainRecord(parsedArguments) ? parsedArguments : {},
    rawArguments: argumentsText,
  }
}

function normalizeUsage(usage: NonNullable<AnthropicResponse['usage']>): ModelUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  }
}

function mergeUsage(current: ModelUsage | undefined, next: ModelUsage): ModelUsage {
  const merged = {
    inputTokens: next.inputTokens ?? current?.inputTokens,
    outputTokens: next.outputTokens ?? current?.outputTokens,
    cacheReadTokens: next.cacheReadTokens ?? current?.cacheReadTokens,
    cacheWriteTokens: next.cacheWriteTokens ?? current?.cacheWriteTokens,
    reasoningTokens: next.reasoningTokens ?? current?.reasoningTokens,
  }
  return {
    ...merged,
    totalTokens: (merged.inputTokens ?? 0) + (merged.outputTokens ?? 0),
  }
}

function anthropicUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.anthropic.com/v1', config.endpointPath ?? defaultAnthropicEndpointPath(config))
}

function anthropicHeaders(config: ModelProviderConfig, request: ModelRequest): HeadersInit {
  const headers = modelRequestHeaders(config, request, { 'anthropic-version': '2023-06-01' }) as Record<string, string>
  const usesBearerAuth = ['claude-oauth', 'minimax-oauth'].includes(config.id)
  if (isOfficialAnthropicBaseUrl(config.baseUrl) && !usesBearerAuth) delete headers.authorization
  if (config.apiKey && !usesBearerAuth) headers['x-api-key'] = config.apiKey
  return headers
}

function isOfficialAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  return !baseUrl || baseUrl.includes('api.anthropic.com')
}

function defaultAnthropicEndpointPath(config: ModelProviderConfig): string {
  const baseUrl = (config.baseUrl || '').replace(/\/+$/, '')
  return baseUrl.endsWith('/anthropic') ? 'v1/messages' : 'messages'
}

function assertAnthropicSuccess(config: ModelProviderConfig, response: AnthropicResponse): void {
  const payload = response as unknown
  if (!isPlainRecord(payload)) return
  const hasAnthropicContent = Array.isArray(payload.content)
  const failed = payload.success === false || (!hasAnthropicContent && ('code' in payload || 'error' in payload))
  if (!failed) return

  const error = isPlainRecord(payload.error) ? payload.error : undefined
  const message = typeof error?.message === 'string'
    ? error.message
    : typeof payload.msg === 'string'
      ? payload.msg
      : typeof payload.message === 'string'
        ? payload.message
        : 'Model provider returned an error response.'
  throw new ModelProviderError(message, {
    provider: config.id,
    details: payload,
  })
}
