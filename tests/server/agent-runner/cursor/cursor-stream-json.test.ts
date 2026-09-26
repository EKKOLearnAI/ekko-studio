import { describe, expect, it } from 'vitest'
import { applyCursorStreamEvent, type CursorEventSink } from '../../../../packages/server/src/modules/coding-agents/services/cursor/event-adapter'
import { parseCursorStreamJsonLine } from '../../../../packages/server/src/modules/coding-agents/services/cursor/stream-json'

const DOCUMENTED_SESSION = 'c6b62c6f-7ead-4fd6-9922-e952131177ff'

const DOCUMENTED_STREAM = [
  '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/Users/user/project","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","model":"Claude 4 Sonnet","permissionMode":"default"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Read README.md and create a summary"}]},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I\'ll read the README.md file"}]},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"tool_call","subtype":"started","call_id":"toolu_vrtx_01NnjaR886UcE8whekg2MGJd","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"tool_call","subtype":"completed","call_id":"toolu_vrtx_01NnjaR886UcE8whekg2MGJd","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"# Project","totalLines":54}}}},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Based on the README, I\'ll create a summary"}]},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"tool_call","subtype":"started","call_id":"toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv","tool_call":{"writeToolCall":{"args":{"path":"summary.txt","fileText":"# README Summary"}}},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"tool_call","subtype":"completed","call_id":"toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv","tool_call":{"writeToolCall":{"args":{"path":"summary.txt","fileText":"# README Summary"},"result":{"success":{"path":"/Users/user/project/summary.txt","linesCreated":19}}}},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done! I\'ve created the summary in summary.txt"}]},"session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff"}',
  '{"type":"result","subtype":"success","duration_ms":5234,"duration_api_ms":5234,"is_error":false,"result":"I\'ll read the README.md fileBased on the README, I\'ll create a summaryDone! I\'ve created the summary in summary.txt","session_id":"c6b62c6f-7ead-4fd6-9922-e952131177ff","request_id":"10e11780-df2f-45dc-a1ff-4540af32e9c0"}',
]

function collectSink() {
  const text: string[] = []
  const started: unknown[] = []
  const completed: unknown[] = []
  const sessions: string[] = []
  const usage: unknown[] = []
  const completedTurns: unknown[] = []
  const errors: Array<{ message: string; usage?: unknown }> = []
  const sink: CursorEventSink = {
    text: value => text.push(value),
    thought: () => undefined,
    toolStarted: value => started.push(value),
    toolCompleted: value => completed.push(value),
    usage: value => usage.push(value),
    session: value => sessions.push(value),
    complete: value => completedTurns.push(value),
    error: (message, errorUsage) => errors.push({ message, usage: errorUsage }),
    status: () => undefined,
  }
  return { sink, text, started, completed, sessions, usage, completedTurns, errors }
}

describe('Cursor stream-json parsing', () => {
  it('ignores blank lines, invalid JSON, user prompts, and unknown event types', () => {
    expect(parseCursorStreamJsonLine('')).toBeNull()
    expect(parseCursorStreamJsonLine('not-json')).toBeNull()
    expect(parseCursorStreamJsonLine('{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}')).toBeNull()
    expect(parseCursorStreamJsonLine('{"type":"thinking","text":"hidden in print mode"}')).toBeNull()
    expect(parseCursorStreamJsonLine('{"type":"future_field","session_id":"s"}')).toBeNull()
  })

  it('maps system init and terminal success from the documented event stream', () => {
    expect(parseCursorStreamJsonLine(DOCUMENTED_STREAM[0])).toEqual({
      type: 'session',
      sessionId: DOCUMENTED_SESSION,
      model: 'Claude 4 Sonnet',
    })
    expect(parseCursorStreamJsonLine(DOCUMENTED_STREAM[3])).toEqual({
      type: 'tool_started',
      toolCallId: 'toolu_vrtx_01NnjaR886UcE8whekg2MGJd',
      toolName: 'read',
      input: { path: 'README.md' },
    })
    expect(parseCursorStreamJsonLine(DOCUMENTED_STREAM[4])).toEqual({
      type: 'tool_completed',
      toolCallId: 'toolu_vrtx_01NnjaR886UcE8whekg2MGJd',
      output: { success: { content: '# Project', totalLines: 54 } },
      failed: false,
    })
    expect(parseCursorStreamJsonLine(DOCUMENTED_STREAM[9])).toEqual({
      type: 'complete',
      sessionId: DOCUMENTED_SESSION,
      result: "I'll read the README.md fileBased on the README, I'll create a summaryDone! I've created the summary in summary.txt",
      usage: { duration_ms: 5234, duration_api_ms: 5234 },
    })
  })

  it('keeps only streaming deltas when --stream-partial-output is enabled', () => {
    const delta = parseCursorStreamJsonLine('{"type":"assistant","timestamp_ms":100,"message":{"content":[{"type":"text","text":"Hel"}]},"session_id":"s"}')
    const nextDelta = parseCursorStreamJsonLine('{"type":"assistant","timestamp_ms":101,"message":{"content":[{"type":"text","text":"lo"}]},"session_id":"s"}')
    const beforeTool = parseCursorStreamJsonLine('{"type":"assistant","timestamp_ms":102,"model_call_id":"call-1","message":{"content":[{"type":"text","text":"Hello"}]},"session_id":"s"}')
    const finalFlush = parseCursorStreamJsonLine('{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]},"session_id":"s"}')

    expect(delta).toEqual({ type: 'text', data: 'Hel' })
    expect(nextDelta).toEqual({ type: 'text', data: 'lo' })
    expect(beforeTool).toBeNull()
    expect(finalFlush).toBeNull()
  })

  it('keeps complete assistant messages when stream-json is not partial', () => {
    const complete = parseCursorStreamJsonLine(DOCUMENTED_STREAM[2], { streamPartial: false })
    expect(complete).toEqual({ type: 'text', data: "I'll read the README.md file" })
    expect(parseCursorStreamJsonLine(DOCUMENTED_STREAM[2])).toBeNull()
  })

  it('maps function-style tools and failed tool results', () => {
    const started = parseCursorStreamJsonLine('{"type":"tool_call","subtype":"started","call_id":"fn-1","tool_call":{"function":{"name":"browser_navigate","arguments":"{\\"url\\":\\"https://example.com\\"}"}}}')
    const failed = parseCursorStreamJsonLine('{"type":"tool_call","subtype":"completed","call_id":"fn-1","tool_call":{"function":{"name":"browser_navigate","result":{"error":{"message":"timeout"}}}}}')

    expect(started).toEqual({
      type: 'tool_started',
      toolCallId: 'fn-1',
      toolName: 'browser_navigate',
      input: { url: 'https://example.com' },
    })
    expect(failed).toEqual({
      type: 'tool_completed',
      toolCallId: 'fn-1',
      output: { error: { message: 'timeout' } },
      failed: true,
    })
  })

  it('maps terminal error results', () => {
    expect(parseCursorStreamJsonLine('{"type":"result","subtype":"error","is_error":true,"result":"auth required","session_id":"s1","duration_ms":12}')).toEqual({
      type: 'error',
      message: 'auth required',
      sessionId: 's1',
      usage: { duration_ms: 12 },
    })
  })
})

describe('Cursor stream-json adaptation', () => {
  it('maps the documented non-partial stream onto the Studio event sink', () => {
    const collected = collectSink()
    for (const line of DOCUMENTED_STREAM) {
      const event = parseCursorStreamJsonLine(line, { streamPartial: false })
      if (event) applyCursorStreamEvent(event, collected.sink)
    }

    expect(collected.text).toEqual([
      "I'll read the README.md file",
      "Based on the README, I'll create a summary",
      "Done! I've created the summary in summary.txt",
    ])
    expect(collected.started).toEqual([
      { id: 'toolu_vrtx_01NnjaR886UcE8whekg2MGJd', name: 'read', input: { path: 'README.md' } },
      { id: 'toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv', name: 'write', input: { path: 'summary.txt', fileText: '# README Summary' } },
    ])
    expect(collected.completed).toEqual([
      { id: 'toolu_vrtx_01NnjaR886UcE8whekg2MGJd', output: { success: { content: '# Project', totalLines: 54 } }, failed: false },
      { id: 'toolu_vrtx_01Q3VHVnWFSKygaRPT7WDxrv', output: { success: { path: '/Users/user/project/summary.txt', linesCreated: 19 } }, failed: false },
    ])
    expect(collected.sessions).toEqual([DOCUMENTED_SESSION, DOCUMENTED_SESSION])
    expect(collected.completedTurns).toEqual([{ duration_ms: 5234, duration_api_ms: 5234 }])
    expect(collected.errors).toEqual([])
  })

  it('does not replay duplicate assistant flushes into the sink', () => {
    const collected = collectSink()
    const lines = [
      '{"type":"assistant","timestamp_ms":1,"message":{"content":[{"type":"text","text":"Hi"}]}}',
      '{"type":"assistant","timestamp_ms":2,"model_call_id":"c1","message":{"content":[{"type":"text","text":"Hi"}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Hi","session_id":"s"}',
    ]
    for (const line of lines) {
      const event = parseCursorStreamJsonLine(line)
      if (event) applyCursorStreamEvent(event, collected.sink)
    }
    expect(collected.text).toEqual(['Hi'])
    expect(collected.sessions).toEqual(['s'])
    expect(collected.completedTurns).toEqual([undefined])
  })
})
