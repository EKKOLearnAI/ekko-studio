import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
const forkBiliMock = vi.fn()
const compressionOwnerMock = vi.fn()
vi.mock('../../packages/server/src/modules/studio/services/context-manager/runtime', () => ({ forkBiliConversation: forkBiliMock }))
const getOrCreateSessionMock = vi.fn((sessionMap: Map<string, any>, sessionId: string) => {
  if (!sessionMap.has(sessionId)) {
    sessionMap.set(sessionId, { messages: [], isWorking: false, events: [], queue: [] })
  }
  return sessionMap.get(sessionId)
})

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
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
  getSessionCompressionOwner: compressionOwnerMock,
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
    history_revision: 0,
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
    forkBiliMock.mockReset().mockResolvedValue(undefined)
    compressionOwnerMock.mockReset().mockResolvedValue({ manager: 'native', conversationId: 'session-1' })
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
  it('branches builtin Ekko with fresh identities and waits for the bili receipt', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const sessions = new Map<string, any>([['session-1', state]])
    getSessionMock.mockReturnValue(makeParentSession({ source: 'builtin_agent', agent: 'ekko-agent', agent_session_id: 'parent-runtime', agent_native_session_id: 'parent-native' }))
    let receipt!: (value: any) => void
    forkBiliMock.mockReturnValue(new Promise(resolve => { receipt = resolve }))
    const pending = handleSessionCommand('session-1', parseSessionCommand('/fork alternate')!, makeCtx(sessions, nsp, socket))
    await vi.waitFor(() => expect(forkBiliMock).toHaveBeenCalledTimes(1))
    expect(state.isWorking).toBe(true)
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: true, newSessionId: expect.any(String) }))
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(forkBiliMock).toHaveBeenCalledWith(expect.objectContaining({ agent: 'ekko', parentSessionId: 'session-1', messages: expect.arrayContaining([expect.objectContaining({ role: 'user', content: 'Root prompt' })]) }))
    receipt({ ok: true })
    await pending
    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'builtin_agent', agent: 'ekko-agent', agent_session_id: '', agent_native_session_id: '' }))
    expect(state.isWorking).toBe(false)
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: true, branchSession: expect.objectContaining({ agent: 'ekko-agent', source: 'builtin_agent' }) }))
  })

  it('reports public fork failure without claiming the child is usable', async () => {
    forkBiliMock.mockRejectedValue(new Error('fork protocol unavailable'))
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    await handleSessionCommand('session-1', parseSessionCommand('/fork alternate')!, makeCtx(new Map([['session-1', state]]), nsp, socket))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ action: 'branch', ok: false, message: expect.stringContaining('fork protocol unavailable') }))
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: true, newSessionId: expect.any(String) }))
    expect(clearSessionMessagesMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(updateSessionMock).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(false)
  })

  it('branches at an explicit persisted message without copying the later suffix', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const sessions = new Map<string, any>([['session-1', { messages: [], isWorking: false, events: [], queue: [] }]])
    await handleSessionCommand('session-1', parseSessionCommand('/fork --at 1 alternate')!, makeCtx(sessions, nsp, socket))
    expect(forkBiliMock).toHaveBeenCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ id: 1, content: 'Root prompt' })] }))
    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'alternate', copyCompression: false, messages: [expect.objectContaining({ role: 'user', content: 'Root prompt' })] }))
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: true, branchSession: expect.objectContaining({ messageCount: 1 }) }))
  })

  it('rejects an unknown branch message without external or local changes', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    await handleSessionCommand('session-1', parseSessionCommand('/fork --at missing alternate')!, makeCtx(new Map(), nsp, socket))
    expect(forkBiliMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('branch message') }))
  })

  it.each([undefined, { manager: 'native', conversationId: 'stale-session' }])('queries the actual independent Hermes owner instead of cached state %j', async (cachedOwner) => {
    const owner = { manager: 'bili', selectedManager: 'native', independentPlugin: true, conversationId: 'session-1', proxyUrl: 'http://127.0.0.1:8787' }
    compressionOwnerMock.mockResolvedValue(owner)
    forkBiliMock.mockResolvedValue({ ok: true })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket } = makeSocketHarness()
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(new Map([['session-1', { messages: [], isWorking: false, events: [], queue: [], contextOwner: cachedOwner }]]), nsp, socket))
    expect(compressionOwnerMock).toHaveBeenCalledExactlyOnceWith('session-1', 'default', 'hermes')
    expect(forkBiliMock).toHaveBeenCalledWith(expect.objectContaining({ owner }))
    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({ copyCompression: false }))
  })

  it('fails closed when ownership lookup fails', async () => {
    compressionOwnerMock.mockRejectedValue(new Error('ownership unavailable'))
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(new Map(), nsp, socket))
    expect(forkBiliMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('ownership unavailable') }))
  })

  it('fails closed when bridge running status cannot be verified', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(new Map(), nsp, socket, { status: vi.fn().mockRejectedValue(new Error('status unavailable')) }))
    expect(forkBiliMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('status unavailable') }))
  })

  it('rejects a branch point inside an unfinished tool exchange before forking', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    getSessionDetailMock.mockReturnValue({ messages: [
      { id: 1, role: 'user', content: 'Root prompt' },
      { id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{}' } }] },
      { id: 3, role: 'tool', content: 'output', tool_call_id: 'call-1', tool_name: 'read_file' },
    ] })
    await handleSessionCommand('session-1', parseSessionCommand('/fork --at 2')!, makeCtx(new Map(), nsp, socket))
    expect(forkBiliMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('tool') }))
  })

  it('does not release or commit over a newer parent run after a delayed fork', async () => {
    let release!: (value: any) => void
    forkBiliMock.mockReturnValue(new Promise(resolve => { release = resolve }))
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const state: any = { messages: [], isWorking: false, events: [], queue: [] }
    const ctx = makeCtx(new Map([['session-1', state]]), nsp, socket)
    const running = handleSessionCommand('session-1', parseSessionCommand('/fork')!, ctx)
    await vi.waitFor(() => expect(forkBiliMock).toHaveBeenCalled())
    state.activeRunMarker = 'newer-run'
    state.runId = 'newer-run'
    state.queue.push({ queue_id: 'next-run', input: 'next' })
    release({ ok: true })
    await running
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(state.isWorking).toBe(true)
    expect(state.runId).toBe('newer-run')
    expect(state.queue).toHaveLength(1)
    expect(ctx.runQueuedItem).not.toHaveBeenCalled()
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: true, newSessionId: expect.any(String) }))
  })

  it('requires a bili receipt before making a child resumable', async () => {
    compressionOwnerMock.mockResolvedValue({ manager: 'bili', conversationId: 'session-1' })
    forkBiliMock.mockResolvedValue(undefined)
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(new Map(), nsp, socket))
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('receipt') }))
  })

  it('keeps the queue untouched when bridge status is unknown', async () => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket } = makeSocketHarness()
    const queued = { queue_id: 'queued-run', input: 'next' }
    const state: any = { messages: [], isWorking: false, events: [], queue: [queued] }
    const ctx = makeCtx(new Map([['session-1', state]]), nsp, socket, { status: vi.fn().mockRejectedValue(new Error('status unavailable')) })
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, ctx)
    expect(ctx.runQueuedItem).not.toHaveBeenCalled()
    expect(state.queue).toEqual([queued])
    expect(state.isWorking).toBe(false)
  })

  it.each([
    [{ role: 'tool', content: 'orphan', tool_call_id: 'missing' }],
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', name: 'read' }] }, { role: 'tool', content: 'one', tool_call_id: 'call' }, { role: 'tool', content: 'duplicate', tool_call_id: 'call' }],
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', name: 'read' }, { id: 'call', name: 'read' }] }],
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', name: 'read' }] }, { role: 'tool', content: 'wrong tool', tool_call_id: 'call', tool_name: 'write' }],
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'call', name: 'read' }] }, { role: 'assistant', content: 'premature answer' }, { role: 'tool', content: 'late output', tool_call_id: 'call' }],
    [{ role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'call', name: 'read', input: {} }]) }, { role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'call', content: 'one' }, { type: 'tool_result', tool_use_id: 'call', content: 'duplicate' }]) }],
  ])('rejects unpaired tool history %j without side effects', async (...history) => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    getSessionDetailMock.mockReturnValue({ messages: [{ id: 1, role: 'user', content: 'Root prompt' }, ...history.map((message, i) => ({ ...message, id: i + 2 }))] })
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(new Map(), nsp, socket))
    expect(forkBiliMock).not.toHaveBeenCalled()
    expect(createBranchedSessionMock).not.toHaveBeenCalled()
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('tool') }))
  })

  it.each([
    [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', name: 'read' }, { id: 'b', name: 'write' }] }, { role: 'tool', content: 'b output', tool_call_id: 'b', tool_name: 'write' }, { role: 'tool', content: 'a output', tool_call_id: 'a', tool_name: 'read' }],
    [{ role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'a', name: 'read', input: {} }]) }, { role: 'user', content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'a', content: 'output' }]) }],
  ])('copies complete tool exchanges %j at an arbitrary DB point', async (...history) => {
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket } = makeSocketHarness()
    const prefix = [{ id: 1, role: 'user', content: 'Root prompt' }, ...history.map((message, i) => ({ ...message, id: i + 2 }))]
    getSessionDetailMock.mockReturnValue({ messages: [...prefix, { id: 100, role: 'assistant', content: 'later suffix' }] })
    await handleSessionCommand('session-1', parseSessionCommand(`/fork --at ${prefix.length} paired`)!, makeCtx(new Map(), nsp, socket))
    expect(forkBiliMock).toHaveBeenCalledWith(expect.objectContaining({ messages: prefix }))
    expect(createBranchedSessionMock).toHaveBeenCalledWith(expect.objectContaining({ copyCompression: false, title: 'paired', messages: prefix.map(message => expect.objectContaining({ role: message.role, content: message.content })) }))
  })

  it('preserves active children and reports local failure after an external receipt', async () => {
    compressionOwnerMock.mockResolvedValue({ manager: 'bili', conversationId: 'session-1' })
    forkBiliMock.mockResolvedValue({ ok: true })
    createBranchedSessionMock.mockImplementation(() => { throw new Error('local transaction failed') })
    const { handleSessionCommand, parseSessionCommand } = await import('../../packages/server/src/modules/studio/services/chat-run/session-command')
    const { nsp, socket, namespaceEmit } = makeSocketHarness()
    const child = { isWorking: true, messages: [], queue: [], runId: 'child-run' }
    const state = { isWorking: false, messages: [], queue: [], events: [] }
    const sessions = new Map([['session-1', state], ['existing-child', child]])
    await handleSessionCommand('session-1', parseSessionCommand('/fork')!, makeCtx(sessions, nsp, socket))
    expect(sessions.get('existing-child')).toBe(child)
    expect(child.isWorking).toBe(true)
    expect(state.isWorking).toBe(false)
    expect(namespaceEmit).toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: false, message: expect.stringContaining('local transaction failed') }))
    expect(namespaceEmit).not.toHaveBeenCalledWith('session.command', expect.objectContaining({ ok: true, newSessionId: expect.any(String) }))
    expect(clearSessionMessagesMock).not.toHaveBeenCalled()
  })
})

describe('branch transaction with real SQLite', () => {
  let db: import('node:sqlite').DatabaseSync
  let store: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
  let failChildRead: boolean

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    failChildRead = false
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
      getDb: () => ({
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => {
          const statement = db.prepare(sql)
          if (sql.includes('SELECT * FROM sessions WHERE id = ?')) return {
            get: (id: string) => {
              if (failChildRead && id === 'child') throw new Error('child hydration failed')
              return statement.get(id)
            },
          }
          return statement
        },
      }),
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    store = await vi.importActual('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'parent', source: 'cli', agent: 'hermes', agent_session_id: 'parent-runtime', agent_native_session_id: 'parent-native' })
    store.addMessage({ session_id: 'parent', role: 'user', content: 'hello' })
  })

  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('never inherits supplied parent runtime or native IDs', () => {
    const child = store.createBranchedSession({ id: 'child', parent_session_id: 'parent', ended_at: 10, last_active: 10,
      agent_session_id: 'parent-runtime', agent_native_session_id: 'parent-native', messages: [{ role: 'user', content: 'hello' }] })
    expect(child).toMatchObject({ agent_session_id: '', agent_native_session_id: '' })
  })

  it('rolls back parent metadata and child rows when reading the child fails', () => {
    const parentBefore = store.getSession('parent')
    failChildRead = true
    expect(() => store.createBranchedSession({ id: 'child', parent_session_id: 'parent', ended_at: 10, last_active: 10,
      messages: [{ role: 'user', content: 'hello' }] })).toThrow('child hydration failed')
    failChildRead = false
    expect(store.getSession('child')).toBeNull()
    expect(store.getSession('parent')).toEqual(parentBefore)
    expect(db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?').get('child')).toEqual({ count: 0 })
  })

  it('rejects an appended parent suffix inside the transaction even without a revision change', () => {
    const messages = store.getSessionDetail('parent')!.messages
    store.addMessage({ session_id: 'parent', role: 'assistant', content: 'new suffix' })
    const parentBefore = store.getSession('parent')
    expect(() => store.createBranchedSession({ id: 'child', parent_session_id: 'parent', ended_at: 10, last_active: 10,
      expectedHistoryRevision: 0, expectedHistoryMessages: messages,
      messages: [{ role: 'user', content: 'hello' }] })).toThrow('Parent history changed')
    expect(store.getSession('child')).toBeNull()
    expect(store.getSession('parent')).toEqual(parentBefore)
  })

  it('rolls back message insertion failures without changing either parent or existing child', () => {
    store.createSession({ id: 'existing-child', source: 'cli' })
    const parentBefore = store.getSession('parent')
    const existingBefore = store.getSession('existing-child')
    db.exec("CREATE TRIGGER reject_branch_message BEFORE INSERT ON messages WHEN NEW.session_id = 'child' BEGIN SELECT RAISE(ABORT, 'injected message failure'); END")
    expect(() => store.createBranchedSession({ id: 'child', parent_session_id: 'parent', ended_at: 10, last_active: 10,
      expectedHistoryRevision: 0, messages: [{ role: 'user', content: 'hello' }] })).toThrow('injected message failure')
    expect(store.getSession('child')).toBeNull()
    expect(store.getSession('parent')).toEqual(parentBefore)
    expect(store.getSession('existing-child')).toEqual(existingBefore)
  })
})
