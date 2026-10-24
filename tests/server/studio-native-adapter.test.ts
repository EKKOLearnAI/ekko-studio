import { describe, expect, it, vi } from 'vitest'
import { OpenAICompatibleModelClient } from '../../packages/ekko-agent/src/model/providers/openai-compatible'
import { OpenAIResponsesModelClient } from '../../packages/ekko-agent/src/model/providers/openai-responses'
import { AnthropicMessagesModelClient } from '../../packages/ekko-agent/src/model/providers/anthropic'
import { translatedNativeRequest } from '../../packages/server/src/modules/studio/services/models/native-adapter'
import { NativeModelWire, nativeModelFrames } from '../../packages/server/src/modules/studio/services/models/native-wire'

type Protocol = 'responses' | 'anthropic'
type Style = 'chat' | Protocol
const imageUrl = 'data:image/png;base64,aGVsbG8='
const cases: [Protocol, Style][] = [['responses', 'chat'], ['responses', 'anthropic'], ['anthropic', 'chat'], ['anthropic', 'responses']]
const frame = (data: any) => `data: ${JSON.stringify(data)}\n\n`
const input = (protocol: Protocol, stream = false) => protocol === 'responses'
  ? { input: [{ role: 'user', content: [{ type: 'input_text', text: 'read image' }, { type: 'input_image', image_url: imageUrl }] }], tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], stream }
  : { messages: [{ role: 'user', content: [{ type: 'text', text: 'read image' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }], tools: [{ name: 'read', input_schema: { type: 'object' } }], max_tokens: 100, stream }

function reply(style: Style, name: string, stream: boolean, missingUsage = false, incomplete = false) {
  // Chat/Responses include cached tokens in input; Anthropic reports them separately.
  const usage = missingUsage ? undefined : style === 'chat'
    ? { prompt_tokens: 19, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 }, cache_creation_input_tokens: 3, completion_tokens_details: { reasoning_tokens: 2 } }
    : style === 'responses' ? { input_tokens: 19, output_tokens: 5, input_tokens_details: { cached_tokens: 4 }, cache_write_tokens: 3, output_tokens_details: { reasoning_tokens: 2 } }
      : { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, reasoning_tokens: 2 }
  const args = '{"path":"example"}', id = 'call-test'
  const item = { type: 'function_call', id, call_id: id, name, arguments: args }
  if (!stream) return Response.json(style === 'chat'
    ? { choices: [{ message: { tool_calls: [{ id, function: { name, arguments: args } }] }, finish_reason: incomplete ? 'length' : 'tool_calls' }], usage }
    : style === 'responses' ? { status: incomplete ? 'incomplete' : 'completed', output: [item], usage }
      : { type: 'message', content: [{ type: 'tool_use', id, name, input: JSON.parse(args) }], stop_reason: incomplete ? 'max_tokens' : 'tool_use', usage })
  let text: string
  if (style === 'chat') text = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] })
    + frame({ choices: [{ delta: {}, finish_reason: incomplete ? 'length' : 'tool_calls' }], usage }) + 'data: [DONE]\n\n'
  else if (style === 'responses') text = frame({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } })
    + frame({ type: 'response.output_item.done', output_index: 0, item })
    + frame({ type: incomplete ? 'response.incomplete' : 'response.completed', response: { status: incomplete ? 'incomplete' : 'completed', output: [item], usage } })
  else text = frame({ type: 'message_start', message: { id: 'msg-test', usage } })
    + frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } })
    + frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } })
    + frame({ type: 'message_delta', delta: { stop_reason: incomplete ? 'max_tokens' : 'tool_use' }, usage })
    + frame({ type: 'message_stop' })
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
}
function fixture(protocol: Protocol, style: Style) {
  const requests: any[] = [], authorize = vi.fn()
  const fetch = vi.fn(async (_url: any, init: any) => {
    const body = JSON.parse(init.body); requests.push(body)
    const name = style === 'chat' ? body.tools?.[0]?.function.name : body.tools?.[0]?.name
    return reply(style, name || 'read', body.stream)
  })
  const Client = style === 'chat' ? OpenAICompatibleModelClient : style === 'responses' ? OpenAIResponsesModelClient : AnthropicMessagesModelClient
  const client = new Client({ id: 'fixture', type: 'custom', baseUrl: 'https://fixture.invalid/v1', defaultModel: 'upstream-model', apiKey: 'host-only' }, { fetch })
  const call = (body = input(protocol), signal = new AbortController().signal) => translatedNativeRequest({ client, protocol, body, signal, model: 'upstream-model', publicModel: 'studio/model', sessionId: 'run-test', authorize })
  return { client, fetch, call, requests, authorize }
}
async function collect(response: Response, protocol: Protocol) {
  const wire = new NativeModelWire(protocol), events: any[] = []
  const streaming = response.headers.get('content-type')?.includes('event-stream') === true
  for await (const chunk of nativeModelFrames(response, streaming, wire)) {
    events.push(JSON.parse(streaming ? chunk.data.split('\n').find(line => line.startsWith('data:'))!.slice(5) : chunk.data))
  }
  return { events, wire }
}

describe.each(cases)('%s CLI through %s provider', (protocol, style) => {
  it.each([false, true])('uses the legacy tool/image adapters with accurate host usage, stream=%s', async stream => {
    const f = fixture(protocol, style), { events, wire } = await collect(await f.call(input(protocol, stream)), protocol)
    expect(f.requests[0].model).toBe('upstream-model')
    expect(JSON.stringify(f.requests[0])).toContain(style === 'anthropic' ? 'aGVsbG8=' : imageUrl)
    expect(JSON.stringify(events)).toContain('call-test')
    expect(JSON.stringify(events)).toContain('read')
    expect(wire.status).toBe('completed')
    expect(wire.usage).toEqual({ inputTokens: 12, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 3, reasoningTokens: 2, isEstimated: false })
    if (protocol === 'responses') expect((stream ? events.at(-1).response : events.at(-1)).usage.total_tokens).toBe(24)
    const headers = new Headers(f.fetch.mock.calls[0][1].headers)
    expect(headers.get('authorization') || `Bearer ${headers.get('x-api-key')}`).toBe('Bearer host-only')
    expect(f.fetch.mock.calls[0][1].redirect).toBe('error')
    expect(f.authorize).toHaveBeenCalled()
  })
  it.each([false, true])('keeps missing usage unknown and token truncation incomplete, stream=%s', async stream => {
    const f = fixture(protocol, style)
    f.fetch.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(init.body), name = style === 'chat' ? body.tools[0].function.name : body.tools[0].name
      return reply(style, name, stream, true, true)
    })
    const { wire } = await collect(await f.call(input(protocol, stream)), protocol)
    expect(wire.status).toBe('incomplete'); expect(wire.usage?.isEstimated ?? true).toBe(true)
  })
  it.each(['eof', 'error'])('rejects upstream %s instead of producing success', async failure => {
    const f = fixture(protocol, style)
    f.fetch.mockResolvedValueOnce(new Response(frame(failure === 'error' ? { error: { message: 'secret' } } : {}), { headers: { 'content-type': 'text/event-stream' } }))
    await expect(collect(await f.call(input(protocol, true)), protocol)).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })
})

it('restores distinct plain and namespace tool identities across the next turn', async () => {
  const f = fixture('responses', 'chat')
  const tools = [{ type: 'function', name: 'ns_read' }, { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'read' }] }]
  f.fetch.mockImplementation(async (_url, init) => {
    const body = JSON.parse(init.body); f.requests.push(body)
    return reply('chat', body.tools[1].function.name, false)
  })
  const output = await (await f.call({ input: 'read', tools } as any)).json()
  expect(output.output[0]).toMatchObject({ name: 'read', namespace: 'ns', call_id: 'call-test' })
  await f.call({ tools, input: [...output.output, { type: 'function_call_output', call_id: 'call-test', output: 'contents' }] } as any)
  expect(new Set(f.requests[0].tools.map((tool: any) => tool.function.name)).size).toBe(2)
  expect(f.requests[1].messages.find((message: any) => message.role === 'assistant').tool_calls[0].function.name).toBe(f.requests[0].tools[1].function.name)
  expect(f.requests[1].messages.find((message: any) => message.role === 'tool')).toMatchObject({ tool_call_id: 'call-test', content: 'contents' })
})

it('cancels the original response reader and signal when the CLI disconnects', async () => {
  const f = fixture('responses', 'chat'), cancel = vi.fn()
  f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frame({ choices: [{ delta: { content: 'partial' } }] }))) }, cancel }), { headers: { 'content-type': 'text/event-stream' } }))
  const reader = (await f.call(input('responses', true))).body!.getReader()
  for (let i = 0; i < 4; i++) await reader.read()
  await reader.cancel()
  expect(cancel).toHaveBeenCalledOnce()
  expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true)
})

it('rejects unavailable model capabilities and unsupported strict/server tools before provider IO', async () => {
  const f = fixture('responses', 'chat')
  f.client.capabilities.vision = false
  await expect(f.call()).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  for (const tool of [{ type: 'web_search' }, { type: 'custom', name: 'patch' }, { type: 'function', name: 'f', strict: true }]) {
    await expect(f.call({ input: 'hi', tools: [tool] } as any)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  }
  expect(f.fetch).not.toHaveBeenCalled()
})

it('does not treat a truncated Anthropic message_delta as a terminal event', async () => {
  const f = fixture('responses', 'anthropic')
  f.fetch.mockResolvedValueOnce(new Response(frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }), { headers: { 'content-type': 'text/event-stream' } }))
  await expect(collect(await f.call(input('responses', true)), 'responses')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it('rejects unsupported content before the shared adapter can discard it', async () => {
  const f = fixture('anthropic', 'responses')
  await expect(f.call({ messages: [{ role: 'user', content: [{ type: 'document' }] }], max_tokens: 100 } as any)).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  expect(f.fetch).not.toHaveBeenCalled()
})

it('rechecks authorization while consuming the upstream response', async () => {
  const f = fixture('responses', 'chat'), reader = (await f.call(input('responses', true))).body!.getReader()
  await reader.read()
  f.authorize.mockImplementation(() => { throw new Error('revoked') })
  await expect((async () => { while (!(await reader.read()).done) {} })()).rejects.toThrow('revoked')
  expect(f.fetch.mock.calls[0][1].signal.aborted).toBe(true)
})
