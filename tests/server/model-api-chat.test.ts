import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelClient } from '../../packages/ekko-agent/src/model/registry'
import { resolveModelProviderConfigs } from '../../packages/ekko-agent/src/model/provider-config'

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

import { prepareChatCompletion } from '../../packages/server/src/modules/studio/services/model-api/service'
import { chatModelRequest, validateChatBody } from '../../packages/server/src/modules/studio/services/model-api/chat'

const dir = mkdtempSync(join(tmpdir(), 'studio-model-api-chat-'))
mocks.config.appHome = dir
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const body = (extra: Record<string, any> = {}) => ({ model: 'deepseek/deepseek-reasoner', messages: [{ role: 'user', content: 'Hello' }], ...extra })
const prepare = (value: Record<string, any> = body()) => prepareChatCompletion({ profiles: ['default'], accountId: '7', body: value, signal: new AbortController().signal })
const completion = (message: any = { content: 'Hello' }, finish = 'stop') => Response.json({
  id: 'chat-id', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 } },
})
const sse = (chunks: any[]) => new Response(chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findKey.mockReturnValue(null)
  mocks.groups.mockResolvedValue([{ provider: 'deepseek', models: ['deepseek-reasoner'], api_mode: 'chat_completions', api_key: 'must-not-leak' }])
  mocks.runtime.mockImplementation(async input => ({ provider: input.provider, apiKey: 'upstream-secret', baseUrl: 'https://api.deepseek.com/v1', apiMode: input.apiMode }))
  mocks.createClient.mockImplementation(createModelClient)
  mocks.fetch.mockImplementation(() => Promise.resolve(completion()))
})

describe('Chat Completions endpoint', () => {
  it('returns an OpenAI chat.completion body with mapped usage', async () => {
    const result = await (await prepare()).create()
    expect(result).toMatchObject({ object: 'chat.completion', model: 'deepseek/deepseek-reasoner' })
    expect(result.choices[0]).toMatchObject({ index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' })
    // prompt_tokens is ordinary input plus cache reads/writes, so it matches the provider's own count.
    expect(result.usage).toEqual({
      prompt_tokens: 120, completion_tokens: 30, total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 5 },
    })
  })

  it('streams role, content and finish deltas in the OpenAI chunk shape', async () => {
    mocks.fetch.mockResolvedValue(sse([
      { choices: [{ index: 0, delta: { content: 'He' } }] },
      { choices: [{ index: 0, delta: { content: 'llo' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
    ]))
    const chunks = await Array.fromAsync((await prepare(body({ stream: true }))).chunks())
    expect(chunks[0]).toMatchObject({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    expect(chunks.map(chunk => chunk.choices[0]?.delta?.content ?? '').join('')).toBe('Hello')
    expect(chunks.at(-1)!.choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' })
  })

  it('reports function calls in the OpenAI shape and finishes with tool_calls', async () => {
    mocks.fetch.mockResolvedValue(completion({
      content: null,
      tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"hi"}' } }],
    }, 'tool_calls'))
    const result = await (await prepare()).create()
    expect(result.choices[0].finish_reason).toBe('tool_calls')
    expect(result.choices[0].message.content).toBeNull()
    expect(result.choices[0].message.tool_calls).toEqual([
      { index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"hi"}' } },
    ])
  })

  it('maps a truncated provider answer to finish_reason length', async () => {
    mocks.fetch.mockResolvedValue(completion({ content: 'partial' }, 'length'))
    expect((await (await prepare()).create()).choices[0].finish_reason).toBe('length')
  })

  it('records external usage once per call', async () => {
    await (await prepare()).create()
    expect(mocks.record).toHaveBeenCalledTimes(1)
    expect(mocks.record.mock.calls[0][0]).toMatchObject({ origin: 'external', source: 'model_api', apiCalls: 1, provider: 'deepseek', model: 'deepseek-reasoner' })
    // The ledger keeps ordinary input and cache reads apart; only the OpenAI view sums them.
    expect(mocks.record.mock.calls[0][0].usage).toMatchObject({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 20 })
  })

  it('rejects models outside the key scope before resolving a provider', async () => {
    await expect(prepareChatCompletion({ profiles: ['default'], allowedModels: ['another/model'], body: body(), signal: new AbortController().signal }))
      .rejects.toMatchObject({ status: 404, param: 'model' })
    expect(mocks.runtime).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('rejects images on a model without vision support', async () => {
    mocks.createClient.mockReturnValue({ capabilities: { vision: false }, create: vi.fn(), stream: vi.fn() })
    const images = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]
    await expect(prepare(body({ messages: images }))).rejects.toMatchObject({ status: 400, param: 'messages' })
  })

  it.each([
    [{ n: 2 }, 'n'],
    [{ stop: ['\n\n'] }, 'stop'],
    [{ response_format: { type: 'json_object' } }, 'response_format'],
    [{ logprobs: true }, 'logprobs'],
    [{ tool_choice: { type: 'function', function: { name: 'x' } } }, 'tool_choice'],
    [{ messages: [] }, 'messages'],
  ])('rejects unsupported field %j with param %s', async (extra, param) => {
    await expect(prepare(body(extra))).rejects.toMatchObject({ status: 400, param })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('rejects remote image URLs instead of fetching them server-side', async () => {
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }]
    await expect(prepare(body({ messages }))).rejects.toMatchObject({ status: 400, param: 'messages' })
  })
})

describe('Chat Completions request mapping', () => {
  it('maps roles, images, tool calls and sampling fields onto a ModelRequest', () => {
    const request = chatModelRequest({
      model: 'p/m',
      temperature: 0.3,
      max_completion_tokens: 64,
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      messages: [
        { role: 'developer', content: 'be terse' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'call_a', content: 'result' },
      ],
    }, 'm')
    expect(request).toMatchObject({ model: 'm', temperature: 0.3, maxTokens: 64, reasoningEffort: 'high', toolChoice: 'required' })
    expect(request.messages[0]).toMatchObject({ role: 'system', content: 'be terse' })
    expect(request.messages[1].contentParts?.some(part => part.type === 'image')).toBe(true)
    expect(request.messages[2].toolCalls?.[0]).toMatchObject({ id: 'call_a', name: 'lookup', arguments: { q: 1 }, rawArguments: '{"q":1}' })
    expect(request.messages[3]).toMatchObject({ role: 'tool', toolCallId: 'call_a', content: 'result' })
    expect(request.tools?.[0]).toMatchObject({ name: 'lookup', description: 'd' })
  })

  it('accepts sampling fields it cannot forward and rejects structural surprises', () => {
    expect(() => validateChatBody({ model: 'p/m', messages: [{ role: 'user', content: 'hi' }], top_p: 0.5, presence_penalty: 0.1, seed: 7, user: 'u' })).not.toThrow()
    expect(() => validateChatBody({ model: 'p/m', messages: [{ role: 'user', content: 'hi' }], functions: [] })).toThrow(/functions/)
    expect(() => validateChatBody({ model: 'p/m', messages: [{ role: 'user', content: 'hi' }], functions: [] })).toThrow(/functions/)
  })
})
