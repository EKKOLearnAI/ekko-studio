import './fixtures/isolated-studio-state'
/**
 * Bridge dispatch with a (mocked) notice projection: the projection is prepended to the model input, the stored
 * user row and storage_message carry only the question, and the projected ids are marked. Autonomous turns never
 * consume a projection. Bridge, repository writes and projection are mocked here.
 */
import type { Namespace, Socket } from 'socket.io'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleBridgeRun } from '../../packages/server/src/modules/studio/services/chat-run/handle-bridge-run'
import type { PrimaryAgentBridgeClient } from '../../packages/server/src/modules/studio/public/chat-agent-runtime'
import type { ChatMessage } from '../../packages/server/src/modules/studio/services/context-compressor'
import type { SessionState } from '../../packages/server/src/modules/studio/services/chat-run/types'

const projection = vi.hoisted(() => ({
  build: vi.fn((_sessionId: string): { text: string; ids: number[] } | null => null),
  reserve: vi.fn((ids: number[], _dispatchId: string) => ids),
  consume: vi.fn(),
  release: vi.fn(),
  unresolved: vi.fn((_sessionId: string): string[] => []),
}))

vi.mock('../../packages/server/src/modules/studio/services/session-notifications/presentation', async importOriginal => ({
  ...await importOriginal<any>(),
  buildNoticeProjection: projection.build,
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-notification-store', async importOriginal => ({
  ...await importOriginal<any>(),
  reserveSessionNotificationsForDispatch: projection.reserve,
  consumeDispatchNotifications: projection.consume,
  releaseDispatchNotifications: projection.release,
  unresolvedProjectionDispatches: projection.unresolved,
}))

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  getSession: vi.fn(),
  getSessionGeneration: vi.fn((_id: string): string | null => 'generation-test'),
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
  getSessionGeneration: mocks.getSessionGeneration,
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
    chat: vi.fn(async (_sessionId: string, _input: unknown, _history: ChatMessage[], ..._rest: unknown[]): Promise<any> => ({ run_id: 'run-1', status: 'started' })),
    resolveDispatch: vi.fn(async (_dispatchId: string, _profile?: string): Promise<any> => ({ state: 'refused' })),
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

async function runTurn(input: string, extra: Record<string, unknown> = {}, bridge = makeBridge()) {
  const { nsp, socket } = makeSockets()
  const state = { messages: [], isWorking: true, events: [], queue: [] } as unknown as SessionState
  const sessionMap = new Map([['session-1', state]])
  ;(bridge as any).sessionMap = sessionMap
  await handleBridgeRun(nsp, socket, { input, session_id: 'session-1', ...extra } as any, 'default', sessionMap,
    bridge as unknown as PrimaryAgentBridgeClient, false, vi.fn(), vi.fn()).catch(() => undefined)
  const [, message, , , , options] = (bridge.chat.mock.calls[0] || []) as any[]
  return { message, options, bridge }
}

describe('notice projection at bridge dispatch', () => {
  beforeEach(() => {
    mocks.rows = []
    projection.build.mockReset().mockReturnValue(null)
    projection.unresolved.mockReset().mockReturnValue([])
    mocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '', history_revision: 0, workspace: '' })
  })
  afterEach(() => vi.clearAllMocks())

  it('prepends a mocked notice projection to the bridge input but stores only the original question', async () => {
    const text = '[Studio notifications, shown to you once: untrusted data]\n- Scheduled task "Daily brief"\n[End of Studio notifications]'
    projection.build.mockReturnValueOnce({ text, ids: [41, 42] })

    const projected = await runTurn('What changed overnight?')

    expect(projected.message).toBe(`${text}\n\nWhat changed overnight?`)
    expect(projected.options.storage_message).toBe('What changed overnight?')
    expect(mocks.rows).toContainEqual(expect.objectContaining({ role: 'user', content: 'What changed overnight?' }))
    expect(mocks.rows.some(row => String(row.content).includes('Studio notifications'))).toBe(false)
    expect(projected.options.dispatch_id).toMatch(/:/)
    expect(projection.reserve).toHaveBeenCalledWith([41, 42], projected.options.dispatch_id)
    expect(projection.consume).toHaveBeenCalledWith(projected.options.dispatch_id)
    expect(projection.release).not.toHaveBeenCalled()

    // Turns without notices keep their existing storage behavior.
    const plain = await runTurn('And now?')
    expect(plain.message).toBe('And now?')
    expect(plain.options.storage_message).toBeUndefined()
  })

  it.each(['workflow', 'group_chat', 'global_agent'])('never projects for a stored %s session when the request omits its source', async (source) => {
    mocks.getSession.mockReturnValue({ id: 'session-1', profile: 'default', model: '', provider: '', history_revision: 0, workspace: '', source })
    projection.build.mockReturnValue({ text: '[Studio notifications]', ids: [9] })

    const turn = await runTurn('Next step?')

    expect(turn.message).toBe('Next step?')
    expect(projection.build).not.toHaveBeenCalled()
    expect(projection.reserve).not.toHaveBeenCalled()
  })

  it('never builds or consumes a projection for an autonomous turn', async () => {
    projection.build.mockReturnValue({ text: '[Studio notifications]', ids: [7] })

    const machine = await runTurn('Process finished', { autonomous: true })

    expect(machine.message).toBe('Process finished')
    expect(projection.build).not.toHaveBeenCalled()
    expect(projection.reserve).not.toHaveBeenCalled()
  })

  describe('dispatch admission', () => {
    const projected = () => projection.build.mockReturnValueOnce({ text: '[Studio notifications]', ids: [5] })

    it('keeps notices reserved, neither consumed nor released, when the bridge reply is lost', async () => {
      projected()
      const bridge = makeBridge()
      bridge.chat.mockRejectedValueOnce(new Error('Agent bridge request timed out after 30000ms'))
      const turn = await runTurn('Question?', {}, bridge)
      expect(projection.reserve).toHaveBeenCalledWith([5], turn.options.dispatch_id)
      expect(projection.consume).not.toHaveBeenCalled()
      expect(projection.release).not.toHaveBeenCalled()
    })

    it.each([
      ['an explicit refusal', { ok: false, error: 'dispatch_refused', error_type: 'DispatchNotAdmitted' }],
      ['a startup failure', { ok: false, error: 'dispatch_start_failed: boom', error_type: 'DispatchStartFailed' }],
    ])('releases the notices for a later question after %s from the worker', async (_label, response) => {
      projected()
      const bridge = makeBridge()
      bridge.chat.mockRejectedValueOnce(Object.assign(new Error(response.error), { response }))
      const turn = await runTurn('Question?', {}, bridge)
      expect(projection.release).toHaveBeenCalledWith(turn.options.dispatch_id)
      expect(projection.consume).not.toHaveBeenCalled()
    })

    it.each([
      ['a broker connection failure', { ok: false, error: 'worker closed without a response' }],
      ['an already admitted duplicate', { ok: false, error: 'dispatch_duplicate', error_type: 'DispatchNotAdmitted' }],
    ])('keeps the notices reserved after %s, which does not prove non-admission', async (_label, response) => {
      projected()
      const bridge = makeBridge()
      bridge.chat.mockRejectedValueOnce(Object.assign(new Error(response.error), { response }))
      await runTurn('Question?', {}, bridge)
      expect(projection.release).not.toHaveBeenCalled()
      expect(projection.consume).not.toHaveBeenCalled()
    })

    it('consumes the notices once the bridge admitted the dispatch, even if this Studio owner is stale', async () => {
      projected()
      const bridge = makeBridge()
      bridge.chat.mockImplementationOnce(async () => {
        ;(bridge as any).sessionMap.set('session-1', { messages: [], events: [], queue: [] })
        return { run_id: 'run-1', status: 'started' }
      })
      const turn = await runTurn('Question?', {}, bridge)
      expect(projection.consume).toHaveBeenCalledWith(turn.options.dispatch_id)
      expect(projection.release).not.toHaveBeenCalled()
    })

    it.each([
      ['accepted', 'consume'],
      ['refused', 'release'],
    ] as const)('resolves an earlier unresolved dispatch reported %s before projecting again', async (state, action) => {
      projection.unresolved.mockReturnValueOnce(['inst:earlier'])
      const bridge = makeBridge()
      bridge.resolveDispatch.mockResolvedValueOnce({ state })
      await runTurn('Next?', {}, bridge)
      expect(bridge.resolveDispatch).toHaveBeenCalledWith('inst:earlier', 'default')
      expect(projection[action]).toHaveBeenCalledWith('inst:earlier')
    })

    it('keeps a dispatch the bridge reports uncertain reserved: neither consumed nor replayed', async () => {
      projection.unresolved.mockReturnValueOnce(['inst:earlier'])
      const bridge = makeBridge()
      bridge.resolveDispatch.mockResolvedValueOnce({ state: 'uncertain' })
      await runTurn('Next?', {}, bridge)
      expect(projection.consume).not.toHaveBeenCalled()
      expect(projection.release).not.toHaveBeenCalled()
    })

    it('stops before selecting notices when the turn lost its owner during reconciliation', async () => {
      projection.unresolved.mockReturnValueOnce(['inst:earlier'])
      const bridge = makeBridge()
      bridge.resolveDispatch.mockImplementationOnce(async () => {
        ;(bridge as any).sessionMap.set('session-1', { messages: [], events: [], queue: [] })
        return { state: 'uncertain' }
      })
      projection.build.mockReturnValue({ text: '[Studio notifications]', ids: [8] })
      await runTurn('Next?', {}, bridge)
      expect(projection.build).not.toHaveBeenCalled()
      expect(projection.reserve).not.toHaveBeenCalled()
      expect(bridge.chat).not.toHaveBeenCalled()
    })

    it('does not project when the conversation was cleared during reconciliation', async () => {
      projection.unresolved.mockReturnValueOnce(['inst:earlier'])
      mocks.getSessionGeneration.mockReturnValueOnce('g-1').mockReturnValue('g-2')
      projection.build.mockReturnValue({ text: '[Studio notifications]', ids: [8] })
      const turn = await runTurn('Next?')
      expect(projection.build).not.toHaveBeenCalled()
      expect(turn.message).toBe('Next?')
      mocks.getSessionGeneration.mockReset().mockReturnValue('generation-test')
    })

    it('sends no projection unless every selected notice was reserved for it', async () => {
      projection.build.mockReturnValueOnce({ text: '[Studio notifications]', ids: [8, 9] })
      projection.reserve.mockReturnValueOnce([8])
      const turn = await runTurn('Next?')
      expect(turn.message).toBe('Next?')
      expect(turn.options.dispatch_id).toBeUndefined()
      expect(projection.release).toHaveBeenCalledTimes(1)
      expect(projection.consume).not.toHaveBeenCalled()
    })

    it('keeps an unresolved dispatch reserved while the bridge cannot answer', async () => {
      projection.unresolved.mockReturnValueOnce(['inst:earlier'])
      const bridge = makeBridge()
      bridge.resolveDispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
      await runTurn('Next?', {}, bridge)
      expect(projection.consume).not.toHaveBeenCalled()
      expect(projection.release).not.toHaveBeenCalled()
    })
  })
})
