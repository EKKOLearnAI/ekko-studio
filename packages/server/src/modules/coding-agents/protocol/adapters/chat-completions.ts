import type { CanonicalResponsesEvent } from './responses-stream'

/** Chat Completions clients use the same provider gateway as Responses clients. */
export function chatCompletionsToResponses(body: any): any {
  const input: any[] = []
  for (const message of body.messages || []) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) })
      continue
    }
    if (message.content != null) {
      const content = Array.isArray(message.content) ? message.content.map((part: any) => {
        if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
        if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url, detail: part.image_url?.detail }
        throw Object.assign(new Error(`Unsupported Chat Completions content: ${part.type}`), { status: 400 })
      }) : message.content
      input.push({ role: message.role, content })
    }
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', call_id: call.id,
      name: call.function?.name, arguments: call.function?.arguments || '{}' })
  }
  const tools = (body.tools || []).map((tool: any) => {
    if (tool.type !== 'function') throw Object.assign(new Error(`Unsupported Chat Completions tool: ${tool.type}`), { status: 400 })
    return { type: 'function', ...tool.function }
  })
  const toolChoice = body.tool_choice?.type === 'function'
    ? { type: 'function', name: body.tool_choice.function?.name } : body.tool_choice
  return { input, tools, stream: body.stream === true,
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(body.parallel_tool_calls != null ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
    ...(body.top_p != null ? { top_p: body.top_p } : {}),
    ...((body.max_completion_tokens ?? body.max_tokens) != null
      ? { max_output_tokens: body.max_completion_tokens ?? body.max_tokens } : {}) }
}

function chatUsage(usage: any) {
  return { prompt_tokens: usage?.input_tokens || 0, completion_tokens: usage?.output_tokens || 0,
    total_tokens: usage?.total_tokens ?? ((usage?.input_tokens || 0) + (usage?.output_tokens || 0)),
    ...(usage?.input_tokens_details ? { prompt_tokens_details: usage.input_tokens_details } : {}),
    ...(usage?.output_tokens_details ? { completion_tokens_details: usage.output_tokens_details } : {}) }
}

export function responsesToChatCompletion(response: any, model: string): any {
  if (response.error || response.status === 'failed') {
    throw Object.assign(new Error(response.error?.message || 'Provider response failed'), { status: 502 })
  }
  const calls: any[] = []
  let text = ''
  for (const item of response.output || []) {
    if (item.type === 'message') text += (item.content || []).map((part: any) => part.text || '').join('')
    if (item.type === 'function_call') calls.push({ id: item.call_id || item.id, type: 'function',
      function: { name: item.name, arguments: item.arguments || '{}' } })
  }
  return { id: response.id, object: 'chat.completion', created: response.created_at || Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content: text || null,
      ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: response.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop' }],
    usage: chatUsage(response.usage) }
}

export async function* responsesToChatCompletionSse(events: AsyncIterable<CanonicalResponsesEvent>, model: string, includeUsage: boolean) {
  let id = 'chatcmpl-scoped'
  const created = Math.floor(Date.now() / 1000)
  const calls = new Map<string, number>()
  let completed = false
  const chunk = (delta: any, finishReason: string | null = null) => `data: ${JSON.stringify({ id,
    object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`
  for await (const event of events) {
    const data = event.data as any
    if (event.type === 'response.created') {
      id = data.response?.id || id
      yield chunk({ role: 'assistant', content: '' })
    } else if (event.type === 'response.output_text.delta') yield chunk({ content: data.delta })
    else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
      yield chunk({ reasoning_content: data.delta })
    } else if (event.type === 'response.output_item.added' && data.item?.type === 'function_call') {
      const item = data.item
      const index = calls.size
      calls.set(item.id, index)
      yield chunk({ tool_calls: [{ index, id: item.call_id || item.id, type: 'function',
        function: { name: item.name, arguments: item.arguments || '' } }] })
    } else if (event.type === 'response.function_call_arguments.delta') {
      const index = calls.get(data.item_id)
      if (index == null) throw new Error('Provider streamed tool arguments without a function call')
      yield chunk({ tool_calls: [{ index, function: { arguments: data.delta } }] })
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      completed = true
      const response = data.response || {}
      if (response.error || response.status === 'failed') throw new Error(response.error?.message || 'Provider response failed')
      yield chunk({}, response.status === 'incomplete' || event.type === 'response.incomplete' ? 'length' : calls.size ? 'tool_calls' : 'stop')
      if (includeUsage) yield `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
        choices: [], usage: chatUsage(response.usage) })}\n\n`
    } else if (event.type === 'response.failed' || event.type === 'error') throw new Error(data.error?.message || 'Provider stream failed')
  }
  if (!completed) throw new Error('Provider stream ended without a final response')
  yield 'data: [DONE]\n\n'
}
