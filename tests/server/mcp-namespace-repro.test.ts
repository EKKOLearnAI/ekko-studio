import { describe, expect, it } from 'vitest'
import * as adapter from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'

// This test deliberately uses only the old public request/response adapters.
// It can run unchanged on the broken parent revision to prove the regression.
describe('MCP short-name namespace loss reproduction', () => {
  it.each(['mcp__nowledge_mem', 'mcp__ekko_studio_interaction'])('round-trips a discovered tool in %s', namespace => {
    const name = namespace === 'mcp__nowledge_mem' ? 'memory_search' : 'ekko_studio_list_session_tasks'
    const body = {
      tools: [],
      input: [{ type: 'tool_search_output', tools: [{
        type: 'namespace', name: namespace,
        tools: [{ type: 'function', name, parameters: { type: 'object', properties: {} } }],
      }] }],
    }
    // The fixed proxy supplies a request-local routing table. Older revisions
    // have no routing-table builder, and exercise their original behavior.
    const builder = (adapter as unknown as Record<string, any>).responseMcpToolRoutes
    const target = { model: 'test', ...(builder ? { mcpToolRoutes: builder(body) } : {}) }
    const outbound = adapter.responsesToOpenAiChat(body, target)
    const providerName = outbound.tools[0].function.name
    const response = adapter.openAiChatToResponses({ choices: [{ message: { tool_calls: [{
      id: 'call_repro', type: 'function', function: { name: providerName, arguments: '{"query":"api2tokens"}' },
    }] } }] }, target)
    expect(response.output[0]).toMatchObject({
      type: 'function_call', name, namespace, arguments: '{"query":"api2tokens"}',
    })
  })
})
