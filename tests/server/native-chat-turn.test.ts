import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedCodingAgentRun } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { startNativeChatTurn } from '../../packages/server/src/modules/coding-agents/services/registry/native-agents'
import type { NativeTurnHost } from '../../packages/server/src/modules/coding-agents/services/runtime/turn-host'

vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({ updateSession: vi.fn() }))
import { updateSession } from '../../packages/server/src/modules/studio/public/sessions'

const runs: ManagedCodingAgentRun[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
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
  it.each(['qwen', 'kimi', 'codebuddy', 'qoder', 'copilot'].flatMap(agent => [false, true].map(imageOnly => [agent, imageOnly] as const)))('forwards %s image attachments through the negotiated ACP transport (image only: %s)', async (agent, imageOnly) => {
    const root = mkdtempSync(join(tmpdir(), 'native-image-'))
    try {
      const path = join(root, 'image.png')
      writeFileSync(path, 'image-bytes')
      const { run, child, host } = fixture(agent)
      if (imageOnly) run.launch.nativeSystemPrompt = ''
      const requests: any[] = []
      child.stdin.on('data', chunk => {
        const message = JSON.parse(chunk.toString()); requests.push(message)
        if (message.id === undefined) return
        const result = message.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } }
          : message.method === 'session/new' ? { sessionId: 'native' } : { stopReason: 'end_turn' }
        queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n'))
      })
      startNativeChatTurn(run, imageOnly ? '' : 'look', '', host, [{ path, name: 'image.png', mediaType: 'image/png' }])
      await vi.waitFor(() => expect(host.complete).toHaveBeenCalled())
      expect(requests.at(-1).params.prompt).toContainEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from('image-bytes').toString('base64') })
      if (imageOnly) expect(requests.at(-1).params.prompt[0]).toEqual({ type: 'text', text: 'Inspect the attached images.' })
      child.emit('close', 0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('keeps ZCode images and prompt together in the Windows desktop stdin bridge (image only: %s)', imageOnly => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const { run, child, host } = fixture('zcode', true)
    run.launch.command = process.execPath
    run.launch.args = ['C:/ZCode/glm/zcode.cjs']
    run.launch.nativeSystemPrompt = ''
    const input = imageOnly ? '' : '中文😀\r\n"%PATH%" & ! ^ '.repeat(8000) + 'FINAL_SENTINEL'
    startNativeChatTurn(run, input, '', host, [{ path: 'C:/图片/image.png', name: 'image.png', mediaType: 'image/png' }])
    const launchArgs = vi.mocked(host.spawn).mock.calls[0][1]
    expect(launchArgs[0]).toBe('--eval')
    expect(launchArgs.join(' ').length).toBeLessThan(7000)
    const args = JSON.parse(child.stdin.read().toString())
    expect(args).toEqual(['C:/ZCode/glm/zcode.cjs', '--output-format', 'stream-json', '--mode', 'yolo',
      '--resume', 'existing-native', '--attach', 'C:/图片/image.png', '-p', input || 'Inspect the attached images.'])
    child.emit('close', 1)
  })

  it.each(['close', 'error', 'throw'])('cleans staged ZCode long input on process %s while retaining image args', event => {
    const { run, child, host } = fixture('zcode')
    let path = ''
    host.spawn = vi.fn((_command, args) => {
      path = args[args.lastIndexOf('--attach') + 1]
      expect(readFileSync(path, 'utf8')).toBe('Studio instructions\n\n' + '长文本😀'.repeat(20000))
      expect(args).toContain('/image.png')
      if (event === 'throw') throw new Error('spawn failed')
      return child as unknown as ChildProcess
    })
    const start = () => startNativeChatTurn(run, '长文本😀'.repeat(20000), '', host,
      [{ path: '/image.png', name: 'image.png', mediaType: 'image/png' }])
    if (event === 'throw') expect(start).toThrow('spawn failed')
    else { start(); child.emit(event, event === 'close' ? 1 : new Error('spawn failed')) }
    expect(path).not.toBe('')
    expect(existsSync(path)).toBe(false)
  })
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
    const args = vi.mocked(host.spawn).mock.calls[0][1]
    expect(args.slice(0, 6)).toEqual(['--output-format', 'stream-json', '--mode', 'yolo', '--resume', 'existing-native'])
    if (process.platform === 'win32') expect(readFileSync(args[args.indexOf('--attach') + 1], 'utf8')).toBe('Current instructions\n\nContinue')
    else expect(args.slice(6)).toEqual(['-p', 'Current instructions\n\nContinue'])
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
