import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  chatCompletionsToResponses,
  responsesToChatCompletion,
  responsesToChatCompletionSse,
} from '../../packages/server/src/modules/coding-agents/protocol/adapters/chat-completions'
import { truncateResponsesToolOutputs } from '../../packages/server/src/modules/coding-agents/protocol/adapters/responses'

async function frames(events: any[], includeUsage = false) {
  let output = ''
  for await (const chunk of responsesToChatCompletionSse(Readable.from(events), 'gpt-test', includeUsage)) output += chunk
  return { output, values: output.split('\n\n').filter(frame => frame.startsWith('data: {'))
    .map(frame => JSON.parse(frame.slice(6))) }
}

describe('Chat Completions custom tools through the Responses gateway', () => {
  it('preserves images and mixed tool history while translating custom grammar and selection', () => {
    const grammar = 'start: /.+/\n'
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } }] },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'patch', type: 'custom', custom: { name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' } },
          { id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
        ] },
        { role: 'tool', tool_call_id: 'patch', content: 'patch applied' },
        { role: 'tool', tool_call_id: 'read', content: 'file content' },
      ],
      tools: [
        { type: 'custom', custom: { name: 'apply_patch', description: 'Apply a patch',
          format: { type: 'grammar', grammar: { syntax: 'lark', definition: grammar } } } },
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' }, strict: true } },
      ],
      tool_choice: { type: 'custom', custom: { name: 'apply_patch' } },
    }
    const original = structuredClone(body)
    expect(chatCompletionsToResponses(body)).toMatchObject({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '这是什么' },
          { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'high' }] },
        { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
        { type: 'function_call', call_id: 'read', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { type: 'custom_tool_call_output', call_id: 'patch', output: 'patch applied' },
        { type: 'function_call_output', call_id: 'read', output: 'file content' },
      ],
      tools: [
        { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: grammar } },
        { type: 'function', name: 'read_file', parameters: { type: 'object' }, strict: true },
      ],
      tool_choice: { type: 'custom', name: 'apply_patch' },
    })
    expect(body).toEqual(original)
  })

  it.each([undefined, { type: 'text' }])('retains unconstrained custom format %j', format => {
    const custom = { name: 'raw', ...(format ? { format } : {}) }
    expect(chatCompletionsToResponses({ tools: [{ type: 'custom', custom }] }).tools).toEqual([{ type: 'custom', ...custom }])
  })

  it.each(['', 'not JSON\n你好', '{"literal":true}'])('round-trips custom input without JSON coercion: %j', input => {
    const completion = responsesToChatCompletion({ id: 'response-a', status: 'completed', output: [
      { type: 'custom_tool_call', id: 'item-a', call_id: 'call-a', name: 'raw', input },
    ] }, 'gpt-test')
    expect(completion.choices[0]).toMatchObject({ message: { content: null,
      tool_calls: [{ id: 'call-a', type: 'custom', custom: { name: 'raw', input } }] }, finish_reason: 'tool_calls' })
    const converted = chatCompletionsToResponses({ messages: [completion.choices[0].message,
      { role: 'tool', tool_call_id: 'call-a', content: '' }] })
    expect(converted.input).toEqual([
      { type: 'custom_tool_call', call_id: 'call-a', name: 'raw', input },
      { type: 'custom_tool_call_output', call_id: 'call-a', output: '' },
    ])
  })

  it('streams interleaved custom inputs and function arguments with distinct call indices', async () => {
    const result = await frames([
      { type: 'response.created', data: { response: { id: 'response-a' } } },
      { type: 'response.output_item.added', data: { item: { type: 'custom_tool_call', id: 'patch-item', call_id: 'patch', name: 'apply_patch', input: '*** ' } } },
      { type: 'response.output_item.added', data: { item: { type: 'function_call', id: 'read-item', call_id: 'read', name: 'read_file', arguments: '' } } },
      { type: 'response.custom_tool_call_input.delta', data: { item_id: 'patch-item', delta: 'Begin Patch\n' } },
      { type: 'response.function_call_arguments.delta', data: { item_id: 'read-item', delta: '{"path":' } },
      { type: 'response.custom_tool_call_input.delta', data: { item_id: 'patch-item', delta: '*** End Patch' } },
      { type: 'response.function_call_arguments.delta', data: { item_id: 'read-item', delta: '"文件.txt"}' } },
      { type: 'response.completed', data: { response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 3 } } } },
    ], true)
    const calls = new Map<number, any>()
    for (const frame of result.values) for (const delta of frame.choices?.[0]?.delta?.tool_calls || []) {
      const call = calls.get(delta.index) || { id: delta.id, type: delta.type,
        ...(delta.type === 'custom' ? { custom: { name: delta.custom.name, input: '' } }
          : { function: { name: delta.function.name, arguments: '' } }) }
      if (delta.custom) call.custom.input += delta.custom.input || ''
      if (delta.function) call.function.arguments += delta.function.arguments || ''
      calls.set(delta.index, call)
    }
    expect([...calls.values()]).toEqual([
      { id: 'patch', type: 'custom', custom: { name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' } },
      { id: 'read', type: 'function', function: { name: 'read_file', arguments: '{"path":"文件.txt"}' } },
    ])
    expect(result.values.at(-2).choices[0].finish_reason).toBe('tool_calls')
    expect(result.values.at(-1).usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 })
    expect(result.output.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it('rejects custom input deltas without a matching custom call', async () => {
    await expect(frames([
      { type: 'response.output_item.added', data: { item: { type: 'function_call', id: 'call', name: 'read_file', arguments: '' } } },
      { type: 'response.custom_tool_call_input.delta', data: { item_id: 'call', delta: 'invalid' } },
    ])).rejects.toThrow('without a custom call')
  })

  it('bounds custom tool results using the same output limit as function results', () => {
    const output = `START\n${'你好🙂'.repeat(5000)}\nEND`
    const body = { input: [
      { type: 'custom_tool_call_output', call_id: 'patch', output },
      { type: 'function_call_output', call_id: 'read', output },
      { type: 'custom_tool_call_output', call_id: 'small', output: 'ok' },
    ] }
    const truncated = truncateResponsesToolOutputs(body)
    expect(truncated.input[0].output).toEqual(truncated.input[1].output)
    expect(Buffer.byteLength(truncated.input[0].output)).toBeLessThanOrEqual(32 * 1024)
    expect(truncated.input[0].output).toContain('tool output truncated')
    expect(truncated.input[0].output).toMatch(/^START\n/)
    expect(truncated.input[0].output).toMatch(/\nEND$/)
    expect(truncated.input[2]).toBe(body.input[2])
    expect(body.input[0].output).toBe(output)
  })

  it('continues to reject unsupported hosted tool types', () => {
    expect(() => chatCompletionsToResponses({ tools: [{ type: 'web_search' }] })).toThrow('Unsupported Chat Completions tool: web_search')
  })
})
