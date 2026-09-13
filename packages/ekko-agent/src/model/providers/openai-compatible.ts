import { ModelProviderError } from '../errors'
import { agentReasoningText, normalizeAgentReasoning } from '../messages'
import {
  abortSignal,
  isPlainRecord,
  parseJson,
  parseResponseJson,
  parseServerSentEventLine,
  providerHttpError,
  providerUrl,
  modelRequestHeaders,
} from '../http'
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
  OpenAIChatReasoningReplayFormat,
} from '../types'

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | Array<
    | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
    | { type: 'image_url'; image_url: { url: string } }
  >
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: unknown
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type OpenAIMessageContent = string | Array<{ type?: string; text?: string }> | null | undefined

interface OpenAIChatResponseMessage {
  content?: OpenAIMessageContent
  reasoning?: string
  reasoning_content?: string
  reasoning_details?: unknown
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIChatPayload {
  model: string
  messages: OpenAIChatMessage[]
  temperature?: number
  max_tokens?: number
  tools?: OpenAIToolDefinition[]
  tool_choice?: 'auto' | 'none' | 'required'
  stream?: boolean
  stream_options?: {
    include_usage: boolean
  }
  vl_high_resolution_images?: true
}

interface OpenAIChatResponse {
  id?: string
  model?: string
  choices?: Array<{
    message?: OpenAIChatResponseMessage
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      reasoning_details?: unknown
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
  error?: {
    message?: string
    type?: string
    code?: string
  }
}

const defaultCapabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  jsonMode: false,
  systemPrompt: true,
}

const TEXT_ONLY_CHAT_TARGET_LIMIT = 512
const textOnlyChatTargets = new Set<string>()

export class OpenAICompatibleModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'openai-chat'
  readonly capabilities: ModelCapabilities

  private readonly config: ModelProviderConfig
  private readonly fetchImpl: FetchLike

  constructor(config: ModelProviderConfig, options: ModelClientOptions = {}) {
    this.config = config
    this.provider = config.id
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.capabilities = {
      ...defaultCapabilities,
      ...config.capabilities,
    }
  }

  requestTarget(): string {
    return chatCompletionsUrl(this.config)
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.postWithImageFallback(request, false, request.signal)
    return normalizeOpenAIChatResponse(this.provider, await parseResponseJson(this.provider, response))
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await this.postWithImageFallback(request, true, request.signal)

    if (!response.body) {
      throw new ModelProviderError('Model provider returned an empty stream body.', {
        provider: this.provider,
        statusCode: response.status,
      })
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const toolCalls = new Map<number, { id: string; name: string; argumentsText: string }>()
    let buffer = ''
    let finishReason: string | undefined
    let responseId: string | undefined
    let responseModel: string | undefined
    const reasoningDetails = new Map<string, Record<string, unknown>>()

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const event = parseServerSentEventLine(line)
          if (!event) continue
          if (event === '[DONE]') {
            yield {
              type: 'done',
              response: {
                id: responseId,
                model: responseModel,
                finishReason,
                reasoning: normalizeAgentReasoning(
                  undefined,
                  openAIReasoningDetails([...reasoningDetails.values()]),
                ),
              },
            }
            return
          }

          const chunk = parseJson<OpenAIChatResponse>(event)
          if (!chunk) continue
          responseId = chunk.id ?? responseId
          responseModel = chunk.model ?? responseModel

          if (chunk.usage) {
            yield { type: 'usage', usage: normalizeUsage(chunk.usage) }
          }

          const choice = chunk.choices?.[0]
          if (!choice) continue
          finishReason = choice.finish_reason ?? finishReason

          const content = choice.delta?.content
          if (content) {
            yield { type: 'text-delta', text: content }
          }
          const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning
          if (reasoning) {
            yield { type: 'reasoning-delta', text: reasoning }
          } else {
            const detailsText = reasoningDetailsText(choice.delta?.reasoning_details)
            if (detailsText) yield { type: 'reasoning-delta', text: detailsText }
          }
          mergeOpenAIReasoningDetails(reasoningDetails, choice.delta?.reasoning_details)

          for (const toolCallDelta of choice.delta?.tool_calls ?? []) {
            const index = toolCallDelta.index ?? 0
            const current = toolCalls.get(index) ?? { id: '', name: '', argumentsText: '' }
            current.id = toolCallDelta.id ?? current.id
            current.name = toolCallDelta.function?.name ?? current.name
            current.argumentsText += toolCallDelta.function?.arguments ?? ''
            toolCalls.set(index, current)
          }

          if (choice.finish_reason === 'tool_calls') {
            let validToolCalls = 0
            for (const toolCall of toolCalls.values()) {
              const normalized = normalizeToolCall(toolCall.id, toolCall.name, toolCall.argumentsText)
              if (!normalized) continue
              validToolCalls += 1
              yield { type: 'tool-call', toolCall: normalized }
            }
            toolCalls.clear()
            if (validToolCalls === 0) {
              throw invalidOpenAIToolCallError(this.provider)
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    yield {
      type: 'done',
      response: {
        id: responseId,
        model: responseModel,
        finishReason,
        reasoning: normalizeAgentReasoning(
          undefined,
          openAIReasoningDetails([...reasoningDetails.values()]),
        ),
      },
    }
  }

  private async postWithImageFallback(request: ModelRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const model = request.model ?? this.config.defaultModel
    const target = chatTargetKey(this.config, model)
    const initialConfig = textOnlyChatTargets.has(target)
      ? withoutVision(this.config)
      : this.config
    const payload = toOpenAIChatPayload(initialConfig, { ...request, stream })
    try {
      return await this.post(payload, request, signal)
    } catch (error) {
      if (!payloadContainsImage(payload) || !isUnsupportedImageError(error)) throw error
      rememberTextOnlyChatTarget(target)
      return this.post(toOpenAIChatPayload(withoutVision(this.config), { ...request, stream }), request, signal)
    }
  }

  private async post(payload: OpenAIChatPayload, request: ModelRequest, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(chatCompletionsUrl(this.config), {
      method: 'POST',
      headers: modelRequestHeaders(this.config, request),
      body: JSON.stringify(payload),
      signal: abortSignal(this.config.timeoutMs, signal),
    })

    if (!response.ok) {
      throw await providerHttpError(this.provider, response)
    }

    return response
  }
}

function chatTargetKey(config: ModelProviderConfig, model: string): string {
  return [config.id, chatCompletionsUrl(config), model]
    .map(value => value.trim().toLowerCase())
    .join('\u0000')
}

function rememberTextOnlyChatTarget(target: string): void {
  if (textOnlyChatTargets.has(target)) return
  if (textOnlyChatTargets.size >= TEXT_ONLY_CHAT_TARGET_LIMIT) {
    const oldest = textOnlyChatTargets.values().next().value
    if (oldest) textOnlyChatTargets.delete(oldest)
  }
  textOnlyChatTargets.add(target)
}

function withoutVision(config: ModelProviderConfig): ModelProviderConfig {
  return {
    ...config,
    capabilities: {
      ...config.capabilities,
      vision: false,
    },
  }
}

function payloadContainsImage(payload: OpenAIChatPayload): boolean {
  return payload.messages.some(message =>
    Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))
}

function isUnsupportedImageError(error: unknown): boolean {
  if (!(error instanceof ModelProviderError)) return false
  let details = ''
  try {
    details = JSON.stringify(error.details)
  } catch {
    // The provider message below is still sufficient for matching.
  }
  const text = `${error.message} ${details}`.toLowerCase()
  const rejectsImageUrl = text.includes('image_url') && (
    text.includes('unknown variant') ||
    text.includes('expected') && text.includes('text') ||
    text.includes('supported values') && text.includes('text') ||
    text.includes('invalid content')
  )
  const rejectsImages = text.includes('image') && (
    text.includes('does not support') ||
    text.includes('not support') ||
    text.includes('unsupported') ||
    text.includes('text-only') ||
    text.includes('text only') ||
    text.includes('only supports text')
  )
  return rejectsImageUrl || rejectsImages
}

export function toOpenAIChatPayload(config: ModelProviderConfig, request: ModelRequest): OpenAIChatPayload {
  const isQwenOAuth = config.id === 'qwen-oauth'
  const supportsVision = config.capabilities?.vision !== false
  const model = request.model ?? config.defaultModel
  const reasoningReplayField = openAIReasoningReplayField(
    config,
    model,
  )
  const requiresAssistantContent = requiresNonNullAssistantContent(
    config,
    model,
  )
  const supportsToolChoice = supportsOpenAIChatToolChoice(model)
  const tools = request.tools?.length ? request.tools.map(toOpenAIToolDefinition) : undefined
  const messages = sanitizeOpenAIChatToolHistory(request.messages)
  const chatMessages: OpenAIChatMessage[] = []
  const toolImageMessages: OpenAIChatMessage[] = []
  for (const message of messages) {
    // Image attachments become user messages and must follow the entire tool batch.
    if (message.role !== 'tool') chatMessages.push(...toolImageMessages.splice(0))
    const converted = toOpenAIChatMessages(
      message, isQwenOAuth, reasoningReplayField, requiresAssistantContent, supportsVision,
    )
    if (message.role === 'tool') {
      chatMessages.push(converted[0]!)
      toolImageMessages.push(...converted.slice(1))
    } else {
      chatMessages.push(...converted)
    }
  }
  chatMessages.push(...toolImageMessages)
  return {
    model,
    messages: chatMessages,
    temperature: request.temperature,
    max_tokens: request.maxTokens,
    ...(tools
      ? {
          tools,
          ...(request.toolChoice && supportsToolChoice ? { tool_choice: request.toolChoice } : {}),
        }
      : {}),
    stream: request.stream,
    stream_options: request.stream ? { include_usage: true } : undefined,
    vl_high_resolution_images: isQwenOAuth && supportsVision ? true : undefined,
  }
}

function supportsOpenAIChatToolChoice(model: string): boolean {
  // DeepSeek Chat thinking mode rejects the tool_choice parameter. V4 models
  // enable thinking by default; the legacy deepseek-reasoner alias does too.
  const modelId = model.trim().toLowerCase()
  return !(
    modelId.includes('deepseek-v4') ||
    modelId.endsWith('deepseek-reasoner')
  )
}

export function normalizeOpenAIChatResponse(provider: string, response: OpenAIChatResponse): ModelResponse {
  if (response.error) {
    throw new ModelProviderError(response.error.message ?? 'Model provider returned an error.', {
      provider,
      details: response.error,
    })
  }

  const choice = response.choices?.[0]
  const toolCalls = normalizeOpenAIToolCalls(choice?.message?.tool_calls)
  if (choice?.finish_reason === 'tool_calls' && !toolCalls?.length) {
    throw invalidOpenAIToolCallError(provider)
  }
  return {
    id: response.id,
    model: response.model,
    content: normalizeContent(choice?.message?.content),
    reasoning: normalizeAgentReasoning(
      normalizeReasoning(choice?.message),
      openAIReasoningDetails(choice?.message?.reasoning_details),
    ),
    toolCalls,
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: choice?.finish_reason ?? undefined,
    raw: response,
  }
}

function normalizeReasoning(message: OpenAIChatResponseMessage | undefined): string | undefined {
  if (!message) return undefined
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) return message.reasoning_content
  if (typeof message.reasoning === 'string' && message.reasoning) return message.reasoning
  return reasoningDetailsText(message.reasoning_details)
}

function toOpenAIChatMessages(
  message: AgentMessage,
  qwenOAuth = false,
  reasoningReplayField?: OpenAIChatReasoningReplayFormat,
  requiresAssistantContent = false,
  supportsVision = true,
): OpenAIChatMessage[] {
  const plainContent = message.role === 'assistant' && message.toolCalls?.length
    ? message.content || (requiresAssistantContent ? '' : null)
    : message.content
  const content = qwenOAuth && typeof plainContent === 'string'
    ? [{
        type: 'text' as const,
        text: plainContent,
        ...(message.role === 'system' ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }]
    : plainContent
  const reasoningText = agentReasoningText(message.reasoning)
  const reasoningDetails = openAIReasoningDetailsData(message)
  const reasoningReplay: Partial<OpenAIChatMessage> = message.role !== 'assistant'
    ? {}
    : reasoningReplayField === 'reasoning' && reasoningText
      ? { reasoning: reasoningText }
      : reasoningReplayField === 'reasoning_content'
        ? { reasoning_content: reasoningText || '' }
        : reasoningReplayField === 'reasoning_details' && reasoningDetails
          ? { reasoning_details: reasoningDetails }
          : reasoningReplayField === 'reasoning_details' && reasoningText
            ? { reasoning: reasoningText }
            : {}
  const base: OpenAIChatMessage = {
    role: message.role,
    content,
    ...reasoningReplay,
    name: message.name,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map(toOpenAIToolCall),
  }
  const images = supportsVision
    ? message.contentParts?.filter(part => part.type === 'image') ?? []
    : []
  if (message.role === 'user' && images.length > 0) {
    return [{
      ...base,
      content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
      ],
    }]
  }
  if (message.role !== 'tool' || images.length === 0) return [base]
  return [base, {
    role: 'user',
    content: [
      { type: 'text', text: `Visual output from tool result ${message.toolCallId}:` },
      ...images.map(image => ({ type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } })),
    ],
  }]
}

function openAIReasoningReplayField(
  config: ModelProviderConfig,
  model: string,
): OpenAIChatReasoningReplayFormat {
  if (config.openAIChatReasoningReplayFormat) {
    return config.openAIChatReasoningReplayFormat
  }
  const identifier = `${config.id} ${config.baseUrl || ''} ${model}`.toLowerCase()
  // OpenRouter preserves provider-native signatures in `reasoning_details`.
  // Several Chat Completions dialects use `reasoning_content`; the remaining
  // OpenAI-compatible Chat adapters receive the common `reasoning` field.
  if (identifier.includes('openrouter')) return 'reasoning_details'
  if (usesReasoningContentProtocol(identifier)) return 'reasoning_content'
  return 'reasoning'
}

function requiresNonNullAssistantContent(
  config: ModelProviderConfig,
  model: string,
): boolean {
  return openAIReasoningReplayField(config, model) === 'reasoning_content'
}

function usesReasoningContentProtocol(identifier: string): boolean {
  return [
    'deepseek',
    'moonshot',
    'kimi',
    'mimo',
    'xiaomimimo',
    'qwen',
    'qwq',
    'dashscope',
    'glm',
    'z.ai',
    'bigmodel',
  ].some(part => identifier.includes(part))
}

function openAIReasoningDetailsData(message: AgentMessage): unknown {
  return message.reasoning?.native?.format === 'openai-reasoning-details'
    ? message.reasoning.native.data
    : undefined
}

function openAIReasoningDetails(value: unknown) {
  return Array.isArray(value) && value.length
    ? {
        format: 'openai-reasoning-details' as const,
        data: value,
      }
    : undefined
}

function reasoningDetailsText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value
    .flatMap((detail) => {
      if (!isPlainRecord(detail)) return []
      const summary = Array.isArray(detail.summary)
        ? detail.summary
            .filter(isPlainRecord)
            .map(part => typeof part.text === 'string' ? part.text : '')
        : typeof detail.summary === 'string'
          ? [detail.summary]
          : []
      return [
        typeof detail.text === 'string' ? detail.text : '',
        ...summary,
      ]
    })
    .filter(Boolean)
    .join('\n')
  return text || undefined
}

function mergeOpenAIReasoningDetails(
  target: Map<string, Record<string, unknown>>,
  value: unknown,
): void {
  if (!Array.isArray(value)) return
  for (let position = 0; position < value.length; position += 1) {
    const detail = value[position]
    if (!isPlainRecord(detail)) continue
    const key = [
      String(detail.type || 'detail'),
      String(detail.index ?? detail.id ?? position),
    ].join(':')
    const current = target.get(key) ?? {}
    const merged: Record<string, unknown> = { ...current, ...detail }
    for (const field of ['text', 'data', 'signature']) {
      const previous = typeof current[field] === 'string' ? current[field] : ''
      const next = typeof detail[field] === 'string' ? detail[field] : ''
      if (previous && next && next !== previous) {
        merged[field] = next.startsWith(previous) ? next : `${previous}${next}`
      }
    }
    target.set(key, merged)
  }
}

function toOpenAIToolDefinition(tool: AgentToolDefinition): OpenAIToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function toOpenAIToolCall(toolCall: AgentToolCall): OpenAIToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.arguments),
    },
  }
}

function toAgentToolCall(toolCall: OpenAIToolCall): AgentToolCall | null {
  return normalizeToolCall(
    toolCall?.id,
    toolCall?.function?.name,
    toolCall?.function?.arguments,
  )
}

function normalizeToolCall(id: unknown, name: unknown, argumentsText: unknown): AgentToolCall | null {
  const normalizedId = String(id || '').trim()
  const normalizedName = String(name || '').trim()
  if (!normalizedId || !normalizedName) return null
  const normalizedArgumentsText = String(argumentsText || '').trim() || '{}'
  const parsedArguments = parseJson<unknown>(normalizedArgumentsText)
  if (isPlainRecord(parsedArguments)) {
    return {
      id: normalizedId,
      name: normalizedName,
      arguments: parsedArguments,
      rawArguments: normalizedArgumentsText,
    }
  }
  return {
    id: normalizedId,
    name: normalizedName,
    arguments: {},
    rawArguments: normalizedArgumentsText,
  }
}

function normalizeOpenAIToolCalls(toolCalls: OpenAIToolCall[] | undefined): AgentToolCall[] | undefined {
  const normalized = (toolCalls ?? [])
    .map(toAgentToolCall)
    .filter((toolCall): toolCall is AgentToolCall => !!toolCall)
  return normalized.length ? normalized : undefined
}

function invalidOpenAIToolCallError(provider: string): ModelProviderError {
  return new ModelProviderError(
    'Model provider returned tool_calls without a complete id and function name.',
    {
      provider,
      retryable: true,
      details: { reason: 'invalid_tool_call' },
    },
  )
}

function sanitizeOpenAIChatToolHistory(messages: AgentMessage[]): AgentMessage[] {
  const pendingToolCalls = new Map<string, AgentToolCall>()
  const sanitized: AgentMessage[] = []

  const closeToolBatch = () => {
    for (const toolCall of pendingToolCalls.values()) {
      sanitized.push({
        role: 'tool',
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: 'Tool result is missing from the conversation history. Execution status is unknown; verify the current state before retrying any action.',
      })
    }
    pendingToolCalls.clear()
  }

  for (const message of messages) {
    if (message.role === 'tool') {
      const toolCallId = String(message.toolCallId || '').trim()
      if (!pendingToolCalls.delete(toolCallId)) continue
      sanitized.push({ ...message, toolCallId })
      continue
    }

    // Interrupted or truncated history must still close every declared call.
    closeToolBatch()
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const toolCalls: AgentToolCall[] = []
      for (const toolCall of message.toolCalls) {
        const normalized = normalizeAgentToolCall(toolCall)
        if (normalized && !pendingToolCalls.has(normalized.id)) {
          toolCalls.push(normalized)
          pendingToolCalls.set(normalized.id, normalized)
        }
      }
      if (
        toolCalls.length === 0 &&
        !message.content.trim() &&
        !agentReasoningText(message.reasoning).trim() &&
        !message.reasoning?.native
      ) continue
      sanitized.push({
        ...message,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      })
      continue
    }

    sanitized.push(message)
  }

  closeToolBatch()
  return sanitized
}

function normalizeAgentToolCall(toolCall: AgentToolCall): AgentToolCall | null {
  const id = String(toolCall?.id || '').trim()
  const name = String(toolCall?.name || '').trim()
  if (!id || !name) return null
  return {
    ...toolCall,
    id,
    name,
    arguments: isPlainRecord(toolCall.arguments) ? toolCall.arguments : {},
    rawArguments: String(toolCall.rawArguments || '').trim() || '{}',
  }
}

function normalizeContent(content: OpenAIMessageContent): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content.map(part => part.text ?? '').join('')
}

function normalizeUsage(usage: NonNullable<OpenAIChatResponse['usage']>): ModelUsage {
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0
  const inputTokens = usage.prompt_tokens ?? 0
  return {
    inputTokens: Math.max(0, inputTokens - cacheReadTokens),
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  }
}

function chatCompletionsUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.openai.com/v1', 'chat/completions')
}
