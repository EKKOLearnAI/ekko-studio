import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../packages/ekko-agent/src/index'

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close() })

async function server(handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void) {
  const instance = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    handler(req, res, text ? JSON.parse(text) : {})
  })
  instance.listen(0, '127.0.0.1')
  await once(instance, 'listening')
  const address = instance.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP address')
  closers.push(() => new Promise<void>((resolve, reject) => {
    instance.closeAllConnections()
    instance.close(error => error ? reject(error) : resolve())
  }))
  return `http://127.0.0.1:${address.port}`
}

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

const names = ['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache']
const definitions = names.map(name => ({ name, description: `Public ${name}`, parameters: { type: 'object', properties: { publicOnly: { type: 'string' } } } }))
const manifest = { ok: true, protocolVersion: 1, toolNames: names, tools: { openai: definitions.map(fn => ({ type: 'function', function: fn })) } }

function client(baseUrl: string) {
  return new api.OpenAICompatibleModelClient({ id: 'test', type: 'openai-compatible', baseUrl, defaultModel: 'test-model', capabilities: { streaming: false } })
}

describe('billion-context public HTTP adapter', () => {
  it.each(['null entry', 'wrong tool type', 'non-object arguments'])('rejects malformed public schemas: %s', async variant => {
    const invalid = structuredClone(manifest)
    if (variant === 'null entry') invalid.tools.openai.unshift(null as any)
    if (variant === 'wrong tool type') invalid.tools.openai[0].type = 'custom'
    if (variant === 'non-object arguments') invalid.tools.openai[0].function.parameters.type = 'string'
    const proxy = await server((_req, res) => json(res, invalid))
    await expect(new api.BillionContextClient({ proxyOrigin: proxy }).manifest()).rejects.toThrow('invalid tool schema')
  })

  it('cancels manifest preparation before runtime-info or model requests', async () => {
    const entered = Promise.withResolvers<void>()
    const paths: string[] = []
    const proxy = await server((req, _res) => { paths.push(req.url || ''); entered.resolve() })
    const manager = new api.BillionContextManager({ proxyOrigin: proxy })
    const controller = new AbortController()
    const pending = manager.prepareRequest({ messages: [], signal: controller.signal }, { conversationId: 'cancelled', modelClient: client(proxy) })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    controller.abort()
    await rejection
    expect(paths).toEqual(['/__bili/plugin/manifest'])
  })

  it('keeps concurrent manifest callers isolated when one cancels', async () => {
    const entered = Promise.withResolvers<void>()
    let requests = 0
    const proxy = await server((_req, res) => {
      if (++requests === 1) return entered.resolve()
      json(res, manifest)
    })
    const manager = new api.BillionContextManager({ proxyOrigin: proxy })
    const controller = new AbortController()
    const pending = manager.tools(controller.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    expect((await manager.tools(new AbortController().signal)).map(tool => tool.definition.name)).toEqual(names)
    controller.abort()
    await rejection
    expect((await manager.tools()).map(tool => tool.definition.name)).toEqual(names)
    expect(requests).toBe(2)
  })

  it('times out public HTTP requests that do not respond', async () => {
    const proxy = await server(() => {})
    await expect(new api.BillionContextClient({ proxyOrigin: proxy, timeoutMs: 20 }).manifest()).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it.each(['chat', 'responses', 'anthropic'].flatMap(style => [false, true].map(streaming => ({ style, streaming }))))('preserves model cancellation and timeout through bili: $style streaming=$streaming', async ({ style, streaming }) => {
    const entered = Promise.withResolvers<void>()
    const proxy = await server((req, res) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      entered.resolve()
    })
    const Constructor = style === 'chat' ? api.OpenAICompatibleModelClient
      : style === 'responses' ? api.OpenAIResponsesModelClient : api.AnthropicMessagesModelClient
    const config = { id: style, type: style === 'anthropic' ? 'anthropic' : 'openai-compatible', baseUrl: 'https://example.com/v1', defaultModel: 'test-model', capabilities: { streaming } }
    const model = new Constructor(config)
    const controller = new AbortController()
    const request = await new api.BillionContextManager({ proxyOrigin: proxy }).prepareRequest({ messages: [{ role: 'user', content: 'cancel' }], signal: controller.signal }, { conversationId: 'model-cancel', modelClient: model })
    const consume = async (target: api.ModelClient, input: api.ModelRequest) => {
      if (!streaming) return target.create(input)
      for await (const _event of target.stream(input)) {}
    }
    const pending = consume(model, request)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await entered.promise
    controller.abort()
    await rejection
    await expect(consume(new Constructor({ ...config, timeoutMs: 20 }), { ...request, signal: undefined })).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it('retains run-scoped runtimes until public skill review draining finishes', async () => {
    const proxy = await server((req, res) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      json(res, { choices: [{ message: { content: 'answer' } }] })
    })
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), tools: new api.AgentToolRegistry() })
    let release!: () => void
    const pendingReview = new Promise<void>(resolve => { release = resolve })
    const originalDrain = api.AgentRuntime.prototype.drainSkillReviews
    const spy = vi.spyOn(api.AgentRuntime.prototype, 'drainSkillReviews').mockImplementation(async function (this: api.AgentRuntime) {
      if (this === runtime) return originalDrain.call(this)
      await pendingReview
    })
    try {
      await runtime.run({ messages: ['hi'], contextKey: 'review-owner', contextManager: new api.BillionContextManager({ proxyOrigin: proxy }) })
      let drained = false
      const draining = runtime.drainSkillReviews().then(() => { drained = true })
      await new Promise(resolve => setImmediate(resolve))
      expect(drained).toBe(false)
      release()
      await draining
    } finally {
      release()
      spy.mockRestore()
    }
  })

  it('owns bili headers case-insensitively and does not duplicate an existing proxy route', async () => {
    let outgoing: IncomingMessage['headers'] | undefined
    const proxy = await server((req, res) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      outgoing = req.headers
      expect(req.url).toBe('/bili/https://example.com/v1/chat/completions')
      json(res, { choices: [{ message: { content: 'answer' } }] })
    })
    const model = new api.OpenAICompatibleModelClient({ id: 'test', type: 'openai-compatible', defaultModel: 'test-model', baseUrl: `${proxy}/bili/https://example.com/v1`, capabilities: { streaming: false }, headers: { 'X-Bili-Plugin': 'wrong', 'X-Bili-Plugin-Conversation': 'wrong' } })
    const runtime = new api.AgentRuntime({ modelClient: model, contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry(), contextKey: 'owned' })
    await runtime.run({ messages: ['hi'] })
    expect(outgoing?.['x-bili-plugin']).toBe('ekko-agent')
    expect(outgoing?.['x-bili-plugin-conversation']).toBe('owned')
  })

  it('uses runtime-owned IDs for tool execution and isolates foreground subagents', async () => {
    const seen: string[] = []
    const toolsSeen: Array<Record<string, unknown>> = []
    const calls = new Map<string, number>()
    const paths: string[] = []
    const proxy = await server((req, res, body) => {
      paths.push(req.url || '')
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      if (req.url === '/__bili/plugin/tool') {
        toolsSeen.push(body)
        return json(res, { ok: true, result: '  exact tool result\n' })
      }
      const session = String(req.headers['x-bili-plugin-conversation'])
      seen.push(session)
      const turn = (calls.get(session) ?? 0) + 1
      calls.set(session, turn)
      const name = session === 'parent' ? 'delegate_task' : 'compress'
      const args = name === 'delegate_task' ? { goal: 'isolated child', mode: 'foreground' } : { content: 'raw summary', conversationId: 'attempted-override' }
      json(res, { choices: [{ message: turn === 1 ? { tool_calls: [{ id: `call-${session}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: 'done' } }] })
    })
    const tools = new api.AgentToolRegistry()
    tools.register(new api.DelegateTaskTool())
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), tools, contextKey: 'parent' })
    const result = await runtime.run({ messages: ['delegate'], contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), contextKey: 'parent', toolContext: { sessionId: 'host-wrong' } })
    expect(result.output.content).toBe('done')
    expect(toolsSeen).toHaveLength(1)
    const child = String(toolsSeen[0].conversationId)
    expect(child).toMatch(/^[0-9a-f-]{36}$/)
    expect(child).not.toContain('parent')
    expect(toolsSeen[0]).toEqual({ conversationId: child, tool: 'compress', args: { content: 'raw summary', conversationId: 'attempted-override' } })
    expect(seen).toEqual(['parent', child, child, 'parent'])
    expect(paths).not.toContain('/__bili/plugin/compact')
  })

  it('keeps an anonymous conversation ID stable across runs', async () => {
    const ids: string[] = []
    const proxy = await server((req, res) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      ids.push(String(req.headers['x-bili-plugin-conversation']))
      json(res, { choices: [{ message: { content: 'ok' } }] })
    })
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    await runtime.run({ messages: ['one'] })
    await runtime.run({ messages: ['two'] })
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).not.toBe('undefined')
  })

  it('rejects runtime-info failure without bypassing bili to the upstream', async () => {
    const paths: string[] = []
    const proxy = await server((req, res) => {
      paths.push(req.url || '')
      json(res, req.url === '/__bili/plugin/manifest' ? manifest : { ok: false }, req.url === '/__bili/plugin/manifest' ? 200 : 503)
    })
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    await expect(runtime.run({ messages: ['hi'] })).rejects.toThrow('HTTP 503')
    expect(paths).toEqual(['/__bili/plugin/manifest', '/__bili/plugin/runtime-info'])
  })

  it('rejects unsupported model transports and tool collisions', async () => {
    const proxy = await server((_req, res) => json(res, manifest))
    const manager = new api.BillionContextManager({ proxyOrigin: proxy })
    const custom: api.ModelClient = { provider: 'custom', requestStyle: 'custom-runtime', capabilities: { streaming: false, tools: true, vision: false, jsonMode: false, systemPrompt: true }, create: async () => { throw new Error('must not run') }, stream: async function* () {} }
    await expect(new api.AgentRuntime({ modelClient: custom, contextManager: manager, tools: new api.AgentToolRegistry() }).run({ messages: ['hi'] })).rejects.toThrow('unsupported by custom-runtime')
    const tools = new api.AgentToolRegistry()
    tools.register({ definition: { name: 'compress' }, execute: async () => ({ ok: true, content: 'wrong owner' }) })
    await expect(new api.AgentRuntime({ modelClient: client(proxy), contextManager: manager, tools }).run({ messages: ['hi'] })).rejects.toThrow('tool collision: compress')
  })

  it.each([false, true])('routes Anthropic HTTP requests through bili (stream=%s)', async streaming => {
    const incoming: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = []
    const upstream = await server((req, res, body) => {
      incoming.push({ headers: req.headers, body })
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\ndata: {"type":"message_stop"}\n\n')
      } else json(res, { content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn' })
    })
    const proxy = await server((req, res, body) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      if (req.url?.startsWith('/bili/')) {
        void fetch(req.url.slice(6), { method: 'POST', body: JSON.stringify(body), headers: req.headers as Record<string, string> }).then(async reply => {
          res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') || 'application/json' })
          res.end(await reply.text())
        })
        return
      }
      json(res, { ok: false }, 404)
    })
    const model = new api.AnthropicMessagesModelClient({ id: 'anthropic', type: 'anthropic', baseUrl: upstream, defaultModel: 'claude-test', apiKey: 'fake-test-key', capabilities: { streaming } })
    const runtime = new api.AgentRuntime({ modelClient: model, contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry(), contextKey: 'anthropic-session' })
    expect((await runtime.run({ messages: ['hi'], maxTokens: 1024 })).output.content).toBe('answer')
    expect(incoming[0].headers['x-bili-plugin-conversation']).toBe('anthropic-session')
    expect(incoming[0].headers['x-bili-plugin-max-output']).toBe('1024')
    expect(incoming[0].headers['x-api-key']).toBe('fake-test-key')
    expect(incoming[0].body.tools).toEqual(definitions.map(definition => ({ name: definition.name, description: definition.description, input_schema: definition.parameters })))
  })

  it.each(['chat', 'responses'])('routes %s streaming HTTP requests through bili', async style => {
    let outgoing: IncomingMessage['headers'] | undefined
    let payload: Record<string, unknown> | undefined
    const upstream = await server((req, res, body) => {
      outgoing = req.headers
      payload = body
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(style === 'chat'
        ? 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n'
        : 'data: {"type":"response.output_text.delta","delta":"answer"}\n\ndata: {"type":"response.completed","response":{"id":"r1","output":[]}}\n\n')
    })
    const proxy = await server((req, res, body) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      void fetch(req.url!.slice(6), { method: 'POST', body: JSON.stringify(body), headers: req.headers as Record<string, string> }).then(async reply => {
        res.writeHead(reply.status, { 'content-type': reply.headers.get('content-type') || 'application/json' })
        res.end(await reply.text())
      })
    })
    const config = { id: style, type: 'openai-compatible' as const, baseUrl: upstream, defaultModel: 'test-model', apiKey: 'fake-openai-key' }
    const model = style === 'chat' ? new api.OpenAICompatibleModelClient(config) : new api.OpenAIResponsesModelClient(config)
    const runtime = new api.AgentRuntime({ modelClient: model, contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    expect((await runtime.run({ messages: ['hi'], contextKey: 'stream' })).output.content).toBe('answer')
    expect(outgoing?.['authorization']).toBe('Bearer fake-openai-key')
    expect(outgoing?.['x-bili-plugin-conversation']).toBe('stream')
    expect(payload?.stream).toBe(true)
    expect(payload?.tools).toEqual(style === 'chat' ? manifest.tools.openai : definitions.map(definition => ({ type: 'function', ...definition })))
  })

  it('routes Chat non-streaming HTTP requests through bili with the provider API key', async () => {
    let outgoing: IncomingMessage['headers'] | undefined
    let payload: Record<string, unknown> | undefined
    const upstream = await server((req, res, body) => {
      outgoing = req.headers
      payload = body
      json(res, { choices: [{ message: { content: 'answer' } }] })
    })
    const proxy = await server((req, res, body) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      void fetch(req.url!.slice(6), { method: 'POST', body: JSON.stringify(body), headers: req.headers as Record<string, string> }).then(async reply => json(res, await reply.json()))
    })
    const model = new api.OpenAICompatibleModelClient({ id: 'chat-non-stream', type: 'openai-compatible', baseUrl: upstream, defaultModel: 'test-model', apiKey: 'fake-openai-key', capabilities: { streaming: false } })
    const runtime = new api.AgentRuntime({ modelClient: model, contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    expect((await runtime.run({ messages: ['hi'], contextKey: 'chat-non-stream' })).output.content).toBe('answer')
    expect(outgoing?.['authorization']).toBe('Bearer fake-openai-key')
    expect(outgoing?.['x-bili-plugin-conversation']).toBe('chat-non-stream')
    expect(payload?.stream).toBe(false)
  })

  it('routes Responses non-streaming HTTP requests through bili', async () => {
    let outgoing: IncomingMessage['headers'] | undefined
    const upstream = await server((req, res, body) => {
      outgoing = req.headers
      expect(body.tools).toEqual(definitions.map(definition => ({ type: 'function', ...definition })))
      json(res, { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'answer' }] }] })
    })
    const proxy = await server((req, res, body) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      void fetch(req.url!.slice(6), { method: 'POST', body: JSON.stringify(body), headers: req.headers as Record<string, string> }).then(async reply => json(res, await reply.json()))
    })
    const model = new api.OpenAIResponsesModelClient({ id: 'responses', type: 'openai-compatible', baseUrl: upstream, defaultModel: 'test-model', apiKey: 'fake-openai-key', capabilities: { streaming: false } })
    const runtime = new api.AgentRuntime({ modelClient: model, contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    expect((await runtime.run({ messages: ['hi'], contextKey: 'responses' })).output.content).toBe('answer')
    expect(outgoing?.['authorization']).toBe('Bearer fake-openai-key')
    expect(outgoing?.['x-bili-plugin-conversation']).toBe('responses')
  })

  it('rejects a manifest missing one of the five public tools', async () => {
    const proxy = await server((_req, res) => json(res, { ...manifest, toolNames: ['compress'] }))
    await expect(new api.BillionContextClient({ proxyOrigin: proxy }).manifest()).rejects.toThrow('five public tools')
  })

  it('refuses tool-disabled opt-in instead of announcing incomplete plugin takeover', async () => {
    const proxy = await server((_req, res) => json(res, manifest))
    const runtime = new api.AgentRuntime({ modelClient: client(proxy), contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), toolsEnabled: false })
    await expect(runtime.run({ messages: ['hello'] })).rejects.toThrow('Context management requires toolsEnabled')
  })

  it('includes manifest tools in the estimate before the first run without sending a model request', async () => {
    const paths: string[] = []
    const proxy = await server((req, res) => { paths.push(req.url || ''); json(res, manifest) })
    const runtime = new api.AgentRuntime({ modelClient: client(proxy), contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    expect((await runtime.estimateContext({ messages: ['hello'] })).toolCount).toBe(5)
    expect(paths).toEqual(['/__bili/plugin/manifest'])
  })

  it('preserves native default without adding bili tools or headers', async () => {
    const received: IncomingMessage['headers'][] = []
    const upstream = await server((req, res, body) => {
      received.push(req.headers)
      expect(body.tools).toBeUndefined()
      json(res, { choices: [{ message: { content: 'native' } }] })
    })
    const runtime = new api.AgentRuntime({ modelClient: client(upstream), tools: new api.AgentToolRegistry() })
    expect(runtime.contextManagement).toBe('native')
    expect((await runtime.run({ messages: ['hi'] })).output.content).toBe('native')
    expect(received[0]['x-bili-plugin']).toBeUndefined()
  })

  it('isolates per-run managers, providers and host tool identities on a shared runtime', async () => {
    const received: Array<{ id: string; tools?: unknown[] }> = []
    const calls = new Map<string, number>()
    const proxy = await server((req, res, body) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      const id = String(req.headers['x-bili-plugin-conversation'])
      received.push({ id, tools: body.tools as unknown[] })
      const turn = (calls.get(id) ?? 0) + 1
      calls.set(id, turn)
      json(res, { choices: [{ message: id !== 'undefined' && turn === 1
        ? { tool_calls: [{ id: `host-${id}`, type: 'function', function: { name: 'host_identity', arguments: '{}' } }] }
        : { content: id === 'undefined' ? 'native' : (body.messages as Array<Record<string, unknown>>).find(message => message.role === 'tool')?.content } }] })
    })
    const hostIds: Array<string | undefined> = []
    const executions: Array<{ owner: string | undefined; host: string | undefined; conversation: string | undefined }> = []
    let release!: () => void
    const providersReady = new Promise<void>(resolve => { release = resolve })
    const tools = new api.AgentToolRegistry()
    tools.registerProvider({ id: 'host', listTools: async context => {
      const owner = context?.sessionId
      hostIds.push(owner)
      if (hostIds.length <= 2) {
        if (hostIds.length === 2) release()
        await providersReady
      }
      return owner ? [{ definition: { name: 'host_identity' }, execute: async (_args, executionContext) => {
        executions.push({ owner, host: executionContext?.sessionId, conversation: executionContext?.contextConversationId })
        return { ok: true, content: owner }
      } }] : []
    } })
    const runtime = new api.AgentRuntime({ modelClient: client(proxy), tools, profileId: 'profile-a' })
    const manager = new api.BillionContextManager({ proxyOrigin: proxy })
    const results = await Promise.all(['one', 'two'].map(id => runtime.run({ messages: ['hi'], contextKey: id, contextManager: manager, toolContext: { sessionId: `host-${id}` } })))
    await runtime.run({ messages: ['native'] })
    expect(results.map(result => result.output.content)).toEqual(['host-one', 'host-two'])
    expect(executions.sort((a, b) => a.owner!.localeCompare(b.owner!))).toEqual([
      { owner: 'host-one', host: 'host-one', conversation: 'one' },
      { owner: 'host-two', host: 'host-two', conversation: 'two' },
    ])
    expect(runtime.contextManagement).toBe('native')
    expect(tools.definitions()).toHaveLength(0)
    expect(hostIds.slice(0, 2).sort()).toEqual(['host-one', 'host-two'])
    expect(received.filter(row => row.tools?.length === 6).map(row => row.id).sort()).toEqual(['one', 'one', 'two', 'two'])
    expect(received.at(-1)).toEqual({ id: 'undefined', tools: undefined })
  })

  it('fails closed when a provider replaces an already-owned tool on a later run', async () => {
    let modelCalls = 0
    const proxy = await server((req, res) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      modelCalls++
      json(res, { choices: [{ message: { content: 'ok' } }] })
    })
    const registry = new api.AgentToolRegistry()
    const runtime = new api.AgentRuntime({ modelClient: client(proxy), tools: registry, contextManager: new api.BillionContextManager({ proxyOrigin: proxy }) })
    await runtime.run({ messages: ['first'] })
    registry.registerProvider({ id: 'foreign', listTools: async () => [{ definition: { name: 'compress' }, execute: async () => ({ ok: true, content: 'foreign' }) }] })
    await expect(runtime.run({ messages: ['second'] })).rejects.toThrow('tool collision: compress')
    expect(modelCalls).toBe(1)
  })

  it('preserves public context tool text verbatim through the runtime loop', async () => {
    const raw = '  { "restored" : "' + 'x'.repeat(300_000) + '" }\n'
    let restored: unknown
    let turn = 0
    const proxy = await server((req, res, body) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      if (req.url === '/__bili/plugin/tool') return json(res, { ok: true, result: raw })
      turn += 1
      if (turn === 2) restored = (body.messages as Array<Record<string, unknown>>).find(message => message.role === 'tool')?.content
      json(res, { choices: [{ message: turn === 1
        ? { tool_calls: [{ id: 'restore', type: 'function', function: { name: 'decompress', arguments: '{}' } }] }
        : { content: 'done' } }] })
    })
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), tools: new api.AgentToolRegistry() })
    const result = await runtime.run({ messages: ['restore'], contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), contextKey: 'restore-owner' })
    expect(restored).toBe(raw)
    expect(result.events.find(event => event.type === 'tool.completed')).toMatchObject({ result: { content: raw } })
  })

  it('keeps overflow recovery owned by bili without bypass or native compaction', async () => {
    const paths: string[] = []
    const proxy = await server((req, res) => {
      paths.push(req.url || '')
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      json(res, { error: { message: 'maximum context length exceeded' } }, 400)
    })
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), tools: new api.AgentToolRegistry() })
    await expect(runtime.run({ messages: ['overflow'], contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), contextKey: 'overflow', maxModelRetries: 0 })).rejects.toThrow('maximum context length exceeded')
    expect(paths).toEqual(['/__bili/plugin/manifest', '/__bili/plugin/runtime-info', '/bili/https://example.com/v1/chat/completions'])
    expect(runtime.tools.definitions()).toEqual([])
  })

  it('retains detached scoped subagents for host-session abort without sharing their boundary identity', async () => {
    const seen: string[] = []
    let childStarted!: () => void
    const ready = new Promise<void>(resolve => { childStarted = resolve })
    let mainTurn = 0
    const proxy = await server((req, res) => {
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      const id = String(req.headers['x-bili-plugin-conversation'])
      seen.push(id)
      if (id !== 'background-parent') { childStarted(); return }
      mainTurn += 1
      if (mainTurn === 1) return json(res, { choices: [{ message: { tool_calls: [{ id: 'delegate', type: 'function', function: { name: 'delegate_task', arguments: JSON.stringify({ goal: 'wait', mode: 'background' }) } }] } }] })
      void ready.then(() => json(res, { choices: [{ message: { content: 'main done' } }] }))
    })
    const tools = new api.AgentToolRegistry()
    tools.register(new api.DelegateTaskTool())
    const runtime = new api.AgentRuntime({ modelClient: client('https://example.com/v1'), tools })
    const result = await runtime.run({ messages: ['delegate'], contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), contextKey: 'background-parent', toolContext: { sessionId: 'host-background' } })
    expect(result.output.content).toBe('main done')
    const child = seen.find(id => id !== 'background-parent')!
    expect(child).toMatch(/^[0-9a-f-]{36}$/)
    expect(runtime.hasBackgroundTasks('host-background')).toBe(true)
    expect(runtime.hasBackgroundTasks('unrelated')).toBe(false)
    expect(runtime.requestBoundaryInterrupt({ sessionId: 'host-background' }).status).toBe('not_running')
    expect(await runtime.abortBackgroundTasks('unrelated')).toBe(0)
    expect(await runtime.abortBackgroundTasks('host-background')).toBe(1)
    expect(runtime.hasBackgroundTasks()).toBe(false)
  })

  it('calls every public operation, preserves result text and rejects unsuccessful replies', async () => {
    const received: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
    const proxy = await server((req, res, body) => {
      received.push({ path: req.url || '', method: req.method || '', body })
      if (req.url === '/__bili/plugin/tool') return json(res, { ok: true, result: '  exact result\n' })
      if (req.url === '/__bili/error') return json(res, { ok: false })
      if (req.url === '/__bili/failure') return json(res, { ok: false }, 503)
      json(res, { ok: true, contextTokens: 42, inputTokens: 99000 })
    })
    const bili = new api.BillionContextClient({ proxyOrigin: proxy })
    await bili.register({ agent: 'ekko-agent', customPublicField: 'kept' })
    await bili.runtimeInfo({ agent: 'ekko-agent', model: 'm', conversationId: 'a & b' })
    expect(await bili.tool('a & b', 'compress', { content: 'verbatim' })).toBe('  exact result\n')
    expect(await bili.status('a & b')).toMatchObject({ contextTokens: 42, inputTokens: 99000 })
    await bili.compact('a & b')
    await bili.callPublic('/__bili/plugin/custom', { body: { unchanged: true } })
    expect(received).toEqual([
      { path: '/__bili/plugin/register', method: 'POST', body: { agent: 'ekko-agent', customPublicField: 'kept' } },
      { path: '/__bili/plugin/runtime-info', method: 'POST', body: { agent: 'ekko-agent', model: 'm', conversationId: 'a & b' } },
      { path: '/__bili/plugin/tool', method: 'POST', body: { conversationId: 'a & b', tool: 'compress', args: { content: 'verbatim' } } },
      { path: '/__bili/plugin/status?conversationId=a%20%26%20b', method: 'GET', body: {} },
      { path: '/__bili/plugin/compact', method: 'POST', body: { conversationId: 'a & b' } },
      { path: '/__bili/plugin/custom', method: 'POST', body: { unchanged: true } },
    ])
    await expect(bili.callPublic('/__bili/error')).rejects.toThrow('unsuccessful response')
    await expect(bili.callPublic('/__bili/failure')).rejects.toThrow('HTTP 503')
    await expect(bili.callPublic('https://example.com/__bili/plugin/tool')).rejects.toThrow('must stay under')
  })

  it('rejects absent tool schemas and does not send the model request', async () => {
    const paths: string[] = []
    const proxy = await server((req, res) => { paths.push(req.url || ''); json(res, { ...manifest, tools: { openai: [] } }) })
    const runtime = new api.AgentRuntime({ modelClient: client(proxy), contextManager: new api.BillionContextManager({ proxyOrigin: proxy }), tools: new api.AgentToolRegistry() })
    await expect(runtime.run({ messages: ['hello'] })).rejects.toThrow('missing or duplicate tool schemas')
    expect(paths).toEqual(['/__bili/plugin/manifest'])
  })

  it('rejects context headers with invalid token budgets before issuing HTTP calls', async () => {
    expect(() => new api.BillionContextManager({ proxyOrigin: 'http://127.0.0.1:8787', contextWindow: -1 })).toThrow('contextWindow')
  })

  it('opts in through manifest tools, proxy routing and stable conversation headers', async () => {
    expect(api.BillionContextManager).toBeTypeOf('function')
    const outgoing: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = []
    const upstream = await server((req, res, body) => {
      outgoing.push({ headers: req.headers, body })
      json(res, { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 90000, completion_tokens: 3, total_tokens: 90003 } })
    })
    const control: Array<{ path: string; body: Record<string, unknown> }> = []
    const proxy = await server((req, res, body) => {
      control.push({ path: req.url || '', body })
      if (req.url === '/__bili/plugin/manifest') return json(res, manifest)
      if (req.url === '/__bili/plugin/runtime-info') return json(res, { ok: true })
      if (req.url?.startsWith('/bili/')) {
        void fetch(req.url.slice('/bili/'.length), { method: 'POST', headers: req.headers as Record<string, string>, body: JSON.stringify(body) }).then(async reply => json(res, await reply.json()))
        return
      }
      json(res, { ok: false }, 404)
    })
    const manager = new api.BillionContextManager({ proxyOrigin: proxy, contextWindow: 200000 })
    const runtime = new api.AgentRuntime({ modelClient: client(upstream), contextManager: manager, tools: new api.AgentToolRegistry(), contextKey: 'conversation-1', profileId: 'profile-a' })
    expect(runtime.contextManagement).toBe('billion-context')
    await runtime.run({ messages: ['first'] })
    const result = await runtime.run({ messages: ['second'] })
    expect(outgoing).toHaveLength(2)
    for (const request of outgoing) {
      expect(request.headers['x-bili-plugin']).toBe('ekko-agent')
      expect(request.headers['x-bili-plugin-agent']).toBe('main')
      expect(request.headers['x-bili-plugin-conversation']).toBe('conversation-1')
      expect(request.headers['x-bili-plugin-context-window']).toBe('200000')
      expect(request.body.tools).toEqual(definitions.map(fn => ({ type: 'function', function: fn })))
    }
    expect(control.filter(request => request.path === '/__bili/plugin/manifest')).toHaveLength(1)
    expect(control.find(request => request.path === '/__bili/plugin/runtime-info')?.body).toMatchObject({ agent: 'ekko-agent', conversationId: 'conversation-1', model: 'test-model', contextWindow: 200000 })
    expect(result.output.usage?.inputTokens).toBe(90000)
    expect(result.contextEstimate!.contextTokens).toBeLessThan(90000)
  })
})
