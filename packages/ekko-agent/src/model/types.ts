export type ModelRequestStyle =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-contents'
  | 'prompt-completion'
  | 'custom-runtime'

export type ModelProviderType =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'custom'

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type AgentReasoningFormat =
  | 'openai-reasoning-details'
  | 'openai-responses-items'
  | 'anthropic-thinking-blocks'
  | 'gemini-content-parts'

export interface AgentReasoningNative {
  format: AgentReasoningFormat
  data: unknown
}

export interface AgentReasoning {
  text?: string
  native?: AgentReasoningNative
  estimatedTokens?: number
}

export interface AgentMessage {
  role: AgentMessageRole
  content: string
  contentParts?: AgentMessageContentPart[]
  reasoning?: AgentReasoning
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
}

export type AgentMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface AgentToolDefinition {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

export interface ModelUsage {
  /** Provider-reported USD cost, when supplied. Missing is not free. */
  costUsd?: number
  costSource?: 'reported' | 'estimated'
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type ModelReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type ModelReasoningSummary = 'auto' | 'concise' | 'detailed'

export type OpenAIChatReasoningReplayFormat =
  | 'reasoning'
  | 'reasoning_content'
  | 'reasoning_details'
  | 'none'

export interface ModelRequest {
  model?: string
  messages: AgentMessage[]
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  reasoningEffort?: ModelReasoningEffort
  reasoningSummary?: ModelReasoningSummary
  tools?: AgentToolDefinition[]
  toolChoice?: 'auto' | 'none' | 'required'
  stream?: boolean
  metadata?: Record<string, unknown>
  context?: unknown
}

export interface ModelResponse {
  id?: string
  model?: string
  content: string
  reasoning?: string | AgentReasoning
  toolCalls?: AgentToolCall[]
  usage?: ModelUsage
  finishReason?: string
  context?: unknown
  raw?: unknown
}

export type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call'; toolCall: AgentToolCall }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done'; response?: Partial<ModelResponse> }
  | { type: 'error'; error: string }

export interface ModelCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  jsonMode: boolean
  systemPrompt: boolean
  maxInputTokens?: number
}

export interface ModelProviderConfig {
  id: string
  type: ModelProviderType
  /** Persisted/public API mode name; requestStyle is its adapter-level form. */
  apiMode?: import('./provider-presets').EkkoModelApiMode
  requestStyle?: ModelRequestStyle
  /**
   * Provider-specific assistant reasoning field used only by the OpenAI Chat
   * Completions adapter. Other request styles use their native replay shape.
   */
  openAIChatReasoningReplayFormat?: OpenAIChatReasoningReplayFormat
  apiKey?: string
  baseUrl?: string
  endpointPath?: string
  defaultModel: string
  headers?: Record<string, string>
  timeoutMs?: number
  capabilities?: Partial<ModelCapabilities>
}

export interface ModelClient {
  provider: string
  requestStyle: ModelRequestStyle
  capabilities: ModelCapabilities
  /** Resolve the credential-free request target used for diagnostics. */
  requestTarget?(request: ModelRequest): string
  create(request: ModelRequest): Promise<ModelResponse>
  stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface ModelClientOptions {
  fetch?: FetchLike
}
