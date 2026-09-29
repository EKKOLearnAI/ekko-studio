import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  createSession: vi.fn(),
  getSession: vi.fn(() => ({ id: 'session-resume', profile: 'default', model: 'gpt-test', provider: 'openai' })),
  updateSession: vi.fn(),
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  countTokens: vi.fn(() => 1),
  SUMMARY_PREFIX: '[Summary] ',
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', async () => {
  const actual = await vi.importActual<any>('../../packages/server/src/modules/studio/services/chat-run/compression')
  return {
    ...actual,
    buildDbHistory: buildDbHistoryMock,
    buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
    buildCompressedHistory: vi.fn(),
    forceCompressBridgeHistory: vi.fn(),
  }
})

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  contextTokensWithCachedOverhead: vi.fn((_state, tokens) => tokens),
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  updateMessageContextTokenUsage: vi.fn((_sid, state, _emit, tokens) => {
    state.contextTokens = tokens
    return tokens
  }),
}))

function createNamespace() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    nsp: {
      adapter: { rooms: { get: vi.fn(() => new Set(['socket-1'])) } },
      to: vi.fn(() => ({
        emit: vi.fn((event: string, payload: any) => emitted.push({ event, payload })),
      })),
    },
  }
}

describe('resumeBridgeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    addMessageMock.mockReturnValue(42)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 3, outputTokens: 2 })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello world' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello world' },
    ])
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 3, outputTokens: 2 })
  })

  it('continues polling a resumed workflow run without judging goals when a cli continuation is queued', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const { nsp, emitted } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
    const sessionMap = new Map<string, any>()
    const dequeueNextQueuedRun = vi.fn()
    sessionMap.set('session-resume', {
      messages: [
        { id: 1, session_id: 'session-resume', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'session-resume', role: 'assistant', content: 'Hello', timestamp: 2 },
      ],
      isWorking: true,
      events: [],
      queue: [{
        queue_id: 'next-cli',
        input: 'queued cli continuation',
        profile: 'default',
        source: 'cli',
        goalContinuation: true,
      }],
    })

    const bridge = {
      getResult: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'running',
        output: 'Hello',
        deltas: ['Hello'],
        events: [{
          event: 'model.usage',
          api_request_id: 'request-before-resume',
          turn_id: 'turn-1',
          api_call_count: 1,
          model: 'gpt-test-response',
          provider: 'openai',
          usage: {
            input_tokens: 80,
            output_tokens: 12,
            cache_read_tokens: 50,
            cache_write_tokens: 3,
            reasoning_tokens: 4,
          },
        }],
      })),
      getOutput: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'complete',
        delta: ' world',
        cursor: 2,
        output: 'Hello world',
        done: true,
        result: { final_response: 'Hello world' },
        error: null,
        events: [],
        event_cursor: 0,
      })),
      contextEstimate: vi.fn(async () => ({
        ok: true,
        session_id: 'session-resume',
        fixed_context_tokens: 0,
        system_prompt_tokens: 0,
        tool_tokens: 0,
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 0,
      })),
      goalEvaluate: vi.fn(async () => ({
        ok: true,
        session_id: 'session-resume',
        handled: true,
        should_continue: false,
      })),
    }

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-resume',
        runId: 'run-resume',
        profile: 'default',
        instructions: 'system prompt',
        model: 'gpt-test',
        provider: 'openai',
        source: 'workflow',
      },
      sessionMap,
      bridge as any,
      dequeueNextQueuedRun,
    )

    expect(bridge.getResult).toHaveBeenCalledWith('run-resume')
    expect(bridge.getOutput).toHaveBeenCalledWith('run-resume', 1, 1)
    expect(updateUsageMock).toHaveBeenCalledWith('session-resume', expect.objectContaining({
      runId: 'run-resume:api:request-before-resume',
      source: 'hermes',
      usageScope: 'model_call',
      apiCalls: 1,
      inputTokens: 80,
      outputTokens: 12,
      cacheReadTokens: 50,
      cacheWriteTokens: 3,
      reasoningTokens: 4,
      model: 'gpt-test-response',
      provider: 'openai',
      isEstimated: false,
    }))
    expect(updateUsageMock).toHaveBeenCalledTimes(1)
    expect(bridge.goalEvaluate).not.toHaveBeenCalled()
    expect(sessionMap.get('session-resume').source).toBe('cli')
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-resume')
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'message.delta',
        payload: expect.objectContaining({ delta: ' world', session_id: 'session-resume' }),
      }),
      expect.objectContaining({
        event: 'run.completed',
        payload: expect.objectContaining({ output: 'Hello world', session_id: 'session-resume' }),
      }),
    ]))
    expect(sessionMap.get('session-resume').isWorking).toBe(true)
  })

  it.each(['cli', 'global_agent'] as const)(
    'preserves standing-goal evaluation and continuation source for a resumed %s run when a workflow continuation is queued',
    async (runSource) => {
      const { resumeBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
      const { nsp } = createNamespace()
      const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
      const sessionMap = new Map<string, any>()
      const dequeueNextQueuedRun = vi.fn()
      sessionMap.set('session-resume', {
        messages: [
          { id: 1, session_id: 'session-resume', role: 'user', content: 'hello', timestamp: 1 },
          { id: 2, session_id: 'session-resume', role: 'assistant', content: 'Hello', timestamp: 2 },
        ],
        isWorking: true,
        events: [],
        queue: [{
          queue_id: 'next-workflow',
          input: 'queued workflow continuation',
          profile: 'default',
          source: 'workflow',
          goalContinuation: true,
        }],
      })

      const bridge = {
        getResult: vi.fn(async () => ({
          ok: true,
          run_id: `run-${runSource}`,
          session_id: 'session-resume',
          status: 'running',
          output: 'Hello',
          deltas: ['Hello'],
          events: [],
        })),
        getOutput: vi.fn(async () => ({
          ok: true,
          run_id: `run-${runSource}`,
          session_id: 'session-resume',
          status: 'complete',
          delta: ' world',
          cursor: 2,
          output: 'Hello world',
          done: true,
          result: { final_response: 'Hello world' },
          error: null,
          events: [],
          event_cursor: 0,
        })),
        contextEstimate: vi.fn(async () => ({
          ok: true,
          session_id: 'session-resume',
          fixed_context_tokens: 0,
          system_prompt_tokens: 0,
          tool_tokens: 0,
          message_count: 0,
          tool_count: 0,
          system_prompt_chars: 0,
        })),
        goalEvaluate: vi.fn(async () => ({
          ok: true,
          session_id: 'session-resume',
          handled: true,
          should_continue: true,
          continuation_prompt: `continue ${runSource}`,
        })),
      }

      await resumeBridgeRun(
        nsp as any,
        socket as any,
        {
          sessionId: 'session-resume',
          runId: `run-${runSource}`,
          profile: 'default',
          instructions: 'system prompt',
          model: 'gpt-test',
          provider: 'openai',
          source: runSource,
        },
        sessionMap,
        bridge as any,
        dequeueNextQueuedRun,
      )

      expect(bridge.goalEvaluate).toHaveBeenCalledWith('session-resume', 'Hello world', 'default')
      expect(sessionMap.get('session-resume').source).toBe('workflow')
      expect(sessionMap.get('session-resume').queue).toEqual([
        expect.objectContaining({
          input: 'queued workflow continuation',
          source: 'workflow',
          goalContinuation: true,
        }),
        expect.objectContaining({
          input: `continue ${runSource}`,
          source: runSource,
          goalContinuation: true,
        }),
      ])
      expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-resume')
    },
  )

  it('completes a timed-out abort when the resumed bridge run reaches a terminal state', async () => {
    const { resumeBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    const { nsp, emitted } = createNamespace()
    const socket = { id: 'socket-1', connected: true, emit: vi.fn() }
    const sessionMap = new Map<string, any>()
    sessionMap.set('session-resume', {
      messages: [
        { id: 1, session_id: 'session-resume', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'session-resume', role: 'assistant', content: 'Hello', timestamp: 2, isStreaming: true },
      ],
      isWorking: true,
      isAborting: true,
      runId: 'run-resume',
      profile: 'default',
      source: 'cli',
      events: [],
      queue: [],
    })

    const bridge = {
      getResult: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'running',
        output: 'Hello',
        deltas: ['Hello'],
        events: [],
      })),
      getOutput: vi.fn(async () => ({
        ok: true,
        run_id: 'run-resume',
        session_id: 'session-resume',
        status: 'interrupted',
        delta: '',
        cursor: 1,
        output: 'Hello',
        done: true,
        result: { interrupted: true, completed: false, final_response: 'Operation interrupted' },
        error: null,
        events: [],
        event_cursor: 0,
      })),
    }

    await resumeBridgeRun(
      nsp as any,
      socket as any,
      {
        sessionId: 'session-resume',
        runId: 'run-resume',
        profile: 'default',
        instructions: 'system prompt',
        model: 'gpt-test',
        provider: 'openai',
      },
      sessionMap,
      bridge as any,
      vi.fn(),
    )

    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'abort.completed',
        payload: expect.objectContaining({ session_id: 'session-resume', run_id: 'run-resume', synced: true }),
      }),
    ]))
    expect(emitted.some(item => item.event === 'run.failed')).toBe(false)
    expect(sessionMap.get('session-resume')).toEqual(expect.objectContaining({
      isWorking: false,
      isAborting: false,
      runId: undefined,
    }))
  })
})
