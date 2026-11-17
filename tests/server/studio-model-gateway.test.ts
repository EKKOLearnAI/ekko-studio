import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createModelClient } from '../../packages/ekko-agent/src/model/registry'
import { resolveAgentGatewayModelConfigs } from '../../packages/server/src/bootstrap/provider-gateway-client'

const fixtures = vi.hoisted(() => ({ home: '', targets: [] as string[], provider: 'deepseek', baseUrl: 'https://upstream.invalid/v1', model: 'family/model', mode: 'chat_completions', calls: [] as any[], respond: undefined as any }))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: { port: 18648, get appHome() { return fixtures.home } } }))
vi.mock('../../packages/server/src/modules/studio/public/provider-account', () => ({ providerAccountId: () => 1, providerRequestProfile: () => 'default', withProviderAccount: (_id: unknown, task: any) => task() }))
vi.mock('../../packages/server/src/modules/studio/public/model-routing', () => ({ canonicalModelRoute: async (value: string) => value, providerRouteNamespace: async (_profile: string, provider: string) => provider, qualifyModelRoute: (provider: string, model: string) => `${provider}/${model}` }))
vi.mock('../../packages/server/src/modules/studio/public/provider-upstream', () => ({ resolveProviderUpstream: async () => ({ provider: fixtures.provider, baseUrl: fixtures.baseUrl, apiKey: 'server-side-secret', apiMode: fixtures.mode }) }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: async () => [{ provider: fixtures.provider, models: [fixtures.model], api_mode: fixtures.mode, api_key: '', base_url: fixtures.baseUrl }] }))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({ normalizeTokenUsage: (usage: any) => ({ inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0, outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, isEstimated: false }), normalizeUsageCost: () => undefined, recordSessionUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: { handleProxyUsageEvent: vi.fn() } }))
vi.mock('../../packages/server/src/modules/coding-agents/services/context-policy', () => ({ codingAgentOutputLimit: () => 8192 }))

import { configureProviderHttp } from '../../packages/server/src/modules/studio/public/provider-http'
import { configureModelGatewayAdapters } from '../../packages/server/src/modules/studio/public/model-gateway-adapters'
import { codingModelGatewayAdapters } from '../../packages/server/src/modules/coding-agents/public/model-gateway'
import { serveModelGateway, gatewayModelStream } from '../../packages/server/src/modules/studio/services/model-api/gateway'
import { registerCodexProxyTarget, revokeCodexProxyTarget, findCodexGatewayTarget, findCodexProxyByToken, codexProxyResponses } from '../../packages/server/src/modules/coding-agents/services/codex/proxy'
import { registerClaudeCodeProxyTarget, revokeClaudeCodeProxyTarget, findClaudeProxyByToken, claudeProxyMessages } from '../../packages/server/src/modules/coding-agents/services/claude-code/proxy'

beforeEach(async () => {
  fixtures.home = await mkdtemp(join(tmpdir(), 'studio-gateway-'))
  fixtures.targets = []
  fixtures.provider = 'deepseek'
  fixtures.baseUrl = 'https://upstream.invalid/v1'
  fixtures.model = 'family/model'
  fixtures.mode = 'chat_completions'
  fixtures.calls = []
  fixtures.respond = () => Response.json({ id: 'chat-1', model: 'family/model', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })
  configureProviderHttp(async input => { fixtures.calls.push(input); return fixtures.respond(input) })
  configureModelGatewayAdapters({
    ...codingModelGatewayAdapters,
    register: (protocol, input, persisted) => {
      const target = codingModelGatewayAdapters.register(protocol, input, persisted)
      fixtures.targets.push(target.routeKey)
      return target
    },
  })
})

afterEach(async () => { await rm(fixtures.home, { recursive: true, force: true }) })

function context(body: any, path = '/api/ekko-studio/models/v1/responses'): any {
  const headers: Record<string, string> = { authorization: 'Bearer account-key' }
  const res = Object.assign(new EventEmitter(), { writableEnded: false })
  return { path, method: 'POST', query: {}, params: {}, request: { body }, res,
    state: { user: { id: 1 }, modelGateway: { userId: 1, profile: 'default' }, modelGatewaySignal: new AbortController().signal },
    get: (name: string) => headers[name.toLowerCase()] || '', set: () => {}, status: 200 }
}

it.each(['codex', 'claude'] as const)('restores a persisted %s credential through the normal registry and preserves inference', async agent => {
  const register = agent === 'codex' ? registerCodexProxyTarget : registerClaudeCodeProxyTarget
  const revoke = agent === 'codex' ? revokeCodexProxyTarget : revokeClaudeCodeProxyTarget
  const find = agent === 'codex' ? findCodexProxyByToken : findClaudeProxyByToken
  const handle = agent === 'codex' ? codexProxyResponses : claudeProxyMessages
  const input = { profile: 'default', ownerUserId: 1, provider: 'deepseek', model: 'family/model',
    baseUrl: fixtures.baseUrl, apiKey: 'upstream-secret', apiMode: 'chat_completions' as const, agentSessionId: `restored-${agent}` }
  const first = register(input)
  expect(first.baseUrl).toContain('/api/ekko-studio/models')
  revoke(first.routeKey)
  expect(find(first.token)).toBeNull()
  const restored = register(input, { token: first.token })
  expect(restored.token).toBe(first.token)
  try {
    const request = context(agent === 'codex' ? { model: 'family/model', input: 'hi' }
      : { model: 'family/model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] })
    request.get = (name: string) => agent === 'codex' && name === 'authorization' ? `Bearer ${restored.token}`
      : agent === 'claude' && name === 'x-api-key' ? restored.token : ''
    await handle(request)
    expect(request.status).toBe(200)
    expect(fixtures.calls).toHaveLength(1)
    expect(fixtures.calls[0]).toMatchObject({ apiKey: 'upstream-secret', body: { model: 'family/model' } })
    // Knowing a route key is insufficient without its bound credential.
    request.params.key = restored.routeKey
    request.get = () => ''
    await handle(request)
    expect(request.status).toBe(401)
    expect(fixtures.calls).toHaveLength(1)
  } finally { revoke(restored.routeKey) }
  expect(find(first.token)).toBeNull()
})

it.each(['chat_completions', 'codex_responses', 'anthropic_messages', 'gemini_contents'] as const)('routes %s through the same account catalog without exposing the upstream key', async protocol => {
  const body = protocol === 'gemini_contents' ? { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }
    : protocol === 'codex_responses' ? { model: 'deepseek/family/model', input: 'hi' }
      : { model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }
  const ctx = context(body, protocol === 'gemini_contents' ? '/api/ekko-studio/models/v1beta/models/deepseek/family/model:generateContent' : undefined)
  await serveModelGateway(ctx, protocol, ['default'])
  expect(ctx.status).toBe(200)
  expect(fixtures.calls).toHaveLength(1)
  expect(fixtures.calls[0]).toMatchObject({ ownerUserId: 1, profile: 'default', apiKey: 'server-side-secret', body: { model: 'family/model' } })
  expect(JSON.stringify(ctx.body)).not.toContain('server-side-secret')
  if (protocol === 'gemini_contents') expect(ctx.body.candidates[0].content.parts).toEqual([{ text: 'hello' }])
  else expect(ctx.body.model).toBe('deepseek/family/model')
})

it.each(['custom:硅基流动', 'custom:中转/%2F%25 +🚀', 'custom:relay'])('round-trips %s through the Ekko client and gateway', async provider => {
  fixtures.provider = provider
  fixtures.respond = (input: any) => input.body.stream
    ? new Response('data: {"id":"chat-1","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"id":"chat-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    : Response.json({ id: 'chat-1', model: fixtures.model, choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] })
  const { providerConfig } = resolveAgentGatewayModelConfigs({ provider, model: fixtures.model,
    baseUrl: 'http://localhost/api/ekko-studio/models/v1', apiKey: 'studio_model_fixture' })
  const client = createModelClient(providerConfig, { fetch: async (url, init) => {
    // Use Fetch's real header validation, where raw Chinese names previously failed.
    const request = new Request(url, init)
    const body = await request.json()
    expect(body.model).toBe('family/model')
    const ctx = context(body, new URL(request.url).pathname)
    ctx.get = (name: string) => request.headers.get(name) || ''
    await serveModelGateway(ctx, 'codex_responses', ['default'])
    if (ctx.body instanceof Readable) {
      const stream = ctx.body
      const bytes = Readable.from((async function* () {
        for await (const chunk of stream) yield Buffer.from(chunk)
      })())
      return new Response(Readable.toWeb(bytes) as ReadableStream, { headers: { 'content-type': 'text/event-stream' } })
    }
    return Response.json(ctx.body, { status: ctx.status })
  } })
  const request = { model: fixtures.model, messages: [{ role: 'user' as const, content: 'hi' }] }
  expect((await client.create(request)).content).toBe('hello')
  let content = ''
  for await (const event of client.stream(request)) {
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'text-delta') content += event.text
  }
  expect(content).toBe('hello')
  expect(fixtures.calls).toHaveLength(2)
  for (const call of fixtures.calls) expect(call).toMatchObject({ apiKey: 'server-side-secret', body: { model: 'family/model' } })
})

it('keeps legacy unencoded provider headers literal, including percent escapes', async () => {
  fixtures.provider = 'custom:literal%2F%25'
  const ctx = context({ model: fixtures.model, input: 'hi' })
  ctx.get = (name: string) => name === 'x-studio-provider' ? fixtures.provider : ''
  await serveModelGateway(ctx, 'codex_responses', ['default'])
  expect(ctx.status).toBe(200)
  expect(fixtures.calls).toHaveLength(1)
})

it('rejects malformed encoded provider headers before dispatch', async () => {
  const ctx = context({ model: fixtures.model, input: 'hi' })
  const headers: Record<string, string> = { 'x-studio-provider': 'custom%3A%broken', 'x-studio-provider-encoding': 'uri' }
  ctx.get = (name: string) => headers[name] || ''
  await expect(serveModelGateway(ctx, 'codex_responses', ['default'])).rejects.toMatchObject({ status: 400 })
  expect(fixtures.calls).toHaveLength(0)
})

it('accepts native Responses fields rather than applying the former restricted sharing schema', async () => {
  fixtures.mode = 'codex_responses'
  fixtures.respond = () => Response.json({ id: 'response-1', model: 'family/model', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } })
  const ctx = context({ model: 'deepseek/family/model', input: 'hi', parallel_tool_calls: false, text: { format: { type: 'json_object' } }, metadata: { kept: 'yes' } })
  await serveModelGateway(ctx, 'codex_responses', ['default'])
  expect(fixtures.calls[0].body).toMatchObject({ parallel_tool_calls: false, metadata: { kept: 'yes' }, text: { format: { type: 'json_object' } } })
  expect(ctx.body.model).toBe('deepseek/family/model')
})

it('preserves a Messages tool-call round trip when translating to Chat', async () => {
  const ctx = context({ model: 'deepseek/family/model', max_tokens: 64, tools: [{ name: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }], messages: [
    { role: 'user', content: 'read this file' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file text' }] },
  ] })
  await serveModelGateway(ctx, 'anthropic_messages', ['default'])
  const sent = fixtures.calls[0].body
  expect(sent.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call-1', function: { name: 'read', arguments: '{"path":"a.ts"}' } })] }),
    expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: 'file text' }),
  ]))
})

it('checks an external sharing key model allowlist before making any upstream request', async () => {
  const ctx = context({ model: 'deepseek/family/model', input: 'hi' })
  ctx.state.modelApiKey = { id: 'restricted', models: [] }
  await expect(serveModelGateway(ctx, 'codex_responses', ['default'])).rejects.toThrow('Model is not available')
  expect(fixtures.calls).toHaveLength(0)
})

it('streams Gemini text before the upstream completes and carries terminal usage', async () => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const frame = (value: any) => `data: ${JSON.stringify(value)}\n\n`
  fixtures.respond = () => new Response(new ReadableStream<Uint8Array>({ async start(controller) {
    controller.enqueue(new TextEncoder().encode(frame({ id: 'chat-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'first' }, finish_reason: null }] })))
    await gate
    controller.enqueue(new TextEncoder().encode(frame({ id: 'chat-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + 'data: [DONE]\n\n'))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })
  const ctx = context({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, '/api/ekko-studio/models/v1beta/models/deepseek/family/model:streamGenerateContent')
  await serveModelGateway(ctx, 'gemini_contents', ['default'])
  const stream = (ctx.body as Readable)[Symbol.asyncIterator]()
  const first = await stream.next()
  expect(String(first.value)).toContain('first')
  finish()
  let tail = ''
  for await (const chunk of { [Symbol.asyncIterator]: () => stream }) tail += String(chunk)
  expect(tail).toContain('usageMetadata')
  expect(tail).toContain('STOP')
  expect(fixtures.calls[0].body.stream).toBe(true)
})

it('keeps Unicode and user payloads intact while rewriting SSE model envelopes', async () => {
  const raw = 'data: {"type":"response.completed","response":{"model":"upstream","output":[{"text":"模型 deepseek/family/model"}]}}\n\n'
  const bytes = new TextEncoder().encode(raw)
  const chunks = Readable.from([bytes.slice(0, 12), bytes.slice(12, 74), bytes.slice(74)])
  let result = ''
  for await (const chunk of gatewayModelStream(chunks, 'deepseek/family/model')) result += chunk
  expect(JSON.parse(result.split('data: ')[1]).response).toEqual({ model: 'deepseek/family/model', output: [{ text: '模型 deepseek/family/model' }] })
})


it('passes native Chat fields and response extensions through without a Responses round trip', async () => {
  fixtures.respond = () => Response.json({ model: 'family/model', choices: [{ message: { role: 'assistant', content: 'native' } }], vendor_result: { trace: 42 } })
  const ctx = context({ model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } }, logprobs: true, top_logprobs: 3, vendor_option: { exact: true } })
  await serveModelGateway(ctx, 'chat_completions', ['default'])
  expect(fixtures.calls[0].body).toMatchObject({ logprobs: true, top_logprobs: 3, vendor_option: { exact: true }, response_format: { type: 'json_schema' } })
  expect(ctx.body).toMatchObject({ model: 'deepseek/family/model', vendor_result: { trace: 42 } })
})

it('forwards native Messages extensions and beta headers, including token counting', async () => {
  fixtures.mode = 'anthropic_messages'
  fixtures.respond = () => Response.json({ input_tokens: 71 })
  const ctx = context({ model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' }, cache_control: { type: 'ephemeral' } }, '/api/ekko-studio/models/v1/messages/count_tokens')
  const previous = ctx.get
  ctx.get = (key: string) => key === 'anthropic-beta' ? 'fixture-feature' : previous(key)
  await serveModelGateway(ctx, 'anthropic_messages', ['default'])
  expect(ctx.body).toEqual({ input_tokens: 71 })
  expect(fixtures.calls[0].url).toBe('https://upstream.invalid/v1/messages/count_tokens')
  expect(fixtures.calls[0].headers['anthropic-beta']).toBe('fixture-feature')
  expect(fixtures.calls[0].body.thinking).toEqual({ type: 'adaptive' })
})

it('accounts external requests once while internal requests keep their existing run accounting', async () => {
  const { recordSessionUsage } = await import('../../packages/server/src/modules/studio/public/usage')
  vi.mocked(recordSessionUsage).mockClear()
  const ctx = context({ model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }] })
  delete ctx.state.modelGateway
  await serveModelGateway(ctx, 'chat_completions', ['default'])
  expect(recordSessionUsage).toHaveBeenCalledTimes(1)
  expect(recordSessionUsage).toHaveBeenCalledWith(expect.objectContaining({ accountId: '1', provider: 'deepseek', model: 'family/model', usage: expect.objectContaining({ inputTokens: 5, outputTokens: 2 }) }))
  await serveModelGateway(context({ model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }] }), 'chat_completions', ['default'])
  expect(recordSessionUsage).toHaveBeenCalledTimes(1)
})


it('keeps signed Anthropic thinking through a Responses tool continuation and fences replay by target', async () => {
  const { reasoningCodec } = await import('../../packages/server/src/modules/studio/public/model-reasoning-codec')
  fixtures.mode = 'anthropic_messages'
  const thinking = { type: 'thinking', thinking: 'plan', signature: 'upstream-signed-thinking' }
  fixtures.respond = () => Response.json({ id: 'msg-1', model: 'family/model', content: [thinking, { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }], usage: { input_tokens: 5, output_tokens: 2 } })
  const first = context({ model: 'deepseek/family/model', input: 'hi' })
  await serveModelGateway(first, 'codex_responses', ['default'])
  const codec = first.state.modelGatewayReasoningCodec
  const reasoning = first.body.output.find((item: any) => item.type === 'reasoning')
  expect(reasoning.encrypted_content).toMatch(/^ekko_r1\./)
  expect(reasoning.encrypted_content).not.toContain(thinking.signature)
  expect(codec.decode(reasoning.encrypted_content)?.native?.data).toEqual([thinking])
  expect((await reasoningCodec('account:2:default:anthropic:model')).decode(reasoning.encrypted_content)).toBeUndefined()
  const next = context({ model: 'deepseek/family/model', input: [...first.body.output, { type: 'function_call_output', call_id: 'call-1', output: 'done' }], instructions: 'policy', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], tool_choice: 'required', parallel_tool_calls: false })
  await serveModelGateway(next, 'codex_responses', ['default'])
  expect(fixtures.calls[1].body.messages[0].content).toEqual([thinking, { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'a' } }])
  expect(fixtures.calls[1].body).toMatchObject({ system: 'policy', tool_choice: { type: 'any', disable_parallel_tool_use: true } })
})

it('captures incremental Anthropic thinking signatures in the terminal reasoning item', async () => {
  fixtures.mode = 'anthropic_messages'
  const frames = [
    { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
  ]
  fixtures.respond = () => new Response(frames.map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const request = context({ model: 'deepseek/family/model', input: 'hi', stream: true })
  await serveModelGateway(request, 'codex_responses', ['default'])
  const codec = request.state.modelGatewayReasoningCodec
  let output = ''
  for await (const chunk of request.body) output += String(chunk)
  const terminal = output.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'response.completed')
  const reasoning = terminal.response.output.find((item: any) => item.type === 'reasoning')
  expect(codec.decode(reasoning.encrypted_content)?.native?.data).toEqual([{ type: 'thinking', thinking: 'plan', signature: 'signed' }])
})

it.each([false, true])('preserves DeepSeek reasoning through a Responses client tool continuation (stream=%s)', async stream => {
  const reasoning = '先读取文件，再判断结果。'
  const call = { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }
  fixtures.respond = () => stream
    ? new Response([
      { choices: [{ delta: { reasoning_content: reasoning } }] },
      { choices: [{ delta: { tool_calls: [{ ...call, index: 0 }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ].map(data => `data: ${JSON.stringify(data)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    : Response.json({ id: 'chat-1', choices: [{ message: { role: 'assistant', content: null, reasoning_content: reasoning, tool_calls: [call] }, finish_reason: 'tool_calls' }] })
  const first = context({ model: 'deepseek/family/model', input: 'hi', stream })
  await serveModelGateway(first, 'codex_responses', ['default'])
  let response = first.body
  if (stream) {
    let output = ''
    for await (const chunk of first.body) output += String(chunk)
    response = output.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))).find(event => event.type === 'response.completed').response
  }
  const reasoningItem = response.output.find((item: any) => item.type === 'reasoning')
  expect(reasoningItem.encrypted_content).toMatch(/^ekko_r1\./)
  expect(first.state.modelGatewayReasoningCodec.decode(reasoningItem.encrypted_content)?.text).toBe(reasoning)
  // Hermes retains encrypted reasoning, emits a textless assistant item, then
  // replays the function call. A summary alone does not survive its converter.
  const next = context({ model: 'deepseek/family/model', input: [
    { type: 'reasoning', encrypted_content: reasoningItem.encrypted_content, summary: [] },
    { role: 'assistant', content: '' },
    ...response.output.filter((item: any) => item.type === 'function_call'),
    { type: 'function_call_output', call_id: 'call-1', output: 'done' },
  ] })
  fixtures.respond = () => Response.json({ id: 'chat-2', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] })
  await serveModelGateway(next, 'codex_responses', ['default'])
  expect(next.status).toBe(200)
  expect(fixtures.calls[1].body.messages.find((message: any) => message.tool_calls)?.reasoning_content).toBe(reasoning)
})

it.each(['deepseek', 'openai-api'])('repairs missing tool reasoning only for compatible Providers (%s)', async provider => {
  fixtures.provider = provider
  const request = context({ model: `${provider}/family/model`, input: [
    { type: 'function_call', call_id: 'old-call', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'old-call', output: 'done' },
  ] })
  await serveModelGateway(request, 'codex_responses', ['default'])
  const message = fixtures.calls[0].body.messages.find((message: any) => message.tool_calls)
  if (provider === 'deepseek') expect(message.reasoning_content).toBe(' ')
  else expect(message).not.toHaveProperty('reasoning_content')
})

it('releases a streaming target even if the client disconnects before its first read', async () => {
  fixtures.respond = () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const request = context({ model: 'deepseek/family/model', input: 'hi', stream: true })
  await serveModelGateway(request, 'codex_responses', ['default'])
  const key = fixtures.targets[0]
  expect(findCodexGatewayTarget(key)).not.toBeNull()
  const closed = new Promise<void>(resolve => request.body.once('close', resolve))
  request.body.destroy()
  await closed
  expect(findCodexGatewayTarget(key)).toBeNull()
})

it('mounts every native protocol URL, including nested Gemini model routes, on the actual Koa router', async () => {
  const { default: Koa } = await import('koa')
  const { createRequestBodyParser } = await import('../../packages/server/src/modules/studio/middleware/request-body-parser')
  const { modelApiRoutes } = await import('../../packages/server/src/modules/studio/routes/model-api')
  const app = new Koa()
  app.use(createRequestBodyParser())
  app.use(async (ctx, next) => { ctx.state.user = { id: 1, username: 'fixture', role: 'user' }; ctx.state.modelGateway = { userId: 1, profile: 'default' }; await next() })
  app.use(modelApiRoutes.routes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  try {
    const { port } = server.address() as { port: number }
    const base = `http://127.0.0.1:${port}/api/ekko-studio/models`
    const cases = [
      ['/v1/responses', { model: 'deepseek/family/model', input: 'hi' }],
      ['/v1/chat/completions', { model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }] }],
      ['/v1/messages', { model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }],
      ['/v1/messages/count_tokens', { model: 'deepseek/family/model', messages: [{ role: 'user', content: 'hi' }] }],
      ['/v1beta/models/deepseek/family/model:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }],
      ['/gemini/v1beta/models/deepseek/family/model:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }],
    ] as const
    for (const [path, body] of cases) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json()
      expect({ status: response.status, error: result.error }, path).toEqual({ status: 200, error: undefined })
      if (path.endsWith('/count_tokens')) expect(response.headers.get('x-studio-token-count-estimated')).toBe('true')
    }
    const list = await fetch(base + '/v1/models')
    expect((await list.json()).data[0].id).toBe('deepseek/family/model')
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})


it.each([{ stream: false, missingContentType: false }, { stream: false, missingContentType: true }, { stream: true, missingContentType: false }])('routes Codex BOT requests to the subscription endpoint with compatible parameters (%j)', async ({ stream, missingContentType }) => {
  fixtures.provider = 'openai-codex'
  fixtures.model = 'gpt-5.4'
  fixtures.baseUrl = 'https://chatgpt.com/backend-api/codex'
  fixtures.mode = 'codex_responses'
  const final = { id: 'resp-codex', object: 'response', model: 'gpt-5.4', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
  fixtures.respond = () => {
    const response = new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: final })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    if (missingContentType) response.headers.delete('content-type')
    return response
  }
  const request = context({ model: 'openai-codex/gpt-5.4', input: 'hi', max_output_tokens: 2048, temperature: 0.8, top_p: 0.9, stream })
  await serveModelGateway(request, 'codex_responses', ['default'])
  expect(request.status).toBe(200)
  expect(fixtures.calls[0].url).toBe('https://chatgpt.com/backend-api/codex/responses')
  expect(fixtures.calls[0].body).toMatchObject({ model: 'gpt-5.4', instructions: '', stream: true, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], include: ['reasoning.encrypted_content'] })
  for (const field of ['max_output_tokens', 'temperature', 'top_p']) expect(fixtures.calls[0].body).not.toHaveProperty(field)
  if (stream) {
    let output = ''
    for await (const chunk of request.body) output += String(chunk)
    expect(output).toContain('response.completed')
    expect(output).toContain('OK')
  } else expect(request.body).toMatchObject({ model: 'openai-codex/gpt-5.4', status: 'completed', output: final.output })
})
