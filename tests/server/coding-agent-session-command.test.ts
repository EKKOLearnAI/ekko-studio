import { beforeEach, describe, expect, it, vi } from 'vitest'

const addMessageMock = vi.hoisted(() => vi.fn(() => 1))
const getSessionMock = vi.hoisted(() => vi.fn())
const updateSessionStatsMock = vi.hoisted(() => vi.fn())
const getOrCreateSessionMock = vi.hoisted(() => vi.fn(() => ({ messages: [], isWorking: false })))
const calcAndUpdateUsageMock = vi.hoisted(() => vi.fn())
const getModelContextLengthMock = vi.hoisted(() => vi.fn(() => 256_000))
const compactMock = vi.hoisted(() => vi.fn())
const getRunInfoMock = vi.hoisted(() => vi.fn())
const getPiSessionStatsMock = vi.hoisted(() => vi.fn())
const getPiSessionStateMock = vi.hoisted(() => vi.fn())
const stopMock = vi.hoisted(() => vi.fn(() => true))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn(async () => ({ agentSessionId: 'agent-session-1' })))
const compactStoredCodingAgentSessionMock = vi.hoisted(() => vi.fn())
const isContextWindowExceededErrorMock = vi.hoisted(() => vi.fn(() => false))
const resetNativeSessionAfterContextOverflowMock = vi.hoisted(() => vi.fn())
const nativeContextRecoveryMessageMock = vi.hoisted(() => vi.fn((agent: string) => `${agent} recovered`))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  addMessage: addMessageMock,
  getSession: getSessionMock,
  updateSessionStats: updateSessionStatsMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/run-state', () => ({
  getOrCreateSession: getOrCreateSessionMock,
  calcAndUpdateUsage: calcAndUpdateUsageMock,
  updateContextTokenUsage: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/public/provider-runtime', () => ({
  getModelContextLength: getModelContextLengthMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: {
    compact: compactMock,
    getRunInfo: getRunInfoMock,
    getPiSessionStats: getPiSessionStatsMock,
    getPiSessionState: getPiSessionStateMock,
    stop: stopMock,
  },
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/context-recovery', () => ({
  isContextWindowExceededError: isContextWindowExceededErrorMock,
  resetNativeSessionAfterContextOverflow: resetNativeSessionAfterContextOverflowMock,
  nativeContextRecoveryMessage: nativeContextRecoveryMessageMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/index', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  compactStoredCodingAgentSession: compactStoredCodingAgentSessionMock,
}))

function makeSocket() {
  const emitted: Array<{ event: string; payload: any }> = []
  return {
    emitted,
    socket: {
      id: 'socket-1',
      connected: true,
      join: vi.fn(),
      emit: (event: string, payload: any) => emitted.push({ event, payload }),
    },
    nsp: {
      adapter: { rooms: new Map() },
      to: () => ({
        emit: () => {},
      }),
    } as any,
  }
}

describe('coding agent session commands', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    addMessageMock.mockReturnValue(1)
    getOrCreateSessionMock.mockReturnValue({ messages: [], isWorking: false })
    calcAndUpdateUsageMock.mockResolvedValue({ inputTokens: 10, outputTokens: 20 })
    getModelContextLengthMock.mockReturnValue(256_000)
  })

  it('parses CLI-style coding agent commands', async () => {
    const { parseCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    expect(parseCodingAgentSessionCommand('/compact')?.name).toBe('compact')
    expect(parseCodingAgentSessionCommand('/compact focus on auth')?.args).toBe('focus on auth')
    expect(parseCodingAgentSessionCommand('/context')?.name).toBe('context')
    expect(parseCodingAgentSessionCommand('/usage')?.name).toBe('usage')
    expect(parseCodingAgentSessionCommand('/status')?.name).toBe('status')
    expect(parseCodingAgentSessionCommand('/model gpt-5')).toBeNull()
    expect(parseCodingAgentSessionCommand('hello')).toBeNull()
  })

  it('emits context usage for coding agent sessions', async () => {
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
      model: 'test-model',
      provider: 'openrouter',
    }, { name: 'context', rawName: 'context', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command.action).toBe('context')
    expect(command.message).toContain('total 30 / 256000 tokens')
    expect(command.contextPercent).toBe(0)
  })

  it('uses native Pi RPC stats for context and usage', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'pi', model: 'pi-model', provider: 'pi-provider' })
    getRunInfoMock.mockReturnValue({ exists: true, agentId: 'pi' })
    getPiSessionStatsMock.mockResolvedValue({
      sessionId: 'pi-session-1',
      userMessages: 3,
      assistantMessages: 3,
      toolCalls: 2,
      toolResults: 2,
      totalMessages: 8,
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155 },
      cost: 0.25,
      contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
    })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')

    const contextSocket = makeSocket()
    await handleCodingAgentSessionCommand(contextSocket.nsp, contextSocket.socket as any, {
      session_id: 'session-1',
    }, { name: 'context', rawName: 'context', args: '' }, 'default', new Map())
    const context = contextSocket.emitted.find(item => item.event === 'session.command')?.payload
    expect(context).toMatchObject({
      action: 'context',
      contextTokens: 40_000,
      contextWindow: 200_000,
      contextPercent: 20,
      source: 'pi',
    })

    const usageSocket = makeSocket()
    await handleCodingAgentSessionCommand(usageSocket.nsp, usageSocket.socket as any, {
      session_id: 'session-1',
    }, { name: 'usage', rawName: 'usage', args: '' }, 'default', new Map())
    const usage = usageSocket.emitted.find(item => item.event === 'session.command')?.payload
    expect(usage).toMatchObject({
      action: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      totalTokens: 155,
      source: 'pi',
    })
    expect(calcAndUpdateUsageMock).not.toHaveBeenCalled()
  })

  it('emits native compact completion for Codex', async () => {
    compactMock.mockResolvedValue({ compacted: true, beforeTokens: 500, afterTokens: 200 })
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'codex' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    const commands = emitted.filter(item => item.event === 'session.command').map(item => item.payload)
    const command = commands.at(-1)
    expect(commands[0].message).toContain('Native /compact sent to Codex.')
    expect(command.action).toBe('compact')
    expect(command.compacted).toBe(true)
    expect(command.message).toContain('Before: 500 tokens')
    expect(command.message).toContain('After: 200 tokens')
  })

  it.each([false, true])('does not launch manual OpenCode compaction when running=%s', async running => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'opencode' })
    getRunInfoMock.mockReturnValue(running ? { agentId: 'opencode', running: true } : null)
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, { session_id: 'session-1' },
      { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())
    expect(compactMock).not.toHaveBeenCalled()
    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
    expect(compactStoredCodingAgentSessionMock).not.toHaveBeenCalled()
    const commands = emitted.filter(item => item.event === 'session.command')
    expect(commands).toHaveLength(1)
    expect(commands[0].payload).toMatchObject({ ok: false, terminal: !running, compacted: false,
      message: expect.stringContaining('managed by OpenCode internally') })
    expect(commands[0].payload.started).toBeUndefined()
  })

  it('detaches an oversized Codex native thread when native compact cannot fit', async () => {
    const overflow = new Error('context_length_exceeded: input exceeds the context window')
    compactMock.mockRejectedValue(overflow)
    isContextWindowExceededErrorMock.mockReturnValue(true)
    resetNativeSessionAfterContextOverflowMock.mockReturnValue({
      reset: true,
      previousNativeSessionId: 'thread-1',
    })
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'codex' })
    const state = { messages: [], isWorking: false, runId: 'run-1', activeRunMarker: 'marker-1' }
    getOrCreateSessionMock.mockReturnValue(state)
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()

    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    expect(isContextWindowExceededErrorMock).toHaveBeenCalledWith(overflow)
    expect(resetNativeSessionAfterContextOverflowMock).toHaveBeenCalledWith('session-1', 'codex')
    expect(stopMock).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(state.runId).toBeUndefined()
    expect(state.activeRunMarker).toBeUndefined()
    const command = emitted.filter(item => item.event === 'session.command').at(-1)?.payload
    expect(command).toMatchObject({
      ok: true,
      action: 'compact',
      terminal: true,
      compacted: false,
      resetNativeThread: true,
    })
    expect(nativeContextRecoveryMessageMock).toHaveBeenCalledWith('Codex')
    expect(command.message).toBe('Codex recovered')
  })

  it('recovers an oversized Pi native session after compact RPC failure', async () => {
    const overflow = new Error('413 Payload Too Large')
    compactMock.mockRejectedValue(overflow)
    isContextWindowExceededErrorMock.mockReturnValue(true)
    resetNativeSessionAfterContextOverflowMock.mockReturnValue({ reset: true, previousNativeSessionId: 'pi-1' })
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'pi', agent_native_session_id: 'pi-1' })
    getRunInfoMock.mockReturnValue({ exists: true, agentId: 'pi' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()

    await handleCodingAgentSessionCommand(nsp, socket as any, { session_id: 'session-1' }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    expect(resetNativeSessionAfterContextOverflowMock).toHaveBeenCalledWith('session-1', 'pi')
    expect(stopMock).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(nativeContextRecoveryMessageMock).toHaveBeenCalledWith('Pi')
    expect(emitted.filter(item => item.event === 'session.command').at(-1)?.payload).toMatchObject({
      ok: true, resetNativeThread: true, compacted: false, message: 'Pi recovered',
    })
  })

  it('reports native compact failure without compressing Studio transcript', async () => {
    compactMock.mockRejectedValue(new Error('native compact unsupported'))
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'codex' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    const commands = emitted.filter(item => item.event === 'session.command').map(item => item.payload)
    const command = commands.at(-1)
    expect(command.action).toBe('compact')
    expect(command.ok).toBe(false)
    expect(command.compacted).toBe(false)
    expect(command.message).toBe('Compaction failed: native compact unsupported')
  })

  it('compacts Pi through its native RPC session and labels it correctly', async () => {
    compactMock.mockResolvedValue({ compacted: true, beforeTokens: 500 })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      agent: 'pi',
      agent_mode: 'global',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'pi-session-1',
      workspace: '/tmp/work',
    })
    getRunInfoMock.mockReturnValue(null)
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: 'focus on code changes' }, 'default', new Map())

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('pi', expect.objectContaining({
      sessionId: 'session-1',
      mode: 'global',
      agentNativeSessionId: 'pi-session-1',
    }), expect.any(Object))
    expect(compactMock).toHaveBeenCalledWith('session-1', 'focus on code changes')
    expect(stopMock).toHaveBeenCalledWith('session-1', { reportClosed: false })
    const commands = emitted.filter(item => item.event === 'session.command').map(item => item.payload)
    expect(commands[0].message).toContain('Native /compact sent to Pi.')
    expect(commands.at(-1)).toMatchObject({ action: 'compact', compacted: true })
  })

  it('rejects busy coding-agent compaction without running the Studio fallback', async () => {
    compactMock.mockRejectedValue(new Error('Coding agent is still processing the previous input'))
    getSessionMock.mockReturnValue({ id: 'session-1', agent: 'codex' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    const command = emitted.filter(item => item.event === 'session.command').at(-1)?.payload
    expect(command.ok).toBe(false)
    expect(command.message).toContain('still processing')
  })

  it('compacts a finished Codex session without rebuilding a run', async () => {
    compactMock
      .mockRejectedValueOnce(new Error('Coding agent session not found'))
      .mockResolvedValueOnce({ compacted: true, beforeTokens: 100, afterTokens: 50 })
    compactStoredCodingAgentSessionMock.mockResolvedValue({ compacted: true, beforeTokens: 100, afterTokens: 50 })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      agent: 'codex',
      agent_mode: 'scoped',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'thread-1',
      workspace: '/tmp/work',
    })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: '' }, 'default', new Map())

    expect(compactStoredCodingAgentSessionMock).toHaveBeenCalledWith('session-1', 'default')
    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
    const commands = emitted.filter(item => item.event === 'session.command').map(item => item.payload)
    const command = commands.at(-1)
    expect(commands[0].message).toContain('Native /compact sent to Codex.')
    expect(command.action).toBe('compact')
    expect(command.compacted).toBe(true)
    expect(command.message).toContain('Before: 100 tokens')
    expect(command.message).toContain('After: 50 tokens')
  })

  it('restarts a finished Claude Code session and forwards compact arguments', async () => {
    compactMock
      .mockRejectedValueOnce(new Error('Coding agent session not found'))
      .mockResolvedValueOnce({ started: true })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      agent: 'claude',
      agent_mode: 'scoped',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'native-1',
      workspace: '/tmp/work',
    })
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: 'focus on auth' }, 'default', new Map())

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('claude-code', expect.objectContaining({
      sessionId: 'session-1',
      agentNativeSessionId: 'native-1',
    }), expect.anything())
    expect(compactMock).toHaveBeenLastCalledWith('session-1', 'focus on auth')
    const commands = emitted.filter(item => item.event === 'session.command').map(item => item.payload)
    expect(commands[0].message).toContain('Native /compact sent to Claude Code.')
  })

  it('rejects compact arguments for a finished Codex session', async () => {
    compactMock.mockRejectedValue(new Error('Coding agent session not found'))
    getSessionMock.mockReturnValue({
      id: 'session-1',
      agent: 'codex',
      agent_mode: 'scoped',
      agent_session_id: 'agent-session-1',
      agent_native_session_id: 'thread-1',
      workspace: '/tmp/work',
    })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'compact', rawName: 'compact', args: 'focus on auth' }, 'default', new Map())

    expect(compactStoredCodingAgentSessionMock).not.toHaveBeenCalled()
    const command = emitted.filter(item => item.event === 'session.command').at(-1)?.payload
    expect(command.ok).toBe(false)
    expect(command.message).toContain('does not accept arguments')
  })

  it('emits coding agent status from the run manager', async () => {
    getRunInfoMock.mockReturnValue({
      exists: true,
      running: false,
      agentId: 'codex',
      model: 'test-model',
      provider: 'openrouter',
      workspaceDir: '/tmp/work',
      nativeSessionId: 'thread-1',
      messageCount: 4,
    })
    getSessionMock.mockReturnValue({ agent: 'codex', model: 'test-model', provider: 'openrouter' })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'status', rawName: 'status', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command.action).toBe('status')
    expect(command.nativeSessionId).toBe('thread-1')
    expect(command.message).toContain('agent: codex')
  })

  it('uses native Pi RPC state for status', async () => {
    getSessionMock.mockReturnValue({ agent: 'pi', model: 'pi-model', provider: 'pi-provider' })
    getRunInfoMock.mockReturnValue({ exists: true, agentId: 'pi', model: 'pi-model', provider: 'pi-provider' })
    getPiSessionStateMock.mockResolvedValue({
      model: { id: 'pi-model', provider: 'pi-provider' },
      thinkingLevel: 'high',
      isStreaming: false,
      isCompacting: false,
      sessionId: 'pi-session-1',
      autoCompactionEnabled: true,
      messageCount: 12,
      pendingMessageCount: 0,
    })
    const { handleCodingAgentSessionCommand } = await import('../../packages/server/src/modules/coding-agents/services/session-command')
    const { socket, nsp, emitted } = makeSocket()
    await handleCodingAgentSessionCommand(nsp, socket as any, {
      session_id: 'session-1',
    }, { name: 'status', rawName: 'status', args: '' }, 'default', new Map())

    const command = emitted.find(item => item.event === 'session.command')?.payload
    expect(command).toMatchObject({
      action: 'status',
      agent: 'pi',
      nativeSessionId: 'pi-session-1',
      autoCompactionEnabled: true,
      source: 'pi',
    })
    expect(command.message).toContain('auto compact: on')
  })
})
