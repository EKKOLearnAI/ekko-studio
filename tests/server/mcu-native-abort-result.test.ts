import { beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ has: vi.fn(), stop: vi.fn(), background: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))
vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({ chatCodingAgentRunManager: { hasSession: fixture.has, stop: fixture.stop }, hasChatEkkoBackgroundTasks: fixture.background, abortChatEkkoBackgroundTasks: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: () => null, updateSession: vi.fn(), updateSessionStats: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({ calcAndUpdateUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/terminal-usage', () => ({ finalizeAbortedRunUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({ flushBridgePendingToDb: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/response-stream', () => ({ flushResponseRunToDb: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({ replaceState: vi.fn() }))
import { handleAbort } from '../../packages/server/src/modules/studio/services/chat-run/abort'
function context(source = 'global_agent') {
  const state = { source, isWorking: true, isAborting: false, runId: 'owned-run', activeRunMarker: 'owned-marker', queue: [], messages: [], events: [], profile: 'default', abortController: new AbortController() }
  const nsp = { to: () => ({ emit: vi.fn() }), adapter: { rooms: new Map() } }
  const socket = { connected: true, emit: vi.fn() }
  const bridge = { interrupt: vi.fn(), goalPause: vi.fn(), destroy: vi.fn() }
  const run = () => handleAbort(nsp as any, socket as any, 'owned-session', new Map([['owned-session', state]]), bridge, vi.fn())
  return { state, bridge, run }
}
beforeEach(() => { vi.resetAllMocks(); fixture.has.mockReturnValue(false); fixture.background.mockReturnValue(false) })
it('returns a nonconfirmation for a real bridge timeout even though legacy local state is released', async () => {
  const f = context(); f.bridge.interrupt.mockResolvedValue({ synced: false })
  expect(await f.run()).toEqual({ runId: 'owned-run', dispatched: true, runtime: 'bridge', synced: false })
  expect(f.state.isWorking).toBe(false)
})
it('does not turn a thrown bridge interrupt or a missing sync field into confirmed termination', async () => {
  for (const response of ['throw', 'missing']) {
    const f = context()
    if (response === 'throw') f.bridge.interrupt.mockRejectedValue(new Error('fixture unavailable'))
    else f.bridge.interrupt.mockResolvedValue({ status: 'interrupted' })
    expect(await f.run()).toMatchObject({ dispatched: true, runtime: 'bridge', synced: false })
  }
})
it('exposes explicit bridge sync and distinguishes native dispatch from the process-exit proof', async () => {
  const bridge = context(); bridge.bridge.interrupt.mockResolvedValue({ synced: true })
  expect(await bridge.run()).toMatchObject({ runtime: 'bridge', synced: true })
  fixture.has.mockReturnValue(true)
  const native = context('coding_agent')
  expect(await native.run()).toMatchObject({ dispatched: true, runtime: 'native' })
  expect(fixture.stop).toHaveBeenCalledWith('owned-session', { reportClosed: false })
})
