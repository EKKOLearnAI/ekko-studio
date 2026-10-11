import { EventEmitter } from 'events'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import { spawn } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import { CodingAgentRunManager } from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { getRecordedUsageTotals } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { getSessionDetail } from '../../packages/server/src/modules/studio/public/sessions'

vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawn: vi.fn(),
}))

describe('OpenCode turns', () => {
  let manager: CodingAgentRunManager
  let workspace: string
  let sessionId: string
  let agentSessionId: string
  let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; signalCode: null }
  let emitted: ReturnType<typeof vi.fn>

  beforeEach(() => {
    initAllHermesTables()
    workspace = mkdtempSync(join(tmpdir(), 'opencode-turn-'))
    sessionId = `chat-${workspace}`
    agentSessionId = `run-${workspace}`
    manager = new CodingAgentRunManager()
    emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    ;(manager as any).markChatRunCompleted = () => {}
    child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    })
    vi.mocked(spawn).mockReturnValue(child as any)
  })

  afterEach(() => {
    manager.shutdown()
    rmSync(workspace, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  function start(mode: 'global' | 'scoped' = 'global') {
    manager.start({
      agentSessionId, sessionId, agentId: 'opencode', mode,
      profile: 'default', provider: mode === 'global' ? 'global' : 'test', model: 'test-model',
      command: 'opencode', args: ['--model', 'test/model'], shellCommand: 'opencode', workspaceDir: workspace,
    })
  }

  function step(id: string, input: number, output: number) {
    child.stdout.write(`${JSON.stringify({
      type: 'step_finish', sessionID: 'ses_native',
      part: { id, type: 'step-finish', tokens: { input, output, reasoning: 3, cache: { read: 10, write: 2 } } },
    })}\n`)
  }

  function close(code = 0) {
    child.exitCode = code
    child.emit('close', code)
  }

  it.each(['global', 'scoped'] as const)('shows and persists native nested API errors in %s mode', async mode => {
    start(mode)
    manager.send(sessionId, 'work')
    const message = 'Upstream request failed: Model is unavailable.'
    child.stdout.write(`${JSON.stringify({ type: 'error', sessionID: 'ses_native', error: {
      name: 'APIError', data: { message, statusCode: 400, isRetryable: false,
        responseHeaders: { authorization: 'private-native-secret' }, responseBody: 'private-upstream-body' },
    } })}\n`)
    close(1)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.failed', expect.objectContaining({ error: message })))
    const failures = emitted.mock.calls.filter(([, event]) => event === 'run.failed')
    expect(failures).toHaveLength(1)
    expect(JSON.stringify(failures)).not.toContain('[object Object]')
    expect(JSON.stringify(failures)).not.toContain('private-native-secret')
    expect(JSON.stringify(failures)).not.toContain('private-upstream-body')
    const stored = getSessionDetail(sessionId)?.messages.filter(row => row.role === 'assistant')
    expect(stored).toEqual([expect.objectContaining({ content: message, finish_reason: 'error' })])
  })

  it.each([
    ['native string', 'Native request failed', 'Native request failed'],
    ['flat message', { message: 'Request failed' }, 'Request failed'],
    ['nested error', { error: { data: { message: 'Provider failed' } } }, 'Provider failed'],
    ['named error without text', { name: 'ProviderModelNotFoundError', data: { modelID: 'missing' } }, 'ProviderModelNotFoundError'],
    ['unknown object', { responseHeaders: { authorization: 'private-secret' } }, 'OpenCode run failed'],
  ])('renders %s without object coercion', async (_label, error, message) => {
    start()
    manager.send(sessionId, 'work')
    child.stdout.write(`${JSON.stringify({ type: 'error', error })}\n`)
    close(1)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.failed', expect.objectContaining({ error: message })))
    expect(JSON.stringify(emitted.mock.calls)).not.toContain('[object Object]')
    expect(JSON.stringify(emitted.mock.calls)).not.toContain('private-secret')
  })

  it('sends option-like text through stdin while retaining image file args', () => {
    start()
    const files = [join(workspace, 'first image.png'), join(workspace, 'second.png')]
    manager.send(sessionId, '--describe these images', {
      images: files.map((path, index) => ({ path, name: `image-${index}.png`, mediaType: 'image/png' })),
    })
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual([
      'run', '--format', 'json', '--agent', 'build', '--auto', '--thinking',
      '--model', 'test/model', '--file', files[0], '--file', files[1],
    ])
    expect(child.stdin.read().toString()).toBe('--describe these images')
    expect(child.stdin.writableEnded).toBe(true)
    expect(vi.mocked(spawn).mock.calls[0][2]?.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    close()
  })

  it('keeps long multiline Unicode input out of Windows cmd shim arguments', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      start()
      const run = manager.getBySession(sessionId)!
      run.launch.command = 'C:\\Tools\\opencode.cmd'
      const text = '你好😀\r\n%PATH% & | "quoted" '.repeat(4000)
      manager.send(sessionId, text)
      const args = vi.mocked(spawn).mock.calls[0][1]!
      expect(args.join(' ').length).toBeLessThan(7000)
      expect(args.join(' ')).not.toContain('你好')
      expect(child.stdin.read().toString()).toBe(text.trim())
      close()
    } finally { Object.defineProperty(process, 'platform', platform) }
  })

  it('supplies a nonempty stdin prompt when only images are attached', () => {
    start()
    manager.send(sessionId, '', { images: [{ path: join(workspace, 'image.png'), name: 'image.png', mediaType: 'image/png' }] })
    expect(child.stdin.read().toString()).toBe('Inspect the attached images.')
    close()
  })

  it.each([0, 1])('records every global step once when the child exits %i', async code => {
    start()
    manager.send(sessionId, 'work')
    step('step-one', 100, 20)
    step('step-one', 100, 20)
    step('step-two', 50, 10)
    close(code)
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(
      sessionId, code === 0 ? 'run.completed' : 'run.failed', expect.anything(),
    ))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toEqual({
      inputTokens: 150, outputTokens: 36, reasoningTokens: 6,
      cacheReadTokens: 20, cacheWriteTokens: 4, apiCalls: 2,
    })
    expect(emitted).toHaveBeenCalledWith(sessionId, 'usage.updated', expect.objectContaining({
      inputTokens: 150, outputTokens: 36,
    }))
  })

  it('uses only proxy usage for scoped runs', async () => {
    start('scoped')
    manager.send(sessionId, 'work')
    manager.handleProxyUsageEvent(agentSessionId, {
      type: 'response.completed',
      data: { response: { id: 'proxy-step', usage: { input_tokens: 100, output_tokens: 20 } } },
    })
    step('native-step', 100, 20)
    close()
    await vi.waitFor(() => expect(emitted).toHaveBeenCalledWith(sessionId, 'run.completed', expect.anything()))
    expect(getRecordedUsageTotals(sessionId, 'coding_agent')).toMatchObject({
      inputTokens: 100, outputTokens: 20, apiCalls: 1,
    })
  })
})
