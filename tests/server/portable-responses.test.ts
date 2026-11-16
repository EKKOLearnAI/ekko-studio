import { expect, it } from 'vitest'
import { portableResponsesRequest, portableResponsesResult, portableResponsesEvents } from '../../packages/server/src/modules/coding-agents/protocol/adapters/portable-responses'

const body = { input: [{ type: 'custom_tool_call', id: 'c', call_id: 'call', name: 'apply_patch', input: 'patch text' }, { type: 'custom_tool_call_output', call_id: 'call', output: 'done' }], tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }, { type: 'function', name: 'read', parameters: {} }] }
it('converts free-form tool definitions and continuations to portable JSON functions', () => {
  const request = portableResponsesRequest(body)
  expect(request.tools.find((tool: any) => tool.name === 'apply_patch')).toMatchObject({ type: 'function', name: 'apply_patch', parameters: { required: ['input'] } })
  expect(request.tools.find((tool: any) => tool.name === 'read')).toMatchObject(body.tools[1])
  expect(request.input[0]).toMatchObject({ type: 'function_call', arguments: '{"input":"patch text"}' })
  expect(request.input[1]).toMatchObject({ type: 'function_call_output', output: 'done' })
  expect(portableResponsesResult({ output: [{ id: 'c', call_id: 'call', type: 'function_call', name: 'apply_patch', arguments: '{"input":"patch text"}' }] }, body).output[0]).toEqual(body.input[0])
})
it('restores a streamed custom call without exposing JSON fragments as free-form input', async () => {
  async function* upstream() {
    yield { type: 'response.output_item.added', data: { item: { type: 'function_call', id: 'c', call_id: 'call', name: 'apply_patch', arguments: '' }, output_index: 0 } }
    yield { type: 'response.function_call_arguments.delta', data: { item_id: 'c', delta: '{"input":"patch text"}' } }
    yield { type: 'response.output_item.done', data: { item: { type: 'function_call', id: 'c', call_id: 'call', name: 'apply_patch', arguments: '{"input":"patch text"}' }, output_index: 0 } }
  }
  const events = []
  for await (const event of portableResponsesEvents(upstream(), body)) events.push(event)
  expect(events.map(e => e.type)).toEqual(['response.output_item.added', 'response.custom_tool_call_input.delta', 'response.custom_tool_call_input.done', 'response.output_item.done'])
  expect(events[1].data.delta).toBe('patch text')
  expect(events[3].data.item).toEqual(body.input[0])
})

it('keeps tool search client-side while converting its definition and continuation to functions', () => {
  const search = { tools: [{ type: 'tool_search', execution: 'client', parameters: { type: 'object', properties: { query: { type: 'string' } } } }], input: [{ type: 'tool_search_call', call_id: 's1', arguments: { query: 'health' } }, { type: 'tool_search_output', call_id: 's1', tools: [] }] }
  const request = portableResponsesRequest(search)
  expect(request.tools[0]).toMatchObject({ type: 'function', name: 'tool_search' })
  expect(request.tools[0].execution).toBeUndefined()
  expect(request.input[0]).toMatchObject({ type: 'function_call', name: 'tool_search', arguments: '{"query":"health"}' })
  expect(request.input[1].type).toBe('function_call_output')
  expect(portableResponsesResult({ output: [{ type: 'function_call', name: 'tool_search', call_id: 's1', arguments: '{"query":"health"}' }] }, search).output[0]).toMatchObject({ type: 'tool_search_call', execution: 'client', arguments: { query: 'health' } })
})
