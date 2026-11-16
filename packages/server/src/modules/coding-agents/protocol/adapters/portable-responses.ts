import type { CanonicalResponsesEvent } from './responses-stream'
import { normalizeResponseFunctionCall, responseFunctionTools, responseMcpToolRoutes } from './responses'

function customTools(body: any): Map<string, any> {
  return new Map((body?.tools || []).filter((tool: any) => tool.type === 'custom').map((tool: any) => [tool.name, tool]))
}

/** Public Responses Providers may support JSON functions but no free-form tools. */
export function portableResponsesRequest(body: any): any {
  const custom = [...customTools(body).values()].map((tool: any) => ({
    type: 'function', name: tool.name,
    description: [tool.description, 'Pass the complete tool input as the input string.', tool.format?.definition].filter(Boolean).join('\n'),
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
  }))
  // Tool search remains client-executed, represented as an ordinary function;
  // never turn it into a server-side search with different permissions.
  const tools = [...responseFunctionTools(body), ...custom]
  const input = Array.isArray(body?.input) ? body.input.map((item: any) => {
    if (item.type === 'custom_tool_call') {
      const { input: text, ...rest } = item
      return { ...rest, type: 'function_call', arguments: JSON.stringify({ input: text }) }
    }
    if (item.type === 'tool_search_call') return { type: 'function_call', call_id: item.call_id, name: 'tool_search', arguments: JSON.stringify(item.arguments || {}) }
    if (item.type === 'tool_search_output') return { type: 'function_call_output', call_id: item.call_id, output: 'Deferred tools loaded: ' + JSON.stringify(item.tools || []) }
    if (item.type === 'custom_tool_call_output') return { ...item, type: 'function_call_output' }
    return item
  }) : body?.input
  return { ...body, ...(body?.tools ? { tools } : {}), input,
    ...(body?.tool_choice?.type === 'custom' ? { tool_choice: { ...body.tool_choice, type: 'function' } } : {}) }
}

function restoredItem(item: any, body: any): any {
  if (item?.type !== 'function_call') return item
  const { arguments: args, ...rest } = item
  const tool = customTools(body).get(item.name)
  if (tool) {
    const parsed = args ? JSON.parse(args) : { input: '' }
    if (typeof parsed.input !== 'string') throw new Error('Provider returned invalid free-form tool input')
    return { ...rest, ...(tool.namespace ? { namespace: tool.namespace } : {}), type: 'custom_tool_call', input: parsed.input }
  }
  if (item.name === 'tool_search') return { type: 'tool_search_call', call_id: item.call_id || item.id, status: item.status || 'completed', execution: 'client', arguments: args ? JSON.parse(args) : {} }
  return { ...item, ...normalizeResponseFunctionCall(item.name, args, responseMcpToolRoutes(body)) }
}

export function portableResponsesResult(response: any, body: any): any {
  if (!Array.isArray(response?.output)) return response
  return { ...response, output: response.output.map((item: any) => restoredItem(item, body)) }
}

/** Restore client-side custom/search calls and MCP namespaces for native CLIs. */
export async function* portableResponsesEvents(events: AsyncIterable<CanonicalResponsesEvent>, body: any): AsyncGenerator<CanonicalResponsesEvent> {
  const names = customTools(body)
  const calls = new Set<string>()
  for await (const event of events) {
    const { sequence_number: _sequence, ...data } = event.data as any
    const item = data.item
    if (item?.type === 'function_call') {
      const special = names.has(item.name) || item.name === 'tool_search'
      if (special) calls.add(item.id)
      if (event.type === 'response.output_item.done') {
        const restored = restoredItem(item, body)
        if (restored.type === 'custom_tool_call') {
          yield { type: 'response.custom_tool_call_input.delta', data: { type: 'response.custom_tool_call_input.delta', item_id: item.id, output_index: data.output_index, delta: restored.input } }
          yield { type: 'response.custom_tool_call_input.done', data: { type: 'response.custom_tool_call_input.done', item_id: item.id, output_index: data.output_index, input: restored.input } }
        }
        yield { type: event.type, data: { ...data, item: restored } }
      } else yield { type: event.type, data: { ...data, item: restoredItem({ ...item, arguments: '' }, body) } }
      continue
    }
    if (calls.has(data.item_id) && event.type.startsWith('response.function_call_arguments.')) continue
    yield { type: event.type, data: { ...data, ...(data.response ? { response: portableResponsesResult(data.response, body) } : {}) } }
  }
}
