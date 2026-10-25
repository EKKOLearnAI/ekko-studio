import { DatabaseSync } from 'node:sqlite'
import { OpenAICompatibleModelClient } from '../../packages/ekko-agent/src/model/providers/openai-compatible'
import { translatedNativeRequest } from '../../packages/server/src/modules/studio/services/models/native-adapter'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginModelGateways } from '../../packages/server/src/modules/studio/services/models/gateway'
import { PluginModelCallStore } from '../../packages/server/src/modules/studio/repositories/plugin-model-call-store'
import { AgentRunStateStore } from '../../packages/server/src/modules/studio/repositories/agent-run-state-store'
import { StudioError, type ExecutionScope, type ModelGatewayHandle } from '../../packages/studio-plugin-sdk/src'
import type { RecordSessionUsageInput } from '../../packages/server/src/modules/studio/services/usage/usage-recorder'
import { normalizeTokenUsage } from '../../packages/server/src/modules/studio/services/usage/usage-recorder'

const scope: ExecutionScope = { scopeId: 'scope', principal: { kind: 'user', id: 'owner' }, profileId: 'one', runId: 'run', surface: 'api', traceId: 'trace' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const terminal = { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } }
function sse(...events: unknown[]) { return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) }
function setup(options: { failedCleanup?: boolean } = {}) {
  const db = new DatabaseSync(':memory:'), store = new PluginModelCallStore(db), state = new AgentRunStateStore(db)
  const authorize = vi.fn(), authorizeStart = vi.fn()
  const request = vi.fn(async (_body: unknown, _signal: AbortSignal, _session: string): Promise<Response> => sse({ type: 'response.output_text.delta', delta: 'hello' }, terminal))
  const record = vi.fn((input: RecordSessionUsageInput) => { const usage = normalizeTokenUsage(input.usage); input.onRecorded?.(usage); return usage })
  const resolve = vi.fn(async () => ({ request, record, images: true }))
  const gateways = new PluginModelGateways({ store, state, authorize, authorizeStart, resolve })
  cleanups.push(async () => { try { if (options.failedCleanup) await expect(gateways.close()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' }); else await gateways.close() } finally { db.close() } })
  const open = (signal = new AbortController().signal, caller = scope) => gateways.open(caller, { model: 'provider/model', protocol: 'responses' }, signal)
  const calls = () => db.prepare('SELECT record_json FROM studio_plugin_model_calls').all().map(row => JSON.parse(String(row.record_json)))
  return { db, store, state, authorize, authorizeStart, request, record, resolve, gateways, open, calls }
}
const post = (gateway: ModelGatewayHandle, body: unknown = { model: 'caller-model', input: 'hi', stream: true }, headers = {}) => fetch(`${gateway.baseUrl}/${gateway.protocol === 'responses' ? 'responses' : gateway.protocol === 'chat-completions' ? 'chat/completions' : 'messages'}`, {
  method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})

it('binds native requests to the host identity and commits measured usage before completion', async () => {
  const f = setup(), gateway = await f.open()
  expect(gateway.images).toBe(true)
  const body = { model: 'caller-model', stream: true, input: [{ type: 'custom_tool_call_output', call_id: 'call', output: 'result' }],
    tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }], parallel_tool_calls: false }
  const response = await post(gateway, body), text = await response.text()
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(text).toContain('response.completed')
  expect(f.request).toHaveBeenCalledExactlyOnceWith(body, expect.any(AbortSignal), 'run')
  expect(f.resolve).toHaveBeenCalledTimes(2)
  expect(f.resolve).toHaveBeenLastCalledWith('one', 'provider/model', 'responses', expect.any(Function), scope)
  expect(f.record).toHaveBeenCalledOnce()
  expect(f.calls()).toEqual([expect.objectContaining({ ownerId: 'owner', profileId: 'one', runId: 'run', model: 'provider/model', status: 'completed',
    usage: expect.objectContaining({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 }) })])
  expect(f.state.usage('run')).toEqual([expect.objectContaining({ source: 'host', final: true, inputTokens: 10 })])
  await gateway.dispose()
  expect((await post(gateway)).status).toBe(401)
})

it('holds Chat completion and late usage until accounting commits once', async () => {
  const f = setup(), gateway = await f.gateways.open(scope, { model: 'provider/model', protocol: 'chat-completions' }, new AbortController().signal)
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder(), frame = (value: any) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
  f.request.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    upstream = controller
    controller.enqueue(frame({ choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] }))
    controller.enqueue(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  const response = await post(gateway, { messages: [{ role: 'user', content: 'hello' }], stream: true })
  const reader = response.body!.getReader(), first = new TextDecoder().decode((await reader.read()).value)
  expect(first).toContain('hello'); expect(first).not.toContain('"stop"')
  expect(f.record).not.toHaveBeenCalled()
  upstream.enqueue(frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }))
  upstream.enqueue(encoder.encode('data: [DONE]\n\n')); upstream.close()
  let tail = ''
  while (true) { const next = await reader.read(); if (next.done) break; tail += new TextDecoder().decode(next.value) }
  expect(tail).toContain('"stop"'); expect(tail).toContain('prompt_tokens'); expect(tail).toContain('[DONE]')
  expect(f.record).toHaveBeenCalledOnce()
  expect(f.calls()).toEqual([expect.objectContaining({ status: 'completed', usage: expect.objectContaining({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 }) })])
})

it.each([false, true])('meters native Chat completions and rejects truncated streams (stream=%s)', async stream => {
  const f = setup(), gateway = await f.gateways.open(scope, { model: 'provider/model', protocol: 'chat-completions' }, new AbortController().signal)
  const data = { choices: [{ index: 0, message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }
  f.request.mockResolvedValue(stream ? new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(data))
  const response = await post(gateway, { messages: [], stream })
  expect(await response.text()).toContain('length')
  expect(f.calls()[0]).toMatchObject({ status: 'incomplete', usage: { inputTokens: 4, outputTokens: 2 } })
  if (stream) {
    f.request.mockResolvedValue(new Response(`data: ${JSON.stringify(data)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }))
    const incomplete = await post(gateway, { messages: [], stream })
    expect(incomplete.status).toBe(502)
    expect(f.calls().at(-1)).toMatchObject({ status: 'failed' })
  }
  const accepted = f.calls().length
  expect((await post(gateway, { messages: [], n: 2, stream })).status).toBe(400)
  expect(f.calls()).toHaveLength(accepted)
})

it('preserves Anthropic tool and signature frames while merging cumulative usage exactly once', async () => {
  const f = setup(), gateway = await f.gateways.open(scope, { model: 'provider/model', protocol: 'anthropic' }, new AbortController().signal)
  const tool = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'read_file', input: {} } }
  f.request.mockResolvedValue(sse({ type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 0, cache_read_input_tokens: 4 } } }, tool,
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native-signature' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 7 } }, { type: 'message_stop' }))
  const response = await post(gateway, { model: 'selected', stream: true, messages: [] }), text = await response.text()
  expect(text).toContain(JSON.stringify(tool)); expect(text).toContain('native-signature')
  expect(f.calls()[0]).toMatchObject({ status: 'incomplete', usage: { inputTokens: 9, outputTokens: 7, cacheReadTokens: 4 } })
  expect(f.record).toHaveBeenCalledOnce()
})

it('rejects non-Run scopes, forged binding fields and protocol changes before allocating access', async () => {
  const f = setup()
  await expect(f.open(undefined, { ...scope, runId: undefined })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' })
  await expect(f.gateways.open(scope, { model: 'p/m', protocol: 'responses', ownerId: 'other' } as any, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  expect(f.resolve).not.toHaveBeenCalled()
  const gateway = await f.open()
  expect((await fetch(`${gateway.baseUrl}/messages`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` } })).status).toBe(404)
  expect((await fetch(`${gateway.baseUrl}/responses/compact`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` } })).status).toBe(401)
  for (const token of ['wrong', 'ü'.repeat(64)]) {
    expect((await post(gateway, {}, { authorization: `Bearer ${token}` })).status).toBe(401)
  }
  expect(f.request).not.toHaveBeenCalled()
})

it('does not publish a terminal frame when durable accounting fails', async () => {
  const f = setup({ failedCleanup: true }), gateway = await f.open()
  f.record.mockImplementation(() => { throw new Error('private database detail') })
  await expect(post(gateway).then(response => response.text())).rejects.toThrow()
  expect(f.calls()[0].status).not.toBe('completed')
  await expect(gateway.dispose()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
})

it('rejects upstream errors without forwarding headers or sensitive diagnostics', async () => {
  const f = setup(), gateway = await f.open()
  f.request.mockResolvedValue(new Response('upstream-secret', { status: 403, headers: { 'x-private': 'secret' } }))
  const response = await post(gateway)
  expect(response.status).toBe(502); expect(response.headers.get('x-private')).toBeNull()
  expect(await response.text()).not.toContain('secret')
  expect(f.calls()[0]).toMatchObject({ status: 'failed', usage: null })
})

it('treats truncated provider output as failed, preserving unknown usage', async () => {
  const f = setup(), gateway = await f.open()
  f.request.mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'partial' }))
  await expect(post(gateway).then(response => response.text())).rejects.toThrow()
  expect(f.calls()[0]).toMatchObject({ status: 'failed', usage: null })
})

it('supports nonstreaming responses and does not accept hidden background execution', async () => {
  const f = setup(), gateway = await f.open()
  f.request.mockResolvedValue(Response.json(terminal.response))
  const response = await post(gateway, { model: 'x', input: 'hi' })
  expect(await response.json()).toEqual(terminal.response)
  for (const field of [{ background: true }, { store: true }, { previous_response_id: 'old' }]) expect((await post(gateway, { input: 'hi', ...field })).status).toBe(400)
  expect(f.request).toHaveBeenCalledOnce()
})

it.each(['scope', 'grant', 'settle'] as const)('revokes a stalled native request on %s and waits for its accounting', async reason => {
  const f = setup(), controller = new AbortController(), gateway = await f.open(controller.signal)
  let ended = false
  f.request.mockImplementation(async (_body, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    ended = true
    throw new Error('aborted')
  })
  const request = post(gateway); void request.catch(() => {})
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
  if (reason === 'scope') controller.abort()
  else if (reason === 'grant') f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'revoked') })
  else await f.gateways.settleRun('run')
  await vi.waitFor(() => expect(ended).toBe(true))
  await gateway.dispose()
  await expect(request).rejects.toThrow()
  expect(f.calls()[0]).toMatchObject({ status: 'cancelled', usage: null })
  expect(f.record).toHaveBeenCalledOnce()
  expect((await post(gateway)).status).toBe(401)
})

it('never rebinds a previous token to a later Run', async () => {
  const f = setup(), first = await f.open(), second = await f.open(undefined, { ...scope, runId: 'next' })
  await f.gateways.settleRun('run')
  expect((await post(first)).status).toBe(401)
  await (await post(second)).text()
  expect(f.calls().map(call => call.runId)).toEqual(['next'])
  expect(second.token).not.toBe(first.token)
})

it('revalidates the selected model before each call and does not bill a disabled target', async () => {
  const f = setup(), gateway = await f.open()
  f.resolve.mockRejectedValue(new StudioError('NOT_FOUND', 'disabled'))
  expect((await post(gateway)).status).toBe(502)
  expect(f.calls()).toEqual([]); expect(f.request).not.toHaveBeenCalled()
})

it('keeps the CLI protocol and billing identity while the selected model changes transport', async () => {
  const f = setup(), gateway = await f.open()
  for (const transport of ['native', 'translated', 'native'] as const) {
    f.resolve.mockResolvedValue({ request: f.request, record: f.record, images: true, transport } as any)
    const response = await post(gateway)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('response.completed')
  }
  expect(f.resolve).toHaveBeenCalledTimes(4)
  expect(f.request).toHaveBeenCalledTimes(3)
  expect(f.calls()).toHaveLength(3)
  expect(f.calls().every(call => call.runId === 'run' && call.status === 'completed')).toBe(true)
  f.authorize.mockImplementation(() => { throw new StudioError('FORBIDDEN', 'Revoked') })
  expect((await post(gateway)).status).not.toBe(200)
  expect(f.request).toHaveBeenCalledTimes(3)
})

it.each(['responses', 'anthropic'] as const)('switches a live %s lease through the real Chat Completions adapter and back', async protocol => {
  const f = setup(), upstream = vi.fn(async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'translated' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }))
  const client = new OpenAICompatibleModelClient({ id: 'fixture', type: 'custom', baseUrl: 'https://fixture.invalid/v1', defaultModel: 'upstream', apiKey: 'host-only' }, { fetch: upstream })
  const native = vi.fn(async () => Response.json(protocol === 'responses'
    ? { id: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native' }] }], usage: { input_tokens: 10, output_tokens: 3 } }
    : { id: 'message', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'native' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }))
  let transport: 'native' | 'translated' = 'native'
  f.resolve.mockImplementation(async () => ({ record: f.record, images: true, transport,
    request: transport === 'native' ? native : (body: Record<string, unknown>, signal: AbortSignal, sessionId: string) =>
      translatedNativeRequest({ client, protocol, model: 'upstream', publicModel: 'provider/model', body, signal, sessionId, authorize: () => f.authorize(scope) }),
  }) as any)
  const gateway = await f.gateways.open(scope, { model: 'provider/model', protocol }, new AbortController().signal)
  const body = protocol === 'responses' ? { input: [{ role: 'user', content: 'hello' }], stream: false }
    : { messages: [{ role: 'user', content: 'hello' }], max_tokens: 100, stream: false }
  for (const next of ['native', 'translated', 'native'] as const) {
    transport = next
    const response = await post(gateway, body)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(next)
  }
  expect(native).toHaveBeenCalledTimes(2)
  expect(upstream).toHaveBeenCalledOnce()
  expect(f.calls().map(call => [call.status, call.runId, call.usage?.inputTokens])).toEqual(Array(3).fill(['completed', 'run', 10]))
})

it('waits for a pending lease admission and prevents it from surviving Run finalization', async () => {
  const f = setup()
  let ready!: () => void
  f.resolve.mockImplementationOnce(async () => { await new Promise<void>(resolve => { ready = resolve }); return { request: f.request, record: f.record } })
  const opening = f.open(); void opening.catch(() => {})
  let settled = false
  const closing = f.gateways.settleRun('run').then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  ready(); await closing
  await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(f.request).not.toHaveBeenCalled()
})

it('releases cancelled gateway RPC admission while keeping unresolved provider work in the cleanup barrier', async () => {
  const f = setup(), controller = new AbortController()
  let ready!: () => void
  f.resolve.mockImplementationOnce(async () => { await new Promise<void>(resolve => { ready = resolve }); return { request: f.request, record: f.record } })
  const opening = f.open(controller.signal)
  controller.abort()
  await expect(opening).rejects.toMatchObject({ code: 'CANCELLED' })
  let settled = false
  const closing = f.gateways.settleRun('run').then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  ready(); await closing
  expect(f.request).not.toHaveBeenCalled()
})

it('does not admit or bill a request disconnected while its provider is resolving', async () => {
  const f = setup(), gateway = await f.open(), controller = new AbortController()
  let ready!: () => void
  f.resolve.mockImplementationOnce(async () => { await new Promise<void>(resolve => { ready = resolve }); return { request: f.request, record: f.record } })
  const request = fetch(`${gateway.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` },
    body: JSON.stringify({ input: 'hello', stream: true }), signal: controller.signal })
  void request.catch(() => {})
  await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(2))
  controller.abort()
  await expect(request).rejects.toThrow()
  ready(); await gateway.dispose()
  expect(f.calls()).toEqual([]); expect(f.request).not.toHaveBeenCalled(); expect(f.record).not.toHaveBeenCalled()
})

it('bounds concurrent native requests on each lease', async () => {
  const f = setup(), gateway = await f.open()
  f.request.mockImplementation(async (_body, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('aborted')
  })
  const pending = Array.from({ length: 4 }, () => post(gateway))
  pending.forEach(request => { void request.catch(() => {}) })
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(4))
  expect((await post(gateway)).status).toBe(429)
  expect(f.calls()).toHaveLength(4)
  await gateway.dispose()
  expect((await Promise.allSettled(pending)).every(result => result.status === 'rejected')).toBe(true)
})

it('rejects oversized SSE frames and keeps the native request failed', async () => {
  const f = setup(), gateway = await f.open()
  f.request.mockResolvedValue(sse({ type: 'response.output_text.delta', delta: 'a'.repeat(1024 * 1024) }, terminal))
  const response = await post(gateway)
  expect(response.status).toBe(502)
  expect(f.calls()[0]).toMatchObject({ status: 'failed', errorCode: 'RESOURCE_EXHAUSTED' })
})

it('decodes split UTF-8, CRLF and multiline SSE data without changing native payloads', async () => {
  const f = setup(), gateway = await f.open()
  const frame = `event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"中文"}\r\n\r\ndata: ${JSON.stringify(terminal)}\r\n\r\n`
  const bytes = Buffer.from(frame)
  f.request.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.subarray(index, index + 1))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  const text = await (await post(gateway)).text()
  expect(text).toContain('中文'); expect(text).toContain('response.completed')
  expect(f.calls()[0].status).toBe('completed')
})
