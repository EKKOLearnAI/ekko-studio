/**
 * Agent Bridge runs: Studio owns compression. A pre-run "context window too small" error must
 * settle the run, and the debug force-compress request keeps working below the threshold.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import { readConfigYamlForProfile } from '../../packages/server/src/modules/studio/public/profile-config'
import { estimateUsageTokensFromMessages } from '../../packages/server/src/modules/studio/services/chat-run/usage'
import type { PrimaryAgentBridgeClient } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import type { HermesMessageRow } from '../../packages/server/src/modules/studio/repositories/session-store'
import type { ChatMessage } from '../../packages/server/src/modules/studio/services/context-compressor'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const mocks = vi.hoisted(() => ({
  rows: [] as Partial<HermesMessageRow>[],
  compress: vi.fn(async (history: unknown[]) => ({
    messages: history,
    meta: { compressed: false, llmCompressed: false, verbatimCount: history.length, compressedStartIndex: -1 },
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: vi.fn(() => ({ id: 'session-1', profile: 'default', model: '', provider: '', history_revision: 0 })),
  getSessionContextMessages: vi.fn(() => mocks.rows),
  getSessionContextMessage: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  getSessionMessageCountByRole: vi.fn(() => 0),
  createSession: vi.fn(),
  addMessage: vi.fn((row: Partial<HermesMessageRow>) => {
    const id = mocks.rows.length + 1
    mocks.rows.push({ ...row, id })
    return id
  }),
  updateSession: vi.fn(),
  updateSessionStats: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/compression-snapshot', () => ({
  getCompressionSnapshot: vi.fn(() => null),
  deleteCompressionSnapshot: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/context-compressor', () => ({
  SUMMARY_PREFIX: '[Previous context summary]',
  ChatContextCompressor: class {
    compress = mocks.compress
  },
}))

vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({
  updateUsage: vi.fn(),
  getUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  bridgeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: vi.fn(() => 256_000),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 1, outputTokens: 1 })),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 1, outputTokens: 1 })),
  getCachedBridgeContextOverhead: vi.fn(() => undefined),
  contextTokensWithCachedOverhead: vi.fn((_state: unknown, tokens: number) => tokens),
  updateContextTokenUsage: vi.fn(),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
  ensureOpenBridgeAssistantMessage: vi.fn(),
  syncBridgeReasoningToMessage: vi.fn(),
  recordBridgeToolStarted: vi.fn(),
  recordBridgeToolCompleted: vi.fn(),
  recordBridgeMoaDisplayTool: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-config', () => ({
  resolveBridgeRunModelConfig: vi.fn(async () => ({ model: 'gpt-test', provider: 'openai' })),
}))

vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({
  resolveAuthorizedProviderRuntimeCredentials: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => ({
  startWorkspaceRunCheckpoint: vi.fn(),
  completeWorkspaceRunCheckpoint: vi.fn(() => null),
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-compression/${profile || 'default'}`,
  saveEnvValueForProfile: vi.fn(),
  readConfigYamlForProfile: vi.fn(async () => ({ compression: { enabled: false } })),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  issueModelRunJwt: vi.fn(async () => 'model-run-token'),
}))

const PREVIOUS_TURN: Partial<HermesMessageRow>[] = [
  { id: 1, session_id: 'session-1', role: 'user', content: 'Approved, deploy it.' },
  {
    id: 2,
    session_id: 'session-1',
    role: 'assistant',
    content: 'Deploying.',
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'terminal', arguments: '{}' } }],
  },
  { id: 3, session_id: 'session-1', role: 'tool', content: 'deployed', tool_call_id: 'call-1', tool_name: 'terminal' },
  { id: 4, session_id: 'session-1', role: 'assistant', content: 'Deployed.' },
]
const PREVIOUS_TURN_HISTORY = [
  ['user', 'Approved, deploy it.'],
  ['assistant', 'Deploying.'],
  ['tool', 'deployed'],
  ['assistant', 'Deployed.'],
]

function makeBridge(events: Record<string, unknown>[] = []) {
  return {
    chat: vi.fn(async (_sessionId: string, _input: unknown, _history: ChatMessage[]) => ({ run_id: 'run-1', status: 'started' })),
    contextEstimate: vi.fn(async () => ({ token_count: 10, fixed_context_tokens: 5, message_count: 0, tool_count: 0, system_prompt_chars: 1 })),
    compressionRespond: vi.fn(async (_requestId: string, _body: { messages?: ChatMessage[] }) => undefined),
    streamOutput: vi.fn(async function* () {
      if (events.length) yield { run_id: 'run-1', done: false, status: 'running', events }
      yield { run_id: 'run-1', done: true, status: 'completed', output: 'ok' }
    }),
  }
}

function makeSockets() {
  const emitter = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = { adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) }, to: vi.fn(() => emitter) }
  const socket = { connected: true, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => emitter), data: {} }
  // Test doubles implement only the socket.io members these run paths touch.
  return { nsp: nsp as unknown as Namespace, socket: socket as unknown as Socket }
}

describe('handle-bridge-run compression', () => {
  beforeEach(() => {
    mocks.rows = [...PREVIOUS_TURN]
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('settles the run and continues the queue when the context window is too small before the run starts', async () => {
    const { nsp, socket } = makeSockets()
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [{ queue_id: 'q-1', input: 'retry' }] as SessionState['queue'] }
    const sessionMap = new Map([['session-1', state]])
    const dequeue = vi.fn()
    const bridge = makeBridge()
    const onEvent = vi.fn()
    // Compression on, and 4 history rows estimated over the 128k trigger: too short to compress.
    vi.mocked(readConfigYamlForProfile).mockImplementation(async () => ({}))
    vi.mocked(estimateUsageTokensFromMessages).mockReturnValue({ inputTokens: 200_000, outputTokens: 0 })
    try {
      await handleBridgeRun(nsp, socket, { session_id: 'session-1', input: 'too big', onEvent }, 'default', sessionMap,
        bridge as unknown as PrimaryAgentBridgeClient, false, vi.fn(), dequeue)
    } finally {
      vi.mocked(readConfigYamlForProfile).mockImplementation(async () => ({ compression: { enabled: false } }))
      vi.mocked(estimateUsageTokensFromMessages).mockReturnValue({ inputTokens: 1, outputTokens: 1 })
    }

    expect(bridge.chat).not.toHaveBeenCalled()
    expect(state).toMatchObject({ isWorking: false, activeRunMarker: undefined, runId: undefined })
    expect(onEvent.mock.calls.filter(([event]) => event === 'run.failed')).toEqual([
      ['run.failed', expect.objectContaining({ error: expect.stringContaining('Context window is too small') })],
    ])
    expect(dequeue).toHaveBeenCalledWith(socket, 'session-1')

    // The dequeued retry runs on the now idle session.
    const retry = makeBridge()
    await handleBridgeRun(nsp, socket, { session_id: 'session-1', input: 'retry' }, 'default', sessionMap,
      retry as unknown as PrimaryAgentBridgeClient, false, vi.fn(), dequeue)
    expect(retry.chat).toHaveBeenCalledTimes(1)
  })

  it('keeps debug force-compress requests below threshold working', async () => {
    // Stub of the compressor contract: an over-budget call with nothing to fold reports a too-small context.
    mocks.compress.mockImplementationOnce(async (history: unknown[], ...args: unknown[]) => {
      if ((args[3] as { overBudget?: boolean } | undefined)?.overBudget) {
        throw Object.assign(new Error('Context window is too small'), { name: 'ContextWindowTooSmallError' })
      }
      return { messages: history, meta: { compressed: false, llmCompressed: false, verbatimCount: history.length, compressedStartIndex: -1 } }
    })
    const bridge = makeBridge([{ event: 'bridge.compression.requested', request_id: 'req-debug', focus_topic: 'debug_force_compress', approx_tokens: 100, messages: [] }])
    const { nsp, socket } = makeSockets()
    const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
    await handleBridgeRun(nsp, socket, { session_id: 'session-1', input: 'debug compress' }, 'default',
      new Map([['session-1', state]]), bridge as unknown as PrimaryAgentBridgeClient, false, vi.fn(), vi.fn())

    expect(bridge.compressionRespond).toHaveBeenCalledTimes(1)
    expect(bridge.compressionRespond.mock.calls[0][1]).not.toHaveProperty('error')
    expect((bridge.compressionRespond.mock.calls[0][1].messages ?? []).map(m => [m.role, m.content])).toEqual(PREVIOUS_TURN_HISTORY)
  })
})
