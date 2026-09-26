import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import '../../packages/server/src/bootstrap/coding-agent-adapters'
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  providerEndpointUrl,
  responsesUrl,
} from '../../packages/server/src/modules/coding-agents/protocol/endpoint-resolver'
import { parseSseFrame, readSseFrames, readSseFrameTexts, sseEvent } from '../../packages/server/src/modules/coding-agents/protocol/sse'
import { AgentTargetRegistry, type AgentTargetInput } from '../../packages/server/src/modules/coding-agents/protocol/target-registry'
import { teeAsyncIterable } from '../../packages/server/src/modules/coding-agents/protocol/stream-tee'
import {
  buildClaudeStreamJsonInput,
  codexImageArgs,
  CodingAgentRunManager,
  codingAgentGatewayErrorMessage,
  sanitizeCodingAgentTerminalOutput,
} from '../../packages/server/src/modules/coding-agents/services/runtime/run-manager'
import { applyResponseStreamEvent } from '../../packages/server/src/modules/studio/services/chat-run/response-stream'
import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { addMessage, createSession, getSession, getSessionDetail, listSessions } from '../../packages/server/src/modules/studio/repositories/session-store'
import { getRecordedUsageTotals, getUsage } from '../../packages/server/src/modules/studio/repositories/usage-store'
import { getChatRunServer, setChatRunServer } from '../../packages/server/src/modules/studio/services/chat-run/server-registry'

describe('agent runner endpoint resolver', () => {
  it('adds v1 for provider hosts without an API root path', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(responsesUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/responses')
    expect(anthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
  })

  it('does not duplicate existing OpenAI-compatible API roots', () => {
    expect(chatCompletionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(chatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    )
    expect(chatCompletionsUrl('https://api.z.ai/api/paas/v4')).toBe('https://api.z.ai/api/paas/v4/chat/completions')
    expect(responsesUrl('https://api.apikey.fan/v1/')).toBe('https://api.apikey.fan/v1/responses')
  })

  it('does not duplicate existing endpoint paths', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    )
    expect(responsesUrl('https://api.example.com/v1/responses')).toBe('https://api.example.com/v1/responses')
    expect(anthropicMessagesUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/messages')
  })

  it('handles Anthropic-compatible roots', () => {
    expect(anthropicMessagesUrl('https://api.apikey.fan')).toBe('https://api.apikey.fan/v1/messages')
    expect(anthropicMessagesUrl('https://api.z.ai/api/anthropic')).toBe('https://api.z.ai/api/anthropic/v1/messages')
    expect(providerEndpointUrl('anthropic_messages', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/messages')
  })
})

describe('coding agent completion errors', () => {
  it('publishes realtime and terminal events after the run manager directory move', () => {
    const previous = getChatRunServer()
    const emitExternalEvent = vi.fn()
    const markExternalRunCompleted = vi.fn()
    setChatRunServer({ emitExternalEvent, markExternalRunCompleted } as any)
    try {
      const manager = new CodingAgentRunManager()
      ;(manager as any).emitToChat('chat-relocated-manager', 'reasoning.delta', { delta: 'thinking' })
      ;(manager as any).markChatRunCompleted('chat-relocated-manager', 'run.completed')

      expect(emitExternalEvent).toHaveBeenCalledWith(
        'chat-relocated-manager',
        'reasoning.delta',
        { delta: 'thinking' },
      )
      expect(markExternalRunCompleted).toHaveBeenCalledWith('chat-relocated-manager', 'run.completed')
    } finally {
      setChatRunServer(previous)
    }
  })

  it.each([
    ['claude-code', 'claude', 'Claude Code'],
    ['grok', 'grok', 'Grok'],
  ])('detaches an oversized %s native session after asynchronous compact failure', (agentId, storedAgent, agentName) => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const sessionId = `chat-native-compact-overflow-${agentId}-${suffix}`
    createSession({
      id: sessionId,
      profile: 'default',
      source: 'coding_agent',
      agent: storedAgent,
      agent_session_id: `agent-${suffix}`,
      agent_native_session_id: `native-${suffix}`,
      model: 'test-model',
      provider: 'test-provider',
      api_mode: 'chat_completions',
      reasoning_effort: '',
      agent_preset: '',
      title: '',
      workspace: process.cwd(),
    })
    const run: any = {
      launch: { agentId, sessionId, agentNativeSessionId: `native-${suffix}` },
      nativeCompactCommandActive: true,
      nativeResumeReady: true,
    }

    ;(manager as any).recoverFailedNativeCompact(run, 'context_length_exceeded: input exceeds the context window')

    expect(getSession(sessionId)?.agent_native_session_id).toBe('')
    expect(run.launch.agentNativeSessionId).toBe('')
    expect(run.nativeResumeReady).toBe(false)
    expect(run.disposeAfterTurn).toBe(true)
    expect(emitted).toHaveBeenCalledWith(sessionId, 'session.command', expect.objectContaining({
      command: 'compact',
      ok: true,
      resetNativeThread: true,
      message: expect.stringContaining(`fresh ${agentName} context`),
    }))
  })

  it('does not detach a native session after a non-overflow compact failure', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const sessionId = `chat-native-compact-ordinary-${suffix}`
    createSession({
      id: sessionId, profile: 'default', source: 'coding_agent', agent: 'grok',
      agent_session_id: `agent-${suffix}`, agent_native_session_id: `native-${suffix}`,
      model: 'test-model', provider: 'test-provider', api_mode: 'chat_completions',
      reasoning_effort: '', agent_preset: '', title: '', workspace: process.cwd(),
    })
    const run: any = {
      launch: { agentId: 'grok', sessionId, agentNativeSessionId: `native-${suffix}` },
      nativeCompactCommandActive: true, nativeResumeReady: true,
    }

    ;(manager as any).recoverFailedNativeCompact(run, 'native compact failed')

    expect(getSession(sessionId)?.agent_native_session_id).toBe(`native-${suffix}`)
    expect(run.nativeCompactCommandActive).toBe(false)
    expect(run.disposeAfterTurn).toBeUndefined()
    expect(emitted).not.toHaveBeenCalled()
  })

  it('does not let a stalled usage refresh block the terminal chat event', async () => {
    vi.useFakeTimers()
    try {
      const manager = new CodingAgentRunManager()
      const emitted = vi.fn()
      ;(manager as any).emitToChat = emitted
      ;(manager as any).completeWorkspaceRunDiff = () => undefined
      ;(manager as any).markChatRunCompleted = () => {}
      ;(manager as any).startCodingAgentMemoryExport = () => {}
      const run: any = {
        id: 'agent-stalled-usage',
        launch: { sessionId: 'chat-stalled-usage' },
        state: { queue: [], events: [], isWorking: true },
        terminalUsageRefresh: new Promise<void>(() => {}),
      }

      const completion = (manager as any).emitAndMarkPrintChatRunCompletedAfterUsage(
        run,
        'run.completed',
        { event: 'run.completed' },
      )
      await vi.advanceTimersByTimeAsync(2_000)
      await completion

      expect(emitted).toHaveBeenCalledWith(
        'chat-stalled-usage',
        'run.completed',
        expect.objectContaining({ event: 'run.completed' }),
      )
      expect(run.state.isWorking).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats gateway API error text as a failed coding-agent run', () => {
    const error = 'API Error: 529 [1305][The service may be temporarily overloaded, please try again later]'

    expect(codingAgentGatewayErrorMessage(error)).toBe(error)
    expect(codingAgentGatewayErrorMessage(`  ${error}\n`)).toBe(error)
    expect(codingAgentGatewayErrorMessage('Provider returned HTTP 502')).toBe('Provider returned HTTP 502')
    expect(codingAgentGatewayErrorMessage('Here is a normal answer mentioning API Error: 529 as an example')).toBeNull()
    expect(codingAgentGatewayErrorMessage('API Error: is a phrase used in this example')).toBeNull()
  })

  it('does not fail a normal native Claude reply whose text begins with a numeric API Error example', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-claude-api-example-${suffix}`
    const chatSessionId = `chat-session-claude-api-example-${suffix}`
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: 'anthropic_messages',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })

    const run = (manager as any).runs.get(agentSessionId)
    run.acceptingPrintEvent = true
    manager.handleResponseEvent(agentSessionId, {
      type: 'response.completed',
      data: {
        response: {
          id: `resp-${suffix}`,
          status: 'completed',
          model: 'test-model',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'API Error: 529 is the example requested by the user.' }],
          }],
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(getSessionDetail(chatSessionId)?.messages.at(-1)).toEqual(expect.objectContaining({
      content: 'API Error: 529 is the example requested by the user.',
      finish_reason: 'stop',
    }))
    expect(emitted).toHaveBeenCalledWith(chatSessionId, 'run.completed', expect.anything())
    expect(emitted).not.toHaveBeenCalledWith(chatSessionId, 'run.failed', expect.anything())
    manager.shutdown()
  })

  it('waits for Claude stdout to close before settling a zero-exit child', async () => {
    initAllHermesTables()
    const fixtureDir = mkdtempSync(join(tmpdir(), 'claude-api-error-close-'))
    const fixturePath = join(fixtureDir, 'delayed-api-error.cjs')
    const nativeError = JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'unknown',
      message: {
        role: 'assistant',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'API Error: stream ended without terminal event' }],
      },
    })
    writeFileSync(fixturePath, process.platform === 'win32'
      ? `setTimeout(() => { process.stdout.write(${JSON.stringify(`${nativeError}\n`)}); process.exit(0) }, 75)\n`
      : [
          "const { spawn } = require('child_process')",
          `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => process.stdout.write(${JSON.stringify(`${nativeError}\n`)}), 75)`) }], { stdio: ['ignore', 1, 2] })`,
          'process.exit(0)',
        ].join('\n'))

    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-claude-close-${suffix}`
    const chatSessionId = `chat-session-claude-close-${suffix}`
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    try {
      manager.start({
        agentSessionId,
        agentId: 'claude-code',
        mode: 'scoped',
        profile: 'default',
        provider: 'test-provider',
        model: 'test-model',
        apiMode: 'anthropic_messages',
        sessionId: chatSessionId,
        command: process.execPath,
        args: [fixturePath],
        shellCommand: process.execPath,
        workspaceDir: process.cwd(),
        state,
      })
      manager.send(chatSessionId, 'test delayed final stdout')

      await vi.waitFor(() => {
        expect(emitted).toHaveBeenCalledWith(chatSessionId, 'run.failed', expect.objectContaining({
          error: 'API Error: stream ended without terminal event',
        }))
      }, { timeout: 2_000 })

      expect(emitted).not.toHaveBeenCalledWith(chatSessionId, 'run.completed', expect.anything())
      expect(getSessionDetail(chatSessionId)?.messages.at(-1)).toEqual(expect.objectContaining({
        content: 'API Error: stream ended without terminal event',
        finish_reason: 'error',
      }))
    } finally {
      manager.shutdown()
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('persists a native Claude API error as an explicit failed terminal message', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-claude-api-error-${suffix}`
    const chatSessionId = `chat-session-claude-api-error-${suffix}`
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      apiMode: 'anthropic_messages',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })

    const run = (manager as any).runs.get(agentSessionId)
    run.currentChild = { exitCode: null, signalCode: null, killed: false }
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      error: 'unknown',
      message: {
        role: 'assistant',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'API Error: stream ended without terminal event' }],
      },
    }))

    expect(run.pendingChatCompletionEvent).toBe('run.failed')
    expect(emitted).not.toHaveBeenCalledWith(chatSessionId, 'run.failed', expect.anything())

    const terminalEventCount = emitted.mock.calls.length
    const terminalMessages = JSON.stringify(state.messages)
    const terminalText = run.printText
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'late text after failure' },
      },
    }))
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'late-tool', name: 'write_file', input: { path: 'late.txt' } }],
      },
    }))
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'result',
      result: 'late successful result',
    }))

    expect(emitted.mock.calls).toHaveLength(terminalEventCount)
    expect(JSON.stringify(state.messages)).toBe(terminalMessages)
    expect(run.printText).toBe(terminalText)

    run.currentChild = undefined
    await (manager as any).emitAndMarkPrintChatRunCompletedAfterUsage(
      run,
      run.pendingChatCompletionEvent,
      run.pendingChatCompletionPayload,
    )
    ;(manager as any).completeClaudePrintTurn(run)
    await new Promise(resolve => setTimeout(resolve, 0))

    const messages = getSessionDetail(chatSessionId)?.messages || []
    expect(messages.at(-1)).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'API Error: stream ended without terminal event',
      finish_reason: 'error',
    }))
    expect(emitted).toHaveBeenCalledWith(chatSessionId, 'run.failed', expect.objectContaining({
      error: 'API Error: stream ended without terminal event',
    }))
    expect(emitted).not.toHaveBeenCalledWith(chatSessionId, 'run.completed', expect.anything())
    manager.shutdown()
  })
})

describe('coding agent image inputs', () => {
  it('builds native Codex image arguments and Claude stream-json image blocks', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'coding-agent-image-'))
    const imagePath = join(tempDir, 'screen.png')
    writeFileSync(imagePath, Buffer.from([1, 2, 3]))
    try {
      const image = { name: 'screen.png', path: imagePath, mediaType: 'image/png' }
      expect(codexImageArgs([image])).toEqual(['--image', imagePath])

      const payload = JSON.parse(buildClaudeStreamJsonInput('inspect this', [image]))
      expect(payload).toEqual({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect this' },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: Buffer.from([1, 2, 3]).toString('base64'),
              },
            },
          ],
        },
        parent_tool_use_id: null,
      })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('agent runner SSE utilities', () => {
  it('parses event and multi-line data fields', () => {
    expect(parseSseFrame('event: response.output_text.delta\ndata: {"delta":"a"}\ndata: {"delta":"b"}')).toEqual({
      event: 'response.output_text.delta',
      data: '{"delta":"a"}\n{"delta":"b"}',
    })
  })

  it('splits LF and CRLF SSE frame boundaries', () => {
    expect(readSseFrameTexts('data: one\n\ndata: two\r\n\r\ndata: three')).toEqual({
      frames: ['data: one', 'data: two'],
      rest: 'data: three',
    })
  })

  it('reads chunked SSE streams with CRLF boundaries', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: first\r\ndata: {"a":'))
        controller.enqueue(encoder.encode('1}\r\n\r\ndata: {"b":2}\n\n'))
        controller.close()
      },
    })

    const frames = []
    for await (const frame of readSseFrames(stream)) frames.push(frame)

    expect(frames).toEqual([
      { event: 'first', data: '{"a":1}' },
      { data: '{"b":2}' },
    ])
  })

  it('serializes named SSE events', () => {
    expect(sseEvent('response.completed', { ok: true })).toBe('event: response.completed\ndata: {"ok":true}\n\n')
  })
})

describe('agent runner target registry', () => {
  it('reuses route credentials for the same normalized target', () => {
    const registry = new AgentTargetRegistry<AgentTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl],
    )

    const first = registry.register({
      provider: ' deepseek ',
      model: ' deepseek-chat ',
      baseUrl: 'https://api.deepseek.com/',
      apiKey: 'sk-first',
    })
    const second = registry.register({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-second',
    })

    expect(second.routeKey).toBe(first.routeKey)
    expect(second.token).toBe(first.token)
    expect(second.apiKey).toBe('sk-second')
    expect(registry.find(first.routeKey)?.apiKey).toBe('sk-second')
  })

  it('separates route credentials by API mode and upstream URL', () => {
    const registry = new AgentTargetRegistry<AgentTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl],
    )

    const chat = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-chat',
      apiMode: 'chat_completions',
    })
    const responses = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-one.example.com/v1',
      apiKey: 'sk-responses',
      apiMode: 'codex_responses',
    })
    const secondUrl = registry.register({
      provider: 'same-provider',
      model: 'same-model',
      baseUrl: 'https://api-two.example.com/v1',
      apiKey: 'sk-second-url',
      apiMode: 'chat_completions',
    })

    expect(chat.routeKey).not.toBe(responses.routeKey)
    expect(chat.token).not.toBe(responses.token)
    expect(chat.routeKey).not.toBe(secondUrl.routeKey)
    expect(chat.token).not.toBe(secondUrl.token)
  })

  it('keeps target tuples distinct when a key part contains the legacy delimiter', () => {
    type SessionTargetInput = AgentTargetInput & {
      agentSessionId: string
      chatSessionId: string
    }
    const registry = new AgentTargetRegistry<SessionTargetInput>(
      input => [input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId, input.chatSessionId],
    )
    const common = {
      provider: 'custom:compat-provider',
      model: 'review-model',
      baseUrl: 'https://provider.example',
      apiMode: 'anthropic_messages' as const,
    }

    const first = registry.register({
      ...common,
      apiKey: 'sk-first',
      agentSessionId: 'agent',
      chatSessionId: 'chat\0tail',
    })
    const second = registry.register({
      ...common,
      apiKey: 'sk-second',
      agentSessionId: 'agent\0chat',
      chatSessionId: 'tail',
    })

    expect(first.key).not.toBe(second.key)
    expect(first.routeKey).not.toBe(second.routeKey)
    expect(first.token).not.toBe(second.token)
    expect(registry.find(first.routeKey)?.apiKey).toBe('sk-first')
    expect(registry.find(second.routeKey)?.apiKey).toBe('sk-second')
  })
})

describe('agent runner stream tee', () => {
  it('allows two consumers to receive the same chunks', async () => {
    async function* source() {
      yield 'a'
      yield 'b'
    }
    const [left, right] = teeAsyncIterable(source())
    const collect = async (iterable: AsyncIterable<string>) => {
      const values: string[] = []
      for await (const value of iterable) values.push(value)
      return values
    }

    await expect(Promise.all([collect(left), collect(right)])).resolves.toEqual([
      ['a', 'b'],
      ['a', 'b'],
    ])
  })
})

describe('coding agent terminal output sanitizer', () => {
  it('strips terminal control codes and redacts provider credentials', () => {
    const output = sanitizeCodingAgentTerminalOutput(
      '\u001b[31mError\u001b[0m\r\nAuthorization: Bearer sk-test-secret-token\napi_key = sk-proj-secret-token',
    )

    expect(output).toContain('Error\nAuthorization: Bearer [redacted]')
    expect(output).toContain('api_key = [redacted-api-key]')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('sk-test-secret-token')
    expect(output).not.toContain('sk-proj-secret-token')
  })
})

describe('coding agent run state', () => {
  it('stores structured display input separately from the CLI prompt', () => {
    const manager = new CodingAgentRunManager()
    const addUserMessage = vi.fn()
    const startClaudePrintTurn = vi.fn()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).addUserMessage = addUserMessage
    ;(manager as any).startClaudePrintTurn = startClaudePrintTurn

    manager.start({
      agentSessionId: 'agent-session-storage-1',
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-storage-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    const storageInput = JSON.stringify([
      { type: 'text', text: 'inspect' },
      { type: 'image', name: 'screen.png', path: '/tmp/screen.png', media_type: 'image/png' },
    ])
    manager.send('chat-session-storage-1', 'inspect\n\nLocal image path for tools: /tmp/screen.png', {
      images: [{ name: 'screen.png', path: '/tmp/screen.png', mediaType: 'image/png' }],
      storageInput,
    })

    expect(addUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-session-storage-1' }),
      storageInput,
    )
    expect(startClaudePrintTurn).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-session-storage-1' }),
      'inspect\n\nLocal image path for tools: /tmp/screen.png',
      '',
      [{ name: 'screen.png', path: '/tmp/screen.png', mediaType: 'image/png' }],
    )
    manager.shutdown()
  })

  it.each(['scoped', 'global'] as const)('marks existing %s Codex runners incompatible when Studio MCP config is missing', mode => {
    const codexHome = mkdtempSync(join(tmpdir(), 'hwui-codex-mcp-compat-'))
    try {
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-test"\n')
      const manager = new CodingAgentRunManager()
      ;(manager as any).ensureDbSession = () => {}
      ;(manager as any).emitToChat = () => {}

      manager.start({
        agentSessionId: 'agent-session-1',
        agentId: 'codex',
        mode,
        profile: 'default',
        provider: 'test-provider',
        model: 'gpt-test',
        sessionId: 'chat-session-1',
        command: 'codex',
        args: [],
        shellCommand: 'codex',
        workspaceDir: process.cwd(),
        env: { CODEX_HOME: codexHome },
        state: { messages: [], isWorking: false, events: [], queue: [] },
      })

      expect(manager.isSessionLaunchCompatible('chat-session-1', {
        agentId: 'codex',
        mode,
        provider: 'test-provider',
        model: 'gpt-test',
      })).toBe(false)

      writeFileSync(join(codexHome, 'config.toml'), ['api', 'browser', 'devices', 'use', 'interaction'].map(toolset => `[mcp_servers.ekko-studio-${toolset}]\ncommand = "node"\n`).join('\n'))
      expect(manager.isSessionLaunchCompatible('chat-session-1', {
        agentId: 'codex',
        mode,
        provider: 'test-provider',
        model: 'gpt-test',
      })).toBe(true)

      manager.shutdown()
    } finally {
      rmSync(codexHome, { recursive: true, force: true })
    }
  })

  it.each(['claude-code', 'pi'])('refreshes global %s runners that lack the private MCP launch argument', agentId => {
    const root = mkdtempSync(join(tmpdir(), 'hwui-global-mcp-compat-'))
    const manager = new CodingAgentRunManager()
    try {
      const mcpPath = join(root, 'mcp.json')
      writeFileSync(mcpPath, '{"mcpServers":{}}')
      const launch = { agentId, mode: 'global', args: [] as string[], reasoningEffort: '' }
      ;(manager as any).getBySession = () => ({ exited: false, launch })
      expect(manager.isSessionLaunchCompatible('session', { agentId, mode: 'global' })).toBe(false)
      launch.args = ['--mcp-config', mcpPath]
      expect(manager.isSessionLaunchCompatible('session', { agentId, mode: 'global' })).toBe(true)
      rmSync(mcpPath)
      expect(manager.isSessionLaunchCompatible('session', { agentId, mode: 'global' })).toBe(false)
    } finally {
      manager.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updates the shared chat session state during streaming', () => {
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.created',
      data: { response: { id: 'resp-1', status: 'in_progress' } },
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.output_text.delta',
      data: { delta: 'hello' },
    })

    expect(state).toEqual(expect.objectContaining({
      isWorking: true,
      source: 'coding_agent',
      profile: 'default',
      runId: 'agent-session-1',
    }))
    expect(state.messages).toEqual([
      expect.objectContaining({
        session_id: 'chat-session-1',
        role: 'assistant',
        content: 'hello',
      }),
    ])
    expect(emitted.map(event => event.event)).toContain('message.delta')
    manager.shutdown()
  })

  it('ignores late Claude proxy events after a print turn completed', () => {
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = emitted

    manager.start({
      agentSessionId: 'agent-session-completed',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-completed',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get('agent-session-completed')
    run.terminalEventHandled = true
    state.isWorking = false

    manager.handleResponseEvent('agent-session-completed', {
      type: 'response.output_text.delta',
      data: { delta: 'belongs to another session' },
    })

    expect(state.isWorking).toBe(false)
    expect(state.messages).toEqual([])
    expect(emitted).not.toHaveBeenCalled()
    manager.shutdown()
  })

  it('ignores proxy terminal failures while a native Codex process is still running', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: true, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-retry',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-codex-retry',
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get('agent-session-codex-retry')
    run.currentChild = { exitCode: null, signalCode: null, killed: false }

    manager.handleResponseEvent('agent-session-codex-retry', {
      type: 'response.failed',
      data: {
        response: {
          id: 'provider-attempt-1',
          status: 'failed',
          error: {
            message: 'Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)',
          },
          output: [],
        },
      },
    })

    expect(run.terminalEventHandled).not.toBe(true)
    expect(run.pendingChatCompletionEvent).toBeUndefined()
    expect(emitted).not.toHaveBeenCalledWith('chat-session-codex-retry', 'run.failed', expect.anything())
    manager.shutdown()
  })

  it('lets recovered native Codex errors complete successfully when the child exits zero', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: true, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-native-retry',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-codex-native-retry',
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get('agent-session-codex-native-retry')
    run.currentChild = { exitCode: null, signalCode: null, killed: false }

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)',
    }))

    expect(run.terminalEventHandled).not.toBe(true)
    expect(run.pendingChatCompletionEvent).toBeUndefined()
    expect(run.codexPendingError).toBe('Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed)')
    expect(emitted).not.toHaveBeenCalledWith('chat-session-codex-native-retry', 'run.failed', expect.anything())

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'error',
      params: { message: 'Reconnecting... 2/5' },
    }))

    expect(run.terminalEventHandled).not.toBe(true)
    expect(run.pendingChatCompletionEvent).toBeUndefined()
    expect(run.codexPendingError).toBe('Reconnecting... 2/5')

    ;(manager as any).appendCodexFinalText(run, 'recovered final answer')
    run.currentChild = undefined
    ;(manager as any).finishCodexExecTurn(run, 0)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(run.terminalEventHandled).toBe(true)
    expect(run.pendingChatCompletionEvent).toBeUndefined()
    expect(emitted).toHaveBeenCalledWith('chat-session-codex-native-retry', 'run.completed', expect.objectContaining({
      output: 'recovered final answer',
      error: undefined,
    }))
    expect(emitted).not.toHaveBeenCalledWith('chat-session-codex-native-retry', 'run.failed', expect.anything())
    ;(manager as any).finishCodexExecTurn(run, 0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(emitted.mock.calls.filter(([, event]) => event === 'run.completed')).toHaveLength(1)
    manager.shutdown()
  })

  it('reports a provisional native Codex error when the child exits non-zero', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: true, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-native-error-exit',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-codex-native-error-exit',
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get('agent-session-codex-native-error-exit')
    run.currentChild = { exitCode: null, signalCode: null, killed: false }
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'error',
      message: 'native transport retries exhausted',
    }))

    run.currentChild = undefined
    ;(manager as any).finishCodexExecTurn(run, 1)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(emitted).toHaveBeenCalledWith('chat-session-codex-native-error-exit', 'run.failed', expect.objectContaining({
      error: 'native transport retries exhausted',
    }))
    expect(emitted).not.toHaveBeenCalledWith('chat-session-codex-native-error-exit', 'run.completed', expect.anything())
    expect(emitted.mock.calls.filter(([, event]) => event === 'run.failed')).toHaveLength(1)
    manager.shutdown()
  })

  it('keeps native Codex turn failures authoritative while the child is still running', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: true, events: [], queue: [] }
    const emitted = vi.fn()
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = emitted
    ;(manager as any).refreshCodingAgentUsage = async () => {}

    manager.start({
      agentSessionId: 'agent-session-codex-native-failure',
      agentId: 'codex',
      mode: 'scoped',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-codex-native-failure',
      command: 'codex',
      args: [],
      shellCommand: 'codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get('agent-session-codex-native-failure')
    run.currentChild = { exitCode: null, signalCode: null, killed: false }

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'turn.failed',
      error: { message: 'native Codex failure' },
    }))

    expect(run.terminalEventHandled).toBe(true)
    expect(run.pendingChatCompletionEvent).toBe('run.failed')
    expect(run.pendingChatCompletionPayload).toEqual(expect.objectContaining({
      error: 'native Codex failure',
    }))
    manager.shutdown()
  })

  it('clears shared chat session run state when a print turn completes', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId: 'agent-session-1',
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'test-model',
      sessionId: 'chat-session-1',
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    manager.handleResponseEvent('agent-session-1', {
      type: 'response.created',
      data: { response: { id: 'resp-1', status: 'in_progress' } },
    })
    state.events.push({ event: 'tool.started', data: { event: 'tool.started' } })

    manager.handleResponseEvent('agent-session-1', {
      type: 'response.completed',
      data: {
        response: {
          id: 'resp-1',
          status: 'completed',
          output: [],
          model: 'test-model',
          usage: { input_tokens: 12, output_tokens: 5 },
        },
      },
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(state).toEqual(expect.objectContaining({
      isWorking: false,
      runId: undefined,
      activeRunMarker: undefined,
      events: [],
    }))
    expect(getUsage('chat-session-1')).toEqual(expect.objectContaining({
      input_tokens: 12,
      output_tokens: 5,
      model: 'test-model',
      profile: 'default',
    }))
    manager.shutdown()
  })

  it('records scoped proxy usage once per model call and skips the scoped turn aggregate', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-proxy-usage-${suffix}`
    const chatSessionId = `chat-session-proxy-usage-${suffix}`
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    ;(manager as any).ensureDbSession = () => {}
    ;(manager as any).emitToChat = () => {}
    ;(manager as any).markChatRunCompleted = () => {}

    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      mode: 'scoped',
      profile: 'default',
      provider: 'glm',
      model: 'glm-5-turbo',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })

    const proxyCompleted = {
      type: 'response.completed',
      data: {
        response: {
          id: `provider-call-${suffix}`,
          status: 'completed',
          model: 'glm-5-turbo',
          output: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        },
      },
    }
    manager.handleProxyUsageEvent(agentSessionId, proxyCompleted)
    manager.handleProxyUsageEvent(agentSessionId, proxyCompleted)
    manager.handleResponseEvent(agentSessionId, {
      type: 'response.completed',
      data: {
        response: {
          id: `turn-${suffix}`,
          status: 'completed',
          output: [],
          usage: { input_tokens: 120, output_tokens: 7 },
        },
      },
    })

    expect(getRecordedUsageTotals(chatSessionId, 'coding_agent')).toEqual({
      inputTokens: 90,
      outputTokens: 7,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      apiCalls: 1,
    })
    manager.shutdown()
  })

  it('leaves coding agent session titles empty for the existing fallback title logic', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-empty-title-${suffix}`
    const chatSessionId = `chat-session-empty-title-${suffix}`
    const run: any = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'claude-code',
        profile: 'default',
        provider: 'test-provider',
        model: 'glm-5-turbo',
        sessionId: chatSessionId,
        command: 'claude',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    ;(manager as any).ensureDbSession(run)

    expect(getSession(chatSessionId)?.title).toBeNull()
    manager.shutdown()
  })

  it('uses the first coding agent user message as the listed session title when title and preview are empty', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-title-fallback-${suffix}`
    const chatSessionId = `chat-session-title-fallback-${suffix}`
    const run: any = {
      id: agentSessionId,
      launch: {
        agentSessionId,
        agentId: 'codex',
        mode: 'global',
        profile: 'default',
        provider: 'global',
        model: '',
        sessionId: chatSessionId,
        command: 'codex',
        args: [],
        shellCommand: 'codex',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
    }

    ;(manager as any).ensureDbSession(run)
    addMessage({
      session_id: chatSessionId,
      role: 'user',
      content: 'Explain why global Codex should not show GLM',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const session = listSessions('default', 'coding_agent').find(item => item.id === chatSessionId)
    expect(session?.preview).toBe('Explain why global Codex should not show GLM')
    expect(session?.title).toBe('Explain why global Codex should not show...')
    manager.shutdown()
  })

  it('starts Codex chat runner without a hidden PTY process', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const result = manager.start({
      agentSessionId: `agent-session-codex-${suffix}`,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: `chat-session-codex-${suffix}`,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })

    expect(result.pid).toBe(0)
    expect(getSession(`chat-session-codex-${suffix}`)).toEqual(expect.objectContaining({
      source: 'coding_agent',
      agent: 'codex',
      model: 'gpt-5-codex',
    }))
    manager.shutdown()
  })

  it('maps Codex exec JSONL assistant deltas into chat messages', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-jsonl-${suffix}`
    const chatSessionId = `chat-session-codex-jsonl-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_1'
    run.printMessageId = 'msg_resp_codex_1'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_1', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'I am GPT-5-Codex' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages).toContainEqual(expect.objectContaining({
      session_id: chatSessionId,
      role: 'assistant',
      content: 'I am GPT-5-Codex',
      finish_reason: 'stop',
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.isWorking).toBe(false)

    expect(emitted.map(event => event.event)).toContain('message.delta')
    expect(emitted.map(event => event.event)).toContain('usage.updated')
    expect(emitted.find(event => event.event === 'usage.updated' && event.payload.contextTokens != null)?.payload).toEqual(expect.objectContaining({
      contextTokens: expect.any(Number),
    }))
    expect(emitted.find(event => event.event === 'run.completed')?.payload).not.toHaveProperty('usage')
    const eventNames = emitted.map(event => event.event)
    expect(eventNames.lastIndexOf('usage.updated')).toBeLessThan(eventNames.indexOf('run.completed'))
    manager.shutdown()
  })

  it('does not reset Codex context tokens when a usage refresh has no context estimate', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = {
      messages: [],
      isWorking: false,
      events: [],
      queue: [],
      contextTokens: 15_000,
    }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-empty-usage-${suffix}`
    const chatSessionId = `chat-session-codex-empty-usage-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)

    await (manager as any).refreshCodingAgentUsage(run)

    expect(state.contextTokens).toBe(15_000)
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'usage.updated',
      payload: expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
    }))
    expect(emitted).not.toContainEqual(expect.objectContaining({
      event: 'usage.updated',
      payload: expect.objectContaining({ contextTokens: 0 }),
    }))
    manager.shutdown()
  })

  it('does not duplicate replayed Codex assistant message text', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-dedupe-${suffix}`
    const chatSessionId = `chat-session-codex-dedupe-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_dedupe'
    run.printMessageId = 'msg_resp_codex_dedupe'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_dedupe', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const text = '好的，你想查看 🐸 Meme币排行！让我先读取 Meme Rank API 的详细说明。'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      msg: { content: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'assistant_message', text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages).toContainEqual(expect.objectContaining({
      session_id: chatSessionId,
      role: 'assistant',
      content: text,
      finish_reason: 'stop',
    }))
    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(text)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([text])
    manager.shutdown()
  })

  it('deduplicates repeated full Codex streaming deltas', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-full-delta-dedupe-${suffix}`
    const chatSessionId = `chat-session-codex-full-delta-dedupe-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_full_delta_dedupe'
    run.printMessageId = 'msg_resp_codex_full_delta_dedupe'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_full_delta_dedupe', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const text = 'It seems like you are sending numbers without additional context. I am not sure what you are looking for.\n\nCould you describe what you need in a sentence or two?'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(text)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([text])
    manager.shutdown()
  })

  it('keeps repeated short Codex markdown chunks while deduplicating final replay', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-markdown-${suffix}`
    const chatSessionId = `chat-session-codex-markdown-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_markdown'
    run.printMessageId = 'msg_resp_codex_markdown'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_markdown', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    for (const delta of ['```', 'ts', '\n', 'const value = 1', '\n', '```']) {
      ;(manager as any).handleCodexExecLine(run, JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { delta },
      }))
    }
    const text = ['```ts', 'const value = 1', '```'].join('\n')
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'assistant_message', text },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(text)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([
      '```',
      'ts',
      '\n',
      'const value = 1',
      '\n',
      '```',
    ])
    manager.shutdown()
  })

  it('normalizes Codex full-text snapshot deltas before emitting chat deltas', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-snapshot-${suffix}`
    const chatSessionId = `chat-session-codex-snapshot-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_snapshot'
    run.printMessageId = 'msg_resp_codex_snapshot'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_snapshot', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const first = 'Hello! How can I help you today?'
    const snapshot = 'Hello! How can I help you today? Please describe what you need.'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: first },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: snapshot },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe(snapshot)
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([
      first,
      ' Please describe what you need.',
    ])
    manager.shutdown()
  })

  it('stores Codex reasoning items in the response run state', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-reasoning-${suffix}`
    const chatSessionId = `chat-session-codex-reasoning-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_reasoning'
    run.printMessageId = 'msg_resp_codex_reasoning'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_reasoning', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', summary: [{ text: 'Need inspect. ' }, { text: 'Then answer.' }] },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: ' From response item.' }] },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/reasoning/delta',
      params: { delta: ' Extra.' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'reasoning',
        summary: [{ text: 'Need inspect. Then answer. From response item. Extra.' }],
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: 'Done.' },
    }))

    expect(emitted.filter(event => event.event === 'reasoning.delta').map(event => event.payload.delta)).toEqual([
      'Need inspect. Then answer.',
      ' From response item.',
      ' Extra.',
    ])
    expect(state.messages.find((message: any) => message.role === 'assistant')).toMatchObject({
      content: 'Done.',
      reasoning: 'Need inspect. Then answer. From response item. Extra.',
      reasoning_content: 'Need inspect. Then answer. From response item. Extra.',
    })
    manager.shutdown()
  })

  it('does not append unrelated Codex final text without a tool boundary', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-no-tool-final-${suffix}`
    const chatSessionId = `chat-session-codex-no-tool-final-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_no_tool_final'
    run.printMessageId = 'msg_resp_codex_no_tool_final'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_no_tool_final', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Initial assistant text.' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Different final text without tools.' },
    }))
    ;(manager as any).completeCodexExecTurn(run)

    const textMessages = state.messages.filter((message: any) => message.role === 'assistant' && !message.tool_calls?.length)
    expect(textMessages.map((message: any) => message.content)).toEqual(['Initial assistant text.'])
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual(['Initial assistant text.'])
    manager.shutdown()
  })

  it('deduplicates a Codex CLI final snapshot already completed by the proxy stream', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-proxy-cli-dedupe-${suffix}`
    const chatSessionId = `chat-session-codex-proxy-cli-dedupe-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_proxy_cli_dedupe'
    run.printMessageId = 'msg_resp_codex_proxy_cli_dedupe'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_proxy_cli_dedupe', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const text = '好的，我来帮你查询厦门的天气。'
    manager.handleResponseEvent(agentSessionId, {
      type: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: text },
    })
    manager.handleResponseEvent(agentSessionId, {
      type: 'response.output_text.done',
      data: { type: 'response.output_text.done', text },
    })
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text },
    }))

    const textMessages = state.messages.filter((message: any) => message.role === 'assistant' && !message.tool_calls?.length)
    expect(textMessages.map((message: any) => message.content)).toEqual([text])
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([text])
    manager.shutdown()
  })

  it('keeps repeated short Codex streaming deltas', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-short-deltas-${suffix}`
    const chatSessionId = `chat-session-codex-short-deltas-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_short_deltas'
    run.printMessageId = 'msg_resp_codex_short_deltas'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_short_deltas', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: '\n' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      method: 'item/agentMessage/delta',
      params: { delta: '\n' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)

    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe('\n\n')
    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual(['\n', '\n'])
    manager.shutdown()
  })

  it('waits for Codex process exit before flushing final text after tools', async () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-tool-final-${suffix}`
    const chatSessionId = `chat-session-codex-tool-final-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.printResponseId = 'resp_codex_tool_final'
    run.printMessageId = 'msg_resp_codex_tool_final'
    run.printTextStarted = false
    run.printText = ''
    run.printCompleted = false
    run.responseStartEmitted = false
    run.terminalEventHandled = false
    run.codexToolBlocks = new Map()
    run.codexChatText = ''
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_codex_tool_final', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })

    const openingText = '我会先查看你的桌面目录。'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: openingText },
    }))
    expect(state.messages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: openingText,
    }))

    manager.handleResponseEvent(agentSessionId, {
      type: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          id: 'call-proxy',
          call_id: 'call-proxy',
          name: 'exec_command',
          arguments: '{"cmd":"ls ~/Desktop"}',
        },
      },
    })
    manager.handleResponseEvent(agentSessionId, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call',
          id: 'call-proxy',
          call_id: 'call-proxy',
          name: 'exec_command',
          arguments: '{"cmd":"ls ~/Desktop"}',
        },
      },
    })
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.started',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        name: 'exec_command',
        arguments: { cmd: 'ls ~/Desktop' },
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        id: 'call-1',
        name: 'exec_command',
        arguments: { cmd: 'ls ~/Desktop' },
        output: 'ai素材\ncache\ngit',
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', id: 'cmd-1', command: 'ls ~/Desktop' },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        id: 'cmd-1',
        command: 'ls ~/Desktop',
        aggregated_output: 'ai素材\ncache\ngit',
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({ type: 'turn.completed' }))
    run.currentChild = { exitCode: null, signalCode: null, killed: false } as any
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: {
        response: {
          id: 'resp_codex_tool_final',
          status: 'completed',
          model: 'gpt-5-codex',
          output: [],
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    })

    expect(emitted.map(event => event.event)).not.toContain('run.completed')
    expect(state.isWorking).toBe(true)
    expect(getSessionDetail(chatSessionId)?.messages || []).not.toContainEqual(expect.objectContaining({
      role: 'assistant',
      tool_calls: expect.any(Array),
    }))

    const finalText = '你的桌面上有以下 3 个目录：ai素材、cache、git。'
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: finalText },
    }))
    run.currentChild = undefined
    ;(manager as any).completeCodexExecTurn(run, run.codexPendingUsage)
    await new Promise(resolve => setTimeout(resolve, 0))

    const textMessages = state.messages.filter((message: any) => message.role === 'assistant' && !message.tool_calls?.length)
    expect(textMessages.map((message: any) => message.content)).toEqual([openingText, finalText])
    expect(textMessages.at(-1)).toEqual(expect.objectContaining({ finish_reason: 'stop' }))
    const dbMessages = getSessionDetail(chatSessionId)?.messages || []
    const dbToolCallMessages = dbMessages.filter(message => message.role === 'assistant' && message.tool_calls?.length)
    const dbToolMessage = dbMessages.find(message => message.role === 'tool' && message.tool_call_id === 'cmd-1')
    expect(dbToolCallMessages).toHaveLength(1)
    expect(dbToolMessage).toEqual(expect.objectContaining({
      role: 'tool',
      content: 'ai素材\ncache\ngit',
      tool_call_id: 'cmd-1',
      run_marker: expect.any(String),
    }))
    expect(dbToolMessage?.run_marker).toBe(dbToolCallMessages[0].run_marker)
    expect(dbMessages).toContainEqual(expect.objectContaining({
      role: 'assistant',
      content: finalText,
    }))
    expect(emitted.map(event => event.event)).toContain('run.completed')
    manager.shutdown()
  })

  it('truncates large coding-agent tool outputs before emitting and flushing to SQLite', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = () => {}
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-large-tool-${suffix}`
    const chatSessionId = `chat-session-codex-large-tool-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    const largeOutput = `HEAD-${'a'.repeat(80 * 1024)}-TAIL`

    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.created',
      data: { response: { id: 'resp_large_tool', status: 'in_progress', model: 'gpt-5-codex', output: [] } },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          id: 'call_large',
          call_id: 'call_large',
          name: 'read_file',
          arguments: '{"path":"big.log"}',
        },
      },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call',
          id: 'call_large',
          call_id: 'call_large',
          name: 'read_file',
          arguments: '{"path":"big.log"}',
        },
      },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call_output',
          id: 'call_large',
          call_id: 'call_large',
          output: largeOutput,
        },
      },
    })
    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: { response: { id: 'resp_large_tool', status: 'completed', model: 'gpt-5-codex', output: [] } },
    })

    const toolMessage = state.messages.find((message: any) => message.role === 'tool')
    const completedPayload = emitted.find(event => event.event === 'tool.completed')?.payload as any
    const dbToolMessage = (getSessionDetail(chatSessionId)?.messages || []).find(message => message.role === 'tool')
    for (const output of [toolMessage?.content, completedPayload?.output, dbToolMessage?.content]) {
      expect(output).toContain('HEAD-')
      expect(output).toContain('-TAIL')
      expect(output).toContain('coding-agent tool output truncated for storage')
      expect(output.length).toBeLessThan(largeOutput.length)
      expect(output.length).toBeLessThan(34 * 1024)
    }
    manager.shutdown()
  })

  it('records Codex thread id so follow-up turns can resume the native session', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-codex-thread-${suffix}`
    const chatSessionId = `chat-session-codex-thread-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    const run = (manager as any).runs.get(agentSessionId)

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'thread.started',
      thread_id: '0199a213-81c0-7800-8aa1-bbab2a035a53',
    }))

    expect(getSession(chatSessionId)?.agent_native_session_id).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53')
    manager.shutdown()
  })

  it('does not report a completed idle coding-agent session cleanup as a run failure', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-idle-cleanup-${suffix}`
    const chatSessionId = `chat-session-idle-cleanup-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'codex',
      profile: 'default',
      provider: 'test-provider',
      model: 'gpt-5-codex',
      sessionId: chatSessionId,
      command: 'codex',
      args: ['--model', 'gpt-5-codex'],
      shellCommand: 'codex --model gpt-5-codex',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: false, events: [], queue: [] },
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.state.isWorking = false
    run.currentChild = undefined

    ;(manager as any).cleanupRun(run, { kill: true })

    expect(emitted).toEqual([])
  })

  it('does not emit run.failed when a print coding-agent session is stopped by abort', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = (_sessionId: string, event: string) => {
      emitted.push({ event, payload: { marked: true } })
    }
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-user-stop-${suffix}`
    const chatSessionId = `chat-session-user-stop-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state: { messages: [], isWorking: true, events: [], queue: [] },
    })

    expect(manager.stop(chatSessionId, { reportClosed: false })).toBe(true)

    expect(emitted).toEqual([])
  })

  it('defers queued-run release until a print coding-agent child exits', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: false, events: [], queue: [{ queue_id: 'queued-1', input: 'next' }] }
    const completed = vi.fn()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).markChatRunCompleted = completed
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-defer-complete-${suffix}`
    const chatSessionId = `chat-session-defer-complete-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)
    run.currentChild = { exitCode: null, signalCode: null, killed: false }

    ;(manager as any).handleClaudePrintResponseEvent(run, {
      type: 'response.completed',
      data: { response: { id: 'resp-defer', status: 'completed', output: [] } },
    })

    expect(completed).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(true)
    expect(run.pendingChatCompletionEvent).toBe('run.completed')
    expect(run.pendingChatCompletionPayload).toEqual(expect.objectContaining({
      event: 'run.completed',
      response_id: 'resp-defer',
    }))

    run.currentChild = undefined
    ;(manager as any).emitAndMarkPrintChatRunCompleted(run, run.pendingChatCompletionEvent, run.pendingChatCompletionPayload)

    expect(completed).toHaveBeenCalledWith(chatSessionId, 'run.completed')
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'run.completed',
      payload: expect.objectContaining({
        response_id: 'resp-defer',
        queue_remaining: 1,
      }),
    }))
    expect(state.isWorking).toBe(false)
    expect(run.pendingChatCompletionEvent).toBeUndefined()
    expect(run.pendingChatCompletionPayload).toBeUndefined()
  })

  it('writes print coding-agent session end markers only after the final queued run completes', () => {
    initAllHermesTables()
    const manager = new CodingAgentRunManager()
    const state: any = { messages: [], isWorking: true, events: [], queue: [{ queue_id: 'queued-1', input: 'next' }] }
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const agentSessionId = `agent-session-ended-marker-${suffix}`
    const chatSessionId = `chat-session-ended-marker-${suffix}`
    manager.start({
      agentSessionId,
      agentId: 'claude-code',
      profile: 'default',
      provider: 'test-provider',
      model: 'claude-test',
      sessionId: chatSessionId,
      command: 'claude',
      args: [],
      shellCommand: 'claude',
      workspaceDir: process.cwd(),
      state,
    })
    const run = (manager as any).runs.get(agentSessionId)

    ;(manager as any).emitAndMarkPrintChatRunCompleted(run, 'run.completed', { event: 'run.completed' })
    expect(getSession(chatSessionId)?.ended_at).toBeNull()
    expect(getSession(chatSessionId)?.end_reason).toBeNull()

    state.queue = []
    state.isWorking = true
    ;(manager as any).emitAndMarkPrintChatRunCompleted(run, 'run.failed', { event: 'run.failed' })
    const session = getSession(chatSessionId)
    expect(session?.ended_at).toEqual(expect.any(Number))
    expect(session?.end_reason).toBe('error')
  })
})

describe('response stream chat event mapper', () => {
  it('does not surface raw provider stream events as chat agent events', () => {
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const mapped = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
      item: { type: 'message', content: [] },
    })

    expect(mapped).toBeNull()
  })

  it('maps reasoning deltas to chat reasoning deltas', () => {
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })

    expect(applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.reasoning.delta', {
      delta: 'thinking',
    })).toEqual({
      event: 'reasoning.delta',
      payload: expect.objectContaining({
        event: 'reasoning.delta',
        delta: 'thinking',
      }),
      runId: 'resp-1',
    })
  })
})

describe('response stream tool detail events', () => {
  it('buffers function-call argument deltas and emits tool.started once arguments are complete', () => {
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    const started = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{}' },
    })
    const withCommand = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.function_call_arguments.delta', {
      item_id: 'call-1',
      delta: '{"command":"pwd"',
    })
    const withFinalArgs = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.function_call_arguments.delta', {
      item_id: 'call-1',
      delta: '}',
    })
    const completedArguments = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
    })
    const duplicateDone = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
    })

    expect(started).toBeNull()
    expect(withCommand).toBeNull()
    expect(withFinalArgs).toBeNull()
    expect(completedArguments).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'call-1',
        tool: 'Bash',
        arguments: '{"command":"pwd"}',
      }),
    }))
    expect(duplicateDone).toBeNull()
  })

  it('emits tool.started immediately when an added function call already has complete arguments', () => {
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
      response: { id: 'resp-1', status: 'in_progress' },
    })
    const started = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
    })
    const done = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
      item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
    })

    expect(started).toEqual(expect.objectContaining({
      event: 'tool.started',
      payload: expect.objectContaining({
        tool_call_id: 'call-1',
        tool: 'Bash',
        arguments: '{"command":"pwd"}',
      }),
    }))
    expect(done).toBeNull()
  })

  it('emits completed tool events with duration', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const state: any = { messages: [], isWorking: false, events: [], queue: [] }
      applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
        response: { id: 'resp-1', status: 'in_progress' },
      })
      applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
        item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
      })

      vi.setSystemTime(new Date('2026-01-01T00:00:01.230Z'))
      const completed = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
        item: { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
      })

      expect(completed).toEqual(expect.objectContaining({
        event: 'tool.completed',
        payload: expect.objectContaining({
          event: 'tool.completed',
          tool_call_id: 'call-1',
          duration: 1.23,
          output: 'ok',
        }),
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits failed tool events with duration and persisted error state', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const state: any = { messages: [], isWorking: false, events: [], queue: [] }
      applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.created', {
        response: { id: 'resp-1', status: 'in_progress' },
      })
      applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.added', {
        item: { type: 'function_call', call_id: 'call-1', name: 'Bash', arguments: '{"command":"pwd"}' },
      })

      vi.setSystemTime(new Date('2026-01-01T00:00:02.500Z'))
      const failed = applyResponseStreamEvent(state, 'session-1', 'run-1', 'response.output_item.done', {
        item: { type: 'function_call_output', call_id: 'call-1', output: { ok: false, error: 'permission denied' } },
      })

      expect(failed).toEqual(expect.objectContaining({
        event: 'tool.failed',
        payload: expect.objectContaining({
          event: 'tool.failed',
          tool_call_id: 'call-1',
          duration: 2.5,
          error: 'permission denied',
          output: '{"ok":false,"error":"permission denied"}',
        }),
      }))
      expect(state.messages.find((message: any) => message.role === 'tool')).toEqual(expect.objectContaining({
        finish_reason: 'error',
        tool_call_id: 'call-1',
      }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OpenCode JSON stream mapping', () => {
  it('ignores scoped proxy lifecycle events and accepts native stdout once', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).ensureDbSession = () => {}
    const run: any = {
      id: 'agent-session-opencode-native',
      launch: {
        agentSessionId: 'agent-session-opencode-native',
        agentId: 'opencode',
        mode: 'scoped',
        profile: 'default',
        provider: 'test',
        model: 'opencode-test',
        sessionId: 'chat-session-opencode-native',
        command: 'opencode',
        args: [],
        shellCommand: 'opencode',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      currentChild: { exitCode: null, signalCode: null, killed: false },
      printResponseId: 'resp_opencode_native',
      printMessageId: 'msg_resp_opencode_native',
      printText: '',
      printTextStarted: false,
      printCompleted: false,
      responseStartEmitted: true,
      terminalEventHandled: false,
    }
    ;(manager as any).runs.set(run.id, run)

    manager.handleResponseEvent(run.id, {
      type: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'proxy duplicate' },
    })
    manager.handleResponseEvent(run.id, {
      type: 'response.completed',
      data: {
        response: {
          id: 'proxy-step-1',
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'proxy duplicate' }] }],
        },
      },
    })

    expect(emitted).toEqual([])
    expect(run.terminalEventHandled).toBe(false)
    expect(run.state.messages).toEqual([])

    ;(manager as any).handleOpenCodeLine(run, JSON.stringify({
      type: 'text',
      sessionID: 'ses_opencode_native',
      part: { type: 'text', text: '您好！有什么可以帮您？', time: { end: Date.now() } },
    }))
    ;(manager as any).handleOpenCodeLine(run, JSON.stringify({
      type: 'text',
      sessionID: 'ses_opencode_native',
      part: { type: 'text', text: '您好！有什么可以帮您？', time: { end: Date.now() } },
    }))

    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([
      '您好！有什么可以帮您？',
    ])
    expect(run.printText).toBe('您好！有什么可以帮您？')
    expect(run.launch.agentNativeSessionId).toBe('ses_opencode_native')
  })
})

describe('Claude Code stream-json mapping', () => {
  it('uses native stream-json tool events while the Claude child is running', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).ensureDbSession = () => {}
    const run = {
      id: 'agent-session-native-tools',
      launch: {
        agentSessionId: 'agent-session-native-tools',
        agentId: 'claude-code',
        profile: 'default',
        provider: 'test',
        model: 'claude-test',
        sessionId: 'chat-session-native-tools',
        command: 'claude',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      currentChild: { exitCode: null, signalCode: null, killed: false },
      printResponseId: 'resp_native_tools',
      printMessageId: 'msg_resp_native_tools',
      printToolBlocks: new Map(),
    }
    ;(manager as any).runs.set(run.id, run)

    manager.handleResponseEvent(run.id, {
      type: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          id: 'call-proxy-web-search',
          call_id: 'call-proxy-web-search',
          name: 'web_search',
          arguments: '{}',
        },
      },
    })
    manager.handleResponseEvent(run.id, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call_output',
          id: 'call-proxy-web-search',
          call_id: 'call-proxy-web-search',
          output: '',
        },
      },
    })

    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call-native-web-search',
          name: 'WebSearch',
          input: { query: 'Xiamen weather' },
        }],
      },
    }))
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-native-web-search',
          content: 'Sunny',
        }],
      },
    }))

    expect(emitted.filter(event => event.event === 'tool.started').map(event => event.payload)).toEqual([
      expect.objectContaining({
        tool_call_id: 'call-native-web-search',
        tool: 'WebSearch',
        arguments: '{"query":"Xiamen weather"}',
      }),
    ])
    expect(emitted.filter(event => event.event === 'tool.completed').map(event => event.payload)).toEqual([
      expect.objectContaining({
        tool_call_id: 'call-native-web-search',
        output: 'Sunny',
      }),
    ])
    expect(run.state.messages).not.toContainEqual(expect.objectContaining({
      tool_calls: [expect.objectContaining({ id: 'call-proxy-web-search' })],
    }))
  })

  it('maps top-level tool_result messages to tool.completed', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).ensureDbSession = () => {}
    const run = {
      id: 'agent-session-1',
      launch: {
        agentSessionId: 'agent-session-1',
        agentId: 'claude-code',
        profile: 'default',
        provider: 'test',
        model: 'claude-test',
        sessionId: 'chat-session-1',
        command: 'claude',
        args: [],
        shellCommand: 'claude',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      printResponseId: 'resp_1',
      printMessageId: 'msg_resp_1',
      printToolBlocks: new Map(),
    }
    ;(manager as any).runs.set(run.id, run)

    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'pwd' } }],
      },
    }))
    ;(manager as any).handleClaudePrintLine(run, JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '/tmp/project' }],
      },
    }))

    expect(emitted.map(event => event.event)).toContain('tool.started')
    expect(emitted).toContainEqual(expect.objectContaining({
      event: 'tool.completed',
      payload: expect.objectContaining({
        tool_call_id: 'toolu_1',
        output: '/tmp/project',
      }),
    }))
  })
})

describe('Codex JSONL tool mapping', () => {
  it('keeps proxy text streaming but uses native JSONL for tool events', () => {
    const manager = new CodingAgentRunManager()
    const emitted: Array<{ event: string; payload: any }> = []
    ;(manager as any).emitToChat = (_sessionId: string, event: string, payload: any) => {
      emitted.push({ event, payload })
    }
    ;(manager as any).ensureDbSession = () => {}
    const run = {
      id: 'agent-session-codex-native-tools',
      launch: {
        agentSessionId: 'agent-session-codex-native-tools',
        agentId: 'codex',
        profile: 'default',
        provider: 'test',
        model: 'gpt-codex-test',
        sessionId: 'chat-session-codex-native-tools',
        command: 'codex',
        args: [],
        shellCommand: 'codex',
        workspaceDir: process.cwd(),
      },
      state: { messages: [], isWorking: false, events: [], queue: [] },
      lastActiveAt: Date.now(),
      startedAt: Date.now(),
      exited: false,
      currentChild: { exitCode: null, signalCode: null, killed: false },
      printResponseId: 'resp_codex_native_tools',
      printMessageId: 'msg_resp_codex_native_tools',
      codexToolBlocks: new Map(),
      codexChatText: '',
    }
    ;(manager as any).runs.set(run.id, run)

    manager.handleResponseEvent(run.id, {
      type: 'response.output_text.delta',
      data: { type: 'response.output_text.delta', delta: 'Searching...' },
    })
    manager.handleResponseEvent(run.id, {
      type: 'response.output_item.added',
      data: {
        item: {
          type: 'function_call',
          id: 'call-proxy-web-search',
          call_id: 'call-proxy-web-search',
          name: 'web_search',
          arguments: '{}',
        },
      },
    })
    manager.handleResponseEvent(run.id, {
      type: 'response.output_item.done',
      data: {
        item: {
          type: 'function_call_output',
          id: 'call-proxy-web-search',
          call_id: 'call-proxy-web-search',
          output: '',
        },
      },
    })

    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.started',
      item: {
        type: 'web_search',
        id: 'call-native-web-search',
        query: 'Xiamen weather',
      },
    }))
    ;(manager as any).handleCodexExecLine(run, JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'web_search',
        id: 'call-native-web-search',
        query: 'Xiamen weather',
        output: 'Sunny',
      },
    }))

    expect(emitted.filter(event => event.event === 'message.delta').map(event => event.payload.delta)).toEqual([
      'Searching...',
    ])
    expect(emitted.filter(event => event.event === 'tool.started').map(event => event.payload)).toEqual([
      expect.objectContaining({
        tool_call_id: 'call-native-web-search',
        tool: 'Web Search',
        arguments: '{"query":"Xiamen weather"}',
      }),
    ])
    expect(emitted.filter(event => event.event === 'tool.completed').map(event => event.payload)).toEqual([
      expect.objectContaining({
        tool_call_id: 'call-native-web-search',
        output: 'Sunny',
      }),
    ])
    expect(run.state.messages).not.toContainEqual(expect.objectContaining({
      tool_calls: [expect.objectContaining({ id: 'call-proxy-web-search' })],
    }))
  })
})
