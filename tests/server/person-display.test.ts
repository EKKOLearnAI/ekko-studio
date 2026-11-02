import { describe, expect, it } from 'vitest'
import { createPersonDisplayStream, personDisplayBackgroundTasks, personDisplayEvent, personDisplayEvents,
  personDisplayMessages, personDisplayPage, personDisplayResponse, personVisibleText } from '../../packages/server/src/modules/studio/services/chat-run/person-display'
import { buildAppResumeMessagePage, buildResumeEvents, buildResumeMessagePage } from '../../packages/server/src/modules/studio/services/chat-run/resume-payload'

const sid = 'person-main-test'
const message = (id: number, role: string, content: any, extra = {}) => ({ id, role, content, session_id: sid, timestamp: id, ...extra })
const hidden = { reasoning: 'PRIVATE', reasoning_content: 'PRIVATE', reasoning_details: { raw: 'PRIVATE' },
  tool_calls: [{ function: { name: 'exec', arguments: 'PRIVATE' } }], raw: 'PRIVATE', debug: 'PRIVATE' }

describe('Person outbound display projection', () => {
  it('removes unframed metadata previews without changing task session metadata', () => {
    const session = { id: sid, preview: 'PRIVATE truncated thinking', parent_last_message: 'PRIVATE', title: 'Bot' }
    const result = personDisplayResponse({ session, sessions: [session, { id: 'person-task-1', preview: 'Task detail' }] })
    expect(result.session).toMatchObject({ title: 'Bot', preview: '', parent_last_message: null })
    expect(result.sessions[1].preview).toBe('Task detail')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(session.preview).toContain('PRIVATE')
  })
  it('keeps immutable raw-offset slots and visible content while discarding all execution fields', () => {
    const input = [message(1, 'user', 'Example <think>literal</think>'),
      message(2, 'assistant', '<think>PRIVATE</think>Done', hidden),
      message(3, 'tool', 'PRIVATE', { tool_name: 'exec', tool_call_id: 'PRIVATE' }),
      message(4, 'moa', 'PRIVATE'), message(5, 'assistant', 'PRIVATE', { display_role: 'tool' }),
      message(6, 'assistant', '', hidden), message(7, 'tool', 'PRIVATE', { display_role: 'assistant' })]
    const before = JSON.stringify(input)
    const output = personDisplayMessages(sid, input)
    expect(output).toHaveLength(input.length)
    expect(output.map(m => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(output.map(m => m.content)).toEqual(['Example <think>literal</think>', 'Done', '', '', '', '', ''])
    expect(JSON.stringify(output)).not.toContain('PRIVATE')
    expect(JSON.stringify(input)).toBe(before)
  })

  it.each([false, true, 'double'])('normalizes native content blocks in warm/cold representation %s', representation => {
    const blocks = [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'tool_use', input: 'PRIVATE' },
      { type: 'text', text: 'Visible' }, { type: 'file', path: '/tmp/file.pdf', name: 'file.pdf', context: 'PRIVATE' }]
    const content = representation === 'double' ? JSON.stringify(JSON.stringify(blocks)) : representation ? JSON.stringify(blocks) : blocks
    const output = personDisplayMessages(sid, [message(1, 'assistant', content, hidden)])
    expect(JSON.stringify(output)).not.toContain('PRIVATE')
    expect(JSON.parse(output[0].content)).toEqual([{ type: 'text', text: 'Visible' }, { type: 'file', path: '/tmp/file.pdf', name: 'file.pdf' }])
  })

  it('fails closed on malformed native blocks while preserving user attachments and ordinary JSON', () => {
    const input = [message(1, 'assistant', '[{"type":"thinking","thinking":"PRIVATE'),
      message(2, 'user', JSON.stringify([{ type: 'file', name: 'input', path: '/tmp/input' }])),
      message(3, 'assistant', '[{"answer":42}]'), message(4, 'assistant', 'internal', { display_content: 'Shown', display_role: 'assistant' })]
    expect(personDisplayMessages(sid, input).map(m => m.content)).toEqual(['', input[1].content, '[{"answer":42}]', 'Shown'])
  })

  it('preserves code literals and removes nested and unclosed reasoning', () => {
    const code = '```xml\n<think>literal</think>\n```'
    expect(personVisibleText(`${code}\n<thinking>PRIVATE<think>PRIVATE</think>PRIVATE</thinking>Done`)).toBe(`${code}\nDone`)
    expect(personVisibleText('Done<reasoning>PRIVATE')).toBe('Done')
    expect(personVisibleText('Done<think>PRIVATE</reasoning>PRIVATE')).toBe('Done')
    expect(personVisibleText('`<think>literal</think>`')).toBe('`<think>literal</think>`')
  })

  it('never leaks reasoning for any split of live text, including one-character chunks', () => {
    const text = 'Hello<think>PRIVATE<thinking>PRIVATE</thinking>PRIVATE</think> world'
    for (const chunks of [...Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]), [...text]]) {
      const stream = createPersonDisplayStream(sid)
      stream('run.started', { run_id: 'r' })
      const events = chunks.map(delta => stream('message.delta', { event: 'message.delta', delta, ...hidden })).filter(Boolean)
      expect(events.map(e => e.delta).join('')).toBe('Hello world')
      expect(JSON.stringify(events)).not.toContain('PRIVATE')
    }
  })

  it('retains approval/clarification, timeout, receipt and plan contracts, strips opaque context', () => {
    const approval = { event: 'approval.requested', approval_id: 'a', command: 'publish', description: 'Publish?', choices: ['once', 'deny'], requested_at: 1000, timeout_ms: 3000, durable: true, ...hidden }
    const input = [{ event: 'approval.requested', data: approval },
      { event: 'clarify.requested', data: { clarify_id: 'q', question: 'Which?', choices: ['A'], durable: true, ...hidden } },
      { event: 'tool.completed', data: { output: 'PRIVATE' } }, { event: 'reasoning.delta', data: { delta: 'PRIVATE' } },
      { event: 'agent.event', data: { raw: 'PRIVATE' } },
      { event: 'context.updated', data: { context: { raw: 'PRIVATE' }, contextTokens: 123 } },
      { event: 'plan.updated', data: { plan_id: 'p', plan: [{ id: 's', step: 'Verify', status: 'in_progress', raw: 'PRIVATE' }] } }]
    const before = JSON.stringify(input)
    const events = personDisplayEvents(sid, buildResumeEvents(input, 2000))
    expect(events.map(e => e.event)).toEqual(['approval.requested', 'clarify.requested', 'context.updated', 'plan.updated'])
    expect(events[0].data).toMatchObject({ approval_id: 'a', command: 'publish', choices: ['once', 'deny'], durable: true, remaining_timeout_ms: 2000 })
    expect(JSON.stringify(events)).not.toContain('PRIVATE')
    expect(JSON.stringify(input)).toBe(before)
    const receipt = { assistantMessageId: '8', executionId: 'e', taskId: 't', title: 'Result', state: 'finished' }
    expect(personDisplayMessages(sid, [message(8, 'assistant', '', { person_task_return: receipt, run_usage: { runId: 'r', costUsd: 0 } })])[0])
      .toMatchObject({ id: 8, person_task_return: receipt, run_usage: { runId: 'r', costUsd: 0 } })
  })

  it('drops orphan replay deltas and raw background previews, preserves terminal and background state', () => {
    const events = personDisplayEvents(sid, [{ event: 'message.delta', data: { delta: 'PRIVATE</think>' } },
      { event: 'run.completed', data: { output: '<think>PRIVATE</think>Done', context: 'PRIVATE', queue_remaining: 2, background_pending: 1 } }])
    expect(events).toEqual([{ event: 'run.completed', data: { output: 'Done', queue_remaining: 2, background_pending: 1 } }])
    expect(personDisplayBackgroundTasks(sid, [{ subagent_id: 's', status: 'running', preview: 'PRIVATE', arguments: 'PRIVATE', output_tail: 'PRIVATE' }]))
      .toEqual([{ subagent_id: 's', status: 'running' }])
  })

  it('keeps legacy offsets across 300 hidden rows and reaches the oldest visible message', () => {
    const raw = [message(1, 'assistant', 'Oldest'), ...Array.from({ length: 300 }, (_, i) => message(i + 2, 'tool', 'PRIVATE'))]
    let offset = 0
    const visible: string[] = []
    while (offset < raw.length) {
      const end = raw.length - offset
      const page = personDisplayMessages(sid, raw.slice(Math.max(0, end - 150), end))
      expect(page.length).toBeGreaterThan(0)
      // Exactly how released Studio and App clients advance pagination.
      offset += page.length
      visible.push(...page.map(m => m.content).filter(Boolean))
    }
    expect(offset).toBe(301)
    expect(visible).toEqual(['Oldest'])
    const cold = buildResumeMessagePage(raw.slice(-145), { messageTotal: 301, messageStateBaselineCount: 145 })
    expect(personDisplayPage(sid, cold)).toMatchObject({ messageTotal: 301, messageLoadedCount: 150, hasMoreBefore: true })
  })

  it('versions the sanitized App page before hashing and retains metadata on a cache hit', () => {
    const raw = buildResumeMessagePage([message(1, 'assistant', 'Done', hidden)])
    const page = personDisplayPage(sid, { ...raw, taskPlans: [], workspaceRunChanges: [] })
    const legacy = buildAppResumeMessagePage(raw, '')
    const first = buildAppResumeMessagePage(page, legacy.id)
    expect(first.id).not.toBe(legacy.id)
    expect(first.messagesCached).toBe(false)
    expect(JSON.stringify(first)).not.toContain('PRIVATE')
    const cached = buildAppResumeMessagePage(page, first.id)
    expect(cached).toMatchObject({ projection: 'person-display-v1', messagesCached: true, taskPlans: [] })
    expect(cached).not.toHaveProperty('messages')
    expect(buildAppResumeMessagePage({ ...page, workspaceRunChanges: [{ change_id: 'changed' } as any] }, first.id).messagesCached).toBe(false)
  })

  it.each(['person-task-test', 'ordinary', 'global-agent'])('leaves task details and other session contracts unchanged: %s', sessionId => {
    const messages = [message(1, 'tool', 'PRIVATE', hidden)]
    const event = { output: 'PRIVATE', context: 'PRIVATE' }
    expect(personDisplayMessages(sessionId, messages)).toBe(messages)
    expect(personDisplayEvent(sessionId, 'tool.completed', event)).toBe(event)
  })
})
