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
import { modelRequestHeaders, modelRequestUrl, isPlainRecord, parseJson, postJson, postStream, providerUrl, readServerSentEvents } from '../http'
import { collectModelEvents, normalizeAgentReasoning } from '../messages'

interface OpenAIResponsesPayload {
  model: string
  instructions?: string
  input: OpenAIResponseInputItem[]
  include?: ['reasoning.encrypted_content']
  temperature?: number
  max_output_tokens?: number
  reasoning?: {
    effort?: NonNullable<ModelRequest['reasoningEffort']>
    summary?: NonNullable<ModelRequest['reasoningSummary']>
  }
  tools?: Array<{
    type: 'function'
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }>
  tool_choice?: 'auto' | 'none' | 'required'
  stream?: boolean
  store: false
}

type OpenAIResponseInputItem =
  | {
      role: 'user' | 'assistant' | 'developer'
      content: string | Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
      >
    }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }
  | OpenAIReasoningInputItem

interface OpenAIReasoningInputItem {
  type: 'reasoning'
  id?: string
  summary?: Array<{ type: 'summary_text'; text: string }>
  content?: Array<{ type: 'reasoning_text'; text: string }>
  encrypted_content?: string
  status?: string
}

interface OpenAIResponsesResponse {
  id?: string
  model?: string
  output_text?: string
  output?: Array<{
    id?: string
    type?: string
    phase?: string
    content?: Array<{ type?: string; text?: string }>
    summary?: Array<{ type?: string; text?: string }>
    encrypted_content?: string
    status?: string
    name?: string
    call_id?: string
    arguments?: string
  }>
  reasoning?: string
  reasoning_text?: string
  reasoning_summary?: string
  usage?: {
    cost?: number
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
  status?: string
  error?: {
    message?: string
  }
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  jsonMode: true,
  systemPrompt: true,
}

export class OpenAIResponsesModelClient implements ModelClient {
  readonly supportsContextTransport = true
  get defaultModel(): string { return this.config.defaultModel }
  readonly provider: string
  readonly requestStyle = 'openai-responses'
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
    return responsesUrl(this.config)
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    if (this.config.id === 'openai-codex') {
      const output = await collectModelEvents(this.stream({ ...request, stream: true }))
      return output.message
    }
    const response = await postJson<OpenAIResponsesResponse>(
      this.config,
      this.fetchImpl,
      modelRequestUrl(responsesUrl(this.config), request),
      toOpenAIResponsesPayload(this.config, { ...request, stream: false }),
      modelRequestHeaders(this.config, request),
      request.signal,
    )
    return normalizeOpenAIResponsesResponse(response)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      modelRequestUrl(responsesUrl(this.config), request),
      toOpenAIResponsesPayload(this.config, { ...request, stream: true }),
      modelRequestHeaders(this.config, request),
      request.signal,
    )

    let streamedText = ''
    let streamedReasoning = ''
    const collectedOutputItems: NonNullable<OpenAIResponsesResponse['output']> = []
    const messagePhasesById = new Map<string, string>()
    const messagePhasesByIndex = new Map<number, string>()
    for await (const event of readServerSentEvents(response)) {
      if (event === '[DONE]') {
        yield {
          type: 'done',
          response: normalizeStreamedResponse(
            {},
            collectedOutputItems,
            streamedText,
            streamedReasoning,
          ),
        }
        return
      }
      const chunk = parseJson<Record<string, unknown>>(event)
      if (!chunk) continue

      if (chunk.type === 'response.output_item.added' && isPlainRecord(chunk.item)) {
        rememberMessagePhase(chunk.item, chunk, messagePhasesById, messagePhasesByIndex)
      }
      if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
        const phase = messagePhaseForChunk(chunk, messagePhasesById, messagePhasesByIndex)
        if (isReasoningMessagePhase(phase)) {
          streamedReasoning += chunk.delta
          yield { type: 'reasoning-delta', text: chunk.delta }
        } else {
          streamedText += chunk.delta
          yield { type: 'text-delta', text: chunk.delta }
        }
      }
      if (
        (chunk.type === 'response.reasoning.delta' ||
          chunk.type === 'response.reasoning_text.delta' ||
          chunk.type === 'response.reasoning_summary_text.delta') &&
        typeof chunk.delta === 'string'
      ) {
        streamedReasoning += chunk.delta
        yield { type: 'reasoning-delta', text: chunk.delta }
      }
      if (chunk.type === 'response.output_item.done' && isPlainRecord(chunk.item)) {
        const item = chunk.item
        rememberMessagePhase(item, chunk, messagePhasesById, messagePhasesByIndex)
        collectedOutputItems.push(item as NonNullable<OpenAIResponsesResponse['output']>[number])
        if (item.type === 'function_call' && typeof item.name === 'string') {
          const id = typeof item.call_id === 'string'
            ? item.call_id
            : typeof item.id === 'string'
              ? item.id
              : ''
          const argumentsText = typeof item.arguments === 'string' ? item.arguments : '{}'
          if (id) yield { type: 'tool-call', toolCall: normalizeToolCall(id, item.name, argumentsText) }
        }
      }
      if (chunk.type === 'error') {
        const message = isPlainRecord(chunk.error) && typeof chunk.error.message === 'string'
          ? chunk.error.message
          : typeof chunk.message === 'string'
            ? chunk.message
            : 'Model provider stream failed.'
        yield { type: 'error', error: message }
        return
      }
      if (chunk.type === 'response.completed' && isPlainRecord(chunk.response)) {
        yield {
          type: 'done',
          response: normalizeStreamedResponse(
            chunk.response as OpenAIResponsesResponse,
            collectedOutputItems,
            streamedText,
            streamedReasoning,
          ),
        }
        return
      }
    }
  }
}

function normalizeStreamedResponse(
  terminal: OpenAIResponsesResponse,
  collectedOutputItems: NonNullable<OpenAIResponsesResponse['output']>,
  streamedText: string,
  streamedReasoning: string,
): ModelResponse {
  const output = collectedOutputItems.length > 0
    ? collectedOutputItems
    : terminal.output?.length
      ? terminal.output
      : streamedText
        ? [{
            type: 'message',
            content: [{ type: 'output_text', text: streamedText }],
          }]
        : []
  const normalized = normalizeOpenAIResponsesResponse({ ...terminal, output })
  if (!normalized.content && streamedText) normalized.content = streamedText
  if (!normalized.reasoning && streamedReasoning) {
    normalized.reasoning = normalizeAgentReasoning(streamedReasoning)
  }
  return normalized
}

export function toOpenAIResponsesPayload(config: ModelProviderConfig, request: ModelRequest): OpenAIResponsesPayload {
  const systemMessages = request.messages.filter(message => message.role === 'system')
  const tools = request.tools?.length ? request.tools.map(toOpenAIResponseTool) : undefined
  const replayableToolCallIds = new Set(
    request.messages.flatMap(message => message.role === 'assistant'
      ? (message.toolCalls ?? [])
          .filter(toolCall => toolCall.id && toolCall.name.trim())
          .map(toolCall => toolCall.id)
      : []),
  )
  const supportsSamplingControls = config.id !== 'openai-codex'
  return {
    model: request.model ?? config.defaultModel,
    instructions: systemMessages.map(message => message.content).join('\n\n') || undefined,
    ...(shouldIncludeEncryptedReasoning(config) ? { include: ['reasoning.encrypted_content'] as const } : {}),
    input: request.messages
      .filter(message => message.role !== 'system')
      .flatMap(message => toOpenAIResponseInput(message, replayableToolCallIds)),
    ...(supportsSamplingControls && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(supportsSamplingControls && request.maxTokens !== undefined ? { max_output_tokens: request.maxTokens } : {}),
    ...(request.reasoningEffort || request.reasoningSummary
      ? {
          reasoning: {
            ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
            ...(request.reasoningSummary ? { summary: request.reasoningSummary } : {}),
          },
        }
      : {}),
    ...(tools
      ? {
          tools,
          ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
        }
      : {}),
    stream: request.stream,
    store: false,
  }
}

export function normalizeOpenAIResponsesResponse(response: OpenAIResponsesResponse): ModelResponse {
  const normalizedToolCalls = response.output
    ?.filter(item => item.type === 'function_call' && item.name && item.call_id)
    .map(item => normalizeToolCall(item.call_id ?? '', item.name ?? '', item.arguments ?? '{}'))
  const toolCalls = normalizedToolCalls?.length ? normalizedToolCalls : undefined

  const messageItems = response.output?.filter(item => item.type === 'message') ?? []
  const outputContent = messageItems
    .filter(item => !isReasoningMessagePhase(item.phase))
    .flatMap(item => item.content ?? [])
    .map(part => part.text ?? '')
    .join('')

  return {
    id: response.id,
    model: response.model,
    content: outputContent || (messageItems.length === 0 ? response.output_text ?? '' : ''),
    reasoning: normalizeAgentReasoning(
      normalizeReasoning(response),
      openAIResponsesReasoningDetails(response.output),
    ),
    toolCalls,
    usage: response.usage ? normalizeUsage(response.usage) : undefined,
    finishReason: response.status,
    context: response.id ? { responseId: response.id } : undefined,
    raw: response,
  }
}

function normalizeReasoning(response: OpenAIResponsesResponse): string | undefined {
  if (typeof response.reasoning === 'string' && response.reasoning) return response.reasoning
  if (typeof response.reasoning_text === 'string' && response.reasoning_text) return response.reasoning_text
  if (typeof response.reasoning_summary === 'string' && response.reasoning_summary) return response.reasoning_summary

  const reasoning = response.output
    ?.flatMap((item) => {
      if (item.type === 'reasoning') return [...(item.content ?? []), ...(item.summary ?? [])]
      if (item.type === 'message' && isReasoningMessagePhase(item.phase)) return item.content ?? []
      return []
    })
    .map(part => part.text ?? '')
    .filter(Boolean)
    .join('\n')
  return reasoning || undefined
}

function rememberMessagePhase(
  item: Record<string, unknown>,
  chunk: Record<string, unknown>,
  phasesById: Map<string, string>,
  phasesByIndex: Map<number, string>,
): void {
  if (item.type !== 'message' || typeof item.phase !== 'string') return
  if (typeof item.id === 'string') phasesById.set(item.id, item.phase)
  if (typeof chunk.output_index === 'number') phasesByIndex.set(chunk.output_index, item.phase)
}

function messagePhaseForChunk(
  chunk: Record<string, unknown>,
  phasesById: ReadonlyMap<string, string>,
  phasesByIndex: ReadonlyMap<number, string>,
): string | undefined {
  if (typeof chunk.phase === 'string') return chunk.phase
  if (typeof chunk.item_id === 'string') {
    const phase = phasesById.get(chunk.item_id)
    if (phase) return phase
  }
  return typeof chunk.output_index === 'number'
    ? phasesByIndex.get(chunk.output_index)
    : undefined
}

function isReasoningMessagePhase(phase: unknown): boolean {
  const normalized = typeof phase === 'string' ? phase.trim().toLowerCase() : ''
  return normalized === 'commentary' || normalized === 'analysis'
}

function toOpenAIResponseInput(
  message: AgentMessage,
  replayableToolCallIds: ReadonlySet<string>,
): OpenAIResponseInputItem[] {
  if (message.role === 'tool') {
    if (!message.toolCallId || !replayableToolCallIds.has(message.toolCallId)) return []
    const items: OpenAIResponseInputItem[] = [{
      type: 'function_call_output',
      call_id: message.toolCallId,
      output: message.content,
    }]
    const images = message.contentParts?.filter(part => part.type === 'image') ?? []
    if (images.length) {
      items.push({
        role: 'user',
        content: [
          { type: 'input_text', text: 'Visual output from the preceding tool result:' },
          ...images.map(image => ({ type: 'input_image' as const, image_url: `data:${image.mimeType};base64,${image.data}` })),
        ],
      })
    }
    return items
  }
  if (message.role === 'assistant') {
    const items: OpenAIResponseInputItem[] = [
      ...openAIResponsesReasoningInput(message),
    ]
    if (message.content) items.push({ role: 'assistant', content: message.content })
    for (const toolCall of message.toolCalls ?? []) {
      if (!toolCall.id || !toolCall.name.trim()) continue
      items.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.rawArguments || JSON.stringify(toolCall.arguments),
      })
    }
    return items
  }
  const images = message.contentParts?.filter(part => part.type === 'image') ?? []
  if (images.length) {
    return [{
      role: 'user',
      content: [
        ...(message.content ? [{ type: 'input_text' as const, text: message.content }] : []),
        ...images.map(image => ({ type: 'input_image' as const, image_url: `data:${image.mimeType};base64,${image.data}` })),
      ],
    }]
  }
  return [{ role: 'user', content: message.content }]
}

function openAIResponsesReasoningInput(message: AgentMessage): OpenAIReasoningInputItem[] {
  if (message.reasoning?.native?.format !== 'openai-responses-items') return []
  if (!Array.isArray(message.reasoning.native.data)) return []
  return message.reasoning.native.data
    .filter(isPlainRecord)
    .filter(item => item.type === 'reasoning')
    .map(item => ({ ...item, type: 'reasoning' }) as OpenAIReasoningInputItem)
}

function openAIResponsesReasoningDetails(output: OpenAIResponsesResponse['output']) {
  const items = output?.filter(item => item.type === 'reasoning') ?? []
  return items.length
    ? {
        format: 'openai-responses-items' as const,
        data: items,
      }
    : undefined
}

function shouldIncludeEncryptedReasoning(config: ModelProviderConfig): boolean {
  const identifier = `${config.id} ${config.baseUrl || ''}`.toLowerCase()
  return config.type === 'openai' ||
    config.id === 'openai' ||
    identifier.includes('api.openai.com')
}

function toOpenAIResponseTool(tool: AgentToolDefinition): NonNullable<OpenAIResponsesPayload['tools']>[number] {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
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

function normalizeUsage(usage: NonNullable<OpenAIResponsesResponse['usage']>): ModelUsage {
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const inputTokens = usage.input_tokens ?? 0
  return {
    ...(typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { costUsd: usage.cost } : {}),
    inputTokens: Math.max(0, inputTokens - cacheReadTokens),
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadTokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  }
}

function responsesUrl(config: ModelProviderConfig): string {
  return providerUrl(config, 'https://api.openai.com/v1', config.endpointPath ?? 'responses')
}
