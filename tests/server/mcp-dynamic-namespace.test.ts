import { describe, expect, it } from 'vitest'
import { responseMcpToolRoutes, responsesToOpenAiChat, responsesToAnthropicMessages, openAiChatToResponses, anthropicMessageToResponses } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'
import { openAiChatSseToResponsesEvents, anthropicMessagesSseToResponsesEvents } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'
const fn = (name: string) => ({ type: 'function', name, parameters: { type: 'object', properties: {} } })
const ns = (name: string, tools: any[]) => ({ type: 'namespace', name, tools })
const body = { tools: [ns('mcp__nowledge_mem', [fn('memory_search')]), ns('mcp__other', [fn('memory_search')]), fn('memory_search')], input: [] }
const routes = responseMcpToolRoutes(body)
const alias = Object.keys(routes).find(key => routes[key].namespace === 'mcp__nowledge_mem')!
const target = { model: 'test', mcpToolRoutes: routes, annotateMcpToolNamespaces: true }
async function* bytes(text: string) { yield new TextEncoder().encode(text) }
async function collect(events: AsyncIterable<any>) { const result=[]; for await (const e of events) result.push(e); return result }

describe('request-local MCP namespace routing', () => {
  it('preserves two MCP tools with identical names alongside a native function', () => {
    const tools = responsesToOpenAiChat(body, target).tools
    expect(tools).toHaveLength(3)
    expect(new Set(tools.map((t: any) => t.function.name)).size).toBe(3)
    expect(tools.map((t: any) => t.function.name)).toContain('memory_search')
    for (const name of Object.keys(routes)) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(responsesToAnthropicMessages(body, target).tools).toHaveLength(3)
  })
  it('restores Chat and Anthropic non-stream calls without changing arguments', () => {
    const chat = openAiChatToResponses({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: alias, arguments: '{"query":"x"}' } }] } }] }, target)
    expect(chat.output[0]).toMatchObject({ name: 'memory_search', namespace: 'mcp__nowledge_mem', arguments: '{"query":"x"}' })
    const anth = anthropicMessageToResponses({ content: [{ type: 'tool_use', id: 'c', name: alias, input: { query: 'x' } }] }, target)
    expect(anth.output[0]).toMatchObject({ name: 'memory_search', namespace: 'mcp__nowledge_mem' })
  })
  it('does not leak a request mapping to another request', () => {
    expect(responseMcpToolRoutes({ tools: [], input: [] })).toEqual({})
    const chat = openAiChatToResponses({ choices: [{ message: { tool_calls: [{ function: { name: alias } }] } }] }, { model: 'test' })
    expect(chat.output[0].namespace).toBeUndefined()
  })
  it('includes deferred tool search output and re-encodes history consistently', () => {
    const b = { tools: [], input: [{ type: 'tool_search_output', tools: body.tools }, { type: 'function_call', namespace: 'mcp__nowledge_mem', name: 'memory_search', call_id: 'c', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: 'ok' }] }
    expect(responseMcpToolRoutes(b)).toEqual(routes)
    const messages = responsesToOpenAiChat(b, target).messages
    expect(messages.find((m: any) => m.tool_calls)?.tool_calls[0].function.name).toBe(alias)
    const am = responsesToAnthropicMessages(b, target).messages
    expect(am.some((m: any) => m.content?.some((c: any) => c.type === 'tool_use' && c.name === alias))).toBe(true)
  })
  it('restores streamed Chat calls from the first item through completion', async () => {
    const text = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: alias, arguments: '{"query":"x"}' } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
    const events = await collect(openAiChatSseToResponsesEvents(bytes(text), target))
    const items = events.filter(e => e.data.item?.type === 'function_call').map(e => e.data.item)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(item).toMatchObject({ name: 'memory_search', namespace: 'mcp__nowledge_mem' })
    expect(events.find(e => e.type === 'response.completed')?.data.response.output).toEqual(expect.arrayContaining([expect.objectContaining({ namespace: 'mcp__nowledge_mem' })]))
  })
  it('restores streamed Anthropic tool use', async () => {
    const frames = [ ['message_start', { message: { id: 'm', usage: {} } }], ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: alias, input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' } }], ['content_block_stop', { index: 0 }], ['message_delta', { delta: { stop_reason: 'tool_use' }, usage: {} }], ['message_stop', {}] ]
    const text = frames.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as any) })}\n\n`).join('')
    const events = await collect(anthropicMessagesSseToResponsesEvents(bytes(text), target))
    const items = events.filter(e => e.data.item?.type === 'function_call').map(e => e.data.item)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(item).toMatchObject({ name: 'memory_search', namespace: 'mcp__nowledge_mem' })
  })
})
