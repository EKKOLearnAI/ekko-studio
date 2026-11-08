import { describe, expect, it, vi } from 'vitest'
import { personBudgetedClient } from '../../packages/server/src/bootstrap/person-model-context'
import { AgentRuntime, AgentToolRegistry, createModelClient } from '../../packages/ekko-agent/src'
import { toOpenAIChatPayload } from '../../packages/ekko-agent/src/model/providers/openai-compatible'
import type { AgentMessage, ModelProviderConfig } from '../../packages/ekko-agent/src/model/types'

const config: ModelProviderConfig = {
  id: 'custom:fixture', type: 'custom', requestStyle: 'openai-chat',
  baseUrl: 'https://provider.invalid/v1', defaultModel: 'fixture',
  capabilities: { streaming: false },
}

type ChatPayload = ReturnType<typeof toOpenAIChatPayload>

function strictTransport(reply: (body: ChatPayload, index: number) => Response = () => jsonReply('ok')) {
  const requests: ChatPayload[] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as ChatPayload
    requests.push(body)
    const systems = body.messages.filter((message) => message.role === 'system')
    if (systems.length > 1 || systems.length === 1 && body.messages[0].role !== 'system') {
      return new Response(JSON.stringify({ error: { message: 'System message must be at the beginning.' } }), { status: 400 })
    }
    return reply(body, requests.length)
  })
  return { requests, fetch, client: createModelClient(config, { fetch }) }
}

function jsonReply(content: string, toolCalls?: unknown[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }),
    { headers: { 'Content-Type': 'application/json' } })
}

const system = (content: string): AgentMessage => ({ role: 'system', content })

describe('OpenAI chat system messages', () => {
  it('merges instruction text in encounter order and preserves the non-system conversation', () => {
    const history: AgentMessage[] = [
      system('Base\n'), system('Guidance'), { role: 'user', content: 'Question', contentParts: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] },
      { role: 'assistant', content: '', reasoning: { text: 'Plan' }, toolCalls: [{ id: 'call', name: 'read', arguments: { path: 'fixture' } }] },
      { role: 'tool', toolCallId: 'call', name: 'read', content: 'Evidence' },
      system('Recovery\nDo not skip checks.'), { role: 'user', content: 'Continue' },
    ]
    const original = structuredClone(history)
    const payload = toOpenAIChatPayload(config, { messages: history })
    expect(payload.messages[0]).toMatchObject({ role: 'system', content: 'Base\n\n\nGuidance\n\nRecovery\nDo not skip checks.' })
    expect(payload.messages.slice(1)).toEqual(toOpenAIChatPayload(config, { messages: history.filter(message => message.role !== 'system') }).messages)
    expect(history).toEqual(original)
  })

  it('moves a single late instruction intact', () => {
    expect(toOpenAIChatPayload(config, { messages: [{ role: 'user', content: 'Question' }, system('  Keep spacing\n')] }).messages)
      .toMatchObject([{ role: 'system', content: '  Keep spacing\n' }, { role: 'user', content: 'Question' }])
  })

  it.each([{ prefix: [] as AgentMessage[] }, { prefix: [system('Only instruction')] }])('keeps an already valid instruction prefix unchanged: %j', ({ prefix }) => {
    const messages: AgentMessage[] = [...prefix, { role: 'user', content: 'Question' }]
    expect(toOpenAIChatPayload(config, { messages }).messages).toMatchObject(messages)
  })

  it('keeps Qwen text-part and cache-control encoding after consolidation', () => {
    const payload = toOpenAIChatPayload({ ...config, id: 'qwen-oauth' }, { messages: [system('Base'), system('Guidance'), { role: 'user', content: 'Question' }] })
    expect(payload.messages[0]).toMatchObject({ role: 'system', content: [{ type: 'text', text: 'Base\n\nGuidance', cache_control: { type: 'ephemeral' } }] })
    expect(payload.messages).toHaveLength(2)
  })

  it.each([false, true])('passes the strict synthetic transport in stream=%s mode', async stream => {
    const transport = strictTransport(() => stream
      ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
      : jsonReply('ok'))
    const request = { messages: [system('Base'), system('Guidance'), { role: 'user' as const, content: 'Question' }, system('Recovery')] }
    if (stream) {
      const events = []
      for await (const event of transport.client.stream(request)) events.push(event)
      expect(events).toContainEqual({ type: 'text-delta', text: 'ok' })
    } else expect(await transport.client.create(request)).toMatchObject({ content: 'ok' })
    expect(transport.requests).toHaveLength(1)
    expect(transport.requests[0].messages.map((message) => message.role)).toEqual(['system', 'user'])
  })

  it.each([false, true])('normalizes runtime final replies with Person wrapping=%s and keeps the tool-free boundary', async wrapped => {
    const transport = strictTransport((_body, index) => index === 1
      ? jsonReply('', [{ id: 'dispatch', type: 'function', function: { name: 'dispatch', arguments: '{}' } }])
      : jsonReply('Queued.'))
    const create = vi.spyOn(transport.client, 'create')
    const client = wrapped ? personBudgetedClient(transport.client, {
      selection: { runtime: 'ekko', mode: 'scoped', profile: 'fixture', provider: config.id, model: 'fixture' },
      messages: [], systemPrompt: '', tools: [], maxSteps: 1, contextTokens: 100000,
      compression: { enabled: false, threshold: 0.8 }, signal: new AbortController().signal,
    }) : transport.client
    const tools = new AgentToolRegistry(), execute = vi.fn(async () => ({ ok: true, content: 'queued' }))
    tools.register({ definition: { name: 'dispatch' }, execute })
    const result = await new AgentRuntime({ tools, skillsEnabled: false, maxSteps: 1 }).run({
      messages: ['Dispatch'], modelClient: client, memoryEnabled: false,
      onToolBatchComplete: () => ({ finalReply: 'Acknowledge the dispatched work.', finishReason: 'waiting_for_tasks' }),
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(transport.requests).toHaveLength(2)
    const closing = transport.requests[1]
    expect(closing.messages.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(closing.messages[0].content).toContain('Acknowledge the dispatched work.')
    expect(closing.messages.at(-1)).toMatchObject({ role: 'tool', content: 'queued', tool_call_id: 'dispatch' })
    const prepared = create.mock.calls[1]![0]
    expect(prepared).toMatchObject({ tools: [], toolChoice: 'none' })
    expect(prepared.messages[wrapped ? 1 : prepared.messages.length - 1]).toMatchObject({ role: 'system', content: 'Acknowledge the dispatched work.' })
    expect(closing.tools).toBeUndefined()
    expect(result.output).toMatchObject({ content: 'Queued.', finishReason: 'waiting_for_tasks' })
  })

  it('normalizes a runtime recovery reminder while retaining required recovery tools and stored history', async () => {
    let active = true
    const transport = strictTransport((_body, index) => index === 2
      ? jsonReply('', [{ id: 'retry', type: 'function', function: { name: 'retry', arguments: '{}' } }])
      : jsonReply(index === 1 ? 'Premature completion' : 'Recovered.'))
    const tools = new AgentToolRegistry(), execute = vi.fn(async () => { active = false; return { ok: true, content: 'restored' } })
    tools.register({ definition: { name: 'retry' }, execute })
    const result = await new AgentRuntime({ tools, skillsEnabled: false,
      recoveryDirective: () => ({ active, automaticToolCalls: [], allowedToolNames: ['retry'], reminder: 'Recovery must complete.' }),
    }).run({ messages: ['Resume'], modelClient: transport.client, memoryEnabled: false })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(transport.requests).toHaveLength(3)
    expect(transport.requests[1]).toMatchObject({ tool_choice: 'required', tools: [{ function: { name: 'retry' } }] })
    expect(transport.requests[1].messages[0].content).toContain('Recovery must complete.')
    expect(transport.requests[1].messages.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(result.messages.filter(message => message.role === 'system')).toHaveLength(2)
    expect(result.output.content).toBe('Recovered.')
  })
})
