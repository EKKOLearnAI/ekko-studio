import { randomUUID } from 'node:crypto'
import type { AgentToolCall, ModelEvent, ModelResponse, ModelUsage } from '../../../../../../ekko-agent/src/model/types'

export interface ChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details: { cached_tokens: number }
  completion_tokens_details: { reasoning_tokens: number }
}

export type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

export interface ChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: {
    index: number
    message: { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: unknown[] }
    finish_reason: ChatFinishReason
    logprobs: null
  }[]
  usage: ChatCompletionUsage | null
}

export interface ChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: { role?: 'assistant'; content?: string; reasoning_content?: string; tool_calls?: unknown[] }
    finish_reason: ChatFinishReason | null
    logprobs: null
  }[]
  usage?: ChatCompletionUsage | null
}

export function chatCompletionUsage(usage?: ModelUsage): ChatCompletionUsage | null {
  if (!usage || usage.inputTokens == null || usage.outputTokens == null) return null
  // Ekko keeps ordinary input separate from cache reads/writes; OpenAI reports the sum.
  const prompt = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens || 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens || 0 },
  }
}

export function chatFinishReason(reason: string | undefined, toolCalls: number): ChatFinishReason {
  if (['length', 'max_tokens', 'MAX_TOKENS', 'incomplete', 'max_output_tokens'].includes(reason || '')) return 'length'
  if (['content_filter', 'SAFETY'].includes(reason || '')) return 'content_filter'
  if (toolCalls > 0 || ['tool_calls', 'tool-call', 'function_call'].includes(reason || '')) return 'tool_calls'
  return 'stop'
}

function toolCallPayload(call: AgentToolCall, index: number) {
  return {
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.arguments) },
  }
}

/**
 * One accumulator feeds both the JSON body and the SSE deltas, so a streaming client
 * and a JSON client observe the same text, the same tool calls and the same usage.
 */
export class ChatCompletionOutput {
  readonly id = `chatcmpl-${randomUUID().replaceAll('-', '')}`
  readonly created = Math.floor(Date.now() / 1000)
  usage?: ModelUsage
  private content = ''
  private reasoning = ''
  private readonly calls: AgentToolCall[] = []
  private readonly seenCalls = new Set<string>()
  private roleSent = false

  constructor(readonly model: string) {}

  private chunk(delta: ChatCompletionChunk['choices'][number]['delta'], finish: ChatFinishReason | null = null): ChatCompletionChunk {
    return {
      id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    }
  }

  /** OpenAI clients expect a leading role delta before any content. */
  open(): ChatCompletionChunk {
    this.roleSent = true
    return this.chunk({ role: 'assistant', content: '' })
  }

  consume(event: ModelEvent): ChatCompletionChunk[] {
    if (event.type === 'usage') { this.usage = event.usage; return [] }
    if (event.type === 'text-delta') {
      this.content += event.text
      return event.text ? [this.chunk({ content: event.text })] : []
    }
    if (event.type === 'reasoning-delta') {
      this.reasoning += event.text
      return event.text ? [this.chunk({ reasoning_content: event.text })] : []
    }
    if (event.type === 'tool-call') {
      const call = event.toolCall
      // Chat providers can reuse ordinal IDs across turns; never emit one twice.
      if (this.seenCalls.has(call.id)) return []
      this.seenCalls.add(call.id)
      this.calls.push(call)
      return [this.chunk({ tool_calls: [toolCallPayload(call, this.calls.length - 1)] })]
    }
    return []
  }

  /** Apply the terminal response, then render the closing chunk and the JSON body. */
  finish(result: Partial<ModelResponse> = {}): { chunk: ChatCompletionChunk; body: ChatCompletion } {
    if (result.usage) this.usage = result.usage
    if (!this.content && result.content) this.content = result.content
    const reasoning = typeof result.reasoning === 'string' ? result.reasoning : result.reasoning?.text
    if (!this.reasoning && reasoning) this.reasoning = reasoning
    for (const call of result.toolCalls || []) {
      if (this.seenCalls.has(call.id)) continue
      this.seenCalls.add(call.id)
      this.calls.push(call)
    }
    const finishReason = chatFinishReason(result.finishReason, this.calls.length)
    const usage = chatCompletionUsage(this.usage)
    const body: ChatCompletion = {
      id: this.id, object: 'chat.completion', created: this.created, model: this.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: this.calls.length && !this.content ? null : this.content,
          ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
          ...(this.calls.length ? { tool_calls: this.calls.map(toolCallPayload) } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      }],
      usage,
    }
    return { chunk: this.chunk({}, finishReason), body }
  }

  /** OpenAI sends usage in a trailing zero-choice chunk when stream_options.include_usage is set. */
  usageChunk(): ChatCompletionChunk | undefined {
    const usage = chatCompletionUsage(this.usage)
    if (!usage) return undefined
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage }
  }

  get opened(): boolean { return this.roleSent }
}
