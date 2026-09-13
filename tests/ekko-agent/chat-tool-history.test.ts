import { describe, expect, it } from 'vitest'
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
