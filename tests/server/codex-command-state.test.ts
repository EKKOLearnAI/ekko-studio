import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ compact: vi.fn(), stored: vi.fn(), addMessage: vi.fn(() => 1), getRunInfo: vi.fn(), stop: vi.fn(), recovery: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/sessions', () => ({ addMessage: mocks.addMessage, getSession: () => ({ agent: 'codex' }), updateSessionStats: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({ getModelContextLength: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/run-state', () => ({ calcAndUpdateUsage: vi.fn(), getOrCreateSession: (map: Map<string, unknown>, id: string) => map.get(id) }))
vi.mock('../../packages/server/src/modules/studio/public/usage', () => ({ getUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({ codingAgentRunManager: mocks }))
vi.mock('../../packages/server/src/modules/coding-agents/services/index', () => ({ compactStoredCodingAgentSession: mocks.stored, startCodingAgentRun: vi.fn() }))
vi.mock('../../packages/server/src/modules/coding-agents/services/context-recovery', () => ({ isContextWindowExceededError: (err: Error) => err.message === 'context window exceeded', resetNativeSessionAfterContextOverflow: mocks.recovery, nativeContextRecoveryMessage: () => 'Native thread reset.' }))
import { handleCodingAgentSessionCommand } from '../../packages/server/src/modules/coding-agents/services/session-command'
beforeEach(() => { vi.clearAllMocks(); mocks.getRunInfo.mockReturnValue(undefined) })
function setup(working = false) {
  const emit = vi.fn(), onEvent = vi.fn(), state: any = { isWorking: working, messages: [], queue: [] }
  const nsp: any = { to: () => ({ emit }), adapter: { rooms: new Map([['session:test', new Set(['socket'])]]) } }
  const socket: any = { join: vi.fn(), connected: true, emit: vi.fn() }
  return { state, emit, onEvent, run: () => handleCodingAgentSessionCommand(nsp, socket, { session_id: 'test', onEvent }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map([['test', state]])) }
}
it('persists and forwards native completion, then leaves the session idle', async () => {
  let done!: (value: unknown) => void
  mocks.compact.mockImplementation(() => new Promise(resolve => { done = resolve }))
  const test = setup(), pending = test.run()
  expect(test.state.isWorking).toBe(true)
  done({ compacted: true }); await pending
  expect(test.state.isWorking).toBe(false)
  expect(mocks.addMessage).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'command', content: 'Compaction completed.' }))
  expect(test.onEvent).toHaveBeenLastCalledWith('session.command', expect.objectContaining({ terminal: true, ok: true }))
})
it('persists failures and clears the command working state', async () => {
  mocks.compact.mockRejectedValue(new Error('provider unavailable'))
  const test = setup(); await test.run()
  expect(test.state.isWorking).toBe(false)
  expect(test.onEvent).toHaveBeenLastCalledWith('session.command', expect.objectContaining({ terminal: true, ok: false }))
  expect(test.state.messages.at(-1).content).toContain('provider unavailable')
})
it('rejects concurrent compaction without clearing an active turn', async () => {
  const test = setup(true); await test.run()
  expect(mocks.compact).not.toHaveBeenCalled(); expect(test.state.isWorking).toBe(true)
  expect(test.onEvent).toHaveBeenLastCalledWith('session.command', expect.objectContaining({ terminal: false, ok: false }))
})
it('supports compaction of a stored session when no runtime is loaded', async () => {
  mocks.compact.mockImplementation(() => { throw new Error('Coding agent session not found') }); mocks.stored.mockResolvedValue({ compacted: true })
  const test = setup(); await test.run()
  expect(mocks.stored).toHaveBeenCalledWith('test', 'default', { signal: expect.any(AbortSignal) }); expect(test.state.isWorking).toBe(false)
})

it('passes cancellation to the compactor and cleans up its abort controller', async () => {
  mocks.compact.mockImplementation((_id, _args, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Codex compaction interrupted')))))
  const test = setup(), pending = test.run()
  test.state.abortController.abort(); await pending
  expect(test.state.isWorking).toBe(false); expect(test.state.abortController).toBeUndefined()
  expect(test.onEvent).toHaveBeenLastCalledWith('session.command', expect.objectContaining({ ok: false, terminal: true }))
})

it('does not let a stopped compactor clear or finish the next queued turn', async () => {
  mocks.compact.mockImplementation((_id, _args, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('interrupted')))))
  const test = setup(), pending = test.run(), oldController = test.state.abortController
  oldController.abort()
  const nextController = new AbortController(); test.state.abortController = nextController; test.state.isWorking = true
  await pending
  expect(test.state.isWorking).toBe(true); expect(test.state.abortController).toBe(nextController)
  expect(test.onEvent).toHaveBeenCalledTimes(1)
})

it('ignores late context overflow after stop instead of resetting the next turn', async () => {
  let fail!: (error: Error) => void
  mocks.compact.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
  const test = setup(), pending = test.run()
  const nextController = new AbortController()
  test.state.abortController = nextController
  test.state.isWorking = true
  fail(new Error('context window exceeded'))
  await pending
  expect(test.state.isWorking).toBe(true)
  expect(test.state.abortController).toBe(nextController)
  expect(test.onEvent).toHaveBeenCalledTimes(1)
})

it('still publishes the current command terminal when recovering its own context overflow', async () => {
  mocks.recovery.mockReturnValue({ reset: true })
  mocks.compact.mockRejectedValue(new Error('context window exceeded'))
  const test = setup()
  await test.run()
  expect(mocks.recovery).toHaveBeenCalledOnce()
  expect(test.state.isWorking).toBe(false)
  expect(test.state.abortController).toBeUndefined()
  expect(test.onEvent).toHaveBeenLastCalledWith('session.command', expect.objectContaining({ terminal: true, resetNativeThread: true }))
})
