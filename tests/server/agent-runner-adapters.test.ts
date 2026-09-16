import { describe, expect, it } from 'vitest'
import {
  anthropicMessageToResponses,
  normalizeResponseFunctionCall,
  openAiChatToResponses,
  responseToolNamespaceForName,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
  stripHistoricalResponsesInlineImages,
  truncateResponsesToolOutputs,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'
import {
  anthropicToOpenAiChat,
  anthropicToOpenAiResponses,
  openAiResponsesToAnthropicMessage,
  openAiToAnthropicMessage,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/anthropic'
import {
  openAiChatSseToAnthropicEvents,
  openAiResponsesSseToAnthropicEvents,
  type AnthropicStreamEvent,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/anthropic-stream'
import {
  anthropicMessagesSseToResponsesEvents,
  normalizeResponsesSseEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses-stream'

const target = { model: 'test-model' }
const codexTarget = { model: 'test-model', annotateMcpToolNamespaces: true }
const anthropicTarget = { provider: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' }

describe('agent runner Responses adapters', () => {
  it('forwards maximum reasoning effort to Chat and Anthropic payloads', () => {
    const maxTarget = { ...target, reasoningEffort: 'max' }

    expect(responsesToOpenAiChat({ input: [] }, maxTarget)).toMatchObject({
      reasoning_effort: 'max',
    })
    expect(responsesToAnthropicMessages({ input: [] }, maxTarget)).toMatchObject({
      reasoning_effort: 'max',
    })
  })

  it('truncates oversized Responses function-call outputs before provider forwarding', () => {
    const largeOutput = `${'A'.repeat(32 * 1024 + 1)}TAIL_MARKER`
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        { type: 'function_call_output', call_id: 'call_big', output: largeOutput },
        { type: 'function_call_output', call_id: 'call_small', output: 'ok' },
      ],
    }

    const sanitized = truncateResponsesToolOutputs(body)
    const output = sanitized.input[1].output

    expect(sanitized).not.toBe(body)
    expect(output.length).toBeLessThan(largeOutput.length)
    expect(output.length).toBeLessThanOrEqual(32 * 1024)
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(output).toContain('truncated before provider request')
    expect(output).toContain(`original_chars=${largeOutput.length}`)
    expect(output.endsWith('TAIL_MARKER')).toBe(true)
    expect(sanitized.input[2]).toBe(body.input[2])
    expect(body.input[1].output).toBe(largeOutput)

    const cjkOutput = `${'界'.repeat(32 * 1024 + 1)}TAIL_MARKER`
    const cjkSanitized = truncateResponsesToolOutputs({
      input: [{ type: 'function_call_output', call_id: 'call_cjk', output: cjkOutput }],
    })
    const cjkTruncated = cjkSanitized.input[0].output
    expect(Buffer.byteLength(cjkTruncated, 'utf8')).toBeLessThanOrEqual(32 * 1024)
    expect(cjkTruncated).toContain(`original_bytes=${Buffer.byteLength(cjkOutput, 'utf8')}`)
    expect(cjkTruncated.endsWith('TAIL_MARKER')).toBe(true)
  })

  it('strips every historical inline image while preserving the full current turn', () => {
    const oldUserImage = 'data:image/png;base64,OLD_USER'
    const oldToolImage = 'data:image/jpeg;base64,OLD_TOOL'
    const currentImageA = 'data:image/png;base64,CURRENT_A'
    const currentImageB = 'data:image/png;base64,CURRENT_B'
    const currentToolImage = 'data:image/webp;base64,CURRENT_TOOL'
    const remoteHistoricalImage = 'https://example.com/old.png'
    const body = {
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'old turn' },
            { type: 'input_image', image_url: oldUserImage },
            { type: 'input_image', image_url: remoteHistoricalImage },
          ],
        },
        {
          type: 'function_call_output',
          call_id: 'old-tool',
          output: [{ type: 'input_image', image_url: { url: oldToolImage } }],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'current turn' },
            { type: 'input_image', image_url: currentImageA },
            { type: 'input_image', image_url: { url: currentImageB } },
          ],
        },
        {
          type: 'function_call_output',
          call_id: 'current-tool',
          output: [{ type: 'input_image', image_url: currentToolImage }],
        },
      ],
    }

    const sanitized = stripHistoricalResponsesInlineImages(body)
    const serialized = JSON.stringify(sanitized)

    expect(sanitized).not.toBe(body)
    expect(serialized).not.toContain(oldUserImage)
    expect(serialized).not.toContain(oldToolImage)
    expect(serialized).toContain(remoteHistoricalImage)
    expect(serialized).toContain(currentImageA)
    expect(serialized).toContain(currentImageB)
    expect(serialized).toContain(currentToolImage)
    expect(serialized.match(/historical inline image omitted before provider request/g)).toHaveLength(2)
    expect(body.input[0].content[1]).toEqual({ type: 'input_image', image_url: oldUserImage })
    expect(body.input[1].output[0]).toEqual({ type: 'input_image', image_url: { url: oldToolImage } })
    expect(sanitized.input[2]).toBe(body.input[2])
    expect(sanitized.input[3]).toBe(body.input[3])
  })

  it('does not strip inline images when no current user turn boundary exists', () => {
    const body = {
      input: [{ type: 'function_call_output', output: [{ type: 'input_image', image_url: 'data:image/png;base64,ONLY' }] }],
    }

    expect(stripHistoricalResponsesInlineImages(body)).toBe(body)
  })

  it('converts Responses input to OpenAI Chat messages and tools', () => {
    const body = {
      instructions: 'be terse',
      max_output_tokens: 16,
      temperature: 0.2,
      top_p: 0.9,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
      ],
      tools: [{ type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' } }],
    }

    expect(responsesToOpenAiChat(body, target)).toMatchObject({
      model: 'test-model',
      max_tokens: 16,
      temperature: 0.2,
      top_p: 0.9,
      stream: false,
      messages: [
        { role: 'system', content: 'be terse\n\nrules' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'search', description: 'Search', parameters: { type: 'object' } },
      }],
    })
  })

  it('keeps a single top-level instructions system message at the front', () => {
    const body = {
      instructions: 'core system prompt',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    }

    expect(responsesToOpenAiChat(body, target).messages).toEqual([
      { role: 'system', content: 'core system prompt' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('merges multiple system messages into one leading message (vLLM compatibility)', () => {
    // Codex 0.149 sends both a top-level `instructions` string and `developer`
    // messages inside `input`. Both convert to `system`; vLLM rejects the
    // second one ("System message must be at the beginning"), so they must be
    // merged into a single leading system message.
    const body = {
      instructions: 'top-level instructions',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'developer message one' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'developer message two' }] },
      ],
    }

    const messages = responsesToOpenAiChat(body, target).messages
    expect(messages).toEqual([
      { role: 'system', content: 'top-level instructions\n\ndeveloper message one\n\ndeveloper message two' },
      { role: 'user', content: 'hello' },
    ])
    const systemMessages = messages.filter((message: any) => message.role === 'system')
    expect(systemMessages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
  })

  it('replays Responses reasoning_content on DeepSeek tool-call continuations', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'inspect the repo' }] },
        {
          type: 'reasoning',
          id: 'rs_deepseek',
          summary: [{ type: 'summary_text', text: 'I should inspect the repository first.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_read',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_read',
          output: 'repository contents',
        },
      ],
    }

    expect(responsesToOpenAiChat(body, anthropicTarget).messages).toEqual([
      { role: 'user', content: 'inspect the repo' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'I should inspect the repository first.',
        tool_calls: [{
          id: 'call_read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_read', content: 'repository contents' },
    ])
    expect(responsesToOpenAiChat(body, target).messages[1]).not.toHaveProperty('reasoning_content')
  })

  it.each(['reasoning_content', 'reasoning', 'reasoning_text'])('replays inline %s without treating assistant content as reasoning', (field) => {
    const body = { input: [
      { role: 'user', content: 'first question', [field]: 'not assistant reasoning' },
      { role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }], [field]: 'First analysis.' },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'plain answer' },
    ] }
    const before = structuredClone(body)
    expect(responsesToOpenAiChat(body, anthropicTarget).messages).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer', reasoning_content: 'First analysis.' },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'plain answer', reasoning_content: '' },
    ])
    expect(body).toEqual(before)
    for (const message of responsesToOpenAiChat(body, target).messages) {
      expect(message).not.toHaveProperty('reasoning_content')
    }
  })

  it('prefers inline reasoning and retains standalone reasoning for assistant history', () => {
    const body = { input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Short summary.' }] },
      { role: 'assistant', content: 'answer', reasoning_content: 'Full original reasoning.' },
      { role: 'user', content: 'continue' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Next analysis.' }] },
      { role: 'assistant', content: 'next answer' },
    ] }
    expect(responsesToOpenAiChat(body, anthropicTarget).messages).toEqual([
      { role: 'assistant', content: 'answer', reasoning_content: 'Full original reasoning.' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'next answer', reasoning_content: 'Next analysis.' },
    ])
  })

  it('fills missing reasoning across tool batches without leaking earlier reasoning', () => {
    const body = { input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'First tool analysis.' }] },
      { type: 'function_call', call_id: 'first', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'first', output: 'first result' },
      { type: 'function_call', call_id: 'second', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'third', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'third', output: 'third result' },
      { type: 'function_call_output', call_id: 'second', output: 'second result' },
      { role: 'assistant', content: 'done' },
    ] }
    const messages = responsesToOpenAiChat(body, anthropicTarget).messages
    expect(messages.map((message: any) => message.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant'])
    expect(messages[0].reasoning_content).toBe('First tool analysis.')
    expect(messages[2].reasoning_content).toBe('')
    expect(messages[2].tool_calls.map((call: any) => call.id)).toEqual(['second', 'third'])
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'second', content: 'second result' })
    expect(messages[4]).toEqual({ role: 'tool', tool_call_id: 'third', content: 'third result' })
    expect(messages[5].reasoning_content).toBe('')
    for (const message of responsesToOpenAiChat(body, target).messages) {
      expect(message).not.toHaveProperty('reasoning_content')
    }
  })

  it('preserves Responses image inputs for Chat and Anthropic providers', () => {
    const imageUrl = 'data:image/png;base64,AQID'
    const body = {
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect this' },
          { type: 'input_image', image_url: imageUrl },
        ],
      }],
    }

    expect(responsesToOpenAiChat(body, target).messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    }])
    expect(responsesToAnthropicMessages(body, target).messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      ],
    }])
  })

  it('preserves Responses image tool outputs without stringifying data URIs', () => {
    const imageUrl = 'data:image/png;base64,AQID'
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'inspect this' }] },
        {
          type: 'function_call',
          call_id: 'call_image',
          name: 'view_image',
          arguments: '{"path":"/tmp/image.png"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_image',
          output: [{ type: 'input_image', image_url: imageUrl, detail: 'high' }],
        },
      ],
    }

    expect(responsesToOpenAiChat(body, target).messages).toEqual([
      { role: 'user', content: 'inspect this' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_image',
          type: 'function',
          function: { name: 'view_image', arguments: '{"path":"/tmp/image.png"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_image',
        content: '[Image output attached for tool view_image]',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Image output from tool view_image (call_image)]' },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
        ],
      },
    ])

    expect(responsesToAnthropicMessages(body, target).messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'inspect this' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_image',
          name: 'view_image',
          input: { path: '/tmp/image.png' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_image',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
          }],
        }],
      },
    ])
  })

  it('groups parallel Responses function calls before Chat tool results', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'check repo' }] },
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
        { type: 'function_call', call_id: 'call_2', name: 'search', arguments: '{"q":"todo"}' },
        { type: 'function_call_output', call_id: 'call_2', output: 'matches' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file text' },
        { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    }

    expect(responsesToOpenAiChat(body, target).messages).toEqual([
      { role: 'user', content: 'check repo' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"todo"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file text' },
      { role: 'tool', tool_call_id: 'call_2', content: 'matches' },
      { role: 'user', content: 'continue' },
    ])
  })

  it('drops incomplete Responses function call history for Chat providers', () => {
    const body = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_missing', name: 'search', arguments: '{"q":"x"}' },
        { role: 'user', content: [{ type: 'input_text', text: 'next turn' }] },
        { type: 'function_call_output', call_id: 'orphan_call', output: 'orphan' },
      ],
    }

    expect(responsesToOpenAiChat(body, target).messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'next turn' },
    ])
  })

  it('converts Responses input to Anthropic messages', () => {
    const body = {
      instructions: 'system text',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ text: 'ok' }] },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
    }

    expect(responsesToAnthropicMessages(body, target, true)).toMatchObject({
      model: 'test-model',
      system: 'system text',
      max_tokens: 4096,
      stream: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
    })
  })

  it('round-trips Codex deferred tool discovery through Anthropic tools', () => {
    const toolSearch = {
      type: 'tool_search',
      execution: 'client',
      description: 'Search deferred MCP tools.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    }

    expect(responsesToAnthropicMessages({
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'open the browser' }] }],
      tools: [toolSearch],
    }, target).tools).toEqual([{
      name: 'tool_search',
      description: 'Search deferred MCP tools.',
      input_schema: toolSearch.parameters,
    }])

    const followup = responsesToAnthropicMessages({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'open the browser' }] },
        {
          type: 'tool_search_call',
          call_id: 'call_search',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'Ekko Studio browser tabs navigation' },
        },
        {
          type: 'tool_search_output',
          call_id: 'call_search',
          status: 'completed',
          execution: 'client',
          tools: [{
            type: 'namespace',
            name: 'mcp__ekko_studio_browser',
            description: 'Hermes browser tools.',
            tools: [{
              type: 'function',
              name: 'ekko_studio_browser_toolset',
              description: 'Discover browser operations.',
              parameters: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
            }],
          }],
        },
      ],
      tools: [toolSearch],
    }, target)

    expect(followup.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'open the browser' }] },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_search',
          name: 'tool_search',
          input: { query: 'Ekko Studio browser tabs navigation' },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_search',
          content: 'Loaded deferred tools: mcp__ekko_studio_browser.ekko_studio_browser_toolset',
        }],
      },
    ])
    expect(followup.tools).toEqual([
      expect.objectContaining({ name: 'tool_search' }),
      {
        name: 'ekko_studio_browser_toolset',
        description: 'Discover browser operations.',
        input_schema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
      },
    ])
  })

  it('keeps historical Hermes namespace calls routable after the Ekko rename', () => {
    const result = responsesToOpenAiChat({
      input: [], tools: [{ type: 'namespace', name: 'mcp__hermes_studio_api' }],
    }, target)
    expect(result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'hermes_studio_api_request' }) }),
    ]))
    expect(responseToolNamespaceForName('hermes_studio_api_request')).toBe('mcp__hermes_studio_api')
    expect(responseToolNamespaceForName('ekko_studio_api_request')).toBe('mcp__ekko_studio_api')
  })

  it('expands Hermes MCP namespace tools for Chat and Anthropic providers', () => {
    const body = {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'list devices' }] }],
      tools: [{ type: 'namespace', name: 'mcp__ekko_studio', description: 'Hermes tools' }],
    }

    expect(responsesToOpenAiChat(body, target).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({
          name: 'ekko_studio_lan_devices_scan',
          parameters: expect.objectContaining({
            properties: expect.objectContaining({
              profile: expect.any(Object),
              token: expect.any(Object),
            }),
          }),
        }),
      }),
    ]))

    expect(responsesToAnthropicMessages(body, target).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'ekko_studio_lan_devices_scan',
        input_schema: expect.objectContaining({
          properties: expect.objectContaining({
            profile: expect.any(Object),
            token: expect.any(Object),
          }),
        }),
      }),
    ]))
  })

  it('expands split Hermes MCP namespaces and routes returned calls to the right server', () => {
    const body = {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'open a browser' }] }],
      tools: [
        { type: 'namespace', name: 'mcp__ekko_studio_api' },
        { type: 'namespace', name: 'mcp__ekko_studio_browser' },
        { type: 'namespace', name: 'mcp__ekko_studio_devices' },
        { type: 'namespace', name: 'mcp__ekko_studio_use' },
      ],
    }

    const anthropicTools = responsesToAnthropicMessages(body, target).tools
    expect(anthropicTools.map((tool: any) => tool.name)).toEqual([
      'ekko_studio_api_openapi_get',
      'ekko_studio_api_request',
      'ekko_studio_browser_toolset',
      'ekko_studio_devices_toolset',
      'ekko_studio_use_toolset',
    ])
    expect(anthropicTools.find((tool: any) => tool.name === 'ekko_studio_browser_toolset')).toMatchObject({
      input_schema: {
        required: ['action'],
        properties: {
          action: { enum: ['list', 'describe', 'call'] },
          tool: { type: 'string' },
          arguments: { type: 'object' },
        },
      },
    })
    expect(responseToolNamespaceForName('ekko_studio_browser_toolset')).toBe('mcp__ekko_studio_browser')
    expect(normalizeResponseFunctionCall('ekko_studio_browser_toolset', '{"action":"list"}')).toEqual({
      name: 'ekko_studio_browser_toolset',
      arguments: '{"action":"list"}',
      namespace: 'mcp__ekko_studio_browser',
    })
  })

  it('keeps unknown MCP namespaces callable through a generic function fallback', () => {
    const body = {
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'call custom mcp' }] }],
      tools: [{ type: 'namespace', name: 'mcp__custom_server', description: 'Custom server tools' }],
    }

    expect(responsesToOpenAiChat(body, target).tools).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({
          name: 'mcp__custom_server',
          parameters: expect.objectContaining({
            required: ['tool', 'arguments'],
          }),
        }),
      }),
    ]))
  })

  it('converts OpenAI Chat responses to Responses output', () => {
    expect(openAiChatToResponses({
      id: 'chatcmpl_1',
      created: 123,
      choices: [{
	        message: {
	          reasoning_content: 'think',
	          content: 'hi',
	          tool_calls: [{
            id: 'call_1',
            function: { name: 'lookup', arguments: '{"id":1}' },
          }],
        },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }, target)).toMatchObject({
      id: 'chatcmpl_1',
      object: 'response',
      created_at: 123,
	      model: 'test-model',
	      output: [
	        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    })
  })

  it('converts OpenAI-compatible reasoning_details responses to Responses output', () => {
    expect(openAiChatToResponses({
      id: 'chatcmpl_details',
      choices: [{
        message: {
          reasoning_details: [
            { type: 'reasoning.text', text: 'inspect ' },
            { type: 'reasoning.text', text: 'the repository' },
          ],
          content: 'done',
        },
      }],
    }, target).output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'inspect the repository' }],
    })
  })

  it('marks expanded Hermes MCP Chat tool calls with their Responses namespace', () => {
    expect(openAiChatToResponses({
      id: 'chatcmpl_1',
      created: 123,
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            function: { name: 'ekko_studio_lan_devices_scan', arguments: '{"profile":"default"}' },
          }],
        },
      }],
    }, target)).toMatchObject({
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'ekko_studio_lan_devices_scan',
        namespace: 'mcp__ekko_studio',
      }],
    })
  })

  it('normalizes generic MCP namespace function calls back to Responses MCP calls', () => {
    expect(openAiChatToResponses({
      id: 'chatcmpl_1',
      created: 123,
      choices: [{
        message: {
          tool_calls: [{
            id: 'call_1',
            function: {
              name: 'mcp__custom_server',
              arguments: '{"tool":"custom_lookup","arguments":{"id":1}}',
            },
          }],
        },
      }],
    }, target)).toMatchObject({
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'custom_lookup',
        arguments: '{"id":1}',
        namespace: 'mcp__custom_server',
      }],
    })
  })

  it('converts Anthropic messages to Responses output', () => {
    expect(anthropicMessageToResponses({
	      id: 'msg_1',
	      content: [
	        { type: 'thinking', thinking: 'anthropic think' },
	        { type: 'text', text: 'hi' },
	        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    }, target)).toMatchObject({
      id: 'msg_1',
	      object: 'response',
	      model: 'test-model',
	      output: [
	        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'anthropic think' }] },
	        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
	        { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"id":1}' },
      ],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    })
  })

  it('returns Anthropic tool_search calls using the Codex-native response item', () => {
    expect(anthropicMessageToResponses({
      id: 'msg_search',
      content: [{
        type: 'tool_use',
        id: 'call_search',
        name: 'tool_search',
        input: { query: 'Ekko Studio browser', limit: 5 },
      }],
      usage: { input_tokens: 2, output_tokens: 3 },
    }, target)).toMatchObject({
      output: [{
        type: 'tool_search_call',
        call_id: 'call_search',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'Ekko Studio browser', limit: 5 },
      }],
    })
  })

  it('marks expanded Hermes MCP Anthropic tool calls with their Responses namespace', () => {
    expect(anthropicMessageToResponses({
      id: 'msg_1',
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'ekko_studio_lan_devices_list', input: { profile: 'default' } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }, target)).toMatchObject({
      output: [{
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'ekko_studio_lan_devices_list',
        namespace: 'mcp__ekko_studio',
      }],
    })
  })
})

async function* encodedChunks(chunks: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const chunk of chunks) yield encoder.encode(chunk)
}

async function collectEvents(events: AsyncIterable<CanonicalResponsesEvent>): Promise<CanonicalResponsesEvent[]> {
  const collected: CanonicalResponsesEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function collectAnthropicEvents(events: AsyncIterable<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const collected: AnthropicStreamEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('agent runner Responses stream adapters', () => {
  it('normalizes OpenAI Chat SSE text and tool calls to Responses events', async () => {
	    const events = await collectEvents(openAiChatSseToResponsesEvents(encodedChunks([
	      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
	      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
	      'data: {"choices":[{"delta":{"content":"llo"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"id\\":"}}]}}]}\n\n',
	      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
	      'data: {"id":"chatcmpl_usage","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":30}}}\n\n',
      'data: [DONE]\n\n',
    ]), codexTarget))

	    expect(events.map(event => event.type)).toEqual([
	      'response.created',
	      'response.output_item.added',
	      'response.reasoning_summary_text.delta',
	      'response.output_item.added',
	      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.output_item.done',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.done',
	      'response.completed',
	    ])
	    expect(events[1].data).toMatchObject({
	      output_index: 0,
	      item: { type: 'reasoning', id: expect.stringMatching(/^rs_/), summary: [] },
	    })
	    expect(events[2].data).toMatchObject({ delta: 'think', output_index: 0, summary_index: 0 })
	    expect(events[5].data).toMatchObject({ delta: 'he', output_index: 1 })
	    expect(events[6].data).toMatchObject({ delta: 'llo', output_index: 1 })
	    expect(events[7].data).toMatchObject({
	      output_index: 2,
	      item: { type: 'function_call', call_id: 'call_1', name: 'lookup', status: 'in_progress' },
	    })
	    expect(events[14].data).toMatchObject({
	      output_index: 2,
	      item: {
	        type: 'function_call',
	        call_id: 'call_1',
	        name: 'lookup',
	        arguments: '{"id":1}',
	        status: 'completed',
	      },
	    })
	    expect(events[10].data).toMatchObject({
	      output_index: 0,
	      item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	    })
	    expect(events[15].data).toMatchObject({
	      response: {
	        model: 'test-model',
	        status: 'completed',
	        id: expect.stringMatching(/^resp_/),
	        usage: {
	          input_tokens: 120,
	          output_tokens: 7,
	          total_tokens: 127,
	          input_tokens_details: { cached_tokens: 30 },
	        },
	        output: [
	          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	          { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
	          { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}', status: 'completed' },
        ],
      },
    })
    expect((events[15].data as any).response.id).toBe((events[0].data as any).response.id)
  })

  it('accepts alternate OpenAI-compatible streaming reasoning fields', async () => {
    const events = await collectEvents(openAiChatSseToResponsesEvents(encodedChunks([
      'data: {"choices":[{"delta":{"reasoning":"first"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_text":" second"}}]}\n\n',
      'data: [DONE]\n\n',
    ]), codexTarget))

    expect(events.filter(event => event.type === 'response.reasoning_summary_text.delta').map(event => event.data.delta))
      .toEqual(['first', ' second'])
    expect((events.at(-1)?.data as any).response.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'first second' }],
    })
  })

  it('deduplicates cumulative OpenAI-compatible reasoning_details chunks', async () => {
    const events = await collectEvents(openAiChatSseToResponsesEvents(encodedChunks([
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"first"}]}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"first second"}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), codexTarget))

    expect(events.filter(event => event.type === 'response.reasoning_summary_text.delta').map(event => event.data.delta))
      .toEqual(['first', ' second'])
    expect((events.at(-1)?.data as any).response.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'first second' }],
    })
  })

  it('marks expanded Hermes MCP Chat SSE tool calls with their Responses namespace', async () => {
    const events = await collectEvents(openAiChatSseToResponsesEvents(encodedChunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"ekko_studio_lan_devices_scan","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), codexTarget))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'response.output_item.done',
        data: expect.objectContaining({
          item: expect.objectContaining({
            type: 'function_call',
            call_id: 'call_1',
            name: 'ekko_studio_lan_devices_scan',
            namespace: 'mcp__ekko_studio',
          }),
        }),
      }),
    ]))
  })

  it('normalizes Anthropic Messages SSE thinking, text, and tool calls to Pi-compatible Responses events', async () => {
	    const events = await collectEvents(anthropicMessagesSseToResponsesEvents(encodedChunks([
	      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":80,"cache_read_input_tokens":20}}}\n\n',
	      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}\n\n',
	      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\r\n\r\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":1}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
    ]), codexTarget))

	    expect(events.map(event => event.type)).toEqual([
	      'response.created',
	      'response.output_item.added',
	      'response.reasoning_summary_text.delta',
	      'response.output_item.added',
	      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.output_item.done',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.done',
	      'response.completed',
	    ])
	    expect(events[1].data).toMatchObject({
	      output_index: 0,
	      item: { type: 'reasoning', id: 'rs_msg_1', summary: [] },
	    })
	    expect(events[2].data).toMatchObject({ delta: 'think', output_index: 0, summary_index: 0 })
	    expect(events[3].data).toMatchObject({ output_index: 1, item: { id: 'msg_msg_1' } })
	    expect(events[6].data).toMatchObject({
	      output_index: 2,
	      item: { type: 'function_call', call_id: 'toolu_1', name: 'lookup' },
	    })
	    expect(events[8].data).toMatchObject({
	      output_index: 0,
	      item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	    })
	    expect(events[13].data).toMatchObject({
	      response: {
	        id: 'msg_1',
	        usage: { input_tokens: 80, cache_read_input_tokens: 20, output_tokens: 9 },
	        output: [
	          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	          { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
          { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"id":1}' },
        ],
      },
    })
  })

  it('marks expanded Hermes MCP Anthropic SSE tool calls with their Responses namespace', async () => {
    const events = await collectEvents(anthropicMessagesSseToResponsesEvents(encodedChunks([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"ekko_studio_lan_devices_list","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"profile\\":\\"default\\"}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]), codexTarget))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'response.output_item.done',
        data: expect.objectContaining({
          item: expect.objectContaining({
            type: 'function_call',
            call_id: 'toolu_1',
            name: 'ekko_studio_lan_devices_list',
            namespace: 'mcp__ekko_studio',
          }),
        }),
      }),
    ]))
  })

  it('streams Anthropic tool_search calls as Codex-native response items', async () => {
    const events = await collectEvents(anthropicMessagesSseToResponsesEvents(encodedChunks([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_search"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_search","name":"tool_search","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"Ekko Studio browser\\"}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]), codexTarget))

    expect(events.some(event => event.type === 'response.function_call_arguments.delta')).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'response.output_item.added',
        data: expect.objectContaining({
          item: expect.objectContaining({
            type: 'tool_search_call',
            call_id: 'call_search',
            status: 'in_progress',
            execution: 'client',
          }),
        }),
      }),
      expect.objectContaining({
        type: 'response.output_item.done',
        data: expect.objectContaining({
          item: {
            type: 'tool_search_call',
            call_id: 'call_search',
            status: 'completed',
            execution: 'client',
            arguments: { query: 'Ekko Studio browser' },
          },
        }),
      }),
    ]))
  })

  it('passes native Responses SSE events through as canonical events', async () => {
    const events = await collectEvents(openAiResponsesSseToResponsesEvents(encodedChunks([
      'event: response.created\r\ndata: {"response":{"id":"resp_1"}}\r\n\r\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: [DONE]\n\n',
    ])))

    expect(events).toEqual([
      {
        type: 'response.created',
        data: { type: 'response.created', response: { id: 'resp_1' } },
      },
      {
        type: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'hi' },
      },
    ])
  })

  it('fills fields required by strict Responses stream clients', async () => {
    const events = await collectEvents(normalizeResponsesSseEvents(openAiResponsesSseToResponsesEvents(encodedChunks([
      'event: response.created\ndata: {"response":{"id":"resp_strict","object":"response","status":"in_progress","model":"test-model","output":[]}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_strict","object":"response","status":"completed","model":"test-model","output":[]}}\n\n',
    ]))))

    expect(events.map(event => event.data.sequence_number)).toEqual([0, 1, 2])
    expect((events[0].data.response as any).created_at).toEqual(expect.any(Number))
    expect((events[2].data.response as any).created_at).toBe((events[0].data.response as any).created_at)
  })

  it.each([undefined, null])('fills absent text annotations throughout native Responses streams (%s)', async annotations => {
    const part = { type: 'output_text', text: 'An image description', ...(annotations === null ? { annotations } : {}) }
    const item = { type: 'message', id: 'msg_image', role: 'assistant', content: [part] }
    const frames = [
      { type: 'response.content_part.added', part },
      { type: 'response.content_part.done', part },
      { type: 'response.output_item.added', item },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id: 'resp_image', output: [item] } },
    ]
    const events = await collectEvents(normalizeResponsesSseEvents(openAiResponsesSseToResponsesEvents(encodedChunks(
      frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`),
    ))))
    const parts = events.flatMap(({ data }: any) => data.part ? [data.part] : data.item?.content || data.response.output[0].content)
    expect(parts).toHaveLength(5)
    for (const result of parts) expect(result).toEqual({ ...part, annotations: [] })
  })

  it('preserves provider annotations and leaves non-text content unchanged', async () => {
    const citation = { type: 'url_citation', start_index: 0, end_index: 4, url: 'https://example.com', title: 'Source' }
    const text = { type: 'output_text', text: 'Look', annotations: [citation] }
    const refusal = { type: 'refusal', refusal: 'Cannot answer' }
    const source = {
      type: 'response.completed',
      data: { response: { id: 'resp_citation', output: [{ type: 'message', content: [text, refusal] }] } },
    }
    const original = structuredClone(source)
    const events = await collectEvents(normalizeResponsesSseEvents((async function* () { yield source })()))
    expect((events[0].data.response as any).output[0].content).toEqual([text, refusal])
    expect(source).toEqual(original)
  })
})

describe('agent runner Anthropic adapters', () => {
  it('forwards maximum reasoning effort to Chat and Responses payloads', () => {
    const maxTarget = { ...anthropicTarget, reasoningEffort: 'max' }

    expect(anthropicToOpenAiChat({ messages: [] }, maxTarget)).toMatchObject({
      reasoning_effort: 'max',
    })
    expect(anthropicToOpenAiResponses({ messages: [] }, maxTarget)).toMatchObject({
      reasoning: { effort: 'max' },
    })
  })

  it('converts Anthropic messages to OpenAI Chat with reasoning_content', () => {
    const body = {
      system: 'system text',
      max_tokens: 32,
      temperature: 0.1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'need tool' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
    }

    expect(anthropicToOpenAiChat(body, anthropicTarget)).toMatchObject({
      model: 'deepseek-reasoner',
      max_tokens: 32,
      temperature: 0.1,
      stream: false,
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'need tool',
          tool_calls: [{
            id: 'toolu_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":1}' },
          }],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
      }],
    })
  })

  it('merges multiple system messages into one leading message (vLLM compatibility)', () => {
    // Claude Code sends its primary prompt as the top-level `system` field and
    // injects additional `role: 'system'` messages mid-conversation (e.g. the
    // ToolSearch deferred-tools notice). A second system message mid-conversation
    // is rejected by vLLM with "System message must be at the beginning." (400),
    // so the adapter must keep exactly one leading system message.
    const body = {
      system: [
        { type: 'text', text: 'claude code system prompt' },
        { type: 'text', text: 'appended rules' },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'system', content: [{ type: 'text', text: 'deferred tools are now available' }] },
      ],
    }

    const messages = anthropicToOpenAiChat(body, anthropicTarget).messages
    expect(messages).toEqual([
      {
        role: 'system',
        content: 'claude code system prompt\nappended rules\n\ndeferred tools are now available',
      },
      { role: 'user', content: 'hello' },
    ])
    expect(messages.filter((message: any) => message.role === 'system')).toHaveLength(1)
    expect(messages[0].role).toBe('system')
  })

  it('keeps a single in-message system prompt at the front', () => {
    const body = {
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hi' },
      ],
    }

    expect(anthropicToOpenAiChat(body, anthropicTarget).messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('preserves Anthropic image inputs for Chat and Responses providers', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'inspect this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
          },
        ],
      }],
    }
    const imageUrl = 'data:image/png;base64,AQID'

    expect(anthropicToOpenAiChat(body, anthropicTarget).messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    }])
    expect(anthropicToOpenAiResponses(body, anthropicTarget).input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'inspect this' },
        { type: 'input_image', image_url: imageUrl },
      ],
    }])
  })

  it('preserves Anthropic image tool results without stringifying data URIs', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'image.png' } }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
            }],
          }],
        },
      ],
    }

    expect(anthropicToOpenAiChat(body, anthropicTarget).messages).toEqual([
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'tool call',
        tool_calls: [{
          id: 'toolu_1',
          type: 'function',
          function: { name: 'Read', arguments: '{"file_path":"image.png"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '[Image output attached.]' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Image output from tool toolu_1]' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
        ],
      },
    ])
    expect(anthropicToOpenAiResponses(body, anthropicTarget).input).toEqual([
      {
        type: 'function_call',
        call_id: 'toolu_1',
        name: 'Read',
        arguments: '{"file_path":"image.png"}',
      },
      {
        type: 'function_call_output',
        call_id: 'toolu_1',
        output: [{
          type: 'input_image',
          image_url: 'data:image/png;base64,AQID',
        }],
      },
    ])
  })

  it('converts Anthropic messages to Responses input', () => {
    expect(anthropicToOpenAiResponses({
      system: 'system text',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    }, anthropicTarget, true)).toMatchObject({
      model: 'deepseek-reasoner',
      instructions: 'system text',
      max_output_tokens: 64,
      stream: true,
      store: false,
      input: [
        { role: 'user', content: 'hello' },
        { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"id":1}' },
        { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    })
  })

  it('converts OpenAI Chat responses to Anthropic messages', () => {
    expect(openAiToAnthropicMessage({
      id: 'chatcmpl_1',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          reasoning_content: 'thinking',
          content: 'hi',
          tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"id":1}' } }],
        },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }, anthropicTarget)).toMatchObject({
      id: 'chatcmpl_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-reasoner',
      content: [
        { type: 'thinking', thinking: 'thinking' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
    })
  })

  it('converts Responses output to Anthropic messages', () => {
    expect(openAiResponsesToAnthropicMessage({
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      ],
      usage: { input_tokens: 5, output_tokens: 6 },
    }, anthropicTarget)).toMatchObject({
      id: 'resp_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-reasoner',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 6 },
    })
  })

  it('drops unused empty optional Responses arguments using the original Anthropic tool schema', () => {
    const message = openAiResponsesToAnthropicMessage({
      id: 'resp_read',
      status: 'completed',
      output: [{
        type: 'function_call',
        call_id: 'call_read',
        name: 'Read',
        arguments: JSON.stringify({
          file_path: '/tmp/package.json',
          pages: '',
          cursor: null,
          nullable_cursor: null,
          explicit_empty: '',
          required_empty: '',
        }),
      }],
    }, anthropicTarget, [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          pages: { type: 'string' },
          cursor: { type: 'string' },
          nullable_cursor: { type: ['string', 'null'] },
          explicit_empty: { type: 'string', enum: [''] },
          required_empty: { type: 'string' },
        },
        required: ['file_path', 'required_empty'],
      },
    }])

    expect(message.content).toEqual([{
      type: 'tool_use',
      id: 'call_read',
      name: 'Read',
      input: {
        file_path: '/tmp/package.json',
        nullable_cursor: null,
        explicit_empty: '',
        required_empty: '',
      },
    }])
  })
})

describe('agent runner Anthropic stream adapters', () => {
  it('normalizes OpenAI Chat SSE to Anthropic Messages events', async () => {
    const events = await collectAnthropicEvents(openAiChatSseToAnthropicEvents(encodedChunks([
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"id\\":"}}]}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7}}\n\n',
    ]), anthropicTarget))

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[1].data).toMatchObject({ content_block: { type: 'thinking' } })
    expect(events[2].data).toMatchObject({ delta: { type: 'thinking_delta', thinking: 'think' } })
    expect(events[5].data).toMatchObject({ delta: { type: 'text_delta', text: 'hi' } })
    expect(events[7].data).toMatchObject({ content_block: { type: 'tool_use', id: 'call_1', name: 'lookup' } })
    expect(events[11].data).toMatchObject({
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 7 },
    })
  })

  it('normalizes Responses SSE to Anthropic Messages events', async () => {
    const events = await collectAnthropicEvents(openAiResponsesSseToAnthropicEvents(encodedChunks([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.output_text.done"}\n\n',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"id\\":1}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"id\\":1}"}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":3}}}\n\n',
    ]), anthropicTarget))

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[2].data).toMatchObject({ delta: { type: 'text_delta', text: 'hi' } })
    expect(events[4].data).toMatchObject({ content_block: { type: 'tool_use', id: 'call_1', name: 'lookup' } })
    expect(events[5].data).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"id":1}' } })
    expect(events[7].data).toMatchObject({
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 3 },
    })
  })

  it('unifies Responses call and item ids while normalizing optional tool arguments', async () => {
    const fullArguments = JSON.stringify({
      file_path: '/tmp/package.json',
      limit: 220,
      offset: 0,
      pages: '',
    })
    const events = await collectAnthropicEvents(openAiResponsesSseToAnthropicEvents(encodedChunks([
      'data: {"type":"response.created","response":{"id":"resp_read"}}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_read","call_id":"call_read","name":"Read","arguments":"","status":"in_progress"}}\n\n',
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_read', delta: fullArguments })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'Read', arguments: fullArguments, status: 'completed' } })}\n\n`,
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":8}}}\n\n',
    ]), anthropicTarget, [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
          pages: { type: 'string' },
        },
        required: ['file_path'],
      },
    }]))

    const starts = events.filter(event => (
      event.type === 'content_block_start' &&
      (event.data as any).content_block?.type === 'tool_use'
    ))
    const argumentDeltas = events.filter(event => (
      event.type === 'content_block_delta' &&
      (event.data as any).delta?.type === 'input_json_delta'
    ))

    expect(starts).toHaveLength(1)
    expect(starts[0].data).toMatchObject({
      content_block: { type: 'tool_use', id: 'call_read', name: 'Read' },
    })
    expect(argumentDeltas).toHaveLength(1)
    expect((argumentDeltas[0].data as any).delta.partial_json).toBe(JSON.stringify({
      file_path: '/tmp/package.json',
      limit: 220,
      offset: 0,
    }))
    expect(JSON.stringify(events)).not.toContain('"name":"tool"')
  })
})
