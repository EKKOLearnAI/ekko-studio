/**
 * repair-release@1 R2: a terminal machine event re-checks its owner at the final run seam.
 *
 * Ownership (generation, profile, Stop, deletion) can change during any awaited preparation step.
 * The machine fence must hold immediately before the stored machine turn and immediately before
 * bridge.chat, not only before the first await.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import type { PrimaryAgentBridgeClient } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import type { ChatMessage } from '../../packages/server/src/modules/studio/services/context-compressor'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  getSession: vi.fn(),
  updateSession: vi.fn(),
  compress: vi.fn(async (history: unknown[]) => ({
    messages: history,
    meta: { compressed: false, llmCompressed: false, verbatimCount: history.length, compressedStartIndex: -1 },
  })),
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: vi.fn(() => 'system prompt'),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: mocks.getSession,
  getSessionGeneration: vi.fn(() => 'generation-test'),
  getSessionContextMessages: vi.fn(() => mocks.rows),
  getSessionContextMessage: vi.fn(),
  getFirstSessionMessageByRole: vi.fn(),
  getSessionMessageCountByRole: vi.fn(() => 0),
  createSession: vi.fn(),
  addMessage: vi.fn((row: Record<string, unknown>) => {
    const id = mocks.rows.length + 1
    mocks.rows.push({ ...row, id })
    return id
  }),
  updateSession: mocks.updateSession,
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
  getProfileDir: (profile: string) => `/tmp/hermes-bridge-machine-fence/${profile || 'default'}`,
  saveEnvValueForProfile: vi.fn(),
  readConfigYamlForProfile: vi.fn(async () => ({ compression: { enabled: false } })),
}))

vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({
  issueModelRunJwt: vi.fn(async () => 'model-run-token'),
}))

function makeBridge() {
  return {
    chat: vi.fn(async (_sessionId: string, _input: unknown, _history: ChatMessage[]) => ({ run_id: 'run-1', status: 'started' })),
    contextEstimate: vi.fn(async () => ({ token_count: 10, fixed_context_tokens: 5, message_count: 0, tool_count: 0, system_prompt_chars: 1 })),
    compressionRespond: vi.fn(async () => undefined),
    streamOutput: vi.fn(async function* () {
      yield { run_id: 'run-1', done: true, status: 'completed', output: 'ok' }
    }),
  }
}

function makeSockets() {
  const emitter = { emit: vi.fn(), except: vi.fn(() => ({ emit: vi.fn() })) }
  const nsp = { adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) }, to: vi.fn(() => emitter) }
  const socket = { connected: true, emit: vi.fn(), join: vi.fn(), to: vi.fn(() => emitter), data: {} }
  // Test doubles implement only the socket.io members these run paths touch.
  return { nsp: nsp as unknown as Namespace, socket: socket as unknown as Socket, emitter }
}


async function run(fence: () => string | null, hooks: { model?: () => void; history?: () => void } = {}) {
  const bridge = makeBridge()
  // History building awaits the profile config after the machine turn is stored and before bridge.chat;
  // ownership changes during that await (only once a stored row exists).
  let changedAfterStore = false
  if (hooks.history) {
    const { readConfigYamlForProfile } = await import('../../packages/server/src/modules/studio/public/profile-config') as any
    readConfigYamlForProfile.mockImplementation(async () => {
      if (mocks.rows.length && !changedAfterStore) { changedAfterStore = true; hooks.history!() }
      return { compression: { enabled: false } }
    })
  }
  const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/modules/studio/services/chat-run/model-config') as any
  if (hooks.model) resolveBridgeRunModelConfig.mockImplementationOnce(async () => { hooks.model!(); return { model: 'gpt-test', provider: 'openai' } })
  const { nsp, socket } = makeSockets()
  const state: SessionState = { messages: [], isWorking: true, events: [], queue: [] }
  const onEvent = vi.fn()
  const dispatched = vi.fn()
  const discarded = vi.fn()
  await handleBridgeRun(
    nsp,
    socket,
    {
      session_id: 'session-1', input: '[IMPORTANT: Background process proc_1 completed normally (exit code 0).]',
      display_role: 'system', autonomous: true, onEvent,
      machine_fence: fence, on_machine_dispatch: dispatched, on_machine_discard: discarded,
    } as any,
    'default',
    new Map([['session-1', state]]),
    bridge as unknown as PrimaryAgentBridgeClient,
    false,
    vi.fn(),
    vi.fn(),
  )
  return { bridge, onEvent, dispatched, discarded, rows: mocks.rows, changedAfterStore }
}

describe('machine event final dispatch fence', () => {
  beforeEach(() => {
    mocks.rows = []
    mocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '', history_revision: 0, workspace: '' })
  })
  afterEach(() => vi.clearAllMocks())

  it('positive control: a current owner dispatches once with current history', async () => {
    const { bridge, dispatched, discarded, rows } = await run(() => null)
    expect(bridge.chat).toHaveBeenCalledTimes(1)
    expect(dispatched).toHaveBeenCalledTimes(1)
    expect(discarded).not.toHaveBeenCalled()
    expect(rows.filter(row => row.display_role === 'system')).toHaveLength(1)
  })

  it('owner reset during preparation before the machine turn is stored: nothing stored, no dispatch', async () => {
    let owner: string | null = null
    const { bridge, dispatched, discarded, rows } = await run(() => owner, { model: () => { owner = 'owner_reset' } })
    expect(bridge.chat).not.toHaveBeenCalled()
    expect(dispatched).not.toHaveBeenCalled()
    expect(discarded).toHaveBeenCalledWith('owner_reset')
    expect(rows).toEqual([])
  })

  it('Stop or delete after the machine turn is stored but before bridge.chat: no dispatch', async () => {
    for (const reason of ['owner_stopped', 'owner_missing']) {
      mocks.rows = []
      let owner: string | null = null
      const { bridge, dispatched, discarded, rows, changedAfterStore } = await run(() => owner, { history: () => { owner = reason } })
      expect(changedAfterStore).toBe(true)
      expect(rows.filter(row => row.display_role === 'system')).toHaveLength(1)
      expect(bridge.chat).not.toHaveBeenCalled()
      expect(dispatched).not.toHaveBeenCalled()
      expect(discarded).toHaveBeenCalledWith(reason)
    }
  })
})
