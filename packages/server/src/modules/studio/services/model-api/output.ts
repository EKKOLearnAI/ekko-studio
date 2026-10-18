import { randomUUID } from 'node:crypto'
import type { AgentReasoning, ModelEvent, ModelResponse, ModelUsage } from '../../../../../../ekko-agent/src/model/types'
import type { ReasoningCodec } from './reasoning'

export interface ResponsesEvent { type: string; [key: string]: any }

export function responsesUsage(usage?: ModelUsage) {
  if (!usage || usage.inputTokens == null || usage.outputTokens == null) return null
  // Ekko's counters separate ordinary input from cache reads/writes.
  const input = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cacheReadTokens || 0 },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens || 0 },
    total_tokens: input + usage.outputTokens,
  }
}

/** The same state builds JSON and SSE output, keeping terminal output and usage identical. */
export class ResponsesOutput {
  readonly id = `resp_${randomUUID().replaceAll('-', '')}`
  readonly output: any[] = []
  usage?: ModelUsage
  private sequence = 0
  private message?: any
  private reasoning?: any
  private nativeCallIds = new Map<string, string>()
  private createdAt = Math.floor(Date.now() / 1000)

  constructor(readonly model: string, private readonly codec: ReasoningCodec, private readonly options: Record<string, any> = {}, private readonly scopeToolIds = false) {}

  event(type: string, data: Record<string, unknown> = {}): ResponsesEvent {
    return { type, sequence_number: this.sequence++, ...data }
  }

  response(status = 'in_progress', error: unknown = null, incompleteReason = 'max_output_tokens') {
    return {
      id: this.id, object: 'response', created_at: this.createdAt,
      completed_at: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
      model: this.model, status, error, output: structuredClone(this.output),
      incomplete_details: status === 'incomplete' ? { reason: incompleteReason } : null,
      usage: responsesUsage(this.usage), store: false, previous_response_id: null,
      parallel_tool_calls: true, tool_choice: this.options.tool_choice || 'auto', tools: this.options.tools || [],
      instructions: this.options.instructions ?? null, max_output_tokens: this.options.max_output_tokens ?? null,
      temperature: this.options.temperature ?? null, reasoning: this.options.reasoning ?? null,
      metadata: this.options.metadata || {}, text: { format: { type: 'text' } },
    }
  }

  private addItem(item: any, events: ResponsesEvent[]) {
    const index = this.output.push(item) - 1
    events.push(this.event('response.output_item.added', { output_index: index, item: structuredClone(item) }))
    return index
  }

  private appendText(text: string, events: ResponsesEvent[]) {
    if (!this.message) {
      this.message = { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
      const index = this.addItem(this.message, events)
      this.message.content.push({ type: 'output_text', text: '', annotations: [], logprobs: [] })
      events.push(this.event('response.content_part.added', { item_id: this.message.id, output_index: index, content_index: 0, part: structuredClone(this.message.content[0]) }))
    }
    this.message.content[0].text += text
    if (text) events.push(this.event('response.output_text.delta', { item_id: this.message.id, output_index: this.output.indexOf(this.message), content_index: 0, delta: text, logprobs: [] }))
  }

  private appendReasoning(text: string, events: ResponsesEvent[]) {
    if (!this.reasoning) {
      this.reasoning = { id: `rs_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', summary: [], status: 'in_progress' }
      const index = this.addItem(this.reasoning, events)
      this.reasoning.summary.push({ type: 'summary_text', text: '' })
      events.push(this.event('response.reasoning_summary_part.added', { item_id: this.reasoning.id, output_index: index, summary_index: 0, part: structuredClone(this.reasoning.summary[0]) }))
    }
    this.reasoning.summary[0].text += text
    if (text) events.push(this.event('response.reasoning_summary_text.delta', { item_id: this.reasoning.id, output_index: this.output.indexOf(this.reasoning), summary_index: 0, delta: text }))
  }

  consume(event: ModelEvent): ResponsesEvent[] {
    const events: ResponsesEvent[] = []
    if (event.type === 'text-delta') this.appendText(event.text, events)
    if (event.type === 'reasoning-delta') this.appendReasoning(event.text, events)
    if (event.type === 'usage') this.usage = event.usage
    if (event.type === 'tool-call') {
      const call = event.toolCall
      // Chat/Gemini providers can reuse ordinal IDs across turns. Keep native Responses IDs intact.
      const callId = this.scopeToolIds ? `call_${this.id.slice(5)}_${this.output.filter(item => item.type === 'function_call').length}` : call.id
      const existingCall = this.output.find(item => item.type === 'function_call' && this.nativeCallIds.get(item.call_id) === call.id)
      if (existingCall) return events
      if (this.output.some(item => item.type === 'function_call' && item.call_id === callId)) return events
      this.nativeCallIds.set(callId, call.id)
      const item = { id: `fc_${randomUUID().replaceAll('-', '')}`, type: 'function_call', call_id: callId, name: call.name, arguments: '', status: 'in_progress' }
      const index = this.addItem(item, events)
      item.arguments = call.rawArguments ?? JSON.stringify(call.arguments)
      events.push(this.event('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments }))
    }
    return events
  }

  finish(result: Partial<ModelResponse> = {}): ResponsesEvent[] {
    const events: ResponsesEvent[] = []
    if (result.usage) this.usage = result.usage
    const reasoning: AgentReasoning | undefined = typeof result.reasoning === 'string' ? { text: result.reasoning } : result.reasoning
    if (reasoning?.text && !this.reasoning) this.appendReasoning(reasoning.text, events)
    if (reasoning?.native && !this.reasoning) this.appendReasoning('', events)
    if (this.reasoning) {
      this.reasoning.encrypted_content = this.codec.encode({ ...reasoning, text: reasoning?.text || this.reasoning.summary[0].text })
    }
    if (!this.message && result.content) this.appendText(result.content, events)
    for (const call of result.toolCalls || []) events.push(...this.consume({ type: 'tool-call', toolCall: call }))
    if (!this.output.length) this.appendText('', events)
    for (const [index, item] of this.output.entries()) {
      const ids = { item_id: item.id, output_index: index }
      item.status = 'completed'
      if (item.type === 'message') {
        events.push(this.event('response.output_text.done', { ...ids, content_index: 0, text: item.content[0].text, logprobs: [] }))
        events.push(this.event('response.content_part.done', { ...ids, content_index: 0, part: item.content[0] }))
      } else if (item.type === 'reasoning') {
        events.push(this.event('response.reasoning_summary_text.done', { ...ids, summary_index: 0, text: item.summary[0].text }))
        events.push(this.event('response.reasoning_summary_part.done', { ...ids, summary_index: 0, part: item.summary[0] }))
      } else {
        events.push(this.event('response.function_call_arguments.done', { ...ids, arguments: item.arguments }))
      }
      events.push(this.event('response.output_item.done', { output_index: index, item }))
    }
    const reason = result.finishReason || ''
    const status = ['length', 'max_tokens', 'MAX_TOKENS', 'incomplete', 'content_filter', 'SAFETY'].includes(reason) ? 'incomplete'
      : ['failed', 'cancelled'].includes(reason) ? 'failed' : 'completed'
    const incompleteReason = ['content_filter', 'SAFETY'].includes(reason) || (result.raw as any)?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'max_output_tokens'
    events.push(this.event(`response.${status}`, { response: this.response(status,
      status === 'failed' ? { code: 'server_error', message: 'The model provider request failed.' } : null, incompleteReason) }))
    return events
  }
}
