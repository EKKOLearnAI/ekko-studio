import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn()
const createSessionMock = vi.fn()
const getSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const getModelContextLengthMock = vi.fn(() => 256_000)
const calcAndUpdateUsageMock = vi.fn()
const forceCompressBridgeHistoryMock = vi.fn()

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  clearSessionMessages: vi.fn(),
  createSession: createSessionMock,
  getSession: getSessionMock,
  renameSession: vi.fn(),
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({})),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbSnapshotAwareHistory: vi.fn(async () => []),
  forceCompressBridgeHistory: forceCompressBridgeHistoryMock,
  getOrCreateSession: vi.fn((map, id) => map.get(id) || { messages: [], isWorking: false }),
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  contextTokensWithCachedOverhead: vi.fn(() => 0),
  estimateUsageTokensFromMessages: vi.fn(() => ({ inputTokens: 0, outputTokens: 0 })),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

function makeContext(state: any) {
  const namespaceEmit = vi.fn()
  const nsp = {
    to: vi.fn(() => ({ emit: namespaceEmit })),
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    join: vi.fn(),
    emit: vi.fn(),
  }
  const sessionMap = new Map([['session-1', state]])
  const runQueuedItem = vi.fn()
  const bridge = {
    command: vi.fn(async () => ({ handled: false })),
    status: vi.fn(async () => ({ exists: true, running: false, current_run_id: null, message_count: 0 })),
  }
  return { namespaceEmit, nsp, runQueuedItem, sessionMap, socket, bridge }
}

describe('CLI-style session commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'default', source: 'cli', model: 'test-model', provider: 'openrouter' })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 10, outputTokens: 20 })
  })

  it('parses /compact as the compress alias and /context as a new command', async () => {
    const { parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    expect(parseSessionCommand('/compact')?.name).toBe('compress')
    expect(parseSessionCommand('/compact focus on auth')?.rawName).toBe('compact')
    expect(parseSessionCommand('/context')?.name).toBe('context')
  })

  it('emits context usage for /context', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const { namespaceEmit, nsp, runQueuedItem, sessionMap, socket, bridge } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    await handleSessionCommand('session-1', parseSessionCommand('/context')!, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    const payload = namespaceEmit.mock.calls.find(([event]: [string]) => event === 'session.command')?.[1]
    expect(payload.action).toBe('context')
    expect(payload.message).toContain('total 30 / 256000 tokens')
    expect(payload.contextPercent).toBe(0)
  })

  it('routes /compact to the existing ChatContextCompressor path', async () => {
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    forceCompressBridgeHistoryMock.mockResolvedValue({
      beforeMessages: 10,
      resultMessages: 3,
      beforeTokens: 20_000,
      afterTokens: 2_000,
      compressed: true,
    })
    const { namespaceEmit, nsp, runQueuedItem, sessionMap, socket, bridge } = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    await handleSessionCommand('session-1', parseSessionCommand('/compact')!, {
      nsp: nsp as any,
      socket: socket as any,
      sessionMap,
      bridge: bridge as any,
      profile: 'default',
      runQueuedItem,
    })

    const payload = namespaceEmit.mock.calls.find(([event]: [string]) => event === 'session.command')?.[1]
    expect(payload.action).toBe('compress')
    expect(forceCompressBridgeHistoryMock).toHaveBeenCalled()
  })

  it.each([false, true])('holds history against deletion during manual compression and releases it after failure=%s', async fail => {
    const state = { messages: [], isWorking: false, isCompressing: false, events: [], queue: [] }
    let finish!: () => void
    forceCompressBridgeHistoryMock.mockImplementationOnce(() => new Promise((resolve, reject) => {
      finish = () => fail ? reject(new Error('provider failed')) : resolve({
        beforeMessages: 10, resultMessages: 3, beforeTokens: 1000, afterTokens: 400, compressed: true,
      })
    }))
    const context = makeContext(state)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const pending = handleSessionCommand('session-1', parseSessionCommand('/compact')!, { ...context, profile: 'default' } as any)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(state.isCompressing).toBe(true)
    finish()
    await pending
    expect(state.isCompressing).toBe(false)
  })
})
