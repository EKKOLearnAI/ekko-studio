import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelClient } from '../../packages/ekko-agent/src/model/registry'
import { resolveModelProviderConfigs } from '../../packages/ekko-agent/src/model/provider-config'
import type { ModelEvent } from '../../packages/ekko-agent/src/model/types'

const mocks = vi.hoisted(() => ({
  groups: vi.fn(), runtime: vi.fn(), record: vi.fn(), fetch: vi.fn(), createClient: vi.fn(), findKey: vi.fn(),
  config: { appHome: '' },
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({ config: mocks.config }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { warn: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({ getSessionAvailableModelGroups: mocks.groups }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  resolveChatEkkoProviderRuntimeConfig: mocks.runtime,
  createChatEkkoAuthorizedProviderFetch: () => mocks.fetch,
  createChatEkkoModelClient: (...args: any[]) => mocks.createClient(...args),
  resolveChatEkkoModelProviderConfigs: (input: any) => resolveModelProviderConfigs(input),
}))
vi.mock('../../packages/server/src/modules/studio/services/usage/usage-recorder', () => ({ recordSessionUsage: mocks.record }))
vi.mock('../../packages/server/src/modules/studio/services/model-api/keys', () => ({ findModelApiKey: mocks.findKey }))

import { prepareModelResponse, listApiModels } from '../../packages/server/src/modules/studio/services/model-api/service'
import { reasoningCodec } from '../../packages/server/src/modules/studio/services/model-api/reasoning'
import { modelApiErrorBody } from '../../packages/server/src/modules/studio/services/model-api/errors'

const dir = mkdtempSync(join(tmpdir(), 'studio-model-api-'))
mocks.config.appHome = dir
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const body = (extra: Record<string, any> = {}) => ({ model: 'deepseek/deepseek-reasoner', input: 'Hello', ...extra })
const prepare = (value = body()) => prepareModelResponse({ profiles: ['default'], accountId: '7', body: value, signal: new AbortController().signal })
const response = (message = { content: 'Hello' } as any) => Response.json({ id: 'chat-id', choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } })
const sse = (chunks: any[]) => new Response(chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findKey.mockReturnValue(null)
  mocks.groups.mockResolvedValue([{ provider: 'deepseek', models: ['deepseek-reasoner'], api_mode: 'chat_completions', api_key: 'must-not-leak' }])
  mocks.runtime.mockImplementation(async input => ({ provider: input.provider, apiKey: 'upstream-secret', baseUrl: 'https://api.deepseek.com/v1', apiMode: input.apiMode }))
  mocks.createClient.mockImplementation(createModelClient)
  mocks.fetch.mockImplementation(() => Promise.resolve(response()))
})

describe('public Responses model API', () => {
  it('filters the directory to the exact key model IDs, including nested and escaped IDs', async () => {
    mocks.groups.mockResolvedValue([
      { provider: 'p', models: ['a', 'vendor/b', 'future'] },
      { provider: 'custom:a/b', models: ['c'] },
    ])
    const allowed = ['p/vendor/b', 'custom:a%2Fb/c']
    expect((await listApiModels(['default'], allowed)).data.map(model => model.id)).toEqual(allowed)
    expect((await listApiModels(['default'], [])).data).toEqual([])
    expect((await listApiModels(['default'])).data).toHaveLength(4)
  })

  it.each([false, true])('rejects models outside the key scope before provider work for stream=%s', async stream => {
    for (const allowedModels of [[], ['another/model']]) {
      await expect(prepareModelResponse({ profiles: ['default'], allowedModels, body: body({ stream }), signal: new AbortController().signal }))
        .rejects.toMatchObject({ status: 404, param: 'model' })
    }
    expect(mocks.groups).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('allowed models remain subject to current catalog and Profile access', async () => {
    const allowedModels = ['deepseek/deepseek-reasoner']
    const request = await prepareModelResponse({ profiles: ['default'], allowedModels, body: body(), signal: new AbortController().signal })
    await request.create()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    mocks.groups.mockResolvedValue([])
    await expect(prepareModelResponse({ profiles: ['restricted'], allowedModels, body: body(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ status: 404, param: 'model' })
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('lists configured provider models with qualified IDs, retaining nested model IDs and no credentials', async () => {
    mocks.groups.mockResolvedValue([
      { provider: 'glm', models: ['glm-5.3'] },
      { provider: 'openrouter', models: ['vendor/model'], api_key: 'secret', base_url: 'private' },
      { provider: 'custom:relay', models: ['gpt-model'], api_mode: 'codex_responses' },
      { provider: 'bedrock', models: ['claude'], api_mode: 'bedrock_converse' },
    ])
    const result = await listApiModels(['default'])
    expect(result.data.map(item => item.id)).toEqual(['glm/glm-5.3', 'openrouter/vendor/model', 'custom:relay/gpt-model', 'bedrock/claude'])
    expect(result.data.at(-1)).toMatchObject({ responses_supported: false })
    expect(JSON.stringify(result)).not.toMatch(/secret|private|api_key/)
  })

  it('excludes MoA presets from every Profile and rejects stale IDs without invoking a provider or recording usage', async () => {
    mocks.groups.mockImplementation(async profile => [
      { provider: 'moa', models: [profile === 'default' ? 'review' : 'research'], api_mode: 'chat_completions' },
      { provider: 'custom:moa', models: ['model'], api_mode: 'chat_completions' },
    ])
    const profiles = ['default', 'research']
    expect((await listApiModels(profiles)).data.map(model => model.id)).toEqual(['custom:moa/model'])
    for (const model of ['moa/review', 'moa/research']) {
      await expect(prepareModelResponse({ profiles, body: body({ model }), signal: new AbortController().signal }))
        .rejects.toMatchObject({ status: 404, param: 'model' })
    }
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it.each(['http://localhost:8647', 'http://127.0.0.1:8649', 'https://studio.example/proxy'])('excludes self-imported models via %s without blocking direct providers or another Studio instance', async origin => {
    mocks.findKey.mockImplementation(key => key === 'local-key' ? { id: 'key-1', userId: 1 } : null)
    mocks.groups.mockResolvedValue([
      { provider: 'glm', models: ['glm-5.3'], api_mode: 'chat_completions' },
      { provider: 'custom:self', base_url: `${origin}/api/ekko-studio/models/v1/`, api_key: 'local-key', models: ['moa/aa', 'glm/glm-5.3', 'custom:self/moa/default'], api_mode: 'codex_responses' },
      { provider: 'custom:remote', base_url: 'https://other.example/api/ekko-studio/models/v1', api_key: 'remote-key', models: ['glm/glm-5.3'], api_mode: 'codex_responses' },
      { provider: 'custom:other-api', base_url: 'https://other.example/v1', api_key: 'local-key', models: ['moa/real-model'], api_mode: 'chat_completions' },
    ])
    expect((await listApiModels(['default'])).data.map(model => model.id)).toEqual(['glm/glm-5.3', 'custom:remote/glm/glm-5.3', 'custom:other-api/moa/real-model'])
    for (const model of ['custom:self/moa/aa', 'custom:self/glm/glm-5.3', 'custom:self/custom:self/moa/default']) {
      await expect(prepare(body({ model }))).rejects.toMatchObject({ status: 404, param: 'model' })
    }
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('unifies duplicate providers/models and routes unique models through their own source credentials', async () => {
    mocks.groups.mockImplementation(async profile => profile === 'default' ? [
      { provider: 'deepseek', models: ['deepseek-reasoner'], api_mode: 'chat_completions' },
      { provider: 'glm', models: ['shared', 'disabled'], model_meta: { disabled: { disabled: true } } },
    ] : [
      { provider: 'deepseek', models: ['deepseek-reasoner', 'deepseek-chat'], api_mode: 'chat_completions' },
      { provider: 'glm', models: ['shared', 'disabled'] },
    ])
    const profiles = ['default', 'research']
    const models = await listApiModels(profiles)
    expect(models.data.map(model => model.id)).toEqual(['deepseek/deepseek-reasoner', 'glm/shared', 'glm/disabled', 'deepseek/deepseek-chat'])
    expect(models.data.find(model => model.id === 'glm/disabled')?.responses_supported).toBe(true)
    expect(JSON.stringify(models)).not.toMatch(/default|research/)
    for (const [id, expectedProfile] of [['deepseek/deepseek-reasoner', 'default'], ['deepseek/deepseek-chat', 'research'], ['glm/disabled', 'research']]) {
      await (await prepareModelResponse({ profiles, accountId: '7', body: body({ model: id }), signal: new AbortController().signal })).create()
      expect(mocks.runtime).toHaveBeenLastCalledWith(expect.objectContaining({ profile: expectedProfile }))
      expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ profile: expectedProfile, accountId: '7', origin: 'external' }))
    }
  })

  it('resolves model and protocol on the server and records only external usage', async () => {
    const request = await prepare(body({ origin: 'internal', provider: 'other', api_mode: 'anthropic_messages', api_key: 'caller-key' }))
    const result = await request.create()
    expect(result).toMatchObject({ object: 'response', model: 'deepseek/deepseek-reasoner', status: 'completed', store: false, usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } })
    expect(result.output[0].content[0].text).toBe('Hello')
    expect(mocks.runtime).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek', apiMode: 'chat_completions', model: 'deepseek-reasoner' }))
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ sessionId: '', accountId: '7', origin: 'external', apiCalls: 1, usage: expect.objectContaining({ inputTokens: 100, cacheReadTokens: 20, outputTokens: 30 }) }))
    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).model).toBe('deepseek-reasoner')
  })

  it('does not confuse a slash in a custom provider name with a nested model ID', async () => {
    mocks.groups.mockResolvedValue([
      { provider: 'custom:foo/bar', models: ['baz'], api_mode: 'chat_completions' },
      { provider: 'custom:foo', models: ['bar/baz'], api_mode: 'chat_completions' },
      { provider: 'custom:foo%2Fbar', models: ['baz'], api_mode: 'chat_completions' },
    ])
    expect((await listApiModels(['default'])).data.map(item => item.id)).toEqual(['custom:foo%2Fbar/baz', 'custom:foo/bar/baz', 'custom:foo%252Fbar/baz'])
    await (await prepare(body({ model: 'custom:foo%2Fbar/baz' }))).create()
    expect(mocks.runtime).toHaveBeenCalledWith(expect.objectContaining({ provider: 'custom:foo/bar', model: 'baz' }))
  })

  it.each([false, true])('round trips DeepSeek reasoning and parallel tool results (stream=%s)', async stream => {
    const calls = ['a', 'b'].map(id => ({ id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ id }) } }))
    mocks.fetch.mockResolvedValueOnce(stream ? sse([
      { choices: [{ delta: { reasoning_content: 'Exact reasoning: 工具查询。' } }] },
      { choices: [{ delta: { tool_calls: calls.map((call, index) => ({ ...call, index })) }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 40, completion_tokens: 10 } }, '[DONE]',
    ]) : response({ content: '', reasoning_content: 'Exact reasoning: 工具查询。', tool_calls: calls }))
    const first = await prepare(body({ stream, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }))
    const events = stream ? await Array.fromAsync(first.events()) : []
    const result = stream ? events.at(-1)!.response : await first.create()
    expect(result.output.map((item: any) => item.type)).toEqual(['reasoning', 'function_call', 'function_call'])
    expect(result.output[0].encrypted_content).toMatch(/^ekko_r1\./)
    const [callA, callB] = result.output.filter((item: any) => item.type === 'function_call')
    const next = await prepare(body({ instructions: 'System', input: [{ role: 'developer', content: 'Developer' }, { role: 'user', content: 'Go' }, ...result.output,
      { type: 'function_call_output', call_id: callB.call_id, output: 'second' }, { type: 'function_call_output', call_id: callA.call_id, output: 'first' }], tools: [{ type: 'function', name: 'lookup' }], tool_choice: 'auto' }))
    await next.create()
    const upstream = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(upstream.messages.filter((m: any) => m.role === 'system')).toHaveLength(2)
    expect(upstream.messages.find((m: any) => m.role === 'assistant')).toMatchObject({ content: '', reasoning_content: 'Exact reasoning: 工具查询。', tool_calls: calls.map((call, i) => ({ ...call, id: [callA.call_id, callB.call_id][i] })) })
    expect(upstream).not.toHaveProperty('tool_choice')
    expect(upstream.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual([callB.call_id, callA.call_id])
    if (stream) {
      expect(events.map(e => e.sequence_number)).toEqual(events.map((_, index) => index))
      expect(events.filter(e => e.type === 'response.completed')).toHaveLength(1)
      expect(events.filter(e => e.type === 'response.function_call_arguments.done')).toHaveLength(2)
    }
    expect(mocks.record).toHaveBeenCalledTimes(2)
  })

  it('keeps native reasoning private and only replays it for the same profile/provider/model/endpoint', async () => {
    const one = await reasoningCodec('same-target')
    const other = await reasoningCodec('different-target')
    const native = { format: 'anthropic-thinking-blocks' as const, data: [{ type: 'thinking', thinking: 'secret', signature: 'native-signature' }] }
    const encrypted = one.encode({ text: 'summary', native })
    expect(encrypted).not.toContain('native-signature')
    expect(one.decode(encrypted)?.native).toEqual(native)
    expect(other.decode(encrypted)).toBeUndefined()
    expect(() => one.decode(encrypted.slice(0, -10))).toThrow('Invalid reasoning')
  })

  it.each([false, true])('replays OpenAI encrypted reasoning on the same target and removes it when switching to Grok (stream=%s)', async stream => {
    mocks.groups.mockResolvedValue([
      { provider: 'openai', models: ['gpt'], api_mode: 'codex_responses' },
      { provider: 'xai', models: ['grok'], api_mode: 'codex_responses' },
    ])
    mocks.runtime.mockImplementation(async input => ({ provider: input.provider, baseUrl: input.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.x.ai/v1', apiMode: 'codex_responses', apiKey: 'secret' }))
    const raw = { id: 'r', status: 'completed', output: [
      { type: 'reasoning', id: 'rs_native', encrypted_content: 'gpt-encrypted', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
    ], usage: { input_tokens: 3, output_tokens: 1 } }
    mocks.fetch.mockImplementation(() => Promise.resolve(Response.json(raw)))
    if (stream) mocks.fetch.mockResolvedValueOnce(sse([{ type: 'response.output_text.delta', delta: 'Hi' }, { type: 'response.completed', response: raw }]))
    const request = await prepare(body({ model: 'openai/gpt', stream }))
    const first = stream ? (await Array.fromAsync(request.events())).at(-1)!.response : await request.create()
    const input = [{ role: 'user', content: 'Hi' }, ...first.output, { role: 'user', content: 'Continue' }]
    await (await prepare(body({ model: 'openai/gpt', input }))).create()
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).input).toContainEqual(expect.objectContaining({ encrypted_content: 'gpt-encrypted' }))
    await (await prepare(body({ model: 'xai/grok', input }))).create()
    expect(mocks.fetch.mock.calls[2][1].body).not.toContain('gpt-encrypted')
    expect(mocks.fetch.mock.calls[2][1].body).not.toContain('ekko_r1')
  })

  it('converts Anthropic JSON responses and preserves native thinking on tool continuation', async () => {
    mocks.groups.mockResolvedValue([{ provider: 'anthropic', models: ['claude'], api_mode: 'anthropic_messages' }])
    mocks.runtime.mockResolvedValue({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', apiMode: 'anthropic_messages', apiKey: 'secret' })
    mocks.fetch.mockImplementation(() => Promise.resolve(Response.json({ id: 'msg', content: [{ type: 'thinking', thinking: 'Think', signature: 'sig' }, { type: 'tool_use', id: 'call', name: 'lookup', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } })))
    const first = await (await prepare(body({ model: 'anthropic/claude' }))).create()
    expect(first.usage.input_tokens).toBe(45)
    await (await prepare(body({ model: 'anthropic/claude', input: [...first.output, { type: 'function_call_output', call_id: first.output.find((item: any) => item.type === 'function_call').call_id, output: 'ok' }] }))).create()
    const replay = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(replay.messages[0].content).toContainEqual({ type: 'thinking', thinking: 'Think', signature: 'sig' })
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
  })

  it('emits ordered Responses SSE with one terminal usage record even if usage repeats', async () => {
    mocks.fetch.mockResolvedValue(sse([
      { choices: [{ delta: { content: 'He' } }] }, { choices: [{ delta: { content: 'llo' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 12, completion_tokens: 3 } }, { usage: { prompt_tokens: 12, completion_tokens: 3 } }, '[DONE]',
    ]))
    const events = await Array.fromAsync((await prepare(body({ stream: true }))).events())
    expect(events.map(e => e.type)).toEqual(['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'])
    expect(events.at(-1)!.response.output[0].content[0].text).toBe('Hello')
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record.mock.calls[0][0].usage.inputTokens).toBe(12)
    expect(events[0].response.output).toEqual([])
  })

  it('completes OpenRouter tool streams when the usage trailer repeats the tool finish reason', async () => {
    mocks.groups.mockResolvedValue([{ provider: 'openrouter', models: ['qwen/qwen3.8-flash'], api_mode: 'chat_completions' }])
    mocks.runtime.mockResolvedValue({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiMode: 'chat_completions', apiKey: 'secret' })
    mocks.fetch.mockResolvedValueOnce(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Guiyang"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 319, completion_tokens: 54, prompt_tokens_details: { cached_tokens: 256 } } },
      '[DONE]',
    ]))
    const tools = [{ type: 'function', name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }]
    const request = await prepare(body({ model: 'openrouter/qwen/qwen3.8-flash', stream: true, tools }))
    const events = await Array.fromAsync(request.events())
    expect(events.at(-1)!.type).toBe('response.completed')
    expect(events.filter(event => event.type === 'response.function_call_arguments.done')).toHaveLength(1)
    const result = events.at(-1)!.response
    expect(result.output).toHaveLength(1)
    expect(result.output[0]).toMatchObject({ type: 'function_call', name: 'weather', arguments: '{"city":"Guiyang"}', status: 'completed' })
    expect(result.usage).toMatchObject({ input_tokens: 319, output_tokens: 54, input_tokens_details: { cached_tokens: 256 } })
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ origin: 'external', usage: expect.objectContaining({ inputTokens: 63, cacheReadTokens: 256, outputTokens: 54 }) }))

    await (await prepare(body({ model: 'openrouter/qwen/qwen3.8-flash', tools, input: [...result.output,
      { type: 'function_call_output', call_id: result.output[0].call_id, output: 'Sunny' }],
    }))).create()
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', tool_call_id: result.output[0].call_id, content: 'Sunny' }),
    ]))
  })

  it('keeps DeepSeek cache hits separate and reports output-token exhaustion', async () => {
    mocks.fetch.mockResolvedValue(Response.json({ choices: [{ message: { content: 'Partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, completion_tokens: 5 } }))
    const result = await (await prepare()).create()
    expect(result).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 } } })
    expect(mocks.record.mock.calls[0][0].usage.inputTokens).toBe(20)
  })

  it.each(['response.completed', 'response.incomplete', 'response.failed'])('translates a native Responses terminal event: %s', async type => {
    mocks.groups.mockResolvedValue([{ provider: 'openai', models: ['gpt'], api_mode: 'codex_responses' }])
    mocks.runtime.mockResolvedValue({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiMode: 'codex_responses', apiKey: 'secret' })
    mocks.fetch.mockResolvedValue(sse([{ type: 'response.output_text.delta', delta: 'Hi' }, { type, response: { status: type.split('.')[1], output: [], usage: { input_tokens: 9, output_tokens: 2 }, error: { message: 'private upstream detail' } } }]))
    const events = await Array.fromAsync((await prepare(body({ model: 'openai/gpt', stream: true }))).events())
    expect(events.at(-1)!.type).toBe(type)
    expect(events.at(-1)!.response.usage).toMatchObject({ input_tokens: 9, output_tokens: 2 })
    expect(mocks.record.mock.calls[0][0].usage.inputTokens).toBe(9)
    expect(JSON.stringify(events)).not.toContain('private upstream detail')
  })

  it.each([false, true])('preserves Gemini function-call thought signatures and finish reasons (stream=%s)', async stream => {
    mocks.groups.mockResolvedValue([{ provider: 'google', models: ['gemini'], api_mode: 'gemini_contents' }])
    mocks.runtime.mockResolvedValue({ provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiMode: 'gemini_contents', apiKey: 'secret' })
    const raw = { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { query: 'hi' } }, thoughtSignature: 'signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, cachedContentTokenCount: 20, candidatesTokenCount: 10 } }
    mocks.fetch.mockResolvedValueOnce(stream ? sse([raw]) : Response.json(raw))
    const request = await prepare(body({ model: 'google/gemini', stream }))
    const result = stream ? (await Array.fromAsync(request.events())).at(-1)!.response : await request.create()
    expect(result.usage).toMatchObject({ input_tokens: 50, output_tokens: 10 })
    const call = result.output.find((item: any) => item.type === 'function_call')
    expect(call).toBeDefined()
    mocks.fetch.mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: 'Partial' }] }, finishReason: 'MAX_TOKENS' }] }))
    const next = await (await prepare(body({ model: 'google/gemini', input: [...result.output, { type: 'function_call_output', call_id: call.call_id, output: 'found' }] }))).create()
    expect(next.status).toBe('incomplete')
    const sent = JSON.parse(mocks.fetch.mock.calls[1][1].body)
    expect(sent.contents[0].parts).toContainEqual(expect.objectContaining({ thoughtSignature: 'signature', functionCall: { name: 'lookup', args: { query: 'hi' } } }))
  })

  it('retains measured usage on stream failure without exposing the upstream error', async () => {
    mocks.createClient.mockReturnValue({ capabilities: {}, async *stream(): AsyncIterable<ModelEvent> {
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
      throw new Error('private upstream url and key')
    } })
    const events = await Array.fromAsync((await prepare(body({ stream: true }))).events())
    expect(events.at(-1)!.type).toBe('response.failed')
    expect(JSON.stringify(events)).not.toContain('private upstream')
    expect(mocks.record.mock.calls[0][0].usage.inputTokens).toBe(12)
  })

  it('keeps separate Gemini streaming tool calls and multiple tool rounds distinct', async () => {
    mocks.groups.mockResolvedValue([{ provider: 'google', models: ['gemini'], api_mode: 'gemini_contents' }])
    mocks.runtime.mockResolvedValue({ provider: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiMode: 'gemini_contents', apiKey: 'secret' })
    mocks.fetch.mockImplementation(() => Promise.resolve(sse(['a', 'b'].map(name => ({ candidates: [{ content: { parts: [{ functionCall: { name, args: {} }, thoughtSignature: `sig-${name}` }] }, finishReason: 'STOP' }] })))))
    const input: any[] = [{ role: 'user', content: 'Go' }]
    const ids: string[] = []
    for (let turn = 0; turn < 2; turn++) {
      const events = await Array.fromAsync((await prepare(body({ model: 'google/gemini', stream: true, input }))).events())
      const output = events.at(-1)!.response.output
      const calls = output.filter((item: any) => item.type === 'function_call')
      expect(calls.map((item: any) => item.name)).toEqual(['a', 'b'])
      input.push(...output, ...calls.map((item: any) => ({ type: 'function_call_output', call_id: item.call_id, output: 'ok' })))
      ids.push(...calls.map((item: any) => item.call_id))
    }
    expect(new Set(ids).size).toBe(4)
    const third = await prepare(body({ model: 'google/gemini', stream: true, input }))
    expect((await Array.fromAsync(third.events())).at(-1)!.type).toBe('response.completed')
  })

  it('records measured usage when the downstream cancels stream consumption', async () => {
    mocks.createClient.mockReturnValue({ capabilities: {}, async *stream(): AsyncIterable<ModelEvent> {
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
      yield { type: 'text-delta', text: 'partial' }
      yield { type: 'done' }
    } })
    for await (const event of (await prepare(body({ stream: true }))).events()) if (event.type === 'response.output_text.delta') break
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record.mock.calls[0][0].usage.outputTokens).toBe(3)
  })

  it.each([
    { model: 'unknown/model' }, { model: 'deepseek/missing' },
    { previous_response_id: 'resp_old' }, { store: true }, { stream: 'true' },
    { tools: [{ type: 'web_search' }] }, { text: { format: { type: 'json_schema' } } },
    { max_output_tokens: -1 }, { temperature: Infinity },
    { include: ['web_search_call.action.sources'] }, { parallel_tool_calls: 'true' },
    { tools: [{ type: 'function', name: 'lookup', strict: true }] }, { metadata: { invalid: [] } }, { text: 'plain' },
    { input: [{ type: 'function_call_output', call_id: 'missing', output: 'bad' }] },
    { input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'http://localhost/private' }] }] },
  ])('rejects invalid or unsupported requests before calling upstream: %j', async extra => {
    await expect(prepare(body(extra))).rejects.toThrow()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('returns explicit unsupported-mode errors without guessing another protocol', async () => {
    mocks.groups.mockResolvedValue([{ provider: 'bedrock', models: ['claude'], api_mode: 'bedrock_converse' }])
    const error = await prepare(body({ model: 'bedrock/claude' })).catch(error => error)
    expect(modelApiErrorBody(error).status).toBe(501)
    expect(mocks.runtime).not.toHaveBeenCalled()
  })
})
