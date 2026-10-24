// Shared Responses stream translation for Coding Agent provider proxies.
import { readSseFrameTexts } from '../sse'
import { normalizeResponseFunctionCall, responseToolNamespaceForName } from './responses'

export interface ResponsesStreamAdapterTarget {
  model: string
  annotateMcpToolNamespaces?: boolean
}

export interface CanonicalResponsesEvent {
  type: string
  data: Record<string, unknown>
}

function normalizeResponseContentPart(part: unknown): unknown {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part
  const content = part as Record<string, unknown>
  // Grok's typed Responses decoder requires this array even without citations.
  if (content.type !== 'output_text' || content.annotations != null) return part
  return { ...content, annotations: [] }
}

function normalizeResponseOutputItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const output = item as Record<string, unknown>
  if (!Array.isArray(output.content)) return item
  return { ...output, content: output.content.map(normalizeResponseContentPart) }
}

/**
 * Fill wire fields required by strict Responses API clients such as Grok Build.
 * Some upstream OpenAI-compatible providers omit these fields, while clients
 * based on the typed Responses schema reject the entire SSE frame without them.
 */
export async function* normalizeResponsesSseEvents(
  events: AsyncIterable<CanonicalResponsesEvent>,
): AsyncGenerator<CanonicalResponsesEvent> {
  let nextSequenceNumber = 0
  const createdAtByResponseId = new Map<string, number>()

  for await (const event of events) {
    const currentSequenceNumber = Number(event.data.sequence_number)
    const sequenceNumber = Number.isSafeInteger(currentSequenceNumber) && currentSequenceNumber >= 0
      ? currentSequenceNumber
      : nextSequenceNumber
    nextSequenceNumber = Math.max(nextSequenceNumber, sequenceNumber + 1)

    const data = {
      ...event.data,
      sequence_number: sequenceNumber,
      ...(event.data.part ? { part: normalizeResponseContentPart(event.data.part) } : {}),
      ...(event.data.item ? { item: normalizeResponseOutputItem(event.data.item) } : {}),
    }
    const response = event.data.response
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      yield {
        ...event,
        data,
      }
      continue
    }

    const responseRecord = response as Record<string, unknown>
    const responseId = String(responseRecord.id || '')
    const currentCreatedAt = Number(responseRecord.created_at)
    const createdAt = Number.isSafeInteger(currentCreatedAt) && currentCreatedAt >= 0
      ? currentCreatedAt
      : createdAtByResponseId.get(responseId) ?? Math.floor(Date.now() / 1000)
    if (responseId) createdAtByResponseId.set(responseId, createdAt)

    yield {
      ...event,
      data: {
        ...data,
        response: {
          ...responseRecord,
          created_at: createdAt,
          ...(Array.isArray(responseRecord.output)
            ? { output: responseRecord.output.map(normalizeResponseOutputItem) }
            : {}),
        },
      },
    }
  }
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function functionCallItem(input: {
  id: string
  callId?: string
  name: string
  arguments: string
  annotateNamespace?: boolean
  status?: 'in_progress' | 'completed'
}) {
  if (input.name === 'tool_search') {
    return {
      type: 'tool_search_call',
      call_id: input.callId || input.id,
      status: input.status || 'completed',
      execution: 'client',
      arguments: safeJsonParse(input.arguments || '{}'),
    }
  }
  const normalized = input.annotateNamespace
    ? normalizeResponseFunctionCall(input.name, input.arguments)
    : { name: input.name, arguments: input.arguments, namespace: undefined }
  const namespace = input.annotateNamespace ? normalized.namespace || responseToolNamespaceForName(input.name) : undefined
  return {
    type: 'function_call',
    id: input.id,
    call_id: input.callId || input.id,
    name: normalized.name,
    arguments: normalized.arguments,
    status: input.status || 'completed',
    ...(namespace ? { namespace } : {}),
  }
}

function parseSseFrames(buffer: string): { events: string[]; rest: string } {
  const parsed = readSseFrameTexts(buffer)
  return { events: parsed.frames, rest: parsed.rest }
}

function extractSseData(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
}

function extractSseEventName(event: string): string {
  return event
    .split(/\r?\n/)
    .find(line => line.startsWith('event:'))
    ?.slice(6)
    .trim() || ''
}

function openAiChatUsageToResponsesUsage(usage: Record<string, any>): Record<string, unknown> {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0)
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  const promptDetails = usage.prompt_tokens_details || usage.input_tokens_details
  const completionDetails = usage.completion_tokens_details || usage.output_tokens_details
  return {
    ...usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number(usage.total_tokens ?? inputTokens + outputTokens),
    ...(promptDetails ? { input_tokens_details: promptDetails } : {}),
    ...(completionDetails ? { output_tokens_details: completionDetails } : {}),
  }
}

function openAiChatReasoningDetailsText(details: unknown): string {
  const entries = Array.isArray(details) ? details : [details]
  return entries.map((entry) => {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object' && typeof (entry as any).text === 'string') {
      return (entry as any).text
    }
    return ''
  }).join('')
}

function openAiChatReasoningDelta(delta: any, accumulated: string): string {
  // OpenAI-compatible providers do not agree on one reasoning field. Prefer
  // normal deltas, then normalize split/cumulative reasoning details without
  // tying the proxy to a provider name or model family.
  for (const field of ['reasoning_content', 'reasoning', 'reasoning_text']) {
    if (typeof delta?.[field] === 'string' && delta[field]) return delta[field]
  }

  const detailsText = openAiChatReasoningDetailsText(delta?.reasoning_details)
  if (detailsText.startsWith(accumulated)) return detailsText.slice(accumulated.length)
  if (detailsText && !accumulated.endsWith(detailsText)) return detailsText
  return ''
}

export async function* openAiChatSseToResponsesEvents(
  stream: AsyncIterable<Uint8Array>,
  target: ResponsesStreamAdapterTarget,
): AsyncGenerator<CanonicalResponsesEvent> {
  const decoder = new TextDecoder()
  const id = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const messageId = `msg_${id}`
  const reasoningId = `rs_${id}`
  let buffer = ''
  let nextOutputIndex = 0
  let reasoningStarted = false
  let reasoningOutputIndex = -1
  let textStarted = false
  let textOutputIndex = -1
  let text = ''
  let reasoning = ''
  let usage: Record<string, unknown> | undefined
  const toolCalls = new Map<number, { id: string; name: string; arguments: string; added: boolean; outputIndex: number }>()

  yield {
    type: 'response.created',
    data: {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', model: target.model, output: [] },
    },
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
    buffer = parsed.rest

    for (const event of parsed.events) {
      for (const dataLine of extractSseData(event)) {
        if (!dataLine || dataLine === '[DONE]') continue
        const data = safeJsonParse(dataLine)
        if (data?.usage && typeof data.usage === 'object') {
          usage = { ...(usage || {}), ...data.usage }
        }
        const choice = data?.choices?.[0]
        if (!choice) continue

        const delta = choice.delta || {}
        const reasoningDelta = openAiChatReasoningDelta(delta, reasoning)
        if (reasoningDelta) {
          if (!reasoningStarted) {
            reasoningStarted = true
            reasoningOutputIndex = nextOutputIndex
            nextOutputIndex += 1
            yield {
              type: 'response.output_item.added',
              data: {
                type: 'response.output_item.added',
                output_index: reasoningOutputIndex,
                item: {
                  type: 'reasoning',
                  id: reasoningId,
                  summary: [],
                },
              },
            }
          }
          reasoning += reasoningDelta
          yield {
            type: 'response.reasoning_summary_text.delta',
            data: {
              type: 'response.reasoning_summary_text.delta',
              item_id: reasoningId,
              output_index: reasoningOutputIndex,
              summary_index: 0,
              delta: reasoningDelta,
            },
          }
        }

        if (typeof delta.content === 'string' && delta.content) {
          if (!textStarted) {
            textStarted = true
            textOutputIndex = nextOutputIndex
            nextOutputIndex += 1
            yield {
              type: 'response.output_item.added',
              data: {
                type: 'response.output_item.added',
                output_index: textOutputIndex,
                item: {
                  type: 'message',
                  id: messageId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: [],
                },
              },
            }
            yield {
              type: 'response.content_part.added',
              data: {
                type: 'response.content_part.added',
                item_id: messageId,
                output_index: textOutputIndex,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              },
            }
          }
          text += delta.content
          yield {
            type: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: textOutputIndex,
              content_index: 0,
              delta: delta.content,
            },
          }
        }

        for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const index = Number(toolCall.index || 0)
          let call = toolCalls.get(index)
          if (!call) {
            call = {
              id: String(toolCall.id || `call_${index}`),
              name: String(toolCall.function?.name || 'tool'),
              arguments: '',
              added: false,
              outputIndex: nextOutputIndex,
            }
            nextOutputIndex += 1
            toolCalls.set(index, call)
          }
          if (toolCall.id) call.id = String(toolCall.id)
          if (toolCall.function?.name) call.name = String(toolCall.function.name)
          if (!call.added && call.name) {
            call.added = true
            yield {
              type: 'response.output_item.added',
              data: {
                type: 'response.output_item.added',
                output_index: call.outputIndex,
                item: functionCallItem({ id: call.id, name: call.name, arguments: '', annotateNamespace: target.annotateMcpToolNamespaces, status: 'in_progress' }),
              },
            }
          }
          const argsDelta = toolCall.function?.arguments
          if (typeof argsDelta === 'string' && argsDelta) {
            call.arguments += argsDelta
            if (call.name !== 'tool_search') {
              yield {
                type: 'response.function_call_arguments.delta',
                data: {
                  type: 'response.function_call_arguments.delta',
                  item_id: call.id,
                  output_index: call.outputIndex,
                  delta: argsDelta,
                },
              }
            }
          }
        }
      }
    }
  }

  const indexedOutput: Array<{ outputIndex: number; item: any }> = []
  if (reasoningStarted) {
    const reasoningItem = {
      type: 'reasoning',
      id: reasoningId,
      summary: [{ type: 'summary_text', text: reasoning }],
    }
    indexedOutput.push({ outputIndex: reasoningOutputIndex, item: reasoningItem })
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: reasoningOutputIndex,
        item: reasoningItem,
      },
    }
  }
  if (textStarted) {
    const messageItem = {
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    indexedOutput.push({ outputIndex: textOutputIndex, item: messageItem })
    yield {
      type: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        item_id: messageId,
        output_index: textOutputIndex,
        content_index: 0,
        text,
      },
    }
    yield {
      type: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: textOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
    }
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: textOutputIndex,
        item: messageItem,
      },
    }
  }

  for (const call of toolCalls.values()) {
    const callItem = functionCallItem({ id: call.id, name: call.name, arguments: call.arguments || '{}', annotateNamespace: target.annotateMcpToolNamespaces })
    indexedOutput.push({ outputIndex: call.outputIndex, item: callItem })
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: call.outputIndex,
        item: callItem,
      },
    }
  }
  const output = indexedOutput
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .map(entry => entry.item)
  yield {
    type: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        status: 'completed',
        model: target.model,
        output,
        ...(usage ? { usage: openAiChatUsageToResponsesUsage(usage) } : {}),
      },
    },
  }
}

export async function* openAiResponsesSseToResponsesEvents(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<CanonicalResponsesEvent> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
    buffer = parsed.rest

    for (const event of parsed.events) {
      const eventName = extractSseEventName(event)
      for (const dataLine of extractSseData(event)) {
        if (!dataLine || dataLine === '[DONE]') continue
        const data = safeJsonParse(dataLine)
        const type = String(data?.type || eventName || data?.event || '').trim()
        if (!type) continue
        if (!data.type) data.type = type
        yield { type, data }
      }
    }
  }
}

export async function* anthropicMessagesSseToResponsesEvents(
  stream: AsyncIterable<Uint8Array>,
  target: ResponsesStreamAdapterTarget,
): AsyncGenerator<CanonicalResponsesEvent> {
  const decoder = new TextDecoder()
  let id = `resp_${Date.now()}`
  let messageId = `msg_${id}`
  let buffer = ''
  let nextOutputIndex = 0
  let reasoningStarted = false
  let reasoningId = ''
  let reasoningOutputIndex = -1
  let textStarted = false
  let textOutputIndex = -1
  let text = ''
  let reasoning = ''
  let usage: Record<string, unknown> | undefined
  const toolBlocks = new Map<number, { id: string; name: string; arguments: string; added: boolean; outputIndex: number }>()

  yield {
    type: 'response.created',
    data: {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', model: target.model, output: [] },
    },
  }

  const ensureReasoning = function* (): Generator<CanonicalResponsesEvent> {
    if (!reasoningStarted) {
      reasoningStarted = true
      reasoningId = `rs_${id}`
      reasoningOutputIndex = nextOutputIndex
      nextOutputIndex += 1
      yield {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: reasoningOutputIndex,
          item: { type: 'reasoning', id: reasoningId, summary: [] },
        },
      }
    }
  }

  const ensureText = function* (): Generator<CanonicalResponsesEvent> {
    if (!textStarted) {
      textStarted = true
      textOutputIndex = nextOutputIndex
      nextOutputIndex += 1
      yield {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: textOutputIndex,
          item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
        },
      }
      yield {
        type: 'response.content_part.added',
        data: {
          type: 'response.content_part.added',
          item_id: messageId,
          output_index: textOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
      }
    }
  }

  const ensureTool = function* (index: number, idValue?: string, name?: string): Generator<CanonicalResponsesEvent, { id: string; name: string; arguments: string; added: boolean; outputIndex: number }> {
    let block = toolBlocks.get(index)
    if (!block) {
      block = {
        id: idValue || `toolu_${index}`,
        name: name || 'tool',
        arguments: '',
        added: false,
        outputIndex: nextOutputIndex,
      }
      nextOutputIndex += 1
      toolBlocks.set(index, block)
    }
    if (idValue) block.id = idValue
    if (name) block.name = name
    if (!block.added) {
      block.added = true
      yield {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: block.outputIndex,
          item: functionCallItem({ id: block.id, name: block.name, arguments: '', annotateNamespace: target.annotateMcpToolNamespaces, status: 'in_progress' }),
        },
      }
    }
    return block
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
    buffer = parsed.rest

    for (const event of parsed.events) {
      const eventName = extractSseEventName(event)
      for (const dataLine of extractSseData(event)) {
        if (!dataLine || dataLine === '[DONE]') continue
        const data = safeJsonParse(dataLine)

        if (eventName === 'message_start' || data?.type === 'message_start') {
          id = String(data?.message?.id || id)
          messageId = `msg_${id}`
          if (data?.message?.usage && typeof data.message.usage === 'object') {
            usage = { ...(usage || {}), ...data.message.usage }
          }
        }

        if (eventName === 'message_delta' || data?.type === 'message_delta') {
          if (data?.usage && typeof data.usage === 'object') {
            usage = { ...(usage || {}), ...data.usage }
          }
        }

        if (eventName === 'content_block_start' || data?.type === 'content_block_start') {
          const contentBlock = data?.content_block || {}
          if (contentBlock.type === 'tool_use') {
            yield* ensureTool(Number(data.index || 0), String(contentBlock.id || ''), String(contentBlock.name || 'tool'))
          }
        }

        if (eventName === 'content_block_delta' || data?.type === 'content_block_delta') {
          const delta = data?.delta || {}
          if (delta.type === 'thinking_delta' && delta.thinking) {
            const textDelta = String(delta.thinking)
            yield* ensureReasoning()
            reasoning += textDelta
            yield {
              type: 'response.reasoning_summary_text.delta',
              data: {
                type: 'response.reasoning_summary_text.delta',
                item_id: reasoningId,
                output_index: reasoningOutputIndex,
                summary_index: 0,
                delta: textDelta,
              },
            }
          }
          if (delta.type === 'text_delta' && delta.text) {
            yield* ensureText()
            text += String(delta.text)
            yield {
              type: 'response.output_text.delta',
              data: {
                type: 'response.output_text.delta',
                item_id: messageId,
                output_index: textOutputIndex,
                content_index: 0,
                delta: String(delta.text),
              },
            }
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            const index = Number(data.index || 0)
            const block = yield* ensureTool(index)
            const argsDelta = String(delta.partial_json)
            block.arguments += argsDelta
            if (block.name !== 'tool_search') {
              yield {
                type: 'response.function_call_arguments.delta',
                data: {
                  type: 'response.function_call_arguments.delta',
                  item_id: block.id,
                  output_index: block.outputIndex,
                  delta: argsDelta,
                },
              }
            }
          }
        }
      }
    }
  }

  const indexedOutput: Array<{ outputIndex: number; item: any }> = []
  if (reasoningStarted) {
    const reasoningItem = {
      type: 'reasoning',
      id: reasoningId,
      summary: [{ type: 'summary_text', text: reasoning }],
    }
    indexedOutput.push({ outputIndex: reasoningOutputIndex, item: reasoningItem })
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: reasoningOutputIndex,
        item: reasoningItem,
      },
    }
  }
  if (textStarted) {
    const messageItem = {
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    indexedOutput.push({ outputIndex: textOutputIndex, item: messageItem })
    yield {
      type: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        item_id: messageId,
        output_index: textOutputIndex,
        content_index: 0,
        text,
      },
    }
    yield {
      type: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: textOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
    }
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: textOutputIndex,
        item: messageItem,
      },
    }
  }
  for (const block of toolBlocks.values()) {
    const item = functionCallItem({ id: block.id, name: block.name, arguments: block.arguments || '{}', annotateNamespace: target.annotateMcpToolNamespaces })
    indexedOutput.push({ outputIndex: block.outputIndex, item })
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: block.outputIndex,
        item,
      },
    }
  }
  const output = indexedOutput
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .map(entry => entry.item)
  yield {
    type: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        status: 'completed',
        model: target.model,
        output,
        ...(usage ? { usage } : {}),
      },
    },
  }
}
