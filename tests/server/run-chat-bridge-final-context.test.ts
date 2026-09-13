import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSystemPromptMock = vi.fn()
const getSessionMock = vi.fn()
const createSessionMock = vi.fn()
const addMessageMock = vi.fn()
const updateSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const updateUsageMock = vi.fn()
const buildCompressedHistoryMock = vi.fn()
const buildDbHistoryMock = vi.fn()
const buildSnapshotAwareHistoryMock = vi.fn(async (_sessionId: string, _profile: string, history: any[]) => history)
const buildDbSnapshotAwareHistoryMock = vi.fn(async (sessionId: string, profile: string, options: any, modelContext: any) => (
  buildSnapshotAwareHistoryMock(
    sessionId,
    profile,
    await buildDbHistoryMock(sessionId, options),
    modelContext,
  )
))
const pushStateMock = vi.fn()
const replaceStateMock = vi.fn()
const forceCompressBridgeHistoryMock = vi.fn()
const calcAndUpdateUsageMock = vi.fn()
const estimateUsageTokensFromMessagesMock = vi.fn()
const updateContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, contextTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
  state.contextTokens = contextTokens
  emit('usage.updated', {
    event: 'usage.updated',
    session_id: sid,
    inputTokens: usage?.inputTokens ?? state.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? state.outputTokens ?? 0,
    contextTokens,
  })
  return contextTokens
})
const getCachedBridgeContextOverheadMock = vi.fn(() => undefined)
const contextTokensWithCachedOverheadMock = vi.fn((_state: any, messageTokens: number) => messageTokens)
const updateMessageContextTokenUsageMock = vi.fn((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => updateContextTokenUsageMock(sid, state, emit, messageTokens, usage))
const flushBridgePendingToDbMock = vi.fn()
const ensureOpenBridgeAssistantMessageMock = vi.fn()
const syncBridgeReasoningToMessageMock = vi.fn()
const recordBridgeToolStartedMock = vi.fn()
const recordBridgeToolCompletedMock = vi.fn()
const recordBridgeMoaDisplayToolMock = vi.fn()
const resolveBridgeRunModelConfigMock = vi.fn()
const resolveAuthorizedProviderRuntimeCredentialsMock = vi.fn()
const issueModelRunJwtMock = vi.fn(async () => 'model-run-token')
const startWorkspaceRunCheckpointMock = vi.fn()
const completeWorkspaceRunCheckpointMock = vi.fn()
const homes: string[] = []

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  createSession: createSessionMock,
  addMessage: addMessageMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: updateUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildCompressedHistory: buildCompressedHistoryMock,
  buildDbHistory: buildDbHistoryMock,
  buildSnapshotAwareHistory: buildSnapshotAwareHistoryMock,
  buildDbSnapshotAwareHistory: buildDbSnapshotAwareHistoryMock,
  pushState: pushStateMock,
  replaceState: replaceStateMock,
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  estimateUsageTokensFromMessages: estimateUsageTokensFromMessagesMock,
  getCachedBridgeContextOverhead: getCachedBridgeContextOverheadMock,
  contextTokensWithCachedOverhead: contextTokensWithCachedOverheadMock,
  updateContextTokenUsage: updateContextTokenUsageMock,
  updateMessageContextTokenUsage: updateMessageContextTokenUsageMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: flushBridgePendingToDbMock,
  ensureOpenBridgeAssistantMessage: ensureOpenBridgeAssistantMessageMock,
  syncBridgeReasoningToMessage: syncBridgeReasoningToMessageMock,
  recordBridgeToolStarted: recordBridgeToolStartedMock,
  recordBridgeToolCompleted: recordBridgeToolCompletedMock,
  recordBridgeMoaDisplayTool: recordBridgeMoaDisplayToolMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({
  resolveBridgeRunModelConfig: resolveBridgeRunModelConfigMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({
  resolveAuthorizedProviderRuntimeCredentials: resolveAuthorizedProviderRuntimeCredentialsMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: startWorkspaceRunCheckpointMock,
  completeWorkspaceRunCheckpoint: completeWorkspaceRunCheckpointMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-final-context/${profile || 'default'}`,
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  issueModelRunJwt: issueModelRunJwtMock,
}))

function makeSocket() {
  return {
    connected: true,
    emit: vi.fn(),
    join: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
    data: {},
  } as any
}

function makeNamespace(emit: ReturnType<typeof vi.fn>) {
  const room = new Set(['socket-1'])
  return {
    adapter: { rooms: new Map([['session:session-1', room]]) },
    to: vi.fn(() => ({ emit })),
  } as any
}

function makeState() {
  return {
    messages: [],
    isWorking: false,
    events: [],
    queue: [],
  } as any
}

describe('bridge run final context usage', () => {
  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-bridge-run-token-'))
    homes.push(home)
    process.env.HERMES_WEB_UI_HOME = home
    vi.clearAllMocks()
    getSystemPromptMock.mockReturnValue('system prompt')
    issueModelRunJwtMock.mockResolvedValue('model-run-token')
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '' })
    resolveBridgeRunModelConfigMock.mockResolvedValue({ model: 'gpt-test', provider: 'openai' })
    resolveAuthorizedProviderRuntimeCredentialsMock.mockResolvedValue({
      provider: 'claude-oauth',
      apiKey: 'fresh-claude-access-token',
      baseUrl: 'https://api.anthropic.com',
      apiMode: 'anthropic_messages',
    })
    buildCompressedHistoryMock.mockResolvedValue([{ role: 'user', content: 'previous' }])
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ])
    buildSnapshotAwareHistoryMock.mockImplementation(async (_sessionId: string, _profile: string, history: any[]) => history)
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 11, outputTokens: 7 })
    estimateUsageTokensFromMessagesMock.mockReturnValue({ inputTokens: 11, outputTokens: 7 })
    completeWorkspaceRunCheckpointMock.mockReturnValue(null)
    ensureOpenBridgeAssistantMessageMock.mockImplementation((state: any, sessionId: string, runMarker: string) => {
      const existing = [...state.messages].reverse().find((message: any) => (
        message.runMarker === runMarker &&
        message.role === 'assistant' &&
        message.finish_reason == null
      ))
      if (existing) return existing
      const message = {
        id: state.messages.length + 1,
        session_id: sessionId,
        runMarker,
        role: 'assistant',
        content: '',
        timestamp: 0,
      }
      state.messages.push(message)
      return message
    })
    syncBridgeReasoningToMessageMock.mockImplementation((message: any, reasoning?: string) => {
      if (!reasoning) return
      message.reasoning = reasoning
      message.reasoning_content = reasoning
    })
    getCachedBridgeContextOverheadMock.mockImplementation((state: any) => {
      const fixed = state?.bridgeContext?.fixedContextTokens
      return typeof fixed === 'number' ? fixed : undefined
    })
    contextTokensWithCachedOverheadMock.mockImplementation((state: any, messageTokens: number) => {
      const fixed = state?.bridgeContext?.fixedContextTokens
      return typeof fixed === 'number' ? fixed + messageTokens : messageTokens
    })
    updateMessageContextTokenUsageMock.mockImplementation((sid: string, state: any, emit: any, messageTokens: number, usage?: { inputTokens: number; outputTokens: number }) => {
      const contextTokens = contextTokensWithCachedOverheadMock(state, messageTokens)
      return updateContextTokenUsageMock(sid, state, emit, contextTokens, usage)
    })
  })

  it('refreshes Studio Claude OAuth before creating the Anthropic bridge agent', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'research',
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      workspace: '/tmp/hermes-bridge-final-context/research/workspace',
    })
    resolveBridgeRunModelConfigMock.mockResolvedValueOnce({
      model: 'claude-opus-4-6',
      provider: 'claude-oauth',
    })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-claude', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 100,
        fixed_context_tokens: 80,
        message_count: 0,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-claude', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'research',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(resolveAuthorizedProviderRuntimeCredentialsMock).toHaveBeenCalledWith({
      profile: 'research',
      provider: 'claude-oauth',
      model: 'claude-opus-4-6',
    })
    expect(resolveAuthorizedProviderRuntimeCredentialsMock.mock.invocationCallOrder[0])
      .toBeLessThan(bridge.contextEstimate.mock.invocationCallOrder[0])
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Array),
      expect.any(String),
      'research',
      expect.objectContaining({
        model: 'claude-opus-4-6',
        provider: 'anthropic',
      }),
    )
    expect(updateSessionMock).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ provider: 'claude-oauth' }),
    )
  })

  afterEach(() => {
    delete process.env.HERMES_WEB_UI_HOME
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('reopens an ended bridge session when starting a new run', async () => {
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
      workspace: '/tmp/hermes-bridge-final-context/default/workspace',
      ended_at: 1_770_000_000,
      end_reason: 'complete',
    })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello again', session_id: 'session-1', queue_id: 'mcu-test-run' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    const reopenCallIndex = updateSessionMock.mock.calls.findIndex(([sessionId, data]) => (
      sessionId === 'session-1' &&
      data.ended_at === null &&
      data.end_reason === null &&
      typeof data.last_active === 'number'
    ))
    const endedCallIndex = updateSessionMock.mock.calls.findIndex(([sessionId, data]) => (
      sessionId === 'session-1' &&
      typeof data.ended_at === 'number' &&
      data.end_reason === 'complete'
    ))

    expect(reopenCallIndex).toBeGreaterThanOrEqual(0)
    expect(endedCallIndex).toBeGreaterThanOrEqual(0)
    expect(reopenCallIndex).toBeLessThan(endedCallIndex)
    expect(emit).toHaveBeenCalledWith('run.started', expect.objectContaining({
      queue_id: 'mcu-test-run',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'done',
      queue_id: 'mcu-test-run',
    }))
  })

  it('does not prepend the Studio guidance a second time when the caller already composed it', async () => {
    // The chat-run socket composes getSystemPrompt() and hands the result down as
    // `instructions`. Composing again duplicated the whole guidance block —
    // MCP usage plus output-format rules — in the system message of every request.
    getSessionMock.mockReturnValue({
      id: 'session-1',
      profile: 'default',
      model: 'gpt-test',
      provider: 'openai',
      workspace: '/tmp/hermes-bridge-final-context/default/workspace',
    })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const sessionMap = new Map([['session-1', makeState()]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 1, fixed_context_tokens: 1, message_count: 1, tool_count: 0, system_prompt_chars: 1 }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const composed = 'system prompt\nAGENT SOUL'
    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', instructions: composed },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(getSystemPromptMock).not.toHaveBeenCalled()
    const sent = String(bridge.chat.mock.calls[0]?.[3] ?? '')
    expect(sent).toContain(composed)
    expect(sent.split('system prompt').length - 1).toBe(1)
  })

  it('refreshes full context tokens when a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).toHaveBeenCalledWith(
      'session-1',
      [],
      expect.not.stringContaining('[Current Hermes profile:'),
      'default',
      {
        model: 'gpt-test',
        provider: 'openai',
        workspace: '/tmp/hermes-bridge-final-context/default/workspace',
      },
    )
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      'hello',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({ background_delegation_enabled: true }),
    )
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('system prompt')
    expect(bridge.contextEstimate.mock.calls[0][2]).toContain('X-Hermes-Profile')
    expect(bridge.contextEstimate.mock.calls[0][2]).not.toContain('Current working directory')
    expect(state.contextTokens).toBe(12345)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('forwards MoA reference and aggregating events from bridge chunks', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [
            { event: 'moa.reference', label: 'grok-4.3', text: 'ref answer', index: 1, count: 2 },
            { event: 'moa.aggregating', aggregator: 'deepseek-v4-pro' },
          ],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'final answer' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(pushStateMock).toHaveBeenCalledWith(sessionMap, 'session-1', 'moa.reference', expect.objectContaining({
      event: 'moa.reference',
      label: 'grok-4.3',
      text: 'ref answer',
      index: 1,
      count: 2,
    }))
    expect(replaceStateMock).toHaveBeenCalledWith(sessionMap, 'session-1', 'moa.aggregating', expect.objectContaining({
      event: 'moa.aggregating',
      aggregator: 'deepseek-v4-pro',
    }))
    expect(emit).toHaveBeenCalledWith('moa.reference', expect.objectContaining({
      label: 'grok-4.3',
      text: 'ref answer',
      index: 1,
      count: 2,
    }))
    expect(emit).toHaveBeenCalledWith('moa.aggregating', expect.objectContaining({
      aggregator: 'deepseek-v4-pro',
    }))
    expect(recordBridgeMoaDisplayToolMock).toHaveBeenCalledWith(
      state,
      'session-1',
      expect.any(String),
      'moa_reference',
      'moa:reference:run-1:1',
      JSON.stringify({ label: 'grok-4.3', preview: '1/2 grok-4.3', text: 'ref answer', index: 1, count: 2 }),
    )
    expect(recordBridgeMoaDisplayToolMock).toHaveBeenCalledWith(
      state,
      'session-1',
      expect.any(String),
      'moa_aggregating',
      'moa:aggregating:run-1',
      JSON.stringify({ aggregator: 'deepseek-v4-pro', preview: 'deepseek-v4-pro', text: 'deepseek-v4-pro' }),
    )
  })

  it('seals authoritative interim assistant messages without duplicating streamed text', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    flushBridgePendingToDbMock.mockImplementation((targetState: any, _sessionId: string, runMarker: string) => {
      const message = [...targetState.messages].reverse().find((candidate: any) => (
        candidate.runMarker === runMarker
        && candidate.role === 'assistant'
        && candidate.finish_reason == null
      ))
      if (message && String(targetState.bridgePendingAssistantContent || '').trim()) {
        message.finish_reason = 'stop'
      }
      targetState.bridgePendingAssistantContent = ''
      targetState.bridgePendingReasoningContent = ''
    })
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [
            { event: 'stream.delta', delta: 'partial' },
            { event: 'message.interim', text: 'partial answer', already_streamed: true },
            { event: 'message.interim', text: 'callback-only commentary', already_streamed: false },
          ],
        }
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'partialfinal answer',
          events: [{ event: 'stream.delta', delta: 'final answer' }],
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.filter((message: any) => message.role === 'assistant').map((message: any) => message.content)).toEqual([
      'partial answer',
      'callback-only commentary',
      'final answer',
    ])
    expect(state.bridgeOutput).toBe('partial answercallback-only commentaryfinal answer')
    expect(emit.mock.calls.filter(([event]) => event === 'message.delta')).toEqual([
      ['message.delta', expect.objectContaining({ delta: 'partial' })],
      ['message.delta', expect.objectContaining({ delta: 'final answer' })],
    ])
    expect(emit).toHaveBeenCalledWith('message.interim', expect.objectContaining({
      text: 'partial answer',
      already_streamed: true,
    }))
    expect(emit).toHaveBeenCalledWith('message.interim', expect.objectContaining({
      text: 'callback-only commentary',
      already_streamed: false,
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'partial answercallback-only commentaryfinal answer',
    }))
  })

  it('uses result.final_response for moa and records only its exact model-call event', async () => {
    resolveBridgeRunModelConfigMock.mockResolvedValueOnce({ model: 'default', provider: 'moa' })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: '',
          events: [{
            event: 'model.usage',
            api_request_id: 'request-1',
            turn_id: 'turn-1',
            api_call_count: 1,
            model: 'moa-aggregator',
            provider: 'openai',
            usage: {
              input_tokens: 120,
              output_tokens: 30,
              cache_read_tokens: 20,
              cache_write_tokens: 4,
              reasoning_tokens: 6,
            },
          }],
          result: {
            final_response: '你好呀！',
            usage: { input_tokens: 999, output_tokens: 999 },
          },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.bridgeOutput).toBe('你好呀！')
    expect(state.messages.find((message: any) => message.role === 'assistant')?.content).toBe('你好呀！')
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: '你好呀！',
    }))
    expect(updateUsageMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      runId: 'run-1:api:request-1',
      source: 'hermes',
      usageScope: 'model_call',
      apiCalls: 1,
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
      reasoningTokens: 6,
      model: 'moa-aggregator',
      provider: 'openai',
      profile: 'default',
      isEstimated: false,
    }))
    expect(updateUsageMock).toHaveBeenCalledTimes(1)
  })

  it('does not synthesize non-moa assistant output from result.final_response', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: '',
          result: { final_response: 'non-moa fallback' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.bridgeOutput).toBe('')
    expect(state.messages.find((message: any) => message.role === 'assistant')).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: '',
    }))
  })

  it('releases working state when the bridge stream ends without a terminal chunk', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          session_id: 'session-1',
          done: false,
          status: 'running',
          delta: 'partial reply',
          cursor: 1,
          output: 'partial reply',
          events: [],
          event_cursor: 0,
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'partial reply',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'partial reply',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('releases workflow state without judging goals when the bridge stream ends without a terminal chunk', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const goalEvaluate = vi.fn(async () => {
      throw new Error('workflow synthetic completion must not judge standing goals')
    })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          session_id: 'session-1',
          done: false,
          status: 'running',
          delta: 'partial workflow reply',
          cursor: 1,
          output: 'partial workflow reply',
          events: [],
          event_cursor: 0,
        }
      }),
      goalEvaluate,
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', source: 'workflow' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.isWorking).toBe(false)
    expect(state.isAborting).toBe(false)
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    expect(goalEvaluate).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'partial workflow reply',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 12345,
    }))
  })

  it('stores a super admin model-run token for the profile without adding it to bridge instructions', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    socket.data.user = { id: 1, username: 'admin', role: 'super_admin' }
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        fixed_context_tokens: 12327,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    const instructions = bridge.contextEstimate.mock.calls[0][2]
    expect(issueModelRunJwtMock).toHaveBeenCalledWith({ id: 1, username: 'admin', role: 'super_admin' })
    expect(readFileSync(join(process.env.HERMES_WEB_UI_HOME || '', 'profiles', 'default', '.model-run-token'), 'utf-8').trim()).toBe('model-run-token')
    expect(instructions).not.toContain('[Current Hermes profile:')
    expect(instructions).not.toContain('Current working directory')
    expect(instructions).not.toContain('pass the current Hermes profile as the profile argument')
    expect(instructions).not.toContain('model-run-token')
    expect(instructions).not.toContain('Current Hermes Web UI model run token')
    expect(instructions).not.toContain('token argument')
    expect(instructions).not.toContain('list_mcp_resources')
    expect(instructions).not.toContain('mcp__hermes-studio__')
  })

  it('creates global-agent bridge sessions with source global_agent', async () => {
    getSessionMock.mockReturnValue(undefined)
    addMessageMock.mockReturnValue(42)
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 42,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1', source: 'global_agent' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'session-1',
      source: 'global_agent',
      workspace: '/tmp/hermes-bridge-final-context/default/workspace',
    }))
    expect(state.source).toBe('global_agent')
  })

  it('passes the workflow workspace through to bridge runs', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['workflow-session', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-workflow', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 42,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-workflow', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    getSessionMock.mockReturnValue(undefined)

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: 'run workflow node',
        session_id: 'workflow-session',
        source: 'workflow',
        workspace: '/tmp/hermes-workflow-workspace',
        background_delegation_enabled: false,
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(createSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'workflow-session',
      source: 'workflow',
      workspace: '/tmp/hermes-workflow-workspace',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'workflow-session',
      'run workflow node',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({
        workspace: '/tmp/hermes-workflow-workspace',
        background_delegation_enabled: false,
      }),
    )
    expect(state.source).toBe('workflow')
  })

  it('does not evaluate standing goals after a workflow run with no queued continuation', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['workflow-session', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-workflow', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 42,
        message_count: 1,
        tool_count: 0,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockRejectedValue(new Error('workflow must not evaluate standing goals')),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-workflow',
          done: true,
          status: 'completed',
          output: 'workflow node complete',
          result: { final_response: 'workflow node complete' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'run workflow node', session_id: 'workflow-session', source: 'workflow' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.goalEvaluate).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'workflow node complete',
    }))
  })

  it.each(['cli', 'global_agent'] as const)(
    'does not evaluate standing goals after a workflow run when a %s continuation is queued',
    async (nextSource) => {
      const emit = vi.fn()
      const nsp = makeNamespace(emit)
      const socket = makeSocket()
      const state = makeState()
      // Mark the queued item as an internal continuation so hasRealQueuedRun()
      // cannot hide a regression in the completed-run source decision.
      state.queue.push({
        queue_id: `next-${nextSource}`,
        input: 'queued continuation',
        profile: 'default',
        source: nextSource,
        goalContinuation: true,
      })
      const sessionMap = new Map([['workflow-session', state]])
      const dequeueNextQueuedRun = vi.fn()
      const bridge = {
        chat: vi.fn().mockResolvedValue({ run_id: 'run-workflow', status: 'started' }),
        contextEstimate: vi.fn().mockResolvedValue({
          token_count: 42,
          message_count: 1,
          tool_count: 0,
          system_prompt_chars: 13,
        }),
        goalEvaluate: vi.fn().mockRejectedValue(new Error('workflow must not evaluate standing goals')),
        streamOutput: vi.fn(async function* () {
          yield {
            run_id: 'run-workflow',
            done: true,
            status: 'completed',
            output: 'workflow node complete',
            result: { final_response: 'workflow node complete' },
          }
        }),
      } as any

      const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
      await handleBridgeRun(
        nsp,
        socket,
        { input: 'run workflow node', session_id: 'workflow-session', source: 'workflow' },
        'default',
        sessionMap,
        bridge,
        false,
        vi.fn(),
        dequeueNextQueuedRun,
      )

      expect(bridge.goalEvaluate).not.toHaveBeenCalled()
      expect(state.source).toBe(nextSource)
      expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'workflow-session')
      expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
        output: 'workflow node complete',
      }))
      expect(emit).not.toHaveBeenCalledWith('run.failed', expect.anything())
    },
  )

  it.each(['cli', 'global_agent'] as const)(
    'evaluates standing goals for a completed %s run even when a workflow continuation is queued',
    async (runSource) => {
      const emit = vi.fn()
      const nsp = makeNamespace(emit)
      const socket = makeSocket()
      const state = makeState()
      // Keep the queued Workflow item internal so the real-queue guard cannot
      // bypass the completed ordinary run's standing-goal evaluation.
      state.queue.push({
        queue_id: 'next-workflow',
        input: 'queued workflow continuation',
        profile: 'default',
        source: 'workflow',
        goalContinuation: true,
      })
      const sessionMap = new Map([['ordinary-session', state]])
      const dequeueNextQueuedRun = vi.fn()
      const bridge = {
        chat: vi.fn().mockResolvedValue({ run_id: `run-${runSource}`, status: 'started' }),
        contextEstimate: vi.fn().mockResolvedValue({
          token_count: 42,
          message_count: 1,
          tool_count: 0,
          system_prompt_chars: 13,
        }),
        goalEvaluate: vi.fn().mockResolvedValue({
          handled: true,
          should_continue: true,
          continuation_prompt: 'continue ordinary standing goal',
        }),
        streamOutput: vi.fn(async function* () {
          yield {
            run_id: `run-${runSource}`,
            done: true,
            status: 'completed',
            output: 'ordinary chat complete',
            result: { final_response: 'ordinary chat complete' },
          }
        }),
      } as any

      const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
      await handleBridgeRun(
        nsp,
        socket,
        { input: 'continue chat', session_id: 'ordinary-session', source: runSource },
        'default',
        sessionMap,
        bridge,
        false,
        vi.fn(),
        dequeueNextQueuedRun,
      )

      expect(bridge.goalEvaluate).toHaveBeenCalledWith('ordinary-session', 'ordinary chat complete', 'default')
      expect(state.queue).toEqual([
        expect.objectContaining({ source: 'workflow' }),
        expect.objectContaining({
          input: 'continue ordinary standing goal',
          source: runSource,
          goalContinuation: true,
        }),
      ])
      expect(state.source).toBe('workflow')
      expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'ordinary-session')
    },
  )

  it('evaluates active goals after a successful bridge run and queues continuation prompts', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    addMessageMock.mockReturnValue(42)
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockResolvedValue({
        handled: true,
        should_continue: true,
        continuation_prompt: '[Continuing toward your standing goal]\nGoal: fix tests',
        message: '↻ Continuing toward goal (1/20): tests still fail',
        verdict: 'continue',
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'not finished',
          result: { final_response: 'not finished' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: 'hello',
        session_id: 'session-1',
        model_groups: [{ provider: 'openai', models: ['gpt-test'] }],
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(bridge.goalEvaluate).toHaveBeenCalledWith('session-1', 'not finished', 'default')
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      role: 'command',
      content: '↻ Continuing toward goal (1/20): tests still fail',
    }))
    expect(emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'continue',
      message: '↻ Continuing toward goal (1/20): tests still fail',
    }))
    expect(state.queue).toEqual([expect.objectContaining({
      input: '[Continuing toward your standing goal]\nGoal: fix tests',
      displayInput: null,
      storageMessage: '[Continuing toward your standing goal]\nGoal: fix tests',
      model: 'gpt-test',
      provider: 'openai',
      model_groups: [{ provider: 'openai', models: ['gpt-test'] }],
      goalContinuation: true,
    })])
    expect(dequeueNextQueuedRun).toHaveBeenCalledWith(socket, 'session-1')
  })

  it('skips hidden goal continuation runs without pausing when the judge is unavailable', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const dequeueNextQueuedRun = vi.fn()
    addMessageMock.mockReturnValue(43)
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      command: vi.fn(),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      goalEvaluate: vi.fn().mockResolvedValue({
        handled: true,
        should_continue: true,
        continuation_prompt: '[Continuing toward your standing goal]\nGoal: fix tests',
        message: '↻ Continuing toward goal (1/20): no auxiliary client configured',
        verdict: 'continue',
        reason: 'no auxiliary client configured',
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: true,
          status: 'completed',
          output: 'done',
          result: { final_response: 'done' },
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      dequeueNextQueuedRun,
    )

    expect(bridge.command).not.toHaveBeenCalled()
    expect(state.queue).toEqual([])
    expect(dequeueNextQueuedRun).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      command: 'goal',
      action: 'judge_unavailable',
      message: 'Goal judge is not configured; automatic goal continuation was skipped. The goal remains active, but Hermes cannot mark it done automatically.',
    }))
  })

  it('uses cached fixed context instead of bridge estimate when available', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [{
            event: 'bridge.context.ready',
            fixed_context_tokens: 20_000,
            system_prompt_tokens: 3_000,
            tool_tokens: 17_000,
          }],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(bridge.contextEstimate).not.toHaveBeenCalled()
    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      18,
      { inputTokens: 11, outputTokens: 7 },
    )
    expect(state.contextTokens).toBe(20_018)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 20_018,
    }))
  })

  it('keeps bridge context ready updates on the snapshot-aware token baseline', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 28_000, outputTokens: 0 })
    buildDbHistoryMock.mockResolvedValue([
      { role: 'user', content: 'very large old context' },
      { role: 'assistant', content: 'large old response' },
      { role: 'user', content: 'hello' },
    ])
    buildSnapshotAwareHistoryMock.mockResolvedValue([
      { role: 'user', content: '[Previous context summary]\n\nsmall summary' },
      { role: 'user', content: 'hello' },
    ])
    estimateUsageTokensFromMessagesMock.mockImplementation((messages: any[]) => {
      if (messages?.[0]?.content?.includes('small summary')) {
        return { inputTokens: 9_000, outputTokens: 0 }
      }
      return { inputTokens: 28_000, outputTokens: 0 }
    })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn(),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [{
            event: 'bridge.context.ready',
            fixed_context_tokens: 10_000,
            system_prompt_tokens: 2_000,
            tool_tokens: 8_000,
          }],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(updateMessageContextTokenUsageMock).toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      9_000,
      { inputTokens: 28_000, outputTokens: 0 },
    )
    expect(updateMessageContextTokenUsageMock).not.toHaveBeenCalledWith(
      'session-1',
      state,
      expect.any(Function),
      28_000,
      { inputTokens: 28_000, outputTokens: 0 },
    )
    expect(state.contextTokens).toBe(19_000)
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      contextTokens: 19_000,
    }))
  })

  it('persists pending tool marker text before a bridge run completes', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const persistedContent: string[] = []
    flushBridgePendingToDbMock.mockImplementation((targetState: any) => {
      persistedContent.push(targetState.bridgePendingAssistantContent || '')
      targetState.bridgePendingAssistantContent = ''
    })
    ensureOpenBridgeAssistantMessageMock.mockImplementation((targetState: any, sessionId: string, runMarker: string) => {
      let message = [...targetState.messages].reverse().find((m: any) => m.runMarker === runMarker && m.role === 'assistant' && m.finish_reason == null)
      if (!message) {
        message = {
          id: targetState.messages.length + 1,
          session_id: sessionId,
          runMarker,
          role: 'assistant',
          content: '',
          timestamp: Math.floor(Date.now() / 1000),
        }
        targetState.messages.push(message)
      }
      return message
    })
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: false, status: 'running', delta: 'Text [Call', events: [] }
        yield { run_id: 'run-1', done: true, status: 'completed', output: '', events: [] }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(persistedContent).toContain('Text [Call')
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: 'Text ',
      output: 'Text ',
    }))
    expect(emit).toHaveBeenCalledWith('message.delta', expect.objectContaining({
      delta: '[Call',
      output: 'Text [Call',
    }))
    expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
      output: 'Text [Call',
    }))
  })

  it.each(['terminal', 'write_file'])(
    'attributes native Hermes Agent %s workspace changes to the final persisted assistant row',
    async (toolName) => {
      const emit = vi.fn()
      const nsp = makeNamespace(emit)
      const socket = makeSocket()
      const state = makeState()
      const sessionMap = new Map([['session-1', state]])
      const change = {
        change_id: `run:run-1:${toolName}`,
        assistant_message_id: '73',
        session_id: 'session-1',
        run_id: 'run-1',
        source: 'run',
        files: [],
      }
      recordBridgeToolStartedMock.mockReturnValue({
        id: `call-${toolName}`,
        name: toolName,
        arguments: '{}',
      })
      recordBridgeToolCompletedMock.mockReturnValue({
        id: `call-${toolName}`,
        output: 'ok',
      })
      flushBridgePendingToDbMock.mockImplementation((targetState: any) => {
        if (String(targetState.bridgePendingAssistantContent || '').trim()) {
          targetState.bridgePendingAssistantContent = ''
          targetState.bridgeAssistantMessageId = '73'
        }
        return targetState.bridgeAssistantMessageId
      })
      completeWorkspaceRunCheckpointMock.mockReturnValue(change)
      const bridge = {
        chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
        contextEstimate: vi.fn().mockResolvedValue({
          token_count: 12345,
          message_count: 2,
          tool_count: 4,
          system_prompt_chars: 13,
        }),
        streamOutput: vi.fn(async function* () {
          yield {
            run_id: 'run-1',
            done: false,
            status: 'running',
            events: [
              { event: 'tool.started', tool_name: toolName, tool_call_id: `call-${toolName}`, args: {} },
              { event: 'tool.completed', tool_name: toolName, tool_call_id: `call-${toolName}`, result: 'ok' },
            ],
          }
          yield { run_id: 'run-1', done: true, status: 'completed', delta: 'Done.', output: 'Done.', events: [] }
        }),
      } as any

      const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
      await handleBridgeRun(
        nsp,
        socket,
        { input: 'update the workspace', session_id: 'session-1' },
        'default',
        sessionMap,
        bridge,
        false,
        vi.fn(),
        vi.fn(),
      )

      expect(recordBridgeToolStartedMock).toHaveBeenCalledWith(
        state,
        'session-1',
        expect.any(String),
        toolName,
        {},
        `call-${toolName}`,
      )
      expect(recordBridgeToolCompletedMock).toHaveBeenCalledWith(
        state,
        'session-1',
        expect.any(String),
        toolName,
        expect.objectContaining({ event: 'tool.completed' }),
      )
      expect(startWorkspaceRunCheckpointMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
      }))
      expect(completeWorkspaceRunCheckpointMock).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-1',
        runId: 'run-1',
        assistantMessageId: '73',
      }))
      expect(emit).toHaveBeenCalledWith('workspace.diff.completed', expect.objectContaining({ change }))
      expect(emit).toHaveBeenCalledWith('run.completed', expect.objectContaining({
        workspace_run_change: change,
      }))
    },
  )

  it('persists the visible plan command instead of the expanded skill prompt', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'planned' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded plan skill prompt]',
        display_input: '/plan build the feature',
        display_role: 'command',
        storage_message: '/plan build the feature',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.role === 'command')).toEqual(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/plan build the feature',
    }))
    expect(addMessageMock).not.toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded plan skill prompt]',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded plan skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({
        storage_message: '/plan build the feature',
        workspace: '/tmp/hermes-bridge-final-context/default/workspace',
      }),
    )
  })

  it('persists the visible moa command while sending only the prompt to the bridge', async () => {
    resolveBridgeRunModelConfigMock.mockResolvedValueOnce({ model: 'default', provider: 'moa' })
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'moa answer' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '都有什么模型参加讨论',
        display_input: '/moa 都有什么模型参加讨论',
        display_role: 'command',
        storage_message: '/moa 都有什么模型参加讨论',
        session_id: 'session-1',
        model: 'default',
        provider: 'moa',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.role === 'command')).toEqual(expect.objectContaining({
      role: 'command',
      content: '/moa 都有什么模型参加讨论',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'command',
      content: '/moa 都有什么模型参加讨论',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '都有什么模型参加讨论',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({
        model: 'default',
        provider: 'moa',
        storage_message: '/moa 都有什么模型参加讨论',
      }),
    )
  })

  it('persists expanded skill prompts as user history with visible command display fields', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: '[IMPORTANT: expanded skill prompt]',
        display_input: '/skill github-pr-review check PR 123',
        display_role: 'command',
        storage_message: '[IMPORTANT: expanded skill prompt]',
        session_id: 'session-1',
      },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.messages.find((message: any) => message.content === '[IMPORTANT: expanded skill prompt]')).toEqual(expect.objectContaining({
      role: 'user',
      display_role: 'command',
      display_content: '/skill github-pr-review check PR 123',
    }))
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      role: 'user',
      content: '[IMPORTANT: expanded skill prompt]',
      display_role: 'command',
      display_content: '/skill github-pr-review check PR 123',
    }))
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      '[IMPORTANT: expanded skill prompt]',
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({
        storage_message: '[IMPORTANT: expanded skill prompt]',
        workspace: '/tmp/hermes-bridge-final-context/default/workspace',
      }),
    )
  })

  it('refreshes full context tokens when a bridge run fails', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockRejectedValue(new Error('bridge timeout')),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 54321,
        fixed_context_tokens: 54303,
        message_count: 1,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.contextTokens).toBe(54321)
    expect(emit).toHaveBeenCalledWith('usage.updated', expect.objectContaining({
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      error: 'bridge timeout',
      inputTokens: 11,
      outputTokens: 7,
      contextTokens: 54321,
    }))
  })

  it('emits bridge lifecycle status events so retries are visible', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'run-1', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({
        token_count: 12345,
        message_count: 2,
        tool_count: 4,
        system_prompt_chars: 13,
      }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'run-1',
          done: false,
          status: 'running',
          events: [
            { event: 'status', kind: 'lifecycle', text: 'Retrying in 3.0s (attempt 1/3)...' },
          ],
        }
        yield { run_id: 'run-1', done: true, status: 'completed', output: 'done' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'hello', session_id: 'session-1' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(replaceStateMock).toHaveBeenCalledWith(sessionMap, 'session-1', 'agent.event', expect.objectContaining({
      event: 'agent.event',
      kind: 'lifecycle',
      text: 'Retrying in 3.0s (attempt 1/3)...',
    }))
    expect(emit).toHaveBeenCalledWith('agent.event', expect.objectContaining({
      event: 'agent.event',
      kind: 'lifecycle',
      text: 'Retrying in 3.0s (attempt 1/3)...',
    }))
  })

  it('captures the Hermes parent history for background callbacks in process memory', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    recordBridgeToolCompletedMock.mockReturnValue({
      id: 'delegate-call',
      messageId: 77,
      output: JSON.stringify({
        mode: 'background',
        delegation_id: 'delegation-1',
        status: 'dispatched',
      }),
    })
    const exactMessages = [
      { role: 'user', content: 'previous' },
      { role: 'user', content: 'start a background task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'delegate-call' }] },
      { role: 'tool', content: 'dispatched', tool_call_id: 'delegate-call' },
      { role: 'assistant', content: 'The background task is running.' },
    ]
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'origin-run', status: 'started' }),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 100, message_count: 2 }),
      streamOutput: vi.fn(async function* () {
        yield {
          run_id: 'origin-run',
          done: true,
          status: 'completed',
          output: 'The background task is running.',
          result: { messages: exactMessages },
          events: [{
            event: 'tool.completed',
            tool_name: 'delegate_task',
            output: JSON.stringify({
              mode: 'background',
              delegation_id: 'delegation-1',
              status: 'dispatched',
            }),
          }],
        }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      { input: 'start a background task', session_id: 'session-1', reasoning_effort: 'high' },
      'default',
      sessionMap,
      bridge,
      false,
      vi.fn(),
      vi.fn(),
    )

    expect(state.backgroundContinuationContexts['delegation-1']).toEqual(expect.objectContaining({
      runtime: 'hermes',
      version: 1,
      delegationId: 'delegation-1',
      sessionId: 'session-1',
      originRunId: 'origin-run',
      model: 'gpt-test',
      provider: 'openai',
      profile: 'default',
      reasoningEffort: 'high',
      messages: exactMessages,
    }))
  })

  it('runs a Hermes background callback from its origin history instead of later messages', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    state.messages.push({
      id: 9,
      session_id: 'session-1',
      role: 'user',
      content: 'later B/C conversation',
      timestamp: 2,
    })
    const callbackContext = {
      runtime: 'hermes' as const,
      version: 1 as const,
      delegationId: 'delegation-1',
      sessionId: 'session-1',
      originRunId: 'origin-run',
      messages: [
        { role: 'user', content: 'original A request' },
        { role: 'assistant', content: 'I started the background task.' },
      ],
      model: 'origin-model',
      provider: 'origin-provider',
      profile: 'default',
      instructions: 'origin system instructions',
      workspace: null,
      reasoningEffort: 'high',
    }
    state.backgroundContinuationContexts = { 'delegation-1': callbackContext }
    resolveBridgeRunModelConfigMock.mockResolvedValueOnce({ model: 'origin-model', provider: 'origin-provider' })
    const bridge = {
      chat: vi.fn().mockResolvedValue({ run_id: 'callback-run', status: 'started' }),
      completeBackgroundNotification: vi.fn().mockResolvedValue(undefined),
      contextEstimate: vi.fn().mockResolvedValue({ token_count: 100, message_count: 2 }),
      streamOutput: vi.fn(async function* () {
        yield { run_id: 'callback-run', done: true, status: 'completed', output: 'callback answer' }
      }),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: 'Background subtask result: finished',
        display_input: null,
        session_id: 'session-1',
        background_delegation_id: 'delegation-1',
        background_claim_id: 'claim-1',
        autonomous: true,
      },
      'default',
      sessionMap,
      bridge,
      true,
      vi.fn(),
      vi.fn(),
      callbackContext,
    )

    expect(buildCompressedHistoryMock).not.toHaveBeenCalled()
    expect(bridge.chat).toHaveBeenCalledWith(
      'session-1',
      'Background subtask result: finished',
      callbackContext.messages,
      'origin system instructions',
      'default',
      expect.objectContaining({
        model: 'origin-model',
        provider: 'origin-provider',
        reasoning_effort: 'high',
      }),
    )
    expect(bridge.chat.mock.calls[0][2]).not.toContainEqual(expect.objectContaining({
      content: 'later B/C conversation',
    }))
    expect(state.backgroundContinuationContexts['delegation-1']).toBeUndefined()
  })

  it('rejects a recovered Hermes callback when its process-local origin history is gone', async () => {
    const emit = vi.fn()
    const nsp = makeNamespace(emit)
    const socket = makeSocket()
    const state = makeState()
    const sessionMap = new Map([['session-1', state]])
    const bridge = {
      chat: vi.fn(),
      completeBackgroundNotification: vi.fn().mockResolvedValue(undefined),
    } as any

    const { handleBridgeRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run')
    await handleBridgeRun(
      nsp,
      socket,
      {
        input: 'Background subtask result: finished',
        display_input: null,
        session_id: 'session-1',
        background_delegation_id: 'delegation-after-restart',
        background_claim_id: 'claim-after-restart',
        autonomous: true,
      },
      'default',
      sessionMap,
      bridge,
      true,
      vi.fn(),
      vi.fn(),
    )

    expect(buildCompressedHistoryMock).not.toHaveBeenCalled()
    expect(bridge.chat).not.toHaveBeenCalled()
    expect(bridge.completeBackgroundNotification).toHaveBeenCalledWith(
      'session-1',
      'default',
      'delegation-after-restart',
      'claim-after-restart',
    )
    expect(emit).toHaveBeenCalledWith('run.failed', expect.objectContaining({
      delegation_id: 'delegation-after-restart',
      error: expect.stringContaining('origin context is unavailable'),
    }))
  })
})
