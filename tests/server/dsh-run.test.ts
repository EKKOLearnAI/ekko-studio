import { withRunUsage } from '../../packages/server/src/modules/studio/repositories/run-usage-store'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getSession, getSessionDetail } from '../../packages/server/src/modules/studio/repositories/session-store'
import { getRecordedUsageTotals } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { DSH_STREAM_METHOD, DSH_USAGE_METHOD } from '../../packages/server/src/modules/coding-agents/services/dsh/stream-plugin'

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: vi.fn() }))

describe('DSH chat runner', () => {
  let manager: CodingAgentRunManager, workspace: string, sessionId: string, emitted: ReturnType<typeof vi.fn>
  let children: ReturnType<typeof createChild>[]
  function createChild() {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 999999999, exitCode: null as number | null, signalCode: null, kill: vi.fn(), sent: [] as any[],
    })
    child.stdin.on('data', chunk => {
      const message = JSON.parse(chunk.toString())
      child.sent.push(message)
      if (!message.method || message.method === 'session/prompt') return
      const result = message.method === 'initialize' ? { protocolVersion: 1 }
        : message.method === 'session/new' ? { sessionId: 'dsh-native' } : {}
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`))
    })
    child.stdin.on('finish', () => setImmediate(() => { child.exitCode = 0; child.emit('close', 0) }))
    children.push(child)
    return child
  }
  beforeEach(() => {
    initAllHermesTables()
    workspace = mkdtempSync(join(tmpdir(), 'studio-dsh-run-'))
    sessionId = `chat-${workspace}`
    children = []
    manager = new CodingAgentRunManager()
    emitted = vi.fn()
    vi.spyOn(process, 'kill').mockReturnValue(true)
    ;(manager as any).emitToChat = emitted
    ;(manager as any).markChatRunCompleted = () => {}
    vi.mocked(spawn).mockImplementation(() => createChild() as any)
    manager.start({ agentSessionId: sessionId, sessionId, agentId: 'dsh', mode: 'scoped', profile: 'default', agentPreset: 'minimal',
      provider: 'test', model: 'test-model', command: 'dsh', args: ['--profile', 'acp'], shellCommand: 'dsh', workspaceDir: workspace })
  })
  afterEach(() => {
    manager.shutdown()
    for (const child of children) { child.exitCode = 0; child.emit('close', 0) }
    rmSync(workspace, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
  async function prompt(text: string) {
    manager.send(sessionId, text)
    const child = children.at(-1)!
    await vi.waitFor(() => expect(child.sent.at(-1)?.method).toBe('session/prompt'))
    return child
  }
  function update(child: ReturnType<typeof createChild>, update: any) {
    child.stdout.write(`${JSON.stringify({ method: 'session/update', params: { sessionId: 'dsh-native', update } })}\n`)
  }
  function finish(child: ReturnType<typeof createChild>) {
    child.stdout.write(`${JSON.stringify({ id: child.sent.find(message => message.method === 'session/prompt').id, result: { stopReason: 'end_turn' } })}\n`)
  }
  it('keeps a stopped DSH turn usage card attached to its persisted reply', async () => {
    const child = await prompt('stop after usage')
    update(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial DSH reply' } })
    manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: {
      id: 'dsh-request', usage: { input_tokens: 20, output_tokens: 5 },
    } } } as any, 1)
    const state = (manager as any).getBySession(sessionId).state
    manager.stop(sessionId, { reportClosed: false })
    const summary = state.finalizeRunUsage()
    expect(summary).toMatchObject({ inputTokens: 20, outputTokens: 5, tokensPerSecond: 5 })
    expect(summary.assistantMessageId).toBeTruthy()
    expect(withRunUsage(sessionId, getSessionDetail(sessionId)!.messages).find(message => String(message.id) === summary.assistantMessageId))
      .toHaveProperty('run_usage', summary)
  })
  it.each(['global', 'scoped'])('accounts DSH calls once across resumed turns in %s mode', async mode => {
    ;(manager as any).getBySession(sessionId).launch.mode = mode
    const native = (child: ReturnType<typeof createChild>, requestId: string) => child.stdout.write(`${JSON.stringify({
      method: DSH_USAGE_METHOD, params: { requestId, sessionId: 'child-or-compaction', model: 'actual-model', provider: 'actual-provider',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20 }, apiDuration: 0.5 },
    })}\n`)
    const child = await prompt('first')
    native(child, 'one'); native(child, 'one')
    native(child, 'two')
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: mode === 'global' ? 20 : 0 })
    finish(child)
    await vi.waitFor(() => expect(child.exitCode).toBe(0))
    const next = await prompt('second')
    native(next, 'three')
    finish(next)
    await vi.waitFor(() => expect(next.exitCode).toBe(0))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject(mode === 'global'
      ? { inputTokens: 30, outputTokens: 15, cacheReadTokens: 60, apiCalls: 3 }
      : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, apiCalls: 0 })
    if (mode === 'global') expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({
      run_usage: expect.objectContaining({ inputTokens: 30, outputTokens: 5, tokensPerSecond: 10, speedSource: 'model' }),
    }))
  })
  it('maps ACP text, reasoning and tools and uses proxy billing without duplicate output', async () => {
    const child = await prompt('work')
    expect(child.sent.find(message => message.method === 'session/new').params._meta).toEqual({ agentPreset: 'minimal' })
    expect(getSession(sessionId)?.agent_preset).toBe('minimal')
    manager.handleResponseEvent(sessionId, { type: 'response.output_text.delta', data: { delta: 'duplicate proxy text' } })
    manager.handleProxyUsageEvent(sessionId, { type: 'response.completed', data: { response: { id: 'bill-1', usage: { input_tokens: 10, output_tokens: 5 } } } })
    update(child, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } })
    update(child, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read_file', rawInput: { path: 'README.md' } })
    update(child, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file content' } }] })
    update(child, { sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'read_file', rawInput: { path: 'missing.md' } })
    update(child, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', status: 'failed', rawOutput: 'File missing' })
    update(child, { sessionUpdate: 'usage_update', used: 900, size: 1000 })
    update(child, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } })
    finish(child)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({ output: '完成' })))
    expect(JSON.stringify(emitted.mock.calls)).toContain('read_file')
    expect(JSON.stringify(emitted.mock.calls)).toContain('Thinking')
    expect(emitted).toHaveBeenCalledWith(sessionId, 'tool.failed', expect.objectContaining({ tool_call_id: 'tool-2' }))
    expect(JSON.stringify(emitted.mock.calls)).not.toContain('duplicate proxy text')
    expect(getSession(sessionId)).toMatchObject({ agent: 'dsh', agent_native_session_id: 'dsh-native' })
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({ inputTokens: 10, outputTokens: 5, apiCalls: 1 })
    const next = await prompt('continue')
    expect(next.sent.some(message => message.method === 'session/resume' && message.params.sessionId === 'dsh-native')).toBe(true)
    expect(next.sent.some(message => message.method === 'session/new')).toBe(false)
    finish(next)
    await vi.waitFor(() => expect(next.exitCode).toBe(0))
  })
  it('reports failure when DSH exits without an ACP result', async () => {
    const child = await prompt('work')
    child.stderr.write('startup failed')
    child.exitCode = 1
    child.emit('close', 1)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.failed', expect.anything()))
    expect(emitted.mock.calls.filter(call => call[1] === 'run.completed')).toHaveLength(0)
  })
  it('publishes native live deltas before ACP completion without dropping repeated long text', async () => {
    const child = await prompt('work')
    const text = 'A repeated chunk longer than sixteen characters. '
    const live = (frame: object) => child.stdout.write(`${JSON.stringify({
      method: DSH_STREAM_METHOD, params: { sessionId: 'dsh-native', frame },
    })}\n`)
    for (const attemptId of ['before-tool', 'after-tool']) {
      live({ type: 'start', attemptId })
      live({ type: 'text-delta', attemptId, text })
      live({ type: 'text-delta', attemptId, text })
      // The UI event must already exist while both model and ACP are unfinished.
      expect(JSON.stringify(emitted.mock.calls)).toContain(text)
      expect(emitted.mock.calls.some(call => call[1] === 'run.completed')).toBe(false)
      live({ type: 'commit', attemptId, messageId: attemptId })
      live({ type: 'end', attemptId })
      update(child, { sessionUpdate: 'agent_message_chunk', messageId: attemptId, content: { type: 'text', text: text.repeat(2) } })
      if (attemptId === 'before-tool') {
        update(child, { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read_file', rawInput: {} })
        update(child, { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', rawOutput: 'done' })
      }
    }
    finish(child)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({ output: text.repeat(4) })))
  })
  it('auto-continues a terminal narration-only stall even when earlier steps ran tools', async () => {
    // Regression for the real muzqiqmjokjagr incident: one session/prompt is a
    // MULTI-STEP loop. Earlier steps ran real tools; the terminal step was a
    // narration-only "I'll …:" with no tool. The old detector judged on the
    // whole-prompt printText + codexToolBlocks, so the earlier tool masked the
    // terminal stall and no auto-continue fired. The fix tracks text since the
    // last tool call and judges the terminal step alone.
    const first = await prompt('work')
    // Step 1: a tool runs (resets the terminal-step text window).
    update(first, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the document:' } })
    update(first, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'read_file', rawInput: { path: 'bid.pdf' } })
    update(first, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'ok' })
    // Terminal step: narration-only, ends in a colon, no tool after it.
    update(first, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "To fix the PDF, I'll map the font names to system fonts in a copy of the docx:" } })
    finish(first)
    // The first child is the old one; the nudge re-dispatch must spawn a SECOND
    // child and resume the same native session with the continue nudge.
    await vi.waitFor(() => expect(children.length).toBe(2))
    const second = children.at(-1)!
    await vi.waitFor(() => expect(second.sent.at(-1)?.method).toBe('session/prompt'))
    expect(second.sent.some(message => message.method === 'session/resume' && message.params.sessionId === 'dsh-native')).toBe(true)
    const nudge = second.sent.find(message => message.method === 'session/prompt')
    expect(nudge.params.prompt).toEqual([{ type: 'text', text: expect.stringContaining('不要只叙述') }])
    // Completing the continued turn surfaces exactly one run.completed for the
    // whole auto-continue sequence (the first child's clean end_turn is not a
    // failure, and the nudge adds no user row).
    update(second, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The PDF now renders correctly. Done.' } })
    finish(second)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.objectContaining({ output: 'The PDF now renders correctly. Done.' })))
    expect(emitted.mock.calls.filter(call => call[1] === 'run.failed')).toHaveLength(0)
  })
  it('does NOT auto-continue when the prompt ends on a tool call (terminal step is a tool, not narration)', async () => {
    // The terminal step of the prompt made a tool call; there is no trailing
    // narration to stall on. textSinceLastTool is empty at finish, so no
    // auto-continue — the turn completes normally with one child.
    const first = await prompt('work')
    update(first, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me run the build:' } })
    update(first, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'exec', rawInput: { cmd: 'npm run build' } })
    update(first, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: 'built' })
    finish(first)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.anything()))
    await new Promise(resolve => setImmediate(resolve))
    expect(children.length).toBe(1)
  })
  it('cancels its ACP session and terminates its owned child on shutdown', async () => {
    const child = await prompt('work')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      manager.shutdown()
      expect(child.sent.at(-1)).toMatchObject({ method: 'session/cancel', params: { sessionId: 'dsh-native' } })
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGINT')
      expect(manager.getRunInfo(sessionId)).toBeNull()
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })
})
