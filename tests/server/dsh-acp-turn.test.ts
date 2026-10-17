import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshAcpTurn } from '../../packages/server/src/modules/coding-agents/services/dsh/acp-turn'
import { DSH_STREAM_METHOD, DSH_USAGE_METHOD } from '../../packages/server/src/modules/coding-agents/services/dsh/stream-plugin'

const turns: DshAcpTurn[] = []
afterEach(() => { for (const turn of turns.splice(0)) turn.dispose(); vi.useRealTimers() })

function connection(options: { resumeError?: boolean; permissionRequired?: boolean; holdPrompt?: boolean; usage?: (event: any) => void } = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
  const sent: any[] = []
  const update = vi.fn(), session = vi.fn(), config = vi.fn()
  const receive = (value: object) => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
  child.stdin.on('data', chunk => {
    const message = JSON.parse(chunk.toString())
    sent.push(message)
    if (!message.method || message.id === undefined) return
    const result = message.method === 'initialize'
      ? { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } }
      : message.method === 'session/new' ? { sessionId: 'native-1', configOptions: [] }
      : message.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
    if (options.holdPrompt && message.method === 'session/prompt') return
    queueMicrotask(() => receive({ id: message.id, ...(message.method === 'session/resume' && options.resumeError
      ? { error: { code: -32000, message: 'Session missing' } } : { result }) }))
  })
  const turn = new DshAcpTurn(child as unknown as ChildProcess, { update, session, config, usage: options.usage, permissionRequired: options.permissionRequired })
  turns.push(turn)
  return { child, turn, sent, receive, update, session }
}

describe('DSH ACP connection', () => {
  it('keeps text, tools and prompt completion alive when usage recording throws', async () => {
    const usage = vi.fn(() => { throw new Error('usage storage failed') })
    const { turn, sent, receive, update } = connection({ holdPrompt: true, usage })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', images: [] })
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    receive({ method: DSH_USAGE_METHOD, params: { sessionId: 'native-1', requestId: 'call' } })
    for (const data of [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } },
      { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read_file' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' },
    ]) receive({ method: 'session/update', params: { sessionId: 'native-1', update: data } })
    receive({ id: sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })
    await expect(pending).resolves.toBe('end_turn')
    expect(usage).toHaveBeenCalledOnce()
    expect(update.mock.calls.map(([event]) => event.sessionUpdate)).toEqual(['agent_message_chunk', 'tool_call', 'tool_call_update'])
  })
  it('passes a chosen preset only to a new native session', async () => {
    const fresh = connection()
    await fresh.turn.prompt({ cwd: '/workspace', text: 'go', images: [], agentPreset: 'minimal' })
    expect(fresh.sent.find(message => message.method === 'session/new').params._meta).toEqual({ agentPreset: 'minimal' })
    const resumed = connection()
    await resumed.turn.prompt({ cwd: '/workspace', text: 'go', images: [], agentPreset: 'standard', nativeSessionId: 'native-1' })
    expect(resumed.sent.find(message => message.method === 'session/resume').params).toEqual({ cwd: '/workspace', mcpServers: [], sessionId: 'native-1' })
  })

  it('negotiates, creates, selects the opaque model value, prompts and closes before EOF', async () => {
    const { turn, sent, child, session } = connection()
    await expect(turn.prompt({ cwd: '/workspace', text: '--hello', images: [], modelValue: '["ekko-studio","custom"]' })).resolves.toBe('end_turn')
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/close'])
    expect(sent[2].params).toEqual({ sessionId: 'native-1', configId: 'model', value: '["ekko-studio","custom"]' })
    expect(sent[3].params.prompt).toEqual([{ type: 'text', text: '--hello' }])
    expect(session).toHaveBeenCalledWith('native-1')
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('never creates an empty replacement when native resume fails', async () => {
    const { turn, sent, session } = connection({ resumeError: true })
    await expect(turn.prompt({ cwd: '/workspace', nativeSessionId: 'missing', text: 'continue', images: [] })).rejects.toThrow('Session missing')
    expect(sent.map(message => message.method)).toEqual(['initialize', 'session/resume'])
    expect(session).not.toHaveBeenCalled()
  })

  it('rejects unsupported images before committing a session', async () => {
    const { turn, sent } = connection()
    await expect(turn.prompt({ cwd: '/workspace', text: '', images: [{ path: '/missing.png' }] })).rejects.toThrow('does not support image')
    expect(sent).toHaveLength(1)
  })

  it.each([false, true])('handles permission choices and fragmented UTF-8 updates (approval required: %s)', async permissionRequired => {
    const { turn, sent, child, receive, update } = connection({ permissionRequired, holdPrompt: true })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', images: [] })
    const rejected = expect(pending).rejects.toThrow('cancelled by test')
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    const notification = Buffer.from(`${JSON.stringify({ method: 'session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } } })}\n`)
    for (const byte of notification) child.stdout.write(Buffer.from([byte]))
    receive({ method: 'session/update', params: { sessionId: 'someone-else', update: { sessionUpdate: 'agent_message_chunk' } } })
    expect(update).toHaveBeenCalledExactlyOnceWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } })
    receive({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native-1', options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } })
    expect(sent.at(-1).result.outcome).toEqual({ outcome: 'selected', optionId: permissionRequired ? 'no' : 'yes' })
    turn.cancel()
    expect(sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'native-1' } })
    turn.dispose(new Error('cancelled by test'))
    await rejected
  })

  it('fails pending work when the process closes without a prompt result', async () => {
    const { turn, child, sent } = connection({ holdPrompt: true })
    const pending = expect(turn.prompt({ cwd: '/workspace', text: 'go', images: [] })).rejects.toThrow('connection closed')
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    child.emit('close', 0)
    await pending
  })

  it('streams only the owned session and deduplicates final blocks by message and attempt', async () => {
    const { turn, sent, receive, update } = connection({ holdPrompt: true })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', images: [] })
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    const frame = (frame: object, sessionId = 'native-1') => receive({ method: DSH_STREAM_METHOD, params: { sessionId, frame } })
    const final = (messageId: string, text: string, sessionUpdate = 'agent_message_chunk') => receive({
      method: 'session/update', params: { sessionId: 'native-1', update: { messageId, sessionUpdate, content: { type: 'text', text } } },
    })
    frame({ type: 'start', attemptId: 'child' }, 'subagent')
    frame({ type: 'text-delta', attemptId: 'child', text: 'private subagent output' }, 'subagent')
    frame({ type: 'text-delta', attemptId: 'unknown', text: 'late output' })
    expect(update).not.toHaveBeenCalled()
    frame({ type: 'start', attemptId: 'first' })
    frame({ type: 'reasoning-delta', attemptId: 'first', text: '想一想' })
    frame({ type: 'text-delta', attemptId: 'first', text: '你好' })
    frame({ type: 'text-delta', attemptId: 'first', text: '世界' })
    expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['想一想', '你好', '世界'])
    frame({ type: 'commit', attemptId: 'first', messageId: 'message-1' })
    frame({ type: 'end', attemptId: 'first' })
    // A later model call can start before the first call's queued ACP updates.
    frame({ type: 'start', attemptId: 'second' })
    frame({ type: 'text-delta', attemptId: 'second', text: '你好世界' })
    frame({ type: 'commit', attemptId: 'second', messageId: 'message-2' })
    frame({ type: 'end', attemptId: 'second' })
    final('message-1', '想一想', 'agent_thought_chunk')
    final('message-1', '你好')
    final('message-1', '世界！') // Preserve a final-only suffix.
    final('message-2', '你好世界')
    final('no-stream', 'Final-only adapter')
    expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['想一想', '你好', '世界', '你好世界', '！', 'Final-only adapter'])
    receive({ id: sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })
    await pending
    turn.dispose()
    frame({ type: 'start', attemptId: 'late' })
    frame({ type: 'text-delta', attemptId: 'late', text: 'after disposal' })
    expect(update).toHaveBeenCalledTimes(6)
  })

  it('does not let an abandoned attempt consume a retry or a final-only message', async () => {
    const { turn, sent, receive, update } = connection({ holdPrompt: true })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', images: [] })
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    for (const frame of [
      { type: 'start', attemptId: 'failed' },
      { type: 'text-delta', attemptId: 'failed', text: 'Trying ' },
      { type: 'end', attemptId: 'failed' },
      { type: 'text-delta', attemptId: 'failed', text: 'late failed chunk' },
      { type: 'start', attemptId: 'retry' },
      { type: 'text-delta', attemptId: 'retry', text: 'Trying again' },
      { type: 'commit', attemptId: 'retry', messageId: 'retried-message' },
      { type: 'end', attemptId: 'retry' },
    ]) receive({ method: DSH_STREAM_METHOD, params: { sessionId: 'native-1', frame } })
    for (const messageId of ['retried-message', 'unstreamed-message']) receive({ method: 'session/update', params: {
      sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: 'Trying again' } },
    } })
    expect(update.mock.calls.map(([value]) => value.content.text)).toEqual(['Trying ', 'Trying again', 'Trying again'])
    receive({ id: sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })
    await pending
  })

  it('survives a dependency log line on stdout instead of disposing the turn', async () => {
    const { turn, sent, receive, child, update } = connection({ holdPrompt: true })
    const pending = turn.prompt({ cwd: '/workspace', text: 'go', images: [] })
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    // The MCP SDK's default logger emits console.debug (== stdout in a stdio
    // child) when a server lacks the resources capability. That line is not an
    // ACP frame and must not tear the connection down.
    child.stdout.write('Client.listResourceTemplates() called but server does not advertise resources capability - returning empty list\n')
    receive({ method: 'session/update', params: { sessionId: 'native-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after noise' } } } })
    receive({ id: sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })
    await expect(pending).resolves.toBe('end_turn')
    expect(update).toHaveBeenCalledExactlyOnceWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after noise' } })
  })

  it('still fails the turn when a frame that looks like JSON is corrupt', async () => {
    const { turn, sent, child } = connection({ holdPrompt: true })
    const pending = expect(turn.prompt({ cwd: '/workspace', text: 'go', images: [] })).rejects.toThrow()
    await vi.waitFor(() => expect(sent.at(-1).method).toBe('session/prompt'))
    // A line beginning with '{' that cannot parse is a real protocol break.
    child.stdout.write('{"jsonrpc":"2.0",\n')
    await pending
    turn.dispose()
  })

  it('bounds a stalled initialize request', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() })
    const turn = new DshAcpTurn(child as unknown as ChildProcess, { update: () => {}, session: () => {}, config: () => {} })
    turns.push(turn)
    const pending = expect(turn.prompt({ cwd: '/workspace', text: 'go', images: [] })).rejects.toThrow('initialize timed out')
    await vi.advanceTimersByTimeAsync(60_000)
    await pending
  })
})
