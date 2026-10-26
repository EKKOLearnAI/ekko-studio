import { afterEach, describe, expect, it, vi } from 'vitest'
import { codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: { handleProxyUsageEvent: vi.fn(), handleResponseEvent: vi.fn() },
}))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('Codex proxy MCP namespace round-trip', () => {
  for (const apiMode of ['chat_completions', 'anthropic_messages'] as const) {
    it.each([false, true])(`${apiMode} restores deferred MCP namespace, stream=%s`, async stream => {
      const namespace = 'mcp__nowledge_mem'
      const name = 'memory_search'
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        const sent = JSON.parse(String(options?.body))
        const toolName = apiMode === 'chat_completions' ? sent.tools[0].function.name : sent.tools[0].name
        expect(toolName).not.toBe(name)
        if (!stream) return Response.json(apiMode === 'chat_completions'
          ? { choices: [{ message: { tool_calls: [{ id: 'c', function: { name: toolName, arguments: '{"query":"api2tokens"}' } }] } }] }
          : { content: [{ type: 'tool_use', id: 'c', name: toolName, input: { query: 'api2tokens' } }] })
        const text = apiMode === 'chat_completions'
          ? `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: toolName, arguments: '{"query":"api2tokens"}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`
          : [ ['message_start', { message: { id: 'm', usage: {} } }], ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'c', name: toolName, input: {} } }], ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"api2tokens"}' } }], ['content_block_stop', { index: 0 }], ['message_stop', {}] ].map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`).join('')
        return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } })
      }))
      const target = registerCodexProxyTarget({ profile: 'test', provider: 'test', model: 'test', apiMode, apiKey: 'test', baseUrl: 'https://provider.test/v1', agentSessionId: 'mcp-test' })
      const ctx: any = {
        params: { key: target.routeKey },
        request: { body: { stream, tools: [], input: [{ type: 'tool_search_output', tools: [{ type: 'namespace', name: namespace, tools: [{ type: 'function', name, parameters: { type: 'object', properties: {} } }] }] }] } },
        get: (key: string) => key === 'authorization' ? `Bearer ${target.token}` : '', set: vi.fn(),
      }
      await codexProxyResponses(ctx)
      expect(ctx.status).toBeUndefined()
      let response = ctx.body
      if (stream) {
        let text = ''
        for await (const chunk of ctx.body) text += chunk.toString()
        const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
        response = events.find(event => event.type === 'response.completed').response
      }
      expect(response.output).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'function_call', name, namespace, arguments: '{"query":"api2tokens"}' })]))
    })
  }
})
