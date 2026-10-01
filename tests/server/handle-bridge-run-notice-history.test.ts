/**
 * Automatic turns (plugin notices, background callbacks) do not persist their
 * input, so the bridge history must not drop the latest stored user message:
 * that message is the previous human turn, not the current input.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import type { PrimaryAgentBridgeClient } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import type { HermesMessageRow } from '../../packages/server/src/modules/studio/repositories/session-store'
import type { ChatMessage } from '../../packages/server/src/modules/studio/services/context-compressor'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
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
  addMessage: vi.fn(() => 99),
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
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-notice-history/${profile || 'default'}`,
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
const NOTICE = '[plugin-notice:n-1] Build finished.'
const NOTICE_RUN = { input: NOTICE, display_input: null, storage_message: NOTICE, autonomous: true }

function roles(messages: ChatMessage[]) {
  return messages.map(message => [message.role, message.content])
}

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

async function runTurn(data: Parameters<typeof handleBridgeRun>[2], skipUserMessage: boolean, bridge: object) {
  const emitter = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = { adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) }, to: vi.fn(() => emitter) }
  const socket = { connected: true, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => emitter), data: {} }
  const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
  await handleBridgeRun(
    // Test doubles implement only the socket.io and bridge members this run path touches.
    nsp as unknown as Namespace,
    socket as unknown as Socket,
    { session_id: 'session-1', ...data },
    'default',
    new Map([['session-1', state]]),
    bridge as unknown as PrimaryAgentBridgeClient,
    skipUserMessage,
    vi.fn(),
    vi.fn(),
  )
}

describe('handle-bridge-run history for turns without a persisted input', () => {
  beforeEach(() => {
    mocks.rows = [...PREVIOUS_TURN]
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the previous human message and the whole agent turn for a plugin notice', async () => {
    const bridge = makeBridge()
    await runTurn(NOTICE_RUN, true, bridge)

    expect(bridge.chat).toHaveBeenCalledTimes(1)
    expect(bridge.chat.mock.calls[0][1]).toBe(NOTICE)
    expect(roles(bridge.chat.mock.calls[0][2])).toEqual(PREVIOUS_TURN_HISTORY)
  })

  it('still drops the persisted current input of a human turn', async () => {
    mocks.rows = [...PREVIOUS_TURN, { id: 5, session_id: 'session-1', role: 'user', content: 'What changed?' }]
    const bridge = makeBridge()
    await runTurn({ input: 'What changed?' }, false, bridge)

    expect(roles(bridge.chat.mock.calls[0][2])).toEqual(PREVIOUS_TURN_HISTORY)
  })

  it('keeps the previous human turn when the bridge compresses during a notice run', async () => {
    const bridge = makeBridge([{ event: 'bridge.compression.requested', request_id: 'req-1', messages: [] }])
    await runTurn(NOTICE_RUN, true, bridge)

    expect(bridge.compressionRespond).toHaveBeenCalledTimes(1)
    expect(bridge.compressionRespond.mock.calls[0][0]).toBe('req-1')
    expect(roles(bridge.compressionRespond.mock.calls[0][1].messages ?? [])).toEqual(PREVIOUS_TURN_HISTORY)
  })
})
