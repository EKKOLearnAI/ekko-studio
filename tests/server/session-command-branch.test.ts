import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.fn(() => 99)
const addMessagesMock = vi.fn()
const clearSessionMessagesMock = vi.fn()
const createBranchedSessionMock = vi.fn((row: any) => row)
const createSessionMock = vi.fn()
const getSessionMock = vi.fn()
const getSessionDetailMock = vi.fn()
const renameSessionMock = vi.fn()
const updateSessionMock = vi.fn()
const updateSessionStatsMock = vi.fn()
const getOrCreateSessionMock = vi.fn((sessionMap: Map<string, any>, sessionId: string) => {
  if (!sessionMap.has(sessionId)) {
    sessionMap.set(sessionId, { messages: [], isWorking: false, events: [], queue: [] })
  }
  return sessionMap.get(sessionId)
})

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  HIDDEN_DISPLAY_ROLE: 'hidden',
  addMessage: addMessageMock,
  addMessages: addMessagesMock,
  clearSessionMessages: clearSessionMessagesMock,
  createBranchedSession: createBranchedSessionMock,
  createSession: createSessionMock,
  getSession: getSessionMock,
  getSessionDetail: getSessionDetailMock,
  renameSession: renameSessionMock,
  updateSession: updateSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/compression', () => ({
  buildDbHistory: vi.fn(),
  estimateSnapshotAwareHistoryUsage: vi.fn(),
  forceCompressBridgeHistory: vi.fn(),
  getOrCreateSession: getOrCreateSessionMock,
  replaceState: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/usage', () => ({
  calcAndUpdateUsage: vi.fn(async () => ({ inputTokens: 0, outputTokens: 0 })),
  contextTokensWithCachedOverhead: vi.fn((_state: any, tokens: number) => tokens),
  updateMessageContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/abort', () => ({
  handleAbort: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/bridge-message', () => ({
  flushBridgePendingToDb: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function makeSocketHarness() {
  const namespaceEmit = vi.fn()
  const socketEmit = vi.fn()
  const nsp = {
    to: vi.fn(() => ({ emit: namespaceEmit })),
    adapter: { rooms: new Map([['session:session-1', new Set(['socket-1'])]]) },
  }
  const socket = {
    id: 'socket-1',
    join: vi.fn(),
    emit: socketEmit,
    connected: true,
  }
  return { nsp, socket, namespaceEmit, socketEmit }
}

function makeParentSession(overrides: Record<string, any> = {}) {
  return {
    id: 'session-1',
    profile: 'default',
    source: 'cli',
    agent: 'hermes',
    agent_mode: '',
    agent_session_id: '',
    agent_native_session_id: '',
    model: 'openai/gpt-5.4',
    provider: 'openai-codex',
    api_mode: 'chat_completions',
    title: 'Parent chat',
    preview: 'Parent prompt',
    workspace: '/repo',
    ...overrides,
  }
}

function makeCtx(sessionMap: Map<string, any>, nsp: any, socket: any, bridgeOverrides: Record<string, any> = {}) {
  return {
    nsp,
    socket,
    sessionMap,
    bridge: {
      status: vi.fn(async () => ({ exists: true, running: false, currentRunId: null })),
      ...bridgeOverrides,
    } as any,
    profile: 'default',
    model: 'openai/gpt-5.4',
    provider: 'openai-codex',
    runQueuedItem: vi.fn(),
  }
}

describe('branch session command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createBranchedSessionMock.mockImplementation((row: any) => row)
    createSessionMock.mockImplementation((row: any) => row)
    getSessionMock.mockReturnValue(makeParentSession())
    getSessionDetailMock.mockReturnValue({
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'Root prompt', display_role: null, display_content: null, timestamp: 101, tool_call_id: null, tool_calls: null, tool_name: null, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null },
        { id: 2, session_id: 'session-1', role: 'assistant', content: 'Root answer', display_role: null, display_content: null, timestamp: 102, tool_call_id: null, tool_calls: null, tool_name: null, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null },
      ],
    })
  })

  it('parses /fork as the only user-facing fork command', async () => {
    const { parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')

    expect(parseSessionCommand('/fork')).toMatchObject({ name: 'branch', rawName: 'fork', args: '' })
    expect(parseSessionCommand('/branch alternate path')).toBeNull()
  })

  it('rejects /fork while the bridge session is running', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: true, events: [], queue: [] }],
    ])

    await handleSessionCommand('session-1', parseSessionCommand('/fork side path')!, makeCtx(sessionMap, nsp, socket))

    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(addMessagesMock).not.toHaveBeenCalled()
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'branch',
      ok: false,
      terminal: false,
      message: expect.stringContaining('Cannot branch while the session is running'),
    }))
  })

  it('rejects /fork for coding agent sessions', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: false, events: [], queue: [] }],
    ])
    getSessionMock.mockReturnValue(makeParentSession({ source: 'coding_agent', agent: 'codex' }))

    await handleSessionCommand('session-1', parseSessionCommand('/fork side path')!, makeCtx(sessionMap, nsp, socket))

    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'branch',
      ok: false,
      terminal: true,
      message: expect.stringContaining('Cannot branch coding agent sessions'),
    }))
  })

  it('rejects /fork when there are no visible conversation messages', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: false, events: [], queue: [] }],
    ])
    getSessionDetailMock.mockReturnValueOnce({
      messages: [
        { id: 1, session_id: 'session-1', role: 'command', content: '/status', display_role: null, display_content: null, timestamp: 101, tool_call_id: null, tool_calls: null, tool_name: null, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null },
      ],
    })

    await handleSessionCommand('session-1', parseSessionCommand('/fork empty')!, makeCtx(sessionMap, nsp, socket))

    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({
      action: 'branch',
      ok: false,
      terminal: true,
      message: expect.stringContaining('no conversation messages'),
    }))
  })

  it('auto-titles /fork as branch: original title by default', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: false, events: [], queue: [] }],
    ])

    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(sessionMap, nsp, socket))

    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'branch: Parent chat',
      parent_session_id: 'session-1',
    }))
    const branchEvent = namespaceEmit.mock.calls.find(call => call[0] === 'session.command')?.[1]
    expect(branchEvent).toMatchObject({
      newSessionTitle: 'branch: Parent chat',
      branchSession: expect.objectContaining({ title: 'branch: Parent chat' }),
    })
  })

  it('forks an idle local bridge chat by copying persisted messages into a child session', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: false, events: [], queue: [] }],
    ])

    await handleSessionCommand('session-1', parseSessionCommand('/fork Alternate')!, makeCtx(sessionMap, nsp, socket))

    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(createSessionMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Alternate',
      parent_session_id: 'session-1',
      profile: 'default',
      source: 'cli',
      agent: 'hermes',
      model: 'openai/gpt-5.4',
      provider: 'openai-codex',
      api_mode: 'chat_completions',
      workspace: '/repo',
      ended_at: expect.any(Number),
      last_active: expect.any(Number),
      messages: [
        expect.objectContaining({ role: 'user', content: 'Root prompt' }),
        expect.objectContaining({ role: 'assistant', content: 'Root answer' }),
      ],
    }))
    expect(addMessagesMock).not.toHaveBeenCalled()
    expect(addMessageMock).toHaveBeenCalledTimes(1)
    expect(addMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 'session-1',
      role: 'command',
      content: expect.stringContaining('Branched session "Alternate"'),
    }))
    const branchEvent = namespaceEmit.mock.calls.find(call => call[0] === 'session.command')?.[1]
    expect(branchEvent).toMatchObject({
      action: 'branch',
      ok: true,
      parentSessionId: 'session-1',
      newSessionTitle: 'Alternate',
      newSessionId: expect.stringMatching(/^\d{8}_\d{6}_[0-9a-f]{6}$/),
      branchSession: expect.objectContaining({
        title: 'Alternate',
        parentSessionId: 'session-1',
        forkPointMessageId: null,
        parentTitle: 'Parent chat',
        parentLastMessage: 'Root answer',
        parentLastMessageRole: 'assistant',
        messageCount: 2,
      }),
    })
    expect(sessionMap.has(branchEvent.newSessionId)).toBe(false)
  })

  it('copies the parent real category once when forking', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: false, events: [], queue: [] }],
    ])
    getSessionMock.mockReturnValue(makeParentSession({ category_id: 42 }))

    await handleSessionCommand('session-1', parseSessionCommand('/fork categorized')!, makeCtx(sessionMap, nsp, socket))

    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      parent_session_id: 'session-1',
      category_id: 42,
    }))
  })

  it('preserves api_server source when forking non-bridge chat sessions', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessionMap = new Map<string, any>([
      ['session-1', { messages: [], isWorking: false, events: [], queue: [] }],
    ])
    getSessionMock.mockReturnValue(makeParentSession({ source: 'api_server', agent: 'hermes' }))

    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(sessionMap, nsp, socket))

    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'api_server',
      agent: 'hermes',
      parent_session_id: 'session-1',
    }))
    const branchEvent = namespaceEmit.mock.calls.find(call => call[0] === 'session.command')?.[1]
    expect(branchEvent.branchSession).toEqual(expect.objectContaining({
      source: 'api_server',
      parentSessionId: 'session-1',
      forkPointMessageId: null,
    }))
  })
})
