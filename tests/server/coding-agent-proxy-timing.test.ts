import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeProxyMessages, registerClaudeCodeProxyTarget } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'
import { codexProxyResponses, registerCodexProxyTarget } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: { handleProxyUsageEvent: vi.fn(), handleResponseEvent: vi.fn() },
}))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks() })

const usage = { input_tokens: 110, output_tokens: 20 }
function providerBody(mode: string, stream: boolean): string {
  const anthropic = { id: 'msg', type: 'message', model: 'model', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage }
  const response = { id: 'response', object: 'response', model: 'model', status: 'completed', output: [], usage }
  const chatUsage = { prompt_tokens: 110, completion_tokens: 20, total_tokens: 130 }
  if (!stream) return JSON.stringify(mode === 'anthropic_messages' ? anthropic : mode === 'codex_responses' ? response : {
    id: 'chat', model: 'model', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: chatUsage,
  })
  const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  if (mode === 'anthropic_messages') return [
    sse('message_start', { type: 'message_start', message: { ...anthropic, content: [] } }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }),
    sse('message_stop', { type: 'message_stop' }),
  ].join('')
  if (mode === 'codex_responses') return [
    sse('response.created', { type: 'response.created', response: { ...response, status: 'in_progress' } }),
    sse('response.completed', { type: 'response.completed', response }),
  ].join('')
  return `data: ${JSON.stringify({ id: 'chat', model: 'model', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }], usage: chatUsage })}\n\ndata: [DONE]\n\n`
}

describe('Coding Agent proxy request timing', () => {
  it.each(['claude', 'codex'])('%s records each provider request including the first-token wait in every API mode', async proxy => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    for (const mode of ['anthropic_messages', 'chat_completions', 'codex_responses'] as const) {
      for (const stream of [false, true]) {
        clock.mockReturnValue(1000)
        vi.mocked(codingAgentRunManager.handleProxyUsageEvent).mockClear()
        vi.stubGlobal('fetch', vi.fn(async () => {
          clock.mockReturnValue(3000) // response headers, before the first token
          const body = providerBody(mode, stream)
          if (!stream) {
            clock.mockReturnValue(5000)
            return new Response(body, { headers: { 'Content-Type': 'application/json' } })
          }
          return new Response(new ReadableStream({ pull(controller) {
            clock.mockReturnValue(5000)
            controller.enqueue(new TextEncoder().encode(body))
            controller.close()
          } }), { headers: { 'Content-Type': 'text/event-stream' } })
        }))
        const register = proxy === 'claude' ? registerClaudeCodeProxyTarget : registerCodexProxyTarget
        const target = register({ profile: 'test', provider: 'test', model: 'model', apiMode: mode, apiKey: 'test', baseUrl: 'https://provider.test/v1', agentSessionId: 'timed-agent' })
        const ctx: any = { params: { key: target.routeKey }, request: { body: { stream, model: 'model', messages: [], input: [], max_tokens: 100 } },
          get: (name: string) => name === 'authorization' ? `Bearer ${target.token}` : '', set: vi.fn() }
        await (proxy === 'claude' ? claudeProxyMessages : codexProxyResponses)(ctx)
        expect(ctx.status, `${proxy} ${mode}, stream=${stream}: ${JSON.stringify(ctx.body)}`).toBeUndefined()
        if (stream) for await (const _chunk of ctx.body) { /* consume the actual proxy stream */ }
        await vi.waitFor(() => expect(codingAgentRunManager.handleProxyUsageEvent).toHaveBeenCalledWith(
          'timed-agent', expect.objectContaining({ type: 'response.completed' }), 4, 'https://provider.test/v1',
        ))
        expect(vi.mocked(codingAgentRunManager.handleProxyUsageEvent).mock.calls.filter(([, event]) => event.type === 'response.completed')).toHaveLength(1)
      }
    }
  })
})
