import { describe, expect, it, vi } from 'vitest'
import {
  collectModelEvents,
  createModelClient,
  modelResponseToAgentMessage,
  normalizeAgentMessage,
  serializeAgentReasoningDetails,
  toOpenAIResponsesPayload,
  type AgentMessage,
  type ModelProviderConfig,
} from '../../packages/ekko-agent/src'

const gpt: ModelProviderConfig = {
  id: 'custom:fun-codex',
  type: 'openai-compatible',
  requestStyle: 'openai-responses',
  baseUrl: 'https://relay.example/v1',
  defaultModel: 'gpt-5.6-sol',
}
const grok: ModelProviderConfig = {
  ...gpt,
  id: 'xai-oauth',
  baseUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-4.7',
}
const reasoningItem = {
  type: 'reasoning',
  id: 'rs_gpt',
  encrypted_content: 'opaque-gpt-reasoning',
  summary: [{ type: 'summary_text', text: 'I should inspect the file.' }],
}
const response = {
  id: 'resp_gpt',
  // Providers may return a resolved model ID different from the requested alias.
  model: 'resolved-model-snapshot',
  output: [
    reasoningItem,
    { type: 'message', content: [{ type: 'output_text', text: 'I will inspect it.' }] },
    { type: 'function_call', call_id: 'call_read', name: 'read_file', arguments: '{"path":"README.md"}' },
  ],
}
const user: AgentMessage = { role: 'user', content: 'Inspect README.md' }
const tool: AgentMessage = { role: 'tool', toolCallId: 'call_read', content: 'File contents' }
const visibleInput = [
  { role: 'user', content: user.content },
  { role: 'assistant', content: 'I will inspect it.' },
  { type: 'function_call', call_id: 'call_read', name: 'read_file', arguments: '{"path":"README.md"}' },
  { type: 'function_call_output', call_id: 'call_read', output: tool.content },
]

async function assistant(config = gpt, model?: string) {
  const client = createModelClient(config, {
    fetch: async () => new Response(JSON.stringify(response)),
  })
  return modelResponseToAgentMessage(await client.create({ model, messages: [user] }))
}

function persisted(message: AgentMessage): AgentMessage {
  return normalizeAgentMessage({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    reasoning_content: message.reasoning?.text,
    reasoning_details: serializeAgentReasoningDetails(message.reasoning),
  })
}

describe('Responses reasoning replay isolation', () => {
  it('preserves same-target opaque items through persistence without sending internal metadata', async () => {
    const message = persisted(await assistant())
    const payload = toOpenAIResponsesPayload(gpt, { messages: [user, message, tool] })
    expect(payload.input).toEqual([visibleInput[0], reasoningItem, ...visibleInput.slice(1)])
    expect(JSON.stringify(payload)).not.toContain('replayScope')
    expect(message.reasoning?.text).toBe('I should inspect the file.')
  })

  it.each([
    ['provider', { ...gpt, id: 'another-provider' }],
    ['model behind the same relay', { ...gpt, defaultModel: 'grok-4.7' }],
    ['base URL', { ...gpt, baseUrl: 'https://other-relay.example/v1' }],
    ['endpoint path', { ...gpt, endpointPath: 'alternate/responses' }],
    ['Grok provider', grok],
  ] as const)('omits foreign reasoning when changing %s, preserving text and tools', async (_name, target) => {
    const message = persisted(await assistant())
    const original = structuredClone(message)
    const payload = toOpenAIResponsesPayload(target, { messages: [user, message, tool] })
    expect(payload.input).toEqual(visibleInput)
    expect(message).toEqual(original)
  })

  it('uses the effective request model instead of the default or returned snapshot name', async () => {
    const message = await assistant(gpt, 'requested-alias')
    expect(toOpenAIResponsesPayload(gpt, { model: 'requested-alias', messages: [message] }).input)
      .toContainEqual(reasoningItem)
    expect(toOpenAIResponsesPayload(gpt, { messages: [message] }).input)
      .not.toContainEqual(reasoningItem)
  })

  it('allows credential refresh without invalidating same-target reasoning', async () => {
    const message = await assistant({ ...gpt, apiKey: 'before-refresh' })
    expect(toOpenAIResponsesPayload({ ...gpt, apiKey: 'after-refresh' }, { messages: [message] }).input)
      .toContainEqual(reasoningItem)
  })

  it('recovers legacy sessions without provenance while keeping stored history intact', async () => {
    const message = persisted(await assistant())
    delete message.reasoning!.native!.replayScope
    const original = structuredClone(message)
    expect(toOpenAIResponsesPayload(grok, { messages: [user, message, tool] }).input).toEqual(visibleInput)
    expect(message).toEqual(original)
  })

  it('selects only matching reasoning when switching GPT → Grok → GPT', async () => {
    const gptMessage = await assistant()
    const grokMessage = await assistant(grok)
    grokMessage.reasoning!.native!.data = [{ ...reasoningItem, id: 'rs_grok', encrypted_content: 'opaque-grok' }]
    const messages = [gptMessage, grokMessage]
    const gptPayload = toOpenAIResponsesPayload(gpt, { messages })
    const grokPayload = toOpenAIResponsesPayload(grok, { messages })
    expect(gptPayload.input.filter(item => 'type' in item && item.type === 'reasoning')).toEqual([reasoningItem])
    expect(grokPayload.input.filter(item => 'type' in item && item.type === 'reasoning'))
      .toEqual(grokMessage.reasoning!.native!.data)
  })

  it.each(['response.completed', '[DONE]'] as const)('records provenance for streaming completion %s', async (terminal) => {
    const frames = response.output.map(item => `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\n`)
    frames.push(terminal === '[DONE]'
      ? 'data: [DONE]\n\n'
      : `data: ${JSON.stringify({ type: terminal, response })}\n\n`)
    const client = createModelClient(gpt, { fetch: async () => new Response(frames.join('')) })
    const { message } = await collectModelEvents(client.stream({ messages: [user] }))
    const restored = persisted(message)
    expect(toOpenAIResponsesPayload(gpt, { messages: [restored] }).input).toContainEqual(reasoningItem)
    expect(toOpenAIResponsesPayload(grok, { messages: [user, restored, tool] }).input).toEqual(visibleInput)
  })

  it('sends the repaired legacy conversation through the Grok client on its first request', async () => {
    const message = await assistant()
    delete message.reasoning!.native!.replayScope
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      if (body.input.some((item: any) => item.encrypted_content)) {
        return new Response(JSON.stringify({ error: { message: 'Could not decrypt the provided encrypted_content.' } }), { status: 400 })
      }
      return new Response(JSON.stringify({ output_text: 'Grok continued.' }))
    })
    const client = createModelClient(grok, { fetch: fetchMock })
    await expect(client.create({ messages: [user, message, tool] })).resolves.toMatchObject({ content: 'Grok continued.' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.input).toEqual(visibleInput)
  })
})
