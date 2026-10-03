import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedCodingAgentRun } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { startNativeChatTurn, type NativeTurnHost } from '../../packages/server/src/modules/coding-agents/services/native/chat-turn'

vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({ updateSession: vi.fn() }))
import { updateSession } from '../../packages/server/src/modules/studio/public/sessions'

const runs: ManagedCodingAgentRun[] = []
afterEach(() => {
  for (const run of runs.splice(0)) {
    run.nativeAcpTurn?.dispose()
    if (run.currentChildKillTimer) clearTimeout(run.currentChildKillTimer)
  }
  vi.clearAllMocks()
})

function fixture(agentId: string, resume = false) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const run = { launch: { agentId, command: agentId, args: [], env: {}, workspaceDir: '/workspace', sessionId: 'studio-session',
    nativeSystemPrompt: 'Studio instructions', nativeMcpServers: { tools: { command: 'node', args: ['mcp.mjs'] } },
    ...(resume ? { agentNativeSessionId: 'existing-native' } : {}),
  }, nativeResumeReady: resume, exited: false, stoppedByUser: false } as unknown as ManagedCodingAgentRun
  runs.push(run)
  const host: NativeTurnHost = {
    spawn: vi.fn(() => child as unknown as ChildProcess),
    isRunning: value => Boolean(value && value === run.currentChild),
    terminate: vi.fn(), forceKill: vi.fn(),
    processError: error => String((error as Error).message), exitError: code => `exit ${code}`,
    stderr: vi.fn(), touch: vi.fn(), response: vi.fn(),
    text: vi.fn(text => { run.printText += text }), reasoning: vi.fn(), toolStarted: vi.fn(), toolCompleted: vi.fn(),
    completeAfterUsage: vi.fn(async () => {}),
    complete: vi.fn(() => { run.pendingChatCompletionEvent = 'run.completed'; run.pendingChatCompletionPayload = {} }),
    fail: vi.fn(() => { run.pendingChatCompletionEvent = 'run.failed'; run.pendingChatCompletionPayload = {} }),
  }
  return { child, run, host }
}

describe('native process turn lifecycle', () => {
  it.each(['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot'].flatMap(agent => [false, true].map(resume => [agent, resume] as const)))(
    'streams and persists %s sessions (resume: %s) before completing after process close', async (agent, resume) => {
      const { child, run, host } = fixture(agent, resume)
      const requests: any[] = []
      child.stdin.on('data', chunk => {
        const message = JSON.parse(chunk.toString())
        requests.push(message)
        if (message.id === undefined) return
        let result: object = {}
        if (message.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: true } }
        if (message.method === 'session/new') result = { sessionId: 'new-native' }
        if (message.method === 'session/prompt') {
          child.stdout.write(JSON.stringify({ method: 'session/update', params: { sessionId: run.launch.agentNativeSessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } } }) + '\n')
          result = { stopReason: 'end_turn' }
        }
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'))
      })
      startNativeChatTurn(run, 'Review', '', host)
      await vi.waitFor(() => expect(host.complete).toHaveBeenCalledTimes(1))
      expect(host.spawn).toHaveBeenCalledWith(agent, agent === 'kimi' ? ['acp'] : ['--acp'], expect.objectContaining({ cwd: '/workspace', pipeStdin: true }))
      expect(requests.map(item => item.method)).toEqual(['initialize', resume ? 'session/load' : 'session/new', 'session/prompt'])
      expect(requests.at(-1).params.prompt).toEqual([{ type: 'text', text: 'Studio instructions\n\nReview' }])
      expect(host.text).toHaveBeenCalledWith('你好', true)
      expect(updateSession).toHaveBeenCalledWith('studio-session', { agent_native_session_id: resume ? 'existing-native' : 'new-native' })
      expect(host.completeAfterUsage).not.toHaveBeenCalled()
      child.emit('close', 0)
      expect(host.completeAfterUsage).toHaveBeenCalledWith('run.completed', {})
      expect(run.currentChild).toBeUndefined()
      expect(host.fail).not.toHaveBeenCalled()
    },
  )

  it('flushes the final ZCode result without a newline and resumes the same session', async () => {
    const { child, run, host } = fixture('zcode', true)
    startNativeChatTurn(run, 'Continue', 'Current instructions', host)
    expect(host.spawn).toHaveBeenCalledWith('zcode', ['--output-format', 'stream-json', '--mode', 'yolo', '--resume', 'existing-native', '-p', 'Current instructions\n\nContinue'], expect.any(Object))
    child.stdout.end(JSON.stringify({ type: 'result', sessionId: 'existing-native', response: '你好', usage: { input_tokens: 4 }, projection: { status: 'completed' } }))
    await vi.waitFor(() => expect(host.complete).toHaveBeenCalledWith({ input_tokens: 4 }))
    expect(host.text).toHaveBeenCalledExactlyOnceWith('你好', true)
    expect(updateSession).toHaveBeenCalledWith('studio-session', { agent_native_session_id: 'existing-native' })
    child.emit('close', 0)
    expect(host.completeAfterUsage).toHaveBeenCalledWith('run.completed', {})
  })

  it('does not complete a ZCode turn after an explicit failure', () => {
    const { child, run, host } = fixture('zcode')
    run.launch.approvalRequired = true
    startNativeChatTurn(run, 'Review', '', host)
    expect(vi.mocked(host.spawn).mock.calls[0][1]).toContain('plan')
    child.stdout.write(JSON.stringify({ type: 'turn.failed', payload: { error: { message: 'Auth required' } } }) + '\n')
    child.stdout.write(JSON.stringify({ type: 'result', response: 'Partial output' }) + '\n')
    child.emit('close', 1)
    expect(host.fail).toHaveBeenCalledExactlyOnceWith('Auth required')
    expect(host.complete).not.toHaveBeenCalled()
    expect(host.completeAfterUsage).toHaveBeenCalledWith('run.failed', {})
  })

  it('rejects a successful ZCode process exit without a final protocol result', () => {
    const { child, run, host } = fixture('zcode')
    startNativeChatTurn(run, 'Review', '', host)
    child.emit('close', 0)
    expect(host.fail).toHaveBeenCalledExactlyOnceWith('ZCode exited without a final result')
    expect(host.complete).not.toHaveBeenCalled()
  })
})
