import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const testState = vi.hoisted(() => {
  class TestEmitter {
    private readonly handlers = new Map<string, Array<(...args: any[]) => void>>()

    on(event: string, handler: (...args: any[]) => void) {
      const handlers = this.handlers.get(event) || []
      handlers.push(handler)
      this.handlers.set(event, handlers)
      return this
    }

    off(event: string, handler: (...args: any[]) => void) {
      const handlers = this.handlers.get(event) || []
      this.handlers.set(event, handlers.filter(item => item !== handler))
      return this
    }

    emit(event: string, ...args: any[]) {
      for (const handler of this.handlers.get(event) || []) handler(...args)
      return true
    }
  }

  return {
    spawnCalls: [] as Array<{ command: string; args: string[]; options: any; child: any }>,
    TestEmitter,
  }
})

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn((command: string, args: string[], options: any) => {
    const child = new testState.TestEmitter() as any
    child.stdin = new testState.TestEmitter()
    child.stdin.end = vi.fn()
    child.stdin.write = vi.fn()
    child.stdout = new testState.TestEmitter()
    child.stderr = new testState.TestEmitter()
    child.pid = 1234
    child.exitCode = null
    child.signalCode = null
    child.killed = false
    child.kill = vi.fn(() => {
      child.killed = true
    })
    testState.spawnCalls.push({ command, args, options, child })
    return child
  }),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../packages/server/src/modules/studio/repositories/session-store')>(),
  updateSessionStats: vi.fn(),
}))

import {
  CodingAgentRunManager,
  isolatedCodingAgentChildEnv,
} from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import '../../packages/server/src/bootstrap/coding-agent-adapters'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const windowsCmd = process.env.comspec || 'cmd.exe'

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform })
}

beforeEach(() => {
  testState.spawnCalls.length = 0
  setPlatform('win32')
})

afterEach(() => {
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
})

describe('coding agent Windows process launch', () => {
  it('keeps Grok prompts out of Windows command arguments and settles after process close', () => {
    const grokHome = mkdtempSync(join(tmpdir(), 'hermes-grok-windows-'))
    const originalDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'studio-secret-that-must-not-leak'
    try {
      const manager = new CodingAgentRunManager()
      const emitCompletion = vi.fn()
      ;(manager as any).handleClaudePrintResponseEvent = vi.fn()
      ;(manager as any).recordGrokNativeSessionId = vi.fn()
      ;(manager as any).completeClaudePrintTurn = vi.fn((run: any, usage: unknown) => {
        run.printCompleted = true
        run.pendingChatCompletionEvent = 'run.completed'
        run.pendingChatCompletionPayload = { usage }
      })
      ;(manager as any).emitAndMarkPrintChatRunCompletedAfterUsage = emitCompletion
      const userPrompt = '请检查 C:\\项目 & echo %PATH% | whoami'
      const run: any = {
        id: 'agent-session-grok-windows',
        launch: {
          agentSessionId: 'agent-session-grok-windows',
          agentNativeSessionId: '11111111-1111-4111-8111-111111111111',
          agentId: 'grok',
          mode: 'scoped',
          profile: 'default',
          provider: 'global',
          model: '',
          sessionId: 'chat-session-grok-windows',
          command: 'C:\\Tools\\grok.cmd',
          args: ['--always-approve', '--no-auto-update'],
          shellCommand: 'grok',
          workspaceDir: process.cwd(),
          env: { GROK_HOME: grokHome },
        },
        state: { messages: [], isWorking: false, events: [], queue: [] },
        lastActiveAt: Date.now(),
        startedAt: Date.now(),
        exited: false,
        nativeResumeReady: false,
      }

      ;(manager as any).startGrokPrintTurn(run, userPrompt)

      const promptPath = join(grokHome, readdirSync(grokHome).find(name => name.startsWith('turn-prompt-')) || '')
      expect(readFileSync(promptPath, 'utf-8')).toBe(`${userPrompt}\n`)
      expect(JSON.stringify(testState.spawnCalls[0]?.args)).not.toContain(userPrompt)
      expect(JSON.stringify(testState.spawnCalls[0]?.args)).toContain('--prompt-file')
      expect(JSON.stringify(testState.spawnCalls[0]?.args)).toContain('--session-id')
      expect(testState.spawnCalls[0]?.options.env.DATABASE_URL).toBeUndefined()

      const child = testState.spawnCalls[0]?.child
      child.stdout.emit('data', Buffer.from('{"type":"end","sessionId":"11111111-1111-4111-8111-111111111111","usage":{"input_tokens":3}}\n'))
      expect(run.printCompleted).toBe(true)
      child.emit('close', 0)

      expect(emitCompletion).toHaveBeenCalledWith(
        run,
        'run.completed',
        { usage: { input_tokens: 3 } },
      )
      expect(existsSync(promptPath)).toBe(false)
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = originalDatabaseUrl
      rmSync(grokHome, { recursive: true, force: true })
    }
  })

  it('resumes a Grok session that persisted before an error event ended the first turn', () => {
    const grokHome = mkdtempSync(join(tmpdir(), 'hermes-grok-resume-'))
    try {
      const manager = new CodingAgentRunManager()
      ;(manager as any).handleClaudePrintResponseEvent = vi.fn()
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const workspaceDir = process.cwd()
      mkdirSync(join(grokHome, 'sessions', encodeURIComponent(workspaceDir), sessionId), { recursive: true })
      const run: any = {
        id: 'agent-session-grok-resume',
        launch: {
          agentSessionId: 'agent-session-grok-resume',
          agentNativeSessionId: sessionId,
          agentId: 'grok',
          mode: 'scoped',
          profile: 'default',
          provider: 'custom',
          model: 'test-model',
          sessionId: 'chat-session-grok-resume',
          command: 'C:\\Tools\\grok.cmd',
          args: ['--always-approve'],
          shellCommand: 'grok',
          workspaceDir,
          env: { GROK_HOME: grokHome },
        },
        state: { messages: [], isWorking: false, events: [], queue: [] },
        lastActiveAt: Date.now(),
        startedAt: Date.now(),
        exited: false,
        nativeResumeReady: false,
      }

      ;(manager as any).startGrokPrintTurn(run, 'retry')

      const commandLine = JSON.stringify(testState.spawnCalls[0]?.args)
      expect(commandLine).toContain('--resume')
      expect(commandLine).not.toContain('--session-id')
      expect(run.nativeResumeReady).toBe(true)
    } finally {
      rmSync(grokHome, { recursive: true, force: true })
    }
  })

  it('does not inherit unrelated Studio secrets into coding-agent children', () => {
    expect(isolatedCodingAgentChildEnv(
      { PI_CODING_AGENT_DIR: 'C:\\Pi' },
      {
        PATH: 'C:\\Windows',
        HOME: 'C:\\Users\\agent',
        DATABASE_URL: 'secret-db',
        HERMES_TOKEN: 'secret-token',
        OPENAI_API_KEY: 'secret-key',
      },
    )).toEqual({
      PATH: 'C:\\Windows',
      HOME: 'C:\\Users\\agent',
      PI_CODING_AGENT_DIR: 'C:\\Pi',
    })
  })

  it('exports completed Pi native sessions through nmem with isolated Pi directories', () => {
    const manager = new CodingAgentRunManager()
    const run = {
      id: 'agent-session-pi-memory',
      launch: {
        agentSessionId: 'agent-session-pi-memory',
        agentNativeSessionId: 'pi-native-memory',
        agentId: 'pi',
        profile: 'default',
        provider: 'test-provider',
        model: 'pi-test',
        sessionId: 'chat-session-pi-memory',
        command: 'pi.cmd',
        args: ['--mode', 'rpc'],
        shellCommand: 'pi',
        workspaceDir: process.cwd(),
        env: {
          PI_CODING_AGENT_DIR: 'C:\\用户\\Pi 配置',
          PI_CODING_AGENT_SESSION_DIR: 'C:\\用户\\Pi 会话',
        },
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      memoryExportStarted: false,
    }

    ;(manager as any).startCodingAgentMemoryExport(run)

    expect(testState.spawnCalls[0]).toMatchObject({
      command: 'nmem',
      args: ['threads', 'save', '--from', 'pi', '--truncate', '--session-id', 'pi-native-memory'],
      options: {
        env: expect.objectContaining({
          PI_CODING_AGENT_DIR: 'C:\\用户\\Pi 配置',
          PI_CODING_AGENT_SESSION_DIR: 'C:\\用户\\Pi 会话',
        }),
      },
    })
    expect(run.memoryExportStarted).toBe(true)
  })

  it('routes Pi extension UI approval requests through Studio and resolves them', () => {
    const manager = new CodingAgentRunManager()
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    const stdin = new testState.TestEmitter() as any
    stdin.write = vi.fn()
    const run: any = {
      id: 'agent-session-pi-ui',
      launch: {
        agentSessionId: 'agent-session-pi-ui',
        agentId: 'pi',
        profile: 'default',
        provider: 'test-provider',
        model: 'pi-test',
        sessionId: 'chat-session-pi-ui',
        command: 'pi.cmd',
        args: ['--mode', 'rpc'],
        shellCommand: 'pi',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      currentChild: {
        stdin,
        exitCode: null,
        signalCode: null,
        killed: false,
      },
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)

    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'confirm-1',
      method: 'confirm',
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'notify-1',
      method: 'notify',
    })
    expect(emitted).toHaveBeenCalledWith(
      'chat-session-pi-ui',
      'approval.requested',
      expect.objectContaining({ approval_id: 'confirm-1', choices: ['once', 'deny'] }),
    )
    expect(manager.resolveApproval('chat-session-pi-ui', 'confirm-1', 'once')).toEqual({
      handled: true,
      resolved: true,
    })

    expect(stdin.write.mock.calls.map((call: any[]) => JSON.parse(call[0]))).toEqual([
      { type: 'extension_ui_response', id: 'confirm-1', confirmed: true },
    ])
  })

  it('maps Pi select/input/editor UI to clarifications and fails unknown methods closed', () => {
    const manager = new CodingAgentRunManager()
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    const stdin = new testState.TestEmitter() as any
    stdin.write = vi.fn()
    const run: any = {
      id: 'agent-session-pi-clarify',
      launch: {
        agentSessionId: 'agent-session-pi-clarify',
        agentId: 'pi',
        profile: 'default',
        provider: 'test-provider',
        model: 'pi-test',
        sessionId: 'chat-session-pi-clarify',
        command: 'pi.cmd',
        args: ['--mode', 'rpc'],
        shellCommand: 'pi',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      currentChild: { stdin, exitCode: null, signalCode: null, killed: false },
    }
    ;(manager as any).runs.set(run.id, run)
    ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)

    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'select-1',
      method: 'select',
      title: 'Choose one',
      options: ['alpha', 'beta'],
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'input-1',
      method: 'input',
      placeholder: 'Type a value',
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'editor-1',
      method: 'editor',
      title: 'Edit content',
      prefill: 'existing content',
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'set-editor-1',
      method: 'set_editor_text',
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'extension_ui_request',
      id: 'unknown-1',
      method: 'open_browser',
    })

    expect(emitted).toHaveBeenCalledWith(
      'chat-session-pi-clarify',
      'clarify.requested',
      expect.objectContaining({ clarify_id: 'select-1', choices: ['alpha', 'beta'] }),
    )
    expect(emitted).toHaveBeenCalledWith(
      'chat-session-pi-clarify',
      'clarify.requested',
      expect.objectContaining({ clarify_id: 'editor-1', initial_response: 'existing content' }),
    )
    expect(manager.resolveClarification('chat-session-pi-clarify', 'select-1', 'missing')).toEqual({
      handled: true,
      resolved: false,
    })
    expect(manager.resolveClarification('chat-session-pi-clarify', 'select-1', 'beta')).toEqual({
      handled: true,
      resolved: true,
    })
    expect(manager.resolveClarification('chat-session-pi-clarify', 'input-1', 'typed')).toEqual({
      handled: true,
      resolved: true,
    })
    expect(manager.resolveClarification('chat-session-pi-clarify', 'editor-1', '')).toEqual({
      handled: true,
      resolved: true,
    })
    expect(stdin.write.mock.calls.map((call: any[]) => JSON.parse(call[0]))).toEqual([
      { type: 'extension_ui_response', id: 'unknown-1', cancelled: true },
      { type: 'extension_ui_response', id: 'select-1', value: 'beta' },
      { type: 'extension_ui_response', id: 'input-1', value: 'typed' },
      { type: 'extension_ui_response', id: 'editor-1', value: '' },
    ])
  })

  it('expires Pi extension UI requests and removes them from pending state', async () => {
    vi.useFakeTimers()
    try {
      const manager = new CodingAgentRunManager()
      const emitted = vi.fn()
      ;(manager as any).emitToChat = emitted
      const stdin = new testState.TestEmitter() as any
      stdin.write = vi.fn()
      const run: any = {
        id: 'agent-session-pi-timeout',
        launch: {
          agentSessionId: 'agent-session-pi-timeout',
          agentId: 'pi',
          profile: 'default',
          provider: 'test-provider',
          model: 'pi-test',
          sessionId: 'chat-session-pi-timeout',
          command: 'pi.cmd',
          args: ['--mode', 'rpc'],
          shellCommand: 'pi',
          workspaceDir: process.cwd(),
        },
        state: { messages: [], isWorking: false, events: [], queue: [] },
        lastActiveAt: Date.now(),
        startedAt: Date.now(),
        exited: false,
        currentChild: { stdin, exitCode: null, signalCode: null, killed: false },
      }
      ;(manager as any).runs.set(run.id, run)
      ;(manager as any).sessionIndex.set(run.launch.sessionId, run.id)

      ;(manager as any).handlePiRpcEvent(run, {
        type: 'extension_ui_request',
        id: 'input-timeout',
        method: 'input',
        timeout: 25,
      })
      expect(run.piUiRequests.has('input-timeout')).toBe(true)

      await vi.advanceTimersByTimeAsync(25)

      expect(run.piUiRequests.has('input-timeout')).toBe(false)
      expect(manager.resolveClarification('chat-session-pi-timeout', 'input-timeout', 'late')).toEqual({
        handled: false,
        resolved: false,
      })
      expect(emitted).toHaveBeenCalledWith(
        'chat-session-pi-timeout',
        'clarify.resolved',
        expect.objectContaining({ clarify_id: 'input-timeout', reason: 'Pi UI request expired' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed terminal event when runtime revocation stops an active Pi run', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => 1
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => emitted.push({ event, payload })
    ;(manager as any).persistTerminalResponse = () => undefined
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-pi-revoked',
      agentId: 'pi',
      mode: 'scoped',
      profile: 'default',
      provider: 'custom:test',
      model: 'pi-test',
      sessionId: 'chat-session-pi-revoked',
      command: 'pi.cmd',
      args: ['--mode', 'rpc'],
      shellCommand: 'pi',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    manager.send('chat-session-pi-revoked', 'keep running')

    expect(manager.stopMatching(launch => launch.provider === 'custom:test')).toBe(1)
    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(1)
    expect(emitted.find(item => item.event === 'run.failed')?.payload.error).toBe('Coding agent session closed')
  })

  it('runs Pi RPC through a non-ASCII npm .cmd path and sends long UTF-8 prompts over stdin', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hermes-pi-windows-prompt-'))
    const dynamicPromptPath = join(tempDir, '动态系统提示词.md')
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-pi-1',
      agentNativeSessionId: 'pi-native-session-1',
      agentId: 'pi',
      mode: 'scoped',
      profile: '默认',
      provider: 'test-provider',
      model: 'pi-test',
      reasoningEffort: 'none',
      sessionId: 'chat-session-pi-1',
      command: 'C:\\用户\\管理员\\AppData\\Roaming\\npm\\pi.cmd',
      args: ['--mode', 'rpc', '--session-dir', 'C:\\用户\\会话 目录'],
      env: {
        PI_CODING_AGENT_DIR: 'C:\\用户\\配置 目录',
        PI_CODING_AGENT_SESSION_DIR: 'C:\\用户\\会话 目录',
        HERMES_PI_DYNAMIC_PROMPT_FILE: dynamicPromptPath,
      },
      shellCommand: 'pi',
      workspaceDir: 'C:\\用户\\项目 目录',
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const prompt = `检查非 ASCII 路径。\n${'超长中文内容'.repeat(4000)}`
    const systemPrompt = `每轮动态工作流指令\n${'系统提示词'.repeat(4000)}`
    manager.send('chat-session-pi-1', prompt, { systemPrompt })

    const call = testState.spawnCalls[0]
    expect(call.command).toBe(windowsCmd)
    expect(call.args[3]).toContain('C:\\用户\\管理员\\AppData\\Roaming\\npm\\pi.cmd')
    expect(call.args[3]).toContain('C:\\用户\\会话^ 目录')
    expect(call.args[3]).not.toContain('超长中文内容')
    expect(call.args[3]).not.toContain('系统提示词')
    expect(call.args[3].length).toBeLessThan(8191)
    expect(call.options.env).toMatchObject({
      PI_CODING_AGENT_DIR: 'C:\\用户\\配置 目录',
      PI_CODING_AGENT_SESSION_DIR: 'C:\\用户\\会话 目录',
      HERMES_PI_DYNAMIC_PROMPT_FILE: dynamicPromptPath,
    })
    expect(call.options.windowsVerbatimArguments).toBe(true)
    expect(call.child.stdin.write).toHaveBeenCalledTimes(2)
    expect(JSON.parse(call.child.stdin.write.mock.calls[0][0])).toMatchObject({
      type: 'set_thinking_level',
      level: 'off',
    })
    expect(JSON.parse(call.child.stdin.write.mock.calls[1][0])).toMatchObject({
      type: 'prompt',
      message: prompt,
    })
    expect(readFileSync(dynamicPromptPath, 'utf8')).toBe(systemPrompt)

    const run = (manager as any).runs.get('agent-session-pi-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('routes Pi compact, context stats, and status through correlated native RPC commands', async () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = () => {}

    manager.start({
      agentSessionId: 'agent-session-pi-commands',
      agentNativeSessionId: 'pi-native-session-commands',
      agentId: 'pi',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'pi-test',
      sessionId: 'chat-session-pi-commands',
      command: 'pi.cmd',
      args: ['--mode', 'rpc'],
      shellCommand: 'pi',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const run = (manager as any).runs.get('agent-session-pi-commands')
    const stdin = testState.spawnCalls[0].child.stdin

    const compactPromise = manager.compact('chat-session-pi-commands', 'focus on code changes') as Promise<any>
    const compactCommand = JSON.parse(stdin.write.mock.calls.at(-1)[0])
    expect(compactCommand).toMatchObject({
      type: 'compact',
      customInstructions: 'focus on code changes',
    })
    ;(manager as any).handlePiRpcEvent(run, {
      id: compactCommand.id,
      type: 'response',
      command: 'compact',
      success: true,
      data: { summary: 'summary', firstKeptEntryId: 'entry-1', tokensBefore: 50_000 },
    })
    await expect(compactPromise).resolves.toEqual({ compacted: true, beforeTokens: 50_000 })

    const statsPromise = manager.getPiSessionStats('chat-session-pi-commands')
    const statsCommand = JSON.parse(stdin.write.mock.calls.at(-1)[0])
    expect(statsCommand.type).toBe('get_session_stats')
    const stats = {
      sessionId: 'pi-native-session-commands',
      userMessages: 2,
      assistantMessages: 2,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 6,
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 },
      cost: 0.25,
      contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
    }
    ;(manager as any).handlePiRpcEvent(run, {
      id: statsCommand.id,
      type: 'response',
      command: 'get_session_stats',
      success: true,
      data: stats,
    })
    await expect(statsPromise).resolves.toEqual(stats)

    const statePromise = manager.getPiSessionState('chat-session-pi-commands')
    const stateCommand = JSON.parse(stdin.write.mock.calls.at(-1)[0])
    expect(stateCommand.type).toBe('get_state')
    const nativeState = {
      model: { id: 'pi-test', provider: 'test-provider' },
      thinkingLevel: 'high',
      isStreaming: false,
      isCompacting: false,
      sessionId: 'pi-native-session-commands',
      autoCompactionEnabled: true,
      messageCount: 6,
      pendingMessageCount: 0,
    }
    ;(manager as any).handlePiRpcEvent(run, {
      id: stateCommand.id,
      type: 'response',
      command: 'get_state',
      success: true,
      data: nativeState,
    })
    await expect(statePromise).resolves.toEqual(nativeState)

    const failedCompact = manager.compact('chat-session-pi-commands') as Promise<any>
    const failedCommand = JSON.parse(stdin.write.mock.calls.at(-1)[0])
    ;(manager as any).handlePiRpcEvent(run, {
      id: failedCommand.id,
      type: 'response',
      command: 'compact',
      success: false,
      error: 'native compact failed',
    })
    await expect(failedCompact).rejects.toThrow('native compact failed')

    expect(manager.getRunInfo('chat-session-pi-commands')?.running).toBe(false)
    manager.stop('chat-session-pi-commands', { reportClosed: false })
  })

  it('inherits user credentials when Studio runs Pi with its global config', () => {
    const previousCredential = process.env.PI_GLOBAL_TEST_CREDENTIAL
    process.env.PI_GLOBAL_TEST_CREDENTIAL = 'global-pi-test-key'
    try {
      const manager = new CodingAgentRunManager()
      ;(manager as any).ensureDbSession = () => {}
      ;(manager as any).emitToChat = () => {}

      manager.start({
        agentSessionId: 'agent-session-global-pi',
        agentId: 'pi',
        mode: 'global',
        profile: 'default',
        provider: 'global',
        model: '',
        sessionId: 'chat-session-global-pi',
        command: 'C:\\Users\\agent\\AppData\\Roaming\\npm\\pi.cmd',
        args: ['--mode', 'rpc'],
        env: {
          PI_CODING_AGENT_DIR: 'C:\\Users\\agent\\.pi\\agent',
        },
        shellCommand: 'pi',
        workspaceDir: 'C:\\Users\\agent\\project',
        state: { messages: [], isWorking: false, events: [], queue: [] },
      })

      expect(testState.spawnCalls[0].options.env).toMatchObject({
        PI_GLOBAL_TEST_CREDENTIAL: 'global-pi-test-key',
        PI_CODING_AGENT_DIR: 'C:\\Users\\agent\\.pi\\agent',
      })

      const run = (manager as any).runs.get('agent-session-global-pi')
      if (run?.idleTimer) clearTimeout(run.idleTimer)
      ;(manager as any).runs.clear()
      ;(manager as any).sessionIndex.clear()
    } finally {
      if (previousCredential === undefined) delete process.env.PI_GLOBAL_TEST_CREDENTIAL
      else process.env.PI_GLOBAL_TEST_CREDENTIAL = previousCredential
    }
  })

  it('waits for Pi retry settlement and reconciles authoritative final text once', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => 1
    ;(manager as any).persistTerminalResponse = () => undefined
    ;(manager as any).refreshCodingAgentUsage = async () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => undefined
    ;(manager as any).markChatRunCompleted = () => {}
    ;(manager as any).startCodingAgentMemoryExport = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => emitted.push({ event, payload })

    manager.start({
      agentSessionId: 'agent-session-pi-retry',
      agentId: 'pi',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'pi-test',
      sessionId: 'chat-session-pi-retry',
      command: 'pi.cmd',
      args: ['--mode', 'rpc'],
      shellCommand: 'pi',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    manager.send('chat-session-pi-retry', 'retry')
    const run = (manager as any).runs.get('agent-session-pi-retry')
    const piChild = testState.spawnCalls[0].child

    ;(manager as any).handlePiRpcEvent(run, { type: 'auto_retry_start' })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: 'transient' },
    })
    expect(emitted.some(item => item.event === 'run.failed')).toBe(false)

    ;(manager as any).handlePiRpcEvent(run, { type: 'auto_retry_end', success: true })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'checking' },
    })
    expect(emitted.filter(item => item.event === 'reasoning.delta').map(item => item.payload.delta)).toEqual(['checking'])
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'final' },
    })
    expect(emitted.filter(item => item.event === 'message.delta').map(item => item.payload.delta)).toEqual(['final'])
    expect(emitted.some(item => item.event === 'run.completed')).toBe(false)
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'final answer' }] },
    })
    ;(manager as any).handlePiRpcEvent(run, { type: 'agent_settled' })
    piChild.exitCode = 0
    piChild.emit('close', 0)

    const deltas = emitted.filter(item => item.event === 'message.delta').map(item => item.payload.delta).join('')
    expect(deltas).toBe('final answer')
    expect(emitted.filter(item => item.event === 'run.completed')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(0)
    expect(manager.hasSession('chat-session-pi-retry')).toBe(false)
  })

  it('defers provider invalidation until the active turn completes', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => 1
    ;(manager as any).persistTerminalResponse = () => undefined
    ;(manager as any).refreshCodingAgentUsage = async () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => undefined
    ;(manager as any).startCodingAgentMemoryExport = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => emitted.push({ event, payload })
    ;(manager as any).markChatRunCompleted = () => {
      expect(manager.hasSession('chat-session-provider-change')).toBe(false)
    }

    manager.start({
      agentSessionId: 'agent-session-provider-change',
      agentId: 'pi',
      mode: 'scoped',
      profile: 'research',
      provider: 'custom:test-provider',
      model: 'pi-test',
      sessionId: 'chat-session-provider-change',
      command: 'pi.cmd',
      args: ['--mode', 'rpc'],
      shellCommand: 'pi',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    manager.send('chat-session-provider-change', 'keep this turn running')
    const run = (manager as any).runs.get('agent-session-provider-change')
    const piChild = testState.spawnCalls[0].child

    expect(manager.invalidateMatching(launch => (
      launch.profile === 'research' && launch.provider === 'custom:test-provider'
    ))).toEqual({ invalidated: 1, deferred: 1 })
    expect(manager.hasSession('chat-session-provider-change')).toBe(true)
    expect(emitted.some(item => item.event === 'run.failed')).toBe(false)

    ;(manager as any).handlePiRpcEvent(run, { type: 'agent_settled' })
    piChild.exitCode = 0
    piChild.emit('close', 0)

    expect(emitted.filter(item => item.event === 'run.completed')).toHaveLength(1)
    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(0)
    expect(manager.hasSession('chat-session-provider-change')).toBe(false)
  })

  it('releases a stale Claude runtime before queued work is allowed to start', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => undefined
    ;(manager as any).startCodingAgentMemoryExport = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => emitted.push({ event, payload })
    ;(manager as any).markChatRunCompleted = () => {
      expect(manager.hasSession('chat-session-claude-provider-change')).toBe(false)
    }

    manager.start({
      agentSessionId: 'agent-session-claude-provider-change',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'research',
      provider: 'custom:test-provider',
      model: 'claude-test',
      sessionId: 'chat-session-claude-provider-change',
      command: 'claude.cmd',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    const run = (manager as any).runs.get('agent-session-claude-provider-change')

    expect(manager.invalidateMatching(launch => launch.provider === 'custom:test-provider')).toEqual({
      invalidated: 1,
      deferred: 1,
    })
    expect(manager.hasSession('chat-session-claude-provider-change')).toBe(true)

    ;(manager as any).emitAndMarkPrintChatRunCompleted(run, 'run.completed', { event: 'run.completed' })

    expect(emitted.filter(item => item.event === 'run.failed')).toHaveLength(0)
    expect(manager.hasSession('chat-session-claude-provider-change')).toBe(false)
  })

  it('preserves text before and after Pi tool loops while streaming each segment once', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => 1
    ;(manager as any).persistTerminalResponse = () => undefined
    ;(manager as any).refreshCodingAgentUsage = async () => {}
    ;(manager as any).completeWorkspaceRunDiff = () => undefined
    ;(manager as any).markChatRunCompleted = () => {}
    ;(manager as any).startCodingAgentMemoryExport = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => emitted.push({ event, payload })

    manager.start({
      agentSessionId: 'agent-session-pi-tool-text',
      agentId: 'pi',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'pi-test',
      sessionId: 'chat-session-pi-tool-text',
      command: 'pi.cmd',
      args: ['--mode', 'rpc'],
      shellCommand: 'pi',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    manager.send('chat-session-pi-tool-text', 'use a tool')
    const run = (manager as any).runs.get('agent-session-pi-tool-text')
    const rpcChild = run.currentChild

    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Before tool. ' },
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Before tool. ' }] },
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'After' },
    })
    ;(manager as any).handlePiRpcEvent(run, {
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'After tool.' }] },
    })
    ;(manager as any).handlePiRpcEvent(run, { type: 'agent_settled' })
    rpcChild.emit('close', 0)
    await vi.waitFor(() => {
      expect(emitted.filter(item => item.event === 'run.completed')).toHaveLength(1)
    })

    const deltas = emitted.filter(item => item.event === 'message.delta').map(item => item.payload.delta).join('')
    expect(deltas).toBe('Before tool. After tool.')
  })

  it('does not idle-clean an active Pi retry but cleans the settled runner later', async () => {
    vi.useFakeTimers()
    try {
      const manager = new CodingAgentRunManager(50)
      ;(manager as any).ensureDbSession = () => {}
      ;(manager as any).addUserMessage = () => 1
      ;(manager as any).emitToChat = () => {}
      ;(manager as any).persistTerminalResponse = () => undefined
      ;(manager as any).refreshCodingAgentUsage = async () => {}
      ;(manager as any).completeWorkspaceRunDiff = () => undefined
      ;(manager as any).markChatRunCompleted = () => {}
      ;(manager as any).startCodingAgentMemoryExport = () => {}
      manager.start({
        agentSessionId: 'agent-session-pi-idle',
        agentId: 'pi',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'pi-test',
        sessionId: 'chat-session-pi-idle',
        command: 'pi.cmd',
        args: ['--mode', 'rpc'],
        shellCommand: 'pi',
        workspaceDir: process.cwd(),
        state: { messages: [], isWorking: false, events: [], queue: [] },
      })
      manager.send('chat-session-pi-idle', 'retry')
      const run = (manager as any).runs.get('agent-session-pi-idle')
      const piChild = testState.spawnCalls[0].child
      ;(manager as any).handlePiRpcEvent(run, { type: 'auto_retry_start' })

      await vi.advanceTimersByTimeAsync(150)
      expect((manager as any).runs.has('agent-session-pi-idle')).toBe(true)

      ;(manager as any).handlePiRpcEvent(run, { type: 'auto_retry_end', success: true })
      ;(manager as any).handlePiRpcEvent(run, { type: 'agent_settled' })
      piChild.exitCode = 0
      piChild.emit('close', 0)
      await vi.advanceTimersByTimeAsync(100)
      expect((manager as any).runs.has('agent-session-pi-idle')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs npm .cmd shims through cmd.exe for hidden Claude Code chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: 'chat-session-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd',
      args: ['--settings', 'C:\\Users\\Administrator\\.hermes-web-ui\\settings.json'],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const groupInput = [
      '群聊系统：这条消息已经提及你，请直接回复。',
      '',
      '以下是群聊记录：',
      `用户：${'长文本'.repeat(4000)}`,
      '',
      '当前消息：检查这个问题',
    ].join('\n')
    manager.send('chat-session-1', groupInput, { systemPrompt: 'system prompt\nsecond line' })

    expect(testState.spawnCalls[0]).toMatchObject({
      command: windowsCmd,
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd')
    expect(testState.spawnCalls[0].args[3]).toContain('^"--settings^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"--append-system-prompt^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"system^ prompt^ /^ second^ line^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"--input-format^" ^"text^"')
    expect(testState.spawnCalls[0].args[3]).not.toContain('\n')
    expect(testState.spawnCalls[0].args[3]).not.toContain('\r')
    expect(testState.spawnCalls[0].args[3]).not.toContain('群聊系统')
    expect(testState.spawnCalls[0].args[3].length).toBeLessThan(8191)
    expect(testState.spawnCalls[0].options).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      windowsHide: true,
    })
    expect(testState.spawnCalls[0].child.stdin.end).toHaveBeenCalledWith(`${groupInput}\n`)

    const run = (manager as any).runs.get('agent-session-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('runs npm .cmd shims through cmd.exe for hidden Codex chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const groupInput = [
      '群聊系统：这条消息已经提及你，请直接回复。',
      '',
      '以下是群聊记录：',
      `用户：${'长文本'.repeat(4000)}`,
      '',
      '当前消息：检查这个问题',
    ].join('\n')
    manager.send('chat-session-codex-1', groupInput, { systemPrompt: 'system prompt\nsecond line' })

    expect(testState.spawnCalls[0]).toMatchObject({
      command: windowsCmd,
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd')
    expect(testState.spawnCalls[0].args[3]).toContain('^"exec^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"-c^"')
    expect(testState.spawnCalls[0].args[3]).toContain('model_reasoning_summary=\\^"auto\\^"')
    expect(testState.spawnCalls[0].args[3]).not.toContain('developer_instructions=')
    expect(testState.spawnCalls[0].args[3]).not.toContain('system^ prompt^ /^ second^ line')
    expect(testState.spawnCalls[0].args[3]).not.toContain('\n')
    expect(testState.spawnCalls[0].args[3]).not.toContain('\r')
    expect(testState.spawnCalls[0].args[3]).toContain('^"--model^"')
    expect(testState.spawnCalls[0].args[3]).toContain('^"-^"')
    expect(testState.spawnCalls[0].args[3]).not.toContain('群聊系统')
    expect(testState.spawnCalls[0].args[3].length).toBeLessThan(8191)
    expect(testState.spawnCalls[0].args[3]).not.toContain('system^ prompt\r\n\r\ntest')
    expect(testState.spawnCalls[0].options).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: true,
      windowsHide: true,
    })
    expect(testState.spawnCalls[0].child.stdin.end).toHaveBeenCalledWith(`${groupInput}\n`)

    const run = (manager as any).runs.get('agent-session-codex-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('keeps long global Codex prompts in the Studio-owned prompt file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hermes-global-codex-prompt-'))
    const promptPath = join(tempDir, 'AGENTS.md')
    writeFileSync(promptPath, [
      'User global Codex instructions.',
      '',
      '<!-- BEGIN HERMES WEB UI PROMPT -->',
      'old Studio prompt',
      '<!-- END HERMES WEB UI PROMPT -->',
      '',
    ].join('\n'))

    try {
      const manager = new CodingAgentRunManager()
      ;(manager as any).ensureDbSession = () => {}
      ;(manager as any).addUserMessage = () => {}
      ;(manager as any).emitToChat = () => {}
      ;(manager as any).markChatRunCompleted = () => {}

      manager.start({
        agentSessionId: 'agent-session-global-codex-file',
        agentId: 'codex',
        mode: 'global',
        profile: 'default',
        provider: 'global',
        model: '',
        sessionId: 'chat-session-global-codex-file',
        command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
        args: [],
        env: { CODEX_HOME: tempDir },
        promptFile: promptPath,
        shellCommand: 'codex',
        workspaceDir: process.cwd(),
        state: { messages: [], isWorking: false, events: [], queue: [] },
      })

      const longPrompt = `Hermes Windows prompt\n${'详细说明'.repeat(3000)}`
      manager.send('chat-session-global-codex-file', 'check this', { systemPrompt: longPrompt })

      const commandLine = testState.spawnCalls[0].args[3]
      expect(commandLine).not.toContain('developer_instructions=')
      expect(commandLine).not.toContain('详细说明')
      expect(commandLine.length).toBeLessThan(8191)
      expect(readFileSync(promptPath, 'utf8')).toContain('User global Codex instructions.')
      expect(readFileSync(promptPath, 'utf8')).toContain(longPrompt)
      expect(readFileSync(promptPath, 'utf8').match(/BEGIN HERMES WEB UI PROMPT/g)).toHaveLength(1)

      const run = (manager as any).runs.get('agent-session-global-codex-file')
      if (run?.idleTimer) clearTimeout(run.idleTimer)
      ;(manager as any).runs.clear()
      ;(manager as any).sessionIndex.clear()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps scoped Claude prompts on file instead of adding a CLI prompt payload', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-single-claude-1',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: 'chat-session-single-claude-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd',
      args: [
        '--settings',
        'C:\\Users\\Administrator\\.hermes-web-ui\\settings.json',
        '--append-system-prompt-file',
        'C:\\Users\\Administrator\\.hermes-web-ui\\hermes-rules.md',
      ],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-single-claude-1', 'test', {
      systemPrompt: 'ordinary single-chat prompt',
    })

    const commandLine = testState.spawnCalls[0].args[3]
    expect(commandLine).toContain('^"--append-system-prompt-file^"')
    expect(commandLine).toContain('hermes-rules.md')
    expect(commandLine).not.toContain('^"--append-system-prompt^"')
    expect(commandLine).not.toContain('ordinary^ single-chat^ prompt')

    const run = (manager as any).runs.get('agent-session-single-claude-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('pipes image content to hidden Claude Code turns using stream-json', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'hermes-claude-image-'))
    const imagePath = join(tempDir, 'sample image.png')
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    try {
      const manager = new CodingAgentRunManager()
      ;(manager as any).ensureDbSession = () => {}
      ;(manager as any).addUserMessage = () => {}
      ;(manager as any).emitToChat = () => {}
      ;(manager as any).markChatRunCompleted = () => {}

      manager.start({
        agentSessionId: 'agent-session-claude-image-1',
        agentId: 'claude-code',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'claude-test',
        sessionId: 'chat-session-claude-image-1',
        command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\claude.cmd',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
        state: { messages: [], isWorking: false, events: [], queue: [] },
      })

      manager.send('chat-session-claude-image-1', 'inspect this image', {
        images: [{ name: 'sample image.png', path: imagePath, mediaType: 'image/png' }],
      })

      const call = testState.spawnCalls[0]
      expect(call.args[3]).toContain('^"--input-format^"')
      expect(call.args[3]).toContain('^"stream-json^"')
      expect(call.args[3]).not.toContain('^"inspect^ this^ image^"')
      expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
      expect(call.child.stdin.end).toHaveBeenCalledOnce()

      const input = JSON.parse(call.child.stdin.end.mock.calls[0][0].trim())
      expect(input.message.content).toEqual([
        { type: 'text', text: 'inspect this image' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw==',
          },
        },
      ])

      const run = (manager as any).runs.get('agent-session-claude-image-1')
      if (run?.idleTimer) clearTimeout(run.idleTimer)
      ;(manager as any).runs.clear()
      ;(manager as any).sessionIndex.clear()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('passes image paths to hidden Codex turns with --image', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-image-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-image-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-image-1', 'inspect this image', {
      images: [{
        name: 'sample image.png',
        path: 'C:\\Users\\Administrator\\Pictures\\sample image.png',
        mediaType: 'image/png',
      }],
    })

    const call = testState.spawnCalls[0]
    expect(call.args[3]).toContain('^"--image^"')
    expect(call.args[3]).toContain('C:\\Users\\Administrator\\Pictures\\sample^ image.png')
    expect(call.args[3]).toContain('^"-^"')
    expect(call.args[3]).not.toContain('^"inspect^ this^ image^"')
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call.child.stdin.end).toHaveBeenCalledWith('inspect this image\n')

    const run = (manager as any).runs.get('agent-session-codex-image-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('preserves non-ASCII Windows .cmd paths when launching hidden chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-unicode-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-unicode-1',
      command: 'C:\\用户\\管理员\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-unicode-1', 'test')

    expect(testState.spawnCalls[0]).toMatchObject({
      command: windowsCmd,
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\用户\\管理员\\AppData\\Roaming\\npm\\codex.cmd')

    const run = (manager as any).runs.get('agent-session-codex-unicode-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('normalizes already quoted Windows .cmd paths before launching hidden chat turns', () => {
    const manager = new CodingAgentRunManager()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-quoted-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-quoted-1',
      command: '"C:\\nvm4w\\nodejs\\codex.cmd"',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-quoted-1', 'test')

    expect(testState.spawnCalls[0]).toMatchObject({
      command: windowsCmd,
      args: expect.arrayContaining(['/d', '/s', '/c']),
    })
    expect(testState.spawnCalls[0].args[3]).toContain('C:\\nvm4w\\nodejs\\codex.cmd')
    expect(testState.spawnCalls[0].args[3]).not.toContain('"C:\\nvm4w\\nodejs\\codex.cmd"')

    const run = (manager as any).runs.get('agent-session-codex-quoted-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('emits an actionable failed run when a hidden Claude Code process is missing', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event: 'marked', payload: { event } })
    }
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-error-1',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: 'chat-session-error-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-error-1', 'test')
    testState.spawnCalls[0].child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.failed',
      payload: expect.objectContaining({
        error: 'Claude Code is not installed or is not available in PATH. Install it in Coding Agent settings, then try again.',
      }),
    }))

    const run = (manager as any).runs.get('agent-session-error-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('emits an actionable failed run when Codex is not installed', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).markChatRunCompleted = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-codex-missing',
      agentId: 'codex',
      mode: 'global',
      profile: 'default',
      provider: 'global',
      model: '',
      sessionId: 'chat-session-codex-missing',
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-missing', 'test')
    testState.spawnCalls[0].child.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.failed',
      payload: expect.objectContaining({
        error: 'Codex is not installed or is not available in PATH. Install it in Coding Agent settings, then try again.',
      }),
    }))

    const run = (manager as any).runs.get('agent-session-codex-missing')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })

  it('includes decoded stderr detail when a hidden Codex process exits non-zero', async () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).addUserMessage = () => {}
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event: 'marked', payload: { event } })
    }
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-codex-error-1',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-test',
      sessionId: 'chat-session-codex-error-1',
      command: 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd',
      args: ['--model', 'gpt-test'],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    manager.send('chat-session-codex-error-1', 'test')
    testState.spawnCalls[0].child.stderr.emit('data', Buffer.from([0xb2, 0xbb, 0xca, 0xc7]))
    testState.spawnCalls[0].child.emit('exit', 1)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.failed',
      payload: expect.objectContaining({
        error: 'Codex exited with code 1: 不是',
      }),
    }))

    const run = (manager as any).runs.get('agent-session-codex-error-1')
    if (run?.idleTimer) clearTimeout(run.idleTimer)
    ;(manager as any).runs.clear()
    ;(manager as any).sessionIndex.clear()
  })
})
