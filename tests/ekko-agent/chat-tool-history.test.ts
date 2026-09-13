import { describe, expect, it, vi } from 'vitest'
import { AgentRuntime, AgentToolRegistry, createModelClient } from '../../packages/ekko-agent/src/index'
import { toOpenAIChatPayload } from '../../packages/ekko-agent/src/model/providers/openai-compatible'
import type { AgentMessage, ModelProviderConfig } from '../../packages/ekko-agent/src/model/types'

const config: ModelProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  defaultModel: 'deepseek-chat',
}

const calls: AgentMessage = {
  role: 'assistant',
  content: 'Starting the work.',
  reasoning: { text: 'Inspect both results.' },
  toolCalls: [
    { id: 'first', name: 'inspect', arguments: {} },
    { id: 'second', name: 'inspect', arguments: {} },
  ],
}

function assertPaired(messages: ReturnType<typeof toOpenAIChatPayload>['messages']) {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'tool') {
      expect(pending.delete(message.tool_call_id!)).toBe(true)
    } else {
      expect([...pending]).toEqual([])
      for (const call of message.tool_calls ?? []) {
        expect(pending.has(call.id)).toBe(false)
        pending.add(call.id)
      }
    }
  }
  expect([...pending]).toEqual([])
}

describe('Chat tool history pairing', () => {
  it.each([true, false])('continues the same tool loop after view_image and terminal_exec (streaming=%s)', async (streaming) => {
    const requestBodies: Array<ReturnType<typeof toOpenAIChatPayload>> = []
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      requestBodies.push(body)
      try {
        assertPaired(body.messages)
      } catch {
        return new Response(JSON.stringify({ error: {
          message: "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)",
        } }), { status: 400 })
      }
      const first = requestBodies.length === 1
      const message = first ? {
        content: '',
        tool_calls: [
          { id: 'call_image', type: 'function', function: { name: 'view_image', arguments: '{}' } },
          { id: 'call_terminal', type: 'function', function: { name: 'terminal_exec', arguments: '{}' } },
        ],
      } : { content: 'Build verified.' }
      const finish_reason = first ? 'tool_calls' : 'stop'
      if (!streaming) return new Response(JSON.stringify({ choices: [{ message, finish_reason }] }))
      const delta = first ? {
        ...message,
        tool_calls: message.tool_calls!.map((tool, index) => ({ ...tool, index })),
      } : message
      const frame = JSON.stringify({ choices: [{ delta, finish_reason }] })
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    const imageTool = vi.fn(async () => ({
      ok: true, content: 'Loaded screenshot.',
      contentParts: [{ type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }],
    }))
    const terminalTool = vi.fn(async () => ({ ok: true, content: 'Build complete.' }))
    const tools = new AgentToolRegistry()
    tools.register({ definition: { name: 'view_image' }, concurrency: 'parallel', execute: imageTool })
    tools.register({ definition: { name: 'terminal_exec' }, execute: terminalTool })
    const runtime = new AgentRuntime({
      tools,
      modelClient: createModelClient({ ...config, capabilities: { streaming, vision: true } }, { fetch: fetchMock }),
    })

    const result = await runtime.run({ messages: ['Inspect the screenshot and build the app.'] })

    expect(result.output.content).toBe('Build verified.')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(imageTool).toHaveBeenCalledTimes(1)
    expect(terminalTool).toHaveBeenCalledTimes(1)
    expect(requestBodies[1].messages.slice(-4).map(message => message.role))
      .toEqual(['assistant', 'tool', 'tool', 'user'])
    expect(result.events.some(event => event.type === 'model.retry' || event.type === 'run.failed')).toBe(false)
  })

  it('closes a batch with no recorded results', () => {
    const payload = toOpenAIChatPayload(config, { messages: [calls] })
    assertPaired(payload.messages)
    expect(payload.messages.slice(1).map(message => message.tool_call_id)).toEqual(['first', 'second'])
    expect(payload.messages.slice(1).every(message => String(message.content).includes('Execution status is unknown'))).toBe(true)
  })

  it.each(['user', 'system', 'assistant', 'end'] as const)(
    'closes a partially completed tool batch before %s without mutating history',
    (boundary) => {
      const messages: AgentMessage[] = [
        structuredClone(calls),
        { role: 'tool', toolCallId: 'second', content: 'Real result' },
        ...(boundary === 'end' ? [] : [{ role: boundary, content: 'Continue' }]),
      ]
      const original = structuredClone(messages)
      const payload = toOpenAIChatPayload(config, { messages })

      assertPaired(payload.messages)
      expect(messages).toEqual(original)
      expect(payload.messages[0]).toMatchObject({
        content: calls.content,
        reasoning_content: calls.reasoning!.text,
      })
      expect(payload.messages[1]).toMatchObject({ content: 'Real result', tool_call_id: 'second' })
      expect(payload.messages[2]).toMatchObject({
        role: 'tool', tool_call_id: 'first', content: expect.stringContaining('unknown'),
      })
    },
  )

  it('drops duplicate and orphan results and scopes reused ids to each batch', () => {
    const payload = toOpenAIChatPayload(config, { messages: [
      { role: 'tool', toolCallId: 'first', content: 'Orphan' },
      { ...calls, toolCalls: [calls.toolCalls![0], calls.toolCalls![0]] },
      { role: 'tool', toolCallId: ' first ', content: 'First result' },
      { role: 'tool', toolCallId: 'first', content: 'Duplicate' },
      { role: 'user', content: 'Continue' },
      { role: 'tool', toolCallId: 'first', content: 'Late result' },
      { ...calls, toolCalls: [{ id: 'first', name: '', arguments: {} }] },
      { role: 'tool', toolCallId: 'first', content: 'Invalid call result' },
      { ...calls, toolCalls: [calls.toolCalls![0]] },
      { role: 'tool', toolCallId: 'first', content: 'Reused id result' },
      { role: 'tool', content: 'Anonymous result' },
    ] })

    assertPaired(payload.messages)
    expect(payload.messages.filter(message => message.role === 'tool').map(message => message.content))
      .toEqual(['First result', 'Reused id result'])
  })

  it.each([true, false])('keeps image output after all tool results (vision=%s)', (vision) => {
    const payload = toOpenAIChatPayload({ ...config, capabilities: { vision } }, {
      messages: [
        calls,
        {
          role: 'tool', toolCallId: 'first', content: 'Screenshot',
          contentParts: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
        },
        { role: 'tool', toolCallId: 'second', content: 'Other result' },
        { role: 'user', content: 'Continue' },
      ],
    })

    assertPaired(payload.messages)
    expect(payload.messages.map(message => message.role))
      .toEqual(vision ? ['assistant', 'tool', 'tool', 'user', 'user'] : ['assistant', 'tool', 'tool', 'user'])
    if (vision) {
      expect(JSON.stringify(payload.messages[3])).toContain('data:image/png;base64,aGVsbG8=')
      expect(JSON.stringify(payload.messages[3])).toContain('tool result first')
    }
    expect(payload.messages.at(-1)?.content).toBe('Continue')
  })

  it('keeps image output after a synthetic missing result at the end of history', () => {
    const payload = toOpenAIChatPayload(config, { messages: [
      calls,
      {
        role: 'tool', toolCallId: 'first', content: 'Screenshot',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
      },
    ] })
    assertPaired(payload.messages)
    expect(payload.messages.map(message => message.role)).toEqual(['assistant', 'tool', 'tool', 'user'])
  })
})
