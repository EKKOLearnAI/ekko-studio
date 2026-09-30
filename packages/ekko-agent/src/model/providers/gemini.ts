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
import { isPlainRecord, postJson, postStream, readServerSentEvents, parseJson } from '../http'
import { agentReasoningText, normalizeAgentReasoning } from '../messages'

interface GeminiPayload {
  contents: Array<{
    role: 'user' | 'model' | 'function'
    parts: GeminiPart[]
  }>
  systemInstruction?: {
    parts: Array<{ text: string }>
  }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
  }
  tools?: Array<{
    functionDeclarations: Array<{
      name: string
      description?: string
      parameters?: Record<string, unknown>
    }>
  }>
}

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
  thought?: boolean
  thoughtSignature?: string
  [key: string]: unknown
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: GeminiPart[]
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
}

const capabilities: ModelCapabilities = {
  streaming: true,
  tools: true,
  vision: true,
  jsonMode: true,
  systemPrompt: true,
}

export class GeminiContentsModelClient implements ModelClient {
  readonly provider: string
  readonly requestStyle = 'gemini-contents'
  readonly capabilities: ModelCapabilities

  private readonly config: ModelProviderConfig
  private readonly fetchImpl: FetchLike

  constructor(config: ModelProviderConfig, options: ModelClientOptions = {}) {
    this.config = config
    this.provider = config.id
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.capabilities = { ...capabilities, ...config.capabilities }
  }

  requestTarget(request: ModelRequest): string {
    return geminiUrl({ ...this.config, apiKey: undefined }, request.model, request.stream === true)
  }

  async create(request: ModelRequest): Promise<ModelResponse> {
    const response = await postJson<GeminiResponse>(
      this.config,
      this.fetchImpl,
      geminiUrl(this.config, request.model, false),
      toGeminiContentsPayload(this.config, request),
      undefined,
      request.signal,
    )
    return normalizeGeminiResponse(response, request.model ?? this.config.defaultModel)
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const response = await postStream(
      this.config,
      this.fetchImpl,
      geminiUrl(this.config, request.model, true),
      toGeminiContentsPayload(this.config, request),
      undefined,
      request.signal,
    )

    const streamedParts: GeminiPart[] = []
    for await (const event of readServerSentEvents(response)) {
      const chunk = parseJson<GeminiResponse>(event)
      if (!chunk) continue
      streamedParts.push(...(chunk.candidates?.[0]?.content?.parts ?? []))
      const normalized = normalizeGeminiResponse(chunk, request.model ?? this.config.defaultModel)
      if (normalized.content) yield { type: 'text-delta', text: normalized.content }
      const reasoningText = agentReasoningText(normalized.reasoning)
      if (reasoningText) yield { type: 'reasoning-delta', text: reasoningText }
      for (const toolCall of normalized.toolCalls ?? []) yield { type: 'tool-call', toolCall }
      if (normalized.usage) yield { type: 'usage', usage: normalized.usage }
    }
    yield {
      type: 'done',
      response: {
        reasoning: normalizeAgentReasoning(
          undefined,
          geminiReasoningDetails(streamedParts),
        ),
      },
    }
  }
}

export function toGeminiContentsPayload(config: ModelProviderConfig, request: ModelRequest): GeminiPayload {
  return {
    systemInstruction: request.messages.some(message => message.role === 'system')
      ? { parts: request.messages.filter(message => message.role === 'system').map(message => ({ text: message.content })) }
      : undefined,
    contents: request.messages.filter(message => message.role !== 'system').map(toGeminiContent),
    generationConfig: request.temperature !== undefined || request.maxTokens !== undefined
      ? { temperature: request.temperature, maxOutputTokens: request.maxTokens }
      : undefined,
    tools: request.tools?.length ? [{ functionDeclarations: request.tools.map(toGeminiTool) }] : undefined,
  }
}

export function normalizeGeminiResponse(response: GeminiResponse, model?: string): ModelResponse {
  const parts = response.candidates?.[0]?.content?.parts ?? []
  return {
    model,
    content: parts.filter(hasTextPart).filter(part => part.thought !== true).map(part => part.text).join(''),
    reasoning: normalizeAgentReasoning(
      parts.filter(hasTextPart).filter(part => part.thought === true).map(part => part.text).join('') || undefined,
      geminiReasoningDetails(parts),
    ),
    toolCalls: parts.filter(hasFunctionCallPart).map((part, index) => ({
      id: `gemini_call_${index}`,
      name: part.functionCall.name,
      arguments: part.functionCall.args,
      rawArguments: JSON.stringify(part.functionCall.args),
    })),
    usage: response.usageMetadata ? normalizeUsage(response.usageMetadata) : undefined,
    finishReason: response.candidates?.[0]?.finishReason,
    raw: response,
  }
}

function toGeminiContent(message: AgentMessage): GeminiPayload['contents'][number] {
  if (message.role === 'assistant') {
    const nativeParts = geminiReasoningParts(message)
    if (nativeParts) {
      return {
        role: 'model',
        parts: nativeParts,
      }
    }
    return {
      role: 'model',
      parts: [
        ...(message.content ? [{ text: message.content }] : []),
        ...(message.toolCalls?.map(toolCall => ({ functionCall: { name: toolCall.name, args: toolCall.arguments } })) ?? []),
      ],
    }
  }

  if (message.role === 'tool') {
    return {
      role: 'function',
      parts: [
        {
          functionResponse: {
            name: message.name ?? message.toolCallId ?? 'tool',
            response: { content: message.content },
          },
        },
        ...(message.contentParts?.filter(part => part.type === 'image').map(image => ({ inlineData: { mimeType: image.mimeType, data: image.data } })) ?? []),
      ],
    }
  }

  return {
    role: 'user',
    parts: [
      ...(message.content ? [{ text: message.content }] : []),
      ...(message.contentParts?.filter(part => part.type === 'image').map(image => ({
        inlineData: { mimeType: image.mimeType, data: image.data },
      })) ?? []),
    ],
  }
}

function geminiReasoningParts(message: AgentMessage): GeminiPart[] | undefined {
  if (message.reasoning?.native?.format !== 'gemini-content-parts') return undefined
  if (!Array.isArray(message.reasoning.native.data)) return undefined
  const parts = message.reasoning.native.data.filter(isGeminiPart)
  return parts.length ? parts : undefined
}

function geminiReasoningDetails(parts: GeminiPart[]) {
  if (!parts.some(part => part.thought === true || typeof part.thoughtSignature === 'string')) return undefined
  return {
    format: 'gemini-content-parts' as const,
    data: parts,
  }
}

function toGeminiTool(tool: AgentToolDefinition): NonNullable<NonNullable<GeminiPayload['tools']>[number]['functionDeclarations']>[number] {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }
}

function normalizeUsage(usage: NonNullable<GeminiResponse['usageMetadata']>): ModelUsage {
  return {
    // Gemini promptTokenCount includes cache; thoughts are separate from candidates.
    // https://ai.google.dev/api/generate-content#UsageMetadata
    inputTokens: usage.promptTokenCount == null ? undefined : Math.max(0, usage.promptTokenCount - (usage.cachedContentTokenCount ?? 0)),
    outputTokens: usage.candidatesTokenCount == null ? undefined : usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0),
    totalTokens: usage.totalTokenCount,
    cacheReadTokens: usage.cachedContentTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
  }
}

function geminiUrl(config: ModelProviderConfig, model: string | undefined, stream: boolean): string {
  if (config.endpointPath) return `${(config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')}/${config.endpointPath}`
  const baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent'
  const separator = method.includes('?') ? '&' : '?'
  const key = config.apiKey ? `${separator}key=${encodeURIComponent(config.apiKey)}` : ''
  return `${baseUrl}/models/${encodeURIComponent(model ?? config.defaultModel)}:${method}${key}`
}

function hasTextPart(part: GeminiPart): part is GeminiPart & { text: string } {
  return 'text' in part && typeof part.text === 'string'
}

function hasFunctionCallPart(part: GeminiPart): part is { functionCall: { name: string; args: Record<string, unknown> } } {
  return 'functionCall' in part && isPlainRecord(part.functionCall) && typeof part.functionCall.name === 'string' && isPlainRecord(part.functionCall.args)
}

function isGeminiPart(value: unknown): value is GeminiPart {
  if (!isPlainRecord(value)) return false
  return typeof value.thoughtSignature === 'string' ||
    typeof value.text === 'string' ||
    (isPlainRecord(value.functionCall) && typeof value.functionCall.name === 'string' && isPlainRecord(value.functionCall.args)) ||
    (isPlainRecord(value.functionResponse) && typeof value.functionResponse.name === 'string' && isPlainRecord(value.functionResponse.response)) ||
    (isPlainRecord(value.inlineData) && typeof value.inlineData.mimeType === 'string' && typeof value.inlineData.data === 'string')
}
