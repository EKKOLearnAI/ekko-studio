import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { codingAgentProxyChatCompletions, registerCodexProxyTarget } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import { claudeProxyMessages, registerClaudeCodeProxyTarget } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'
import { chatCompletionsToResponses, responsesToChatCompletionSse } from '../../packages/server/src/modules/coding-agents/protocol/adapters/chat-completions'
import { codingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: {
  handleProxyUsageEvent: vi.fn(), handleResponseEvent: vi.fn(),
} }))
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

const response = { id: 'response-a', status: 'completed', output: [{ type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }
const chat = { id: 'chat-a', choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }
const anthropic = { id: 'msg-a', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }

function context(target: { routeKey: string; token: string }, body: any) {
  return { params: { key: target.routeKey }, request: { body }, status: 200, body: undefined,
    get: (name: string) => name === 'authorization' ? `Bearer ${target.token}` : '', set: vi.fn() } as any
}
async function read(stream: AsyncIterable<Uint8Array | string>) {
  let text = ''
  for await (const chunk of stream) text += chunk.toString()
  return text
}

describe('native scoped model gateway', () => {
  it.each(['codebuddy', 'copilot'].flatMap(agentId =>
    ['chat_completions', 'codex_responses', 'anthropic_messages'].map(apiMode => [agentId, apiMode] as const)))
  ('routes %s to selected %s GLM model', async (agentId, apiMode) => {
    const target = registerCodexProxyTarget({ profile: 'research', provider: 'custom:test', model: 'glm-5.3-flash',
      baseUrl: 'https://provider.example/v1', apiKey: 'sk-upstream', apiMode: apiMode as any,
      agentId, agentSessionId: `run-${agentId}-${apiMode}` })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(apiMode === 'chat_completions' ? chat : apiMode === 'codex_responses' ? response : anthropic))
    const original = { model: 'native-alias', messages: [{ role: 'system', content: 'rules' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'call-a', content: 'file content' }, { role: 'user', content: 'continue' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }] }
    const ctx = context(target, original)
    await codingAgentProxyChatCompletions(ctx)
    expect(ctx.status).toBe(200)
    expect(ctx.body.choices[0].message.content).toBe('hello')
    expect(ctx.body.model).toBe('glm-5.3-flash')
    expect(ctx.body.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })
    expect(ctx.request.body).toBe(original)
    const [url, options] = fetch.mock.calls[0]
    expect(String(url).endsWith(apiMode === 'chat_completions' ? '/chat/completions' : apiMode === 'codex_responses' ? '/responses' : '/messages')).toBe(true)
    const sent = JSON.parse(String(options!.body))
    expect(sent.model).toBe('glm-5.3-flash')
    expect(JSON.stringify(sent)).toContain('file content')
    expect(JSON.stringify(sent)).toContain('call-a')
    expect(JSON.stringify(sent)).toContain('read_file')
    expect(codingAgentRunManager.handleResponseEvent).not.toHaveBeenCalled()
  })

  it.each(['qwen', 'kimi', 'copilot', 'zcode'])('keeps %s proxy usage separate from its native stream', async agentId => {
    const target = registerClaudeCodeProxyTarget({ provider: 'custom:test', model: 'claude-sonnet-4-6',
      baseUrl: 'https://provider.example/v1', apiKey: 'sk-upstream', apiMode: 'chat_completions', agentId, agentSessionId: `native-${agentId}` })
    const upstream = 'data: ' + JSON.stringify({ id: 'chat-a', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] }) + '\n\n'
      + 'data: ' + JSON.stringify({ id: 'chat-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: chat.usage }) + '\n\n' + 'data: [DONE]\n\n'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }))
    const ctx = context(target, { model: 'native-model', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hello' }] })
    await claudeProxyMessages(ctx)
    expect(await read(ctx.body)).toContain('hello')
    expect(codingAgentRunManager.handleProxyUsageEvent).toHaveBeenCalled()
    expect(codingAgentRunManager.handleResponseEvent).not.toHaveBeenCalled()
  })

  it.each(['codebuddy', 'copilot'])('streams %s text, tool calls and usage through the public Chat Completions route', async agentId => {
    const target = registerCodexProxyTarget({ profile: 'research', provider: 'custom:test', model: 'selected-model',
      baseUrl: 'https://provider.example/v1', apiKey: 'sk-upstream', apiMode: 'codex_responses', agentId, agentSessionId: `stream-${agentId}` })
    const events = [
      { type: 'response.created', response: { id: 'response-a' } },
      { type: 'response.output_text.delta', delta: 'hello' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'tool-a', call_id: 'call-a', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'tool-a', delta: '{"path":"a.ts"}' },
      { type: 'response.completed', response },
    ]
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }))
    const ctx = context(target, { model: 'alias', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hello' }] })
    await codingAgentProxyChatCompletions(ctx)
    const text = await read(ctx.body)
    expect(text).toContain('"content":"hello"')
    expect(text).toContain('"id":"call-a"')
    expect(text).toContain('"name":"read_file"')
    expect(text).toContain('"finish_reason":"tool_calls"')
    expect(text).toContain('"prompt_tokens":3')
    expect(text).toContain('data: [DONE]')
    expect(vi.mocked(codingAgentRunManager.handleProxyUsageEvent).mock.calls.filter(([, event]) => event.type === 'response.completed')).toHaveLength(1)
    expect(codingAgentRunManager.handleResponseEvent).not.toHaveBeenCalled()
  })

  it.each(['codebuddy', 'copilot'].flatMap(agentId =>
    ['chat_completions', 'codex_responses', 'anthropic_messages'].map(apiMode => [agentId, apiMode] as const)))
  ('preserves %s streamed tool JSON through the %s upstream', async (agentId, apiMode) => {
    const target = registerCodexProxyTarget({ profile: 'research', provider: 'custom:test', model: 'selected-model',
      baseUrl: 'https://provider.example/v1', apiKey: 'sk-upstream', apiMode: apiMode as any,
      agentId, agentSessionId: `tools-${agentId}-${apiMode}` })
    const calls = [
      { id: 'call-bash', name: 'bash', arguments: JSON.stringify({ command: 'printf "厦门天气 ☀️"', description: 'Print weather' }) },
      { id: 'call-mcp', name: 'ekko_studio_browser_toolset', arguments: JSON.stringify({ action: 'list' }) },
      { id: 'call-empty', name: 'no_arguments', arguments: '{}' },
    ]
    const fragments = calls.map(call => [call.arguments.slice(0, 2), call.arguments.slice(2)])
    let upstream: string
    if (apiMode === 'chat_completions') {
      const deltas = [
        { tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function',
          function: { name: call.name, arguments: fragments[index][0] } })) },
        { tool_calls: calls.map((_, index) => ({ index, function: { arguments: fragments[index][1] } })) },
      ]
      upstream = deltas.map(delta => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`).join('')
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`
        + 'data: [DONE]\n\n'
    } else {
      const events = apiMode === 'codex_responses' ? [
        { type: 'response.created', response: { id: 'response-tools' } },
        ...calls.map((call, output_index) => ({ type: 'response.output_item.added', output_index,
          item: { type: 'function_call', id: call.id, call_id: call.id, name: call.name, arguments: '' } })),
        ...[0, 1].flatMap(fragment => calls.map((call, output_index) => ({ type: 'response.function_call_arguments.delta',
          item_id: call.id, output_index, delta: fragments[output_index][fragment] }))),
        { type: 'response.completed', response: { id: 'response-tools', status: 'completed',
          output: calls.map(call => ({ type: 'function_call', call_id: call.id, ...call })) } },
      ] : [
        { type: 'message_start', message: { id: 'message-tools', content: [] } },
        ...calls.map((call, index) => ({ type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })),
        ...[0, 1].flatMap(fragment => calls.map((_, index) => ({ type: 'content_block_delta', index,
          delta: { type: 'input_json_delta', partial_json: fragments[index][fragment] } }))),
        ...calls.map((_, index) => ({ type: 'content_block_stop', index })),
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]
      upstream = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }))
    const ctx = context(target, { stream: true, messages: [{ role: 'user', content: 'use tools' }] })
    await codingAgentProxyChatCompletions(ctx)
    const frames = (await read(ctx.body)).split('\n\n').filter(frame => frame.startsWith('data: {'))
      .map(frame => JSON.parse(frame.slice(6)))
    const accumulated = new Map<number, { id: string; name: string; arguments: string }>()
    for (const frame of frames) for (const call of frame.choices?.[0]?.delta?.tool_calls || []) {
      const current = accumulated.get(call.index) || { id: '', name: '', arguments: '' }
      current.id += call.id || ''
      current.name += call.function?.name || ''
      current.arguments += call.function?.arguments || ''
      accumulated.set(call.index, current)
    }
    expect([...accumulated.values()]).toEqual(calls)
    for (const call of accumulated.values()) expect(() => JSON.parse(call.arguments)).not.toThrow()
    expect(frames.at(-1).choices[0].finish_reason).toBe('tool_calls')
  })

  it('preserves function selection and output limits and refuses truncated streams', async () => {
    expect(chatCompletionsToResponses({ messages: [], max_tokens: 32,
      tool_choice: { type: 'function', function: { name: 'read' } } })).toMatchObject({ max_output_tokens: 32, tool_choice: { type: 'function', name: 'read' } })
    const events = Readable.from([{ type: 'response.output_text.delta', data: { delta: 'partial' } }])
    await expect(read(responsesToChatCompletionSse(events, 'model-a', false))).rejects.toThrow('without a final response')
  })
})
