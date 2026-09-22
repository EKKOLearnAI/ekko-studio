import { describe, expect, it, vi } from 'vitest'
import {
  AgentRuntime,
  AgentToolRegistry,
  AnthropicMessagesModelClient,
  collectModelEvents,
  ModelProviderError,
  ModelProviderRegistry,
  authorizedModelProviderPreset,
  createModelClient,
  modelResponseToAgentMessage,
  normalizeAnthropicResponse,
  normalizeGeminiResponse,
  toAnthropicMessagesPayload,
  toGeminiContentsPayload,
  normalizeOpenAIChatResponse,
  normalizeOpenAIResponsesResponse,
  resolveModelProviderConfigs,
  toOpenAIResponsesPayload,
  toOpenAIChatPayload,
  toPromptCompletionPayload,
} from '../../packages/ekko-agent/src/index'
import type { ModelProviderConfig } from '../../packages/ekko-agent/src/index'

const providerConfig: ModelProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',
}

describe('ekko-agent model requests', () => {
  it('replays streamed DeepSeek reasoning_content through a complete tool loop', async () => {
    const encoder = new TextEncoder()
    let call = 0
    const requestBodies: Array<Record<string, any>> = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      call += 1
      const frames = call === 1
        ? [
            'data: {"id":"chatcmpl_tool","model":"deepseek-chat","choices":[{"delta":{"reasoning_content":"I need the weather tool.","tool_calls":[{"index":0,"id":"call_weather","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"Xiamen\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ]
        : [
            'data: {"id":"chatcmpl_final","model":"deepseek-chat","choices":[{"delta":{"content":"Sunny"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame))
          controller.close()
        },
      }), { status: 200 })
    })
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      async execute(input) {
        return { ok: true, content: `${input.city}: Sunny` }
      },
    })
    const client = createModelClient(providerConfig, { fetch: fetchMock })
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const result = await runtime.run({ messages: ['Check Xiamen weather'] })

    expect(result.output.content).toBe('Sunny')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBodies[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: '',
        reasoning_content: 'I need the weather tool.',
        tool_calls: [expect.objectContaining({ id: 'call_weather' })],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'call_weather',
        content: 'Xiamen: Sunny',
      }),
    ]))
  })

  it('retries a streamed response whose tool call has an empty function name', async () => {
    const encoder = new TextEncoder()
    let call = 0
    const fetchMock = vi.fn(async () => {
      call += 1
      const frames = call === 1
        ? [
            'data: {"id":"chatcmpl_invalid","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_invalid","type":"function","function":{"name":"","arguments":""}}]},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ]
        : [
            'data: {"id":"chatcmpl_recovered","choices":[{"delta":{"content":"Recovered"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame))
          controller.close()
        },
      }), { status: 200 })
    })
    const client = createModelClient(providerConfig, { fetch: fetchMock })
    const runtime = new AgentRuntime({ modelClient: client })

    const result = await runtime.run({ messages: ['Answer without an empty tool call.'] })

    expect(result.output.content).toBe('Recovered')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'model.retry',
        error: expect.stringContaining('complete id and function name'),
      }),
    ]))
  })

  it('filters invalid Chat tool history and its orphaned tool result', () => {
    const payload = toOpenAIChatPayload(providerConfig, {
      messages: [
        { role: 'user', content: 'Check the weather.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_invalid', name: '', arguments: {} }],
        },
        {
          role: 'tool',
          content: 'orphaned result',
          toolCallId: 'call_invalid',
          name: '',
        },
        { role: 'user', content: 'Try again.' },
      ],
      tools: [{ name: 'weather', parameters: { type: 'object' } }],
    })

    expect(payload.messages).toEqual([
      expect.objectContaining({ role: 'user', content: 'Check the weather.' }),
      expect.objectContaining({ role: 'user', content: 'Try again.' }),
    ])
  })

  it('normalizes empty Chat tool arguments and drops incomplete parallel calls', () => {
    const response = normalizeOpenAIChatResponse('deepseek', {
      choices: [{
        message: {
          content: '',
          tool_calls: [
            { id: 'call_valid', type: 'function', function: { name: 'weather', arguments: '' } },
            { id: 'call_invalid', type: 'function', function: { name: '', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    })

    expect(response.toolCalls).toEqual([{
      id: 'call_valid',
      name: 'weather',
      arguments: {},
      rawArguments: '{}',
    }])
  })

  it('remembers image-rejecting Chat targets across client instances', async () => {
    const model = `text-only-memory-test-${Date.now()}-${Math.random()}`
    const config: ModelProviderConfig = {
      id: 'custom:adaptive-chat-test',
      type: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://adaptive-chat.example.com/v1',
      defaultModel: model,
    }
    const bodies: Array<Record<string, any>> = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length === 1) {
        return new Response(JSON.stringify({
          error: {
            message: 'Failed to deserialize messages[14]: unknown variant `image_url`, expected `text`',
          },
        }), { status: 400 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Text fallback worked.' }, finish_reason: 'stop' }],
      }), { status: 200 })
    })
    const request = {
      messages: [{
        role: 'user' as const,
        content: 'Keep this text.',
        contentParts: [{ type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }],
      }],
    }

    await expect(createModelClient(config, { fetch: fetchMock }).create(request))
      .resolves.toMatchObject({ content: 'Text fallback worked.' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(bodies[0])).toContain('image_url')
    expect(JSON.stringify(bodies[1])).not.toContain('image_url')
    expect(JSON.stringify(bodies[1])).toContain('Keep this text.')

    await expect(createModelClient(config, { fetch: fetchMock }).create(request))
      .resolves.toMatchObject({ content: 'Text fallback worked.' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(bodies[2])).not.toContain('image_url')
  })

  it('completes a Codex Responses tool loop when terminal output arrays are empty', async () => {
    const encoder = new TextEncoder()
    let call = 0
    const requestBodies: Array<Record<string, any>> = []
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      call += 1
      const frames = call === 1
        ? [
            'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_weather","name":"weather","arguments":"{\\"city\\":\\"Xiamen\\"}"}}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","output":[]}}\n\n',
          ]
        : [
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Sunny"}\n\n',
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_final","status":"completed","output":[]}}\n\n',
          ]
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame))
          controller.close()
        },
      }), { status: 200 })
    })
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
      async execute(input) {
        return { ok: true, content: `${input.city}: 30C` }
      },
    })
    const client = createModelClient({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5.6-terra',
    }, { fetch: fetchMock })
    const runtime = new AgentRuntime({ modelClient: client, tools })

    const result = await runtime.run({ messages: ['Check Xiamen weather'] })

    expect(result.output.content).toBe('Sunny')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBodies[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_weather',
        name: 'weather',
      }),
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: 'Xiamen: 30C',
      },
    ]))
    expect(requestBodies.every(body => body.stream === true)).toBe(true)
  })

  it('defines first-class request presets for authorized providers', () => {
    expect(authorizedModelProviderPreset('nous')).toMatchObject({
      id: 'nous',
      baseUrl: 'https://inference-api.nousresearch.com/v1',
      requestStyle: 'openai-chat',
    })
    expect(authorizedModelProviderPreset('openai-codex')).toMatchObject({
      id: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiMode: 'codex_responses',
      requestStyle: 'openai-responses',
    })
    expect(authorizedModelProviderPreset('xai-oauth')).toMatchObject({
      id: 'xai-oauth',
      baseUrl: 'https://api.x.ai/v1',
      requestStyle: 'openai-responses',
    })
    expect(authorizedModelProviderPreset('qwen-oauth')).toMatchObject({
      id: 'qwen-oauth',
      baseUrl: 'https://portal.qwen.ai/v1',
      apiMode: 'chat_completions',
      requestStyle: 'openai-chat',
    })
    expect(authorizedModelProviderPreset('claude-oauth')).toMatchObject({
      id: 'claude-oauth',
      baseUrl: 'https://api.anthropic.com',
      requestStyle: 'anthropic-messages',
    })
    expect(authorizedModelProviderPreset('minimax-oauth')).toMatchObject({
      id: 'minimax-oauth',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiMode: 'anthropic_messages',
      requestStyle: 'anthropic-messages',
    })
  })

  it.each([
    {
      provider: 'nous',
      url: 'https://inference-api.nousresearch.com/v1/chat/completions',
      response: { choices: [{ message: { content: 'Nous' }, finish_reason: 'stop' }] },
      expectedContent: 'Nous',
    },
    {
      provider: 'xai-oauth',
      url: 'https://api.x.ai/v1/responses',
      response: { output_text: 'xAI', status: 'completed' },
      expectedContent: 'xAI',
    },
  ])('sends $provider access tokens to its default endpoint', async ({
    provider,
    url,
    response,
    expectedContent,
  }) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response)))
    const resolved = resolveModelProviderConfigs({
      provider,
      apiKey: 'oauth-access-token',
      model: 'test-model',
    })
    const client = createModelClient(resolved.providerConfig, { fetch: fetchMock })

    const result = await client.create({ messages: [{ role: 'user', content: 'Hello' }] })

    expect(result.content).toBe(expectedContent)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(url)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer oauth-access-token',
    })
  })

  it('sends Codex OAuth identity headers to the ChatGPT Responses endpoint', async () => {
    const tokenPayload = Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' },
    })).toString('base64url')
    const accessToken = `header.${tokenPayload}.signature`
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Codex"}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_codex","status":"completed","output":[]}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const resolved = resolveModelProviderConfigs({
      provider: 'openai-codex',
      apiKey: accessToken,
      model: 'gpt-5-codex',
    })

    const result = await createModelClient(resolved.providerConfig, { fetch: fetchMock }).create({
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { session_id: 'session-1', profile: 'default' },
      maxTokens: 1024,
      temperature: 0.2,
    })

    expect(result.content).toBe('Codex')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${accessToken}`,
      'user-agent': 'codex_cli_rs/0.0.0 (Ekko Agent)',
      originator: 'codex_cli_rs',
      'ChatGPT-Account-ID': 'account-123',
    })
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).toMatchObject({ store: false, stream: true })
    expect(requestBody).not.toHaveProperty('metadata')
    expect(requestBody).not.toHaveProperty('max_output_tokens')
    expect(requestBody).not.toHaveProperty('temperature')
  })

  it('keeps Codex streamed text when the terminal response output is empty', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"OK"}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.6-terra","status":"completed","output":[],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const client = createModelClient({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5.6-terra',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'Hello' }],
    })) events.push(event)

    expect(events).toContainEqual({ type: 'text-delta', text: 'OK' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({ content: 'OK', finishReason: 'completed' }),
    }))
  })

  it('requests and streams Responses reasoning summaries', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        reasoning: {
          effort: 'high',
          summary: 'auto',
        },
      })
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Checked the constraints."}\n\n'))
          controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done"}\n\n'))
          controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_reasoning","status":"completed","output":[]}}\n\n'))
          controller.close()
        },
      }), { status: 200 })
    })
    const client = createModelClient({
      id: 'custom:responses',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      defaultModel: 'reasoning-model',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'Solve it' }],
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
    })) events.push(event)

    expect(events).toContainEqual({ type: 'reasoning-delta', text: 'Checked the constraints.' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({
        content: 'Done',
        reasoning: { text: 'Checked the constraints.' },
      }),
    }))
  })

  it('routes Responses commentary-phase messages through the reasoning channel', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_commentary","type":"message","phase":"commentary","content":[]}}\n\n'))
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_commentary","delta":"**Loading model skill**"}\n\n'))
        controller.enqueue(encoder.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_commentary","type":"message","phase":"commentary","content":[{"type":"output_text","text":"**Loading model skill**"}]}}\n\n'))
        controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_final","type":"message","phase":"final_answer","content":[]}}\n\n'))
        controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":1,"item_id":"msg_final","delta":"Ready."}\n\n'))
        controller.enqueue(encoder.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"id":"msg_final","type":"message","phase":"final_answer","content":[{"type":"output_text","text":"Ready."}]}}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_commentary","status":"completed","output":[]}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const client = createModelClient({
      id: 'custom:responses',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      defaultModel: 'reasoning-model',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'Use the model skill.' }],
    })) events.push(event)

    expect(events).toContainEqual({ type: 'reasoning-delta', text: '**Loading model skill**' })
    expect(events).not.toContainEqual({ type: 'text-delta', text: '**Loading model skill**' })
    expect(events).toContainEqual({ type: 'text-delta', text: 'Ready.' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({
        content: 'Ready.',
        reasoning: { text: '**Loading model skill**' },
      }),
    }))
  })

  it('keeps non-Codex Responses create requests non-streaming', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output_text: 'xAI',
      status: 'completed',
    })))
    const client = createModelClient({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-4.5',
    }, { fetch: fetchMock })

    const response = await client.create({ messages: [{ role: 'user', content: 'Hello' }] })
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))

    expect(response.content).toBe('xAI')
    expect(requestBody.stream).toBe(false)
  })

  it('emits Responses function calls from output item events', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}\n\n'))
        controller.enqueue(encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[]}}\n\n'))
        controller.close()
      },
    }), { status: 200 }))
    const client = createModelClient({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      apiKey: 'token',
      defaultModel: 'gpt-5.6-terra',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({ messages: [{ role: 'user', content: 'Read it' }] })) {
      events.push(event)
    }

    expect(events).toContainEqual({
      type: 'tool-call',
      toolCall: {
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'README.md' },
        rawArguments: '{"path":"README.md"}',
      },
    })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'done',
      response: expect.objectContaining({
        toolCalls: [expect.objectContaining({ id: 'call_1', name: 'read_file' })],
      }),
    }))
  })

  it('omits unsupported metadata from xAI OAuth Responses requests', async () => {
    const payload = toOpenAIResponsesPayload({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'grok-4.5',
    }, {
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { session_id: 'session-1', profile: 'default' },
      context: { responseId: 'response-from-first-turn' },
    })

    expect(payload).not.toHaveProperty('metadata')
    expect(payload.previous_response_id).toBeUndefined()
  })

  it('omits tool choice from every provider payload when no tools are present', async () => {
    const request = {
      messages: [{ role: 'user' as const, content: 'Compress this context.' }],
      toolChoice: 'none' as const,
      stream: false,
    }
    const responsesPayload = toOpenAIResponsesPayload({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'grok-4.5',
    }, request)
    const chatPayload = toOpenAIChatPayload(providerConfig, request)
    const anthropicPayload = toAnthropicMessagesPayload({
      id: 'anthropic',
      type: 'anthropic',
      defaultModel: 'claude-sonnet',
    }, request)

    for (const payload of [responsesPayload, chatPayload, anthropicPayload]) {
      expect(payload).not.toHaveProperty('tools')
      expect(payload).not.toHaveProperty('tool_choice')
    }

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: 'OK' })))
    const customClient = createModelClient({
      id: 'runtime',
      type: 'custom',
      requestStyle: 'custom-runtime',
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'runtime-agent',
    }, { fetch: fetchMock })
    await customClient.create(request)

    const customPayload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(customPayload).not.toHaveProperty('tools')
    expect(customPayload).not.toHaveProperty('toolChoice')
  })

  it('preserves tool choice when provider payloads include tools', () => {
    const request = {
      messages: [{ role: 'user' as const, content: 'Use the tool.' }],
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
      toolChoice: 'required' as const,
    }

    expect(toOpenAIResponsesPayload({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'grok-4.5',
    }, request)).toMatchObject({
      tools: [expect.objectContaining({ name: 'lookup' })],
      tool_choice: 'required',
    })
    expect(toOpenAIChatPayload(providerConfig, request)).toMatchObject({
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'lookup' }) })],
      tool_choice: 'required',
    })
    expect(toAnthropicMessagesPayload({
      id: 'anthropic',
      type: 'anthropic',
      defaultModel: 'claude-sonnet',
    }, request)).toMatchObject({
      tools: [expect.objectContaining({ name: 'lookup' })],
      tool_choice: { type: 'any' },
    })
  })

  it('omits tool choice for DeepSeek thinking models across providers', () => {
    const request = {
      messages: [{ role: 'user' as const, content: 'Remember this.' }],
      tools: [{ name: 'memory_write', parameters: { type: 'object' } }],
      toolChoice: 'required' as const,
    }
    const thinkingPayload = toOpenAIChatPayload({
      id: 'custom:deepseek-relay',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      baseUrl: 'https://relay.example/v1',
      defaultModel: 'deepseek/deepseek-v4-flash',
    }, request)
    const legacyNonThinkingPayload = toOpenAIChatPayload({
      id: 'custom:deepseek-relay',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      baseUrl: 'https://relay.example/v1',
      defaultModel: 'deepseek-chat',
    }, request)

    expect(thinkingPayload).toMatchObject({
      tools: [expect.objectContaining({
        function: expect.objectContaining({ name: 'memory_write' }),
      })],
    })
    expect(thinkingPayload).not.toHaveProperty('tool_choice')
    expect(legacyNonThinkingPayload.tool_choice).toBe('required')
  })

  it('strips tool choice inside AgentRuntime when its tool registry is empty', async () => {
    const create = vi.fn(async () => ({ content: 'done' }))
    const runtime = new AgentRuntime({
      modelClient: {
        provider: 'test',
        requestStyle: 'custom-runtime',
        capabilities: {
          streaming: false,
          tools: true,
          vision: false,
          jsonMode: false,
          systemPrompt: true,
        },
        create,
        stream: vi.fn(),
      },
      toolsEnabled: false,
      modelDefaults: {
        model: 'test-model',
        toolChoice: 'none',
      },
    })

    await runtime.run({ messages: ['Hello'] })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'test-model',
      tools: undefined,
      toolChoice: undefined,
    }))
  })

  it('sends Qwen OAuth identity headers to the Portal Chat Completions endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'Qwen' }, finish_reason: 'stop' }],
    })))
    const resolved = resolveModelProviderConfigs({
      provider: 'qwen-oauth',
      apiKey: 'qwen-access-token',
      model: 'qwen3-coder-plus',
    })

    const result = await createModelClient(resolved.providerConfig, { fetch: fetchMock }).create({
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(result.content).toBe('Qwen')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://portal.qwen.ai/v1/chat/completions')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer qwen-access-token',
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-AuthType': 'qwen-oauth',
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      }],
      vl_high_resolution_images: true,
    })
  })

  it('resolves provider configs from explicit api mode with inferred fallback', () => {
    const resolved = resolveModelProviderConfigs({
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'secret',
      model: 'glm-5.2',
      apiMode: 'codex_responses',
    })

    expect(resolved.providerConfig).toMatchObject({
      id: 'glm',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKey: 'secret',
      defaultModel: 'glm-5.2',
      timeoutMs: 300_000,
      capabilities: { vision: false },
    })
    expect(resolved.fallbackProviderConfig).toMatchObject({
      requestStyle: 'openai-chat',
      defaultModel: 'glm-5.2',
      capabilities: { vision: false },
    })
  })

  it('marks GLM V models as vision-capable while keeping text GLM models text-only', () => {
    const text = resolveModelProviderConfigs({
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: 'glm-5.3',
      apiMode: 'codex_responses',
    })
    const vision = resolveModelProviderConfigs({
      provider: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: 'glm-5v-turbo',
      apiMode: 'chat_completions',
    })

    expect(text.providerConfig.capabilities?.vision).toBe(false)
    expect(vision.providerConfig.capabilities?.vision).toBe(true)
  })

  it('infers anthropic provider configs from anthropic URLs', () => {
    const resolved = resolveModelProviderConfigs({
      provider: 'custom',
      baseUrl: 'https://api.z.ai/api/anthropic',
      model: 'glm-5.2',
    })

    expect(resolved.providerConfig).toMatchObject({
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
    })
    expect(resolved.fallbackProviderConfig).toBeUndefined()
  })

  it('converts internal requests to OpenAI-compatible chat payloads', () => {
    const payload = toOpenAIChatPayload(providerConfig, {
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'List files.' },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
      temperature: 0.2,
      maxTokens: 1024,
      metadata: { session_id: 'session-1', profile: 'default' },
    })

    expect(payload).toMatchObject({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'List files.' },
      ],
      temperature: 0.2,
      max_tokens: 1024,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
          },
        },
      ],
    })
    expect(payload).not.toHaveProperty('metadata')
  })

  it('replays assistant reasoning_content for providers that require it during tool calls', () => {
    const payload = toOpenAIChatPayload(providerConfig, {
      messages: [
        { role: 'user', content: 'Check the weather.' },
        {
          role: 'assistant',
          content: '',
          reasoning: { text: 'I need the weather tool.' },
          toolCalls: [{
            id: 'call_weather',
            name: 'weather',
            arguments: { city: 'Xiamen' },
          }],
        },
        {
          role: 'tool',
          content: 'Sunny',
          toolCallId: 'call_weather',
          name: 'weather',
        },
      ],
    })

    expect(payload.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: 'I need the weather tool.',
      tool_calls: [expect.objectContaining({ id: 'call_weather' })],
    })
    expect(payload.messages[1]).not.toHaveProperty('reasoning')
  })

  it('includes empty reasoning_content for synthetic DeepSeek tool-call messages', () => {
    const payload = toOpenAIChatPayload(providerConfig, {
      messages: [
        { role: 'user', content: 'Use the matched skill.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'skill-auto-1',
            name: 'skill_view',
            arguments: { name: 'matched-skill' },
          }],
        },
        {
          role: 'tool',
          content: 'Matched skill instructions.',
          toolCallId: 'skill-auto-1',
          name: 'skill_view',
        },
      ],
      tools: [{ name: 'memory_search' }],
    })

    expect(payload.messages[1]).toMatchObject({
      role: 'assistant',
      content: '',
      reasoning_content: '',
      tool_calls: [expect.objectContaining({ id: 'skill-auto-1' })],
    })
  })

  it.each([
    {
      id: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2-thinking',
    },
    {
      id: 'xiaomi',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2-flash',
    },
    {
      id: 'qwen-oauth',
      baseUrl: 'https://portal.qwen.ai/v1',
      model: 'qwen3.7-plus',
    },
    {
      id: 'glm',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: 'glm-5.2',
    },
  ])('maps unified reasoning to reasoning_content for $model', ({ id, baseUrl, model }) => {
    const payload = toOpenAIChatPayload({
      id,
      type: 'openai-compatible',
      baseUrl,
      defaultModel: model,
    }, {
      messages: [{
        role: 'assistant',
        content: '',
        reasoning: { text: 'Previous analysis.' },
        toolCalls: [{
          id: 'call_1',
          name: 'lookup',
          arguments: { q: 'weather' },
        }],
      }],
    })

    expect(payload.messages[0]).toMatchObject({
      reasoning_content: 'Previous analysis.',
    })
    expect(payload.messages[0]?.content).not.toBeNull()
    expect(payload.messages[0]).not.toHaveProperty('reasoning')
  })

  it('allows an OpenAI Chat provider to override its reasoning replay format', () => {
    const message = {
      role: 'assistant' as const,
      content: 'Previous answer.',
      reasoning: { text: 'Previous analysis.' },
    }
    const reasoningContentPayload = toOpenAIChatPayload({
      id: 'custom:reasoning-content',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      openAIChatReasoningReplayFormat: 'reasoning_content',
      baseUrl: 'https://chat.example/v1',
      defaultModel: 'custom-model',
    }, { messages: [message] })
    const disabledPayload = toOpenAIChatPayload({
      id: 'custom:no-reasoning-replay',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      openAIChatReasoningReplayFormat: 'none',
      baseUrl: 'https://strict.example/v1',
      defaultModel: 'strict-chat',
    }, { messages: [message] })

    expect(reasoningContentPayload.messages[0]).toMatchObject({
      reasoning_content: 'Previous analysis.',
    })
    expect(reasoningContentPayload.messages[0]).not.toHaveProperty('reasoning')
    expect(disabledPayload.messages[0]).not.toHaveProperty('reasoning')
    expect(disabledPayload.messages[0]).not.toHaveProperty('reasoning_content')
    expect(disabledPayload.messages[0]).not.toHaveProperty('reasoning_details')
  })

  it('uses one reasoning field for OpenRouter fallback and other compatible endpoints', () => {
    const messages = [{
      role: 'assistant' as const,
      content: 'Previous answer.',
      reasoning: { text: 'Previous analysis.' },
    }]
    const openRouterPayload = toOpenAIChatPayload({
      id: 'openrouter',
      type: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'anthropic/claude-sonnet-4.6',
    }, { messages })
    const strictPayload = toOpenAIChatPayload({
      id: 'custom:strict',
      type: 'openai-compatible',
      baseUrl: 'https://strict.example/v1',
      defaultModel: 'strict-chat',
    }, { messages })

    expect(openRouterPayload.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'Previous answer.',
      reasoning: 'Previous analysis.',
    })
    expect(openRouterPayload.messages[0]).not.toHaveProperty('reasoning_content')
    expect(strictPayload.messages[0]).toMatchObject({
      reasoning: 'Previous analysis.',
    })
    expect(strictPayload.messages[0]).not.toHaveProperty('reasoning_content')
  })

  it('preserves OpenRouter reasoning_details signatures across a streamed tool loop', async () => {
    const encoder = new TextEncoder()
    let call = 0
    const requestBodies: Array<Record<string, any>> = []
    const reasoningDetails = [{
      type: 'reasoning.text',
      text: 'I need the weather tool.',
      signature: 'openrouter-signature',
      index: 0,
    }]
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      call += 1
      const frames = call === 1
        ? [
            `data: ${JSON.stringify({
              id: 'chatcmpl_tool',
              model: 'anthropic/claude-sonnet-4.6',
              choices: [{
                delta: {
                  reasoning_details: reasoningDetails,
                  tool_calls: [{
                    index: 0,
                    id: 'call_weather',
                    type: 'function',
                    function: { name: 'weather', arguments: '{"city":"Xiamen"}' },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
            })}\n\n`,
            'data: [DONE]\n\n',
          ]
        : [
            'data: {"id":"chatcmpl_final","choices":[{"delta":{"content":"Sunny"},"finish_reason":"stop"}]}\n\n',
            'data: [DONE]\n\n',
          ]
      return new Response(new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame))
          controller.close()
        },
      }), { status: 200 })
    })
    const tools = new AgentToolRegistry()
    tools.register({
      definition: {
        name: 'weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
      async execute() {
        return { ok: true, content: 'Sunny' }
      },
    })
    const runtime = new AgentRuntime({
      modelClient: createModelClient({
        id: 'openrouter',
        type: 'openai-compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'test-key',
        defaultModel: 'anthropic/claude-sonnet-4.6',
      }, { fetch: fetchMock }),
      tools,
    })

    await runtime.run({ messages: ['Check Xiamen weather'] })

    expect(requestBodies[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        reasoning_details: reasoningDetails,
        tool_calls: [expect.objectContaining({ id: 'call_weather' })],
      }),
    ]))
    expect(requestBodies[1]?.messages[1]).not.toHaveProperty('reasoning')
    expect(requestBodies[1]?.messages[1]).not.toHaveProperty('reasoning_content')
  })

  it('normalizes OpenAI-compatible responses into the internal shape', () => {
    const response = normalizeOpenAIChatResponse('deepseek', {
      id: 'chatcmpl_1',
      model: 'deepseek-chat',
      choices: [
        {
          message: {
            content: 'Done.',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"README.md"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 7 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })

    expect(response).toMatchObject({
      id: 'chatcmpl_1',
      model: 'deepseek-chat',
      content: 'Done.',
      finishReason: 'tool_calls',
      usage: {
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 7,
        reasoningTokens: 2,
      },
      toolCalls: [
        {
          id: 'call_1',
          name: 'read_file',
          arguments: { path: 'README.md' },
        },
      ],
    })
  })

  it('creates OpenAI-compatible clients through the registry', () => {
    const registry = new ModelProviderRegistry()
    registry.register(providerConfig)

    const client = registry.create('deepseek', {
      fetch: vi.fn(),
    })

    expect(client.provider).toBe('deepseek')
    expect(client.requestStyle).toBe('openai-chat')
    expect(client.capabilities.tools).toBe(true)
    expect(registry.list()).toHaveLength(1)
  })

  it('creates clients for every supported request style', () => {
    expect(createModelClient({
      id: 'openai-responses',
      type: 'openai',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-4.1',
    }).requestStyle).toBe('openai-responses')

    expect(createModelClient({
      id: 'claude',
      type: 'anthropic',
      defaultModel: 'claude-sonnet',
    }).requestStyle).toBe('anthropic-messages')

    expect(createModelClient({
      id: 'gemini',
      type: 'gemini',
      defaultModel: 'gemini-2.5-pro',
    }).requestStyle).toBe('gemini-contents')

    expect(createModelClient({
      id: 'legacy',
      type: 'custom',
      requestStyle: 'prompt-completion',
      defaultModel: 'legacy-text',
    }).requestStyle).toBe('prompt-completion')

    expect(createModelClient({
      id: 'runtime',
      type: 'custom',
      defaultModel: 'runtime-agent',
    }).requestStyle).toBe('custom-runtime')
  })

  it('converts internal requests to self-contained OpenAI Responses payloads', () => {
    const payload = toOpenAIResponsesPayload({
      id: 'openai',
      type: 'openai',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-4.1',
    }, {
      messages: [
        { role: 'system', content: 'Be direct.' },
        { role: 'user', content: 'Search docs.' },
      ],
      tools: [{ name: 'search', parameters: { type: 'object' } }],
      maxTokens: 500,
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      metadata: { session_id: 'session-1', profile: 'default' },
      context: { responseId: 'resp_previous' },
    })

    expect(payload).toMatchObject({
      model: 'gpt-4.1',
      instructions: 'Be direct.',
      input: [{ role: 'user', content: 'Search docs.' }],
      max_output_tokens: 500,
      reasoning: { effort: 'medium', summary: 'auto' },
      tools: [{ type: 'function', name: 'search' }],
      store: false,
    })
    expect(payload).not.toHaveProperty('metadata')
    expect(payload).not.toHaveProperty('previous_response_id')
  })

  it('omits internal metadata from custom runtime HTTP requests', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: 'OK' })))
    const client = createModelClient({
      id: 'runtime',
      type: 'custom',
      requestStyle: 'custom-runtime',
      baseUrl: 'http://127.0.0.1:11434',
      defaultModel: 'runtime-agent',
    }, { fetch: fetchMock })

    await client.create({
      messages: [{ role: 'user', content: 'Hello' }],
      metadata: { session_id: 'session-1', profile: 'default' },
    })

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody).not.toHaveProperty('metadata')
  })

  it('replays Responses tool calls and results with native input item types', () => {
    const payload = toOpenAIResponsesPayload({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-5.6-terra',
    }, {
      messages: [
        { role: 'user', content: 'Check the weather.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call_weather',
            name: 'web_search',
            arguments: { query: 'Xiamen weather today' },
            rawArguments: '{"query":"Xiamen weather today"}',
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_weather',
          name: 'web_search',
          content: 'Sunny, 30°C',
        },
      ],
    })

    expect(payload.input).toEqual([
      { role: 'user', content: 'Check the weather.' },
      {
        type: 'function_call',
        call_id: 'call_weather',
        name: 'web_search',
        arguments: '{"query":"Xiamen weather today"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather',
        output: 'Sunny, 30°C',
      },
    ])
  })

  it('replays encrypted OpenAI Responses reasoning items without flattening them', () => {
    const response = normalizeOpenAIResponsesResponse({
      id: 'resp_reasoning',
      model: 'gpt-5.4',
      status: 'completed',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Checked the weather.' }],
          encrypted_content: 'encrypted-reasoning',
          status: 'completed',
        },
        {
          type: 'function_call',
          call_id: 'call_weather',
          name: 'weather',
          arguments: '{"city":"Xiamen"}',
        },
      ],
    })
    const message = modelResponseToAgentMessage(response)
    const payload = toOpenAIResponsesPayload({
      id: 'openai',
      type: 'openai',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-5.4',
    }, {
      messages: [message],
    })

    expect(message.reasoning).toEqual({
      text: 'Checked the weather.',
      native: {
        format: 'openai-responses-items',
        data: [expect.objectContaining({
          id: 'rs_1',
          type: 'reasoning',
          encrypted_content: 'encrypted-reasoning',
        })],
      },
    })
    expect(payload.include).toEqual(['reasoning.encrypted_content'])
    expect(payload.input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Checked the weather.' }],
        encrypted_content: 'encrypted-reasoning',
        status: 'completed',
      },
      {
        type: 'function_call',
        call_id: 'call_weather',
        name: 'weather',
        arguments: '{"city":"Xiamen"}',
      },
    ])
  })

  it('only asks the official OpenAI Responses endpoint for encrypted reasoning', () => {
    const request = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
    }
    const xaiPayload = toOpenAIResponsesPayload({
      id: 'xai-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      baseUrl: 'https://api.x.ai/v1',
      defaultModel: 'grok-code',
    }, request)
    const codexPayload = toOpenAIResponsesPayload({
      id: 'openai-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: 'gpt-5-codex',
    }, request)

    expect(xaiPayload).not.toHaveProperty('include')
    expect(codexPayload).not.toHaveProperty('include')
  })

  it('omits invalid empty-name tool history from Responses replay', () => {
    const payload = toOpenAIResponsesPayload({
      id: 'custom:fun-codex',
      type: 'openai-compatible',
      requestStyle: 'openai-responses',
      defaultModel: 'gpt-5.5',
    }, {
      messages: [
        { role: 'user', content: 'Check the weather.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{
            id: 'call_invalid',
            name: '',
            arguments: { url: 'https://example.com' },
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_invalid',
          name: '',
          content: 'Unknown tool: ',
        },
        { role: 'user', content: 'Try again.' },
      ],
    })

    expect(payload.input).toEqual([
      { role: 'user', content: 'Check the weather.' },
      { role: 'user', content: 'Try again.' },
    ])
  })

  it('converts internal requests to Anthropic Messages payloads', () => {
    const payload = toAnthropicMessagesPayload({
      id: 'claude',
      type: 'anthropic',
      defaultModel: 'claude-sonnet',
    }, {
      messages: [
        { role: 'system', content: 'Use short answers.' },
        { role: 'user', content: 'Hello.' },
      ],
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    })

    expect(payload).toMatchObject({
      model: 'claude-sonnet',
      system: 'Use short answers.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello.' }] }],
      max_tokens: 4096,
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
    })
  })

  it('replays signed Claude thinking blocks and never invents unsigned Claude blocks', () => {
    const signedThinking = {
      type: 'thinking' as const,
      thinking: 'I should call the tool.',
      signature: 'claude-signature',
    }
    const response = normalizeAnthropicResponse({
      content: [
        signedThinking,
        {
          type: 'tool_use',
          id: 'call_weather',
          name: 'weather',
          input: { city: 'Xiamen' },
        },
      ],
      stop_reason: 'tool_use',
    })
    const config: ModelProviderConfig = {
      id: 'anthropic',
      type: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    }
    const signedPayload = toAnthropicMessagesPayload(config, {
      messages: [modelResponseToAgentMessage(response)],
    })
    const plainPayload = toAnthropicMessagesPayload(config, {
      messages: [{
        role: 'assistant',
        content: 'Answer',
        reasoning: { text: 'Unsigned internal summary.' },
      }],
    })

    expect(signedPayload.messages[0]?.content).toEqual([
      signedThinking,
      {
        type: 'tool_use',
        id: 'call_weather',
        name: 'weather',
        input: { city: 'Xiamen' },
      },
    ])
    expect(plainPayload.messages[0]?.content).toEqual([
      { type: 'text', text: 'Answer' },
    ])
  })

  it('converts unified reasoning text to unsigned thinking for non-Claude Anthropic-compatible models', () => {
    const payload = toAnthropicMessagesPayload({
      id: 'minimax-oauth',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      defaultModel: 'MiniMax-M3',
    }, {
      messages: [{
        role: 'assistant',
        content: '',
        reasoning: {
          text: 'I should call the tool.',
          native: {
            format: 'anthropic-thinking-blocks',
            data: [{
              type: 'thinking',
              thinking: 'I should call the tool.',
              signature: 'claude-only-signature',
            }],
          },
        },
        toolCalls: [{
          id: 'call_weather',
          name: 'weather',
          arguments: { city: 'Xiamen' },
        }],
      }],
    })

    expect(payload.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'I should call the tool.' },
      {
        type: 'tool_use',
        id: 'call_weather',
        name: 'weather',
        input: { city: 'Xiamen' },
      },
    ])
  })

  it('captures streamed Claude thinking signatures for the next request', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Use a tool."}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-thinking"}}\n\n'))
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'))
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const config: ModelProviderConfig = {
      id: 'anthropic',
      type: 'anthropic',
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet-4-6',
    }
    const client = new AnthropicMessagesModelClient(config, { fetch: fetchMock })

    const streamed = await collectModelEvents(client.stream({
      messages: [{ role: 'user', content: 'Think' }],
    }))
    const replay = toAnthropicMessagesPayload(config, {
      messages: [streamed.message],
    })

    expect(streamed.message.reasoning).toEqual({
      text: 'Use a tool.',
      native: {
        format: 'anthropic-thinking-blocks',
        data: [{
          type: 'thinking',
          thinking: 'Use a tool.',
          signature: 'signed-thinking',
        }],
      },
    })
    expect(replay.messages[0]?.content).toEqual([{
      type: 'thinking',
      thinking: 'Use a tool.',
      signature: 'signed-thinking',
    }])
  })

  it('calls Anthropic-compatible /anthropic bases through /v1/messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
    }), { status: 200 }))
    const client = new AnthropicMessagesModelClient({
      id: 'custom:glm-anthropic',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'test-key',
      defaultModel: 'glm-5.2',
    }, { fetch: fetchMock })

    const response = await client.create({
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.content).toBe('OK')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer test-key',
      'x-api-key': 'test-key',
    })
  })

  it('uses Bearer-only auth for MiniMax Coding Plan', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'OK' }],
      stop_reason: 'end_turn',
    }), { status: 200 }))
    const client = new AnthropicMessagesModelClient({
      id: 'minimax-oauth',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.minimax.io/anthropic',
      apiKey: 'oauth-access-token',
      defaultModel: 'MiniMax-M3',
    }, { fetch: fetchMock })

    await client.create({ messages: [{ role: 'user', content: 'hi' }] })

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.minimax.io/anthropic/v1/messages')
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer oauth-access-token',
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-api-key')
  })

  it('merges Anthropic streaming input, output, and cache usage', async () => {
    const encoder = new TextEncoder()
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":0,"cache_read_input_tokens":80,"cache_creation_input_tokens":5}}}\n\n'))
        controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n'))
        controller.enqueue(encoder.encode('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n'))
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    const client = new AnthropicMessagesModelClient({
      id: 'anthropic',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'test-key',
      defaultModel: 'claude-sonnet',
    }, { fetch: fetchMock })

    const events = []
    for await (const event of client.stream({
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) events.push(event)

    expect(events).toContainEqual({
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 7,
        totalTokens: 107,
        cacheReadTokens: 80,
        cacheWriteTokens: 5,
        reasoningTokens: undefined,
      },
    })
  })

  it('throws Anthropic-compatible JSON error bodies even when HTTP status is 200', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 500,
      msg: '404 NOT_FOUND',
      success: false,
    }), { status: 200 }))
    const client = new AnthropicMessagesModelClient({
      id: 'custom:glm-anthropic',
      type: 'anthropic',
      requestStyle: 'anthropic-messages',
      baseUrl: 'https://api.z.ai/api/anthropic/messages',
      apiKey: 'test-key',
      defaultModel: 'glm-5.2',
    }, { fetch: fetchMock })

    await expect(client.create({
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({
      message: '404 NOT_FOUND',
      provider: 'custom:glm-anthropic',
    })
  })

  it('converts internal requests to Gemini Contents payloads', () => {
    const payload = toGeminiContentsPayload({
      id: 'gemini',
      type: 'gemini',
      defaultModel: 'gemini-2.5-pro',
    }, {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello.' },
      ],
      tools: [{ name: 'lookup', parameters: { type: 'object' } }],
      temperature: 0.1,
    })

    expect(payload).toMatchObject({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello.' }] }],
      generationConfig: { temperature: 0.1 },
      tools: [{ functionDeclarations: [{ name: 'lookup' }] }],
    })
  })

  it('replays Gemini thought signatures with their original content parts', () => {
    const originalParts = [
      { text: 'I should call the tool.', thought: true },
      {
        functionCall: { name: 'weather', args: { city: 'Xiamen' } },
        thoughtSignature: 'gemini-signature',
      },
    ]
    const response = normalizeGeminiResponse({
      candidates: [{
        content: { parts: originalParts },
        finishReason: 'STOP',
      }],
    }, 'gemini-3-pro')
    const message = modelResponseToAgentMessage(response)
    const payload = toGeminiContentsPayload({
      id: 'gemini',
      type: 'gemini',
      defaultModel: 'gemini-3-pro',
    }, {
      messages: [message],
    })

    expect(message.content).toBe('')
    expect(message.reasoning).toEqual({
      text: 'I should call the tool.',
      native: {
        format: 'gemini-content-parts',
        data: originalParts,
      },
    })
    expect(payload.contents).toEqual([{
      role: 'model',
      parts: originalParts,
    }])
  })

  it('converts internal requests to prompt completion payloads', () => {
    const payload = toPromptCompletionPayload({
      id: 'legacy',
      type: 'custom',
      requestStyle: 'prompt-completion',
      defaultModel: 'legacy-text',
    }, {
      messages: [
        { role: 'system', content: 'Instruction.' },
        { role: 'user', content: 'Question.' },
      ],
      maxTokens: 100,
    })

    expect(payload).toEqual({
      model: 'legacy-text',
      prompt: 'SYSTEM: Instruction.\n\nUSER: Question.',
      max_tokens: 100,
      stream: undefined,
      temperature: undefined,
    })
  })

  it('sends requests with provider headers and normalizes the response', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'chatcmpl_2',
      model: 'deepseek-chat',
      choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }],
    })))

    const client = createModelClient(providerConfig, { fetch: fetchMock })
    const response = await client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })

    expect(response.content).toBe('Hello.')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer test-key',
          'content-type': 'application/json',
        }),
        body: expect.stringContaining('"model":"deepseek-chat"'),
      }),
    )
  })

  it('throws normalized provider errors for failing HTTP responses', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: {
        message: 'rate limited',
      },
    }), { status: 429 }))

    const client = createModelClient(providerConfig, { fetch: fetchMock })

    await expect(client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({
      name: 'ModelProviderError',
      provider: 'deepseek',
      statusCode: 429,
      retryable: true,
      message: 'rate limited',
    } satisfies Partial<ModelProviderError>)
  })

  it('surfaces string provider error bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: '400',
      error: 'Argument not supported: metadata',
    }), { status: 400 }))

    const client = createModelClient(providerConfig, { fetch: fetchMock })
    await expect(client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({
      message: 'Argument not supported: metadata',
      statusCode: 400,
    })
  })

  it('surfaces Codex detail error bodies', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      detail: 'Unsupported parameter: max_output_tokens',
    }), { status: 400 }))

    const client = createModelClient(providerConfig, { fetch: fetchMock })
    await expect(client.create({
      messages: [{ role: 'user', content: 'Hello' }],
    })).rejects.toMatchObject({
      message: 'Unsupported parameter: max_output_tokens',
      statusCode: 400,
    })
  })

})

describe('OrcaRouter reasoning replay', () => {
  const orcaConfig: ModelProviderConfig = {
    id: 'orcarouter',
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://api.orcarouter.ai/v1',
    defaultModel: 'deepseek/deepseek-v4-pro',
  }

  it('replays OrcaRouter reasoning through reasoning_content', () => {
    const payload = toOpenAIChatPayload(orcaConfig, {
      messages: [
        { role: 'assistant', content: 'answer', reasoning: 'because' },
        { role: 'user', content: 'next' },
      ],
    })
    const assistant = (payload.messages as Array<Record<string, any>>)[0]
    expect(assistant.reasoning_content).toBe('because')
    expect(assistant).not.toHaveProperty('reasoning')
    expect(assistant).not.toHaveProperty('reasoning_details')
  })

  it('recognises the Auth entry point and the gateway hostname, not the model name', () => {
    const viaOauthEntry = toOpenAIChatPayload({
      id: 'orcarouter-oauth',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      defaultModel: 'openai/gpt-5.5',
    }, { messages: [{ role: 'assistant', content: 'a', reasoning: 'r' }] })
    expect((viaOauthEntry.messages as Array<Record<string, any>>)[0].reasoning_content).toBe('r')

    const viaHostname = toOpenAIChatPayload({
      id: 'custom:my-gateway',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      baseUrl: 'https://api.orcarouter.ai/v1',
      defaultModel: 'openai/gpt-5.5',
    }, { messages: [{ role: 'assistant', content: 'a', reasoning: 'r' }] })
    expect((viaHostname.messages as Array<Record<string, any>>)[0].reasoning_content).toBe('r')
  })

  it('leaves an unrelated OpenAI-compatible provider on the common reasoning field', () => {
    const payload = toOpenAIChatPayload({
      id: 'custom:other-relay',
      type: 'openai-compatible',
      requestStyle: 'openai-chat',
      baseUrl: 'https://relay.example/v1',
      defaultModel: 'some/model',
    }, { messages: [{ role: 'assistant', content: 'a', reasoning: 'r' }] })
    const assistant = (payload.messages as Array<Record<string, any>>)[0]
    expect(assistant.reasoning).toBe('r')
    expect(assistant).not.toHaveProperty('reasoning_content')
  })
})
