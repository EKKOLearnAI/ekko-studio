/**
 * Automatic turns (plugin notices, background callbacks, goal continuations)
 * store their input as a hidden user row. The bridge history of that turn cuts
 * only that row, so the previous human turn stays, and later turns see the
 * stored history alternate user/assistant.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun, resumeBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
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
  HIDDEN_DISPLAY_ROLE: 'hidden',
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

function makeBridge(events: Record<string, unknown>[] = [], terminal: Record<string, unknown> = { status: 'completed', output: 'ok' }) {
  return {
    chat: vi.fn(async (_sessionId: string, _input: unknown, _history: ChatMessage[]) => ({ run_id: 'run-1', status: 'started' })),
    contextEstimate: vi.fn(async () => ({ token_count: 10, fixed_context_tokens: 5, message_count: 0, tool_count: 0, system_prompt_chars: 1 })),
    compressionRespond: vi.fn(async (_requestId: string, _body: { messages?: ChatMessage[] }) => undefined),
    streamOutput: vi.fn(async function* () {
      if (events.length) yield { run_id: 'run-1', done: false, status: 'running', events }
      yield { run_id: 'run-1', done: true, ...terminal }
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

async function runTurn(data: Parameters<typeof handleBridgeRun>[2], skipUserMessage: boolean, bridge: object) {
  const { nsp, socket } = makeSockets()
  const state: SessionState = { messages: [], isWorking: false, events: [], queue: [] }
  await handleBridgeRun(
    nsp,
    socket,
    { session_id: 'session-1', ...data },
    'default',
    new Map([['session-1', state]]),
    bridge as unknown as PrimaryAgentBridgeClient,
    skipUserMessage,
    vi.fn(),
    vi.fn(),
  )
}

describe('handle-bridge-run input of automatic turns', () => {
  beforeEach(() => {
    mocks.rows = [...PREVIOUS_TURN]
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('stores a plugin notice as a hidden user row and keeps the stored history alternating', async () => {
    const onEvent = vi.fn()
    const bridge = makeBridge()
    await runTurn({ ...NOTICE_RUN, onEvent }, true, bridge)

    expect(bridge.chat.mock.calls[0][1]).toBe(NOTICE)
    expect(roles(bridge.chat.mock.calls[0][2])).toEqual(PREVIOUS_TURN_HISTORY)
    expect(mocks.rows.slice(PREVIOUS_TURN.length)).toEqual([
      expect.objectContaining({ role: 'user', content: NOTICE, display_role: 'hidden' }),
    ])
    expect(onEvent.mock.calls.map(call => call[0])).not.toContain('message.created')

    // The bridge stores the notice reply (bridge-message persistence is mocked here).
    mocks.rows.push({ id: mocks.rows.length + 1, session_id: 'session-1', role: 'assistant', content: 'Noted.' })
    const next = makeBridge()
    await runTurn({ input: 'What changed?' }, false, next)

    // Alternates: no assistant follows the previous turn's last assistant directly.
    expect(roles(next.chat.mock.calls[0][2])).toEqual([...PREVIOUS_TURN_HISTORY, ['user', NOTICE], ['assistant', 'Noted.']])
  })

  it('still drops the persisted current input of a human turn', async () => {
    const bridge = makeBridge()
    await runTurn({ input: 'What changed?' }, false, bridge)

    expect(roles(bridge.chat.mock.calls[0][2])).toEqual(PREVIOUS_TURN_HISTORY)
  })

  it('does not store the input of a background callback that cannot run without its origin context', async () => {
    const bridge = { ...makeBridge(), completeBackgroundNotification: vi.fn(async () => undefined) }
    await runTurn({ ...NOTICE_RUN, background_delegation_id: 'delegation-1', background_claim_id: 'claim-1' }, true, bridge)

    expect(bridge.chat).not.toHaveBeenCalled()
    expect(mocks.rows).toEqual(PREVIOUS_TURN)
  })

  it.each([
    ['a terminal error chunk without text', { status: 'error', error: 'provider unavailable', output: '' }],
    ['result.failed', { status: 'completed', output: '', result: { failed: true, error: 'agent failed' } }],
  ])('does not resend the input of a notice run that ended with %s', async (_label, terminal) => {
    await runTurn(NOTICE_RUN, true, makeBridge([], terminal))

    const next = makeBridge()
    await runTurn({ input: 'What changed?' }, false, next)

    expect(roles(next.chat.mock.calls[0][2])).toEqual(PREVIOUS_TURN_HISTORY)
  })

  it('keeps the previous human turn when the bridge compresses during a notice run', async () => {
    const bridge = makeBridge([{ event: 'bridge.compression.requested', request_id: 'req-1', messages: [] }])
    await runTurn(NOTICE_RUN, true, bridge)

    expect(bridge.compressionRespond).toHaveBeenCalledTimes(1)
    expect(bridge.compressionRespond.mock.calls[0][0]).toBe('req-1')
    expect(roles(bridge.compressionRespond.mock.calls[0][1].messages ?? [])).toEqual(PREVIOUS_TURN_HISTORY)
  })

  it('keeps the previous human turn when a notice run resumed after a restart compresses', async () => {
    await runTurn(NOTICE_RUN, true, makeBridge())

    const compression = { event: 'bridge.compression.requested', request_id: 'req-resume', messages: [] }
    const resumed = {
      getResult: vi.fn(async () => ({ deltas: [], events: [], output: '' })),
      getOutput: vi.fn()
        .mockResolvedValueOnce({ run_id: 'run-1', cursor: 0, event_cursor: 1, delta: '', done: false, status: 'running', events: [compression] })
        .mockResolvedValueOnce({ run_id: 'run-1', cursor: 0, event_cursor: 1, delta: '', done: true, status: 'completed', output: 'ok', events: [] }),
      compressionRespond: vi.fn(async (_requestId: string, _body: { messages?: ChatMessage[] }) => undefined),
    }
    const { nsp, socket } = makeSockets()
    // A restarted server starts with an empty session map.
    await resumeBridgeRun(
      nsp,
      socket,
      { sessionId: 'session-1', runId: 'run-1', profile: 'default', instructions: 'system prompt' },
      new Map(),
      resumed as unknown as PrimaryAgentBridgeClient,
      vi.fn(),
    )

    expect(resumed.compressionRespond).toHaveBeenCalledTimes(1)
    expect(resumed.compressionRespond.mock.calls[0][0]).toBe('req-resume')
    expect(roles(resumed.compressionRespond.mock.calls[0][1].messages ?? [])).toEqual(PREVIOUS_TURN_HISTORY)
  })
})
