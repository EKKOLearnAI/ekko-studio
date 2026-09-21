import { beforeEach, describe, expect, it, vi } from 'vitest'

const managerMock = vi.hoisted(() => ({
  runIdForSession: vi.fn(),
  isSessionLaunchCompatible: vi.fn(),
  isSessionProcessing: vi.fn(),
  stop: vi.fn(),
}))
const startCodingAgentRunMock = vi.hoisted(() => vi.fn())
const sendCodingAgentRunInputMock = vi.hoisted(() => vi.fn())
const writeModelRunProfileTokenMock = vi.hoisted(() => vi.fn(async () => undefined))
const getSystemPromptMock = vi.hoisted(() => vi.fn(() => 'system prompt'))
const getSessionMock = vi.hoisted(() => vi.fn())
const updateSessionMock = vi.hoisted(() => vi.fn())
const handleCodingAgentSessionCommandMock = vi.hoisted(() => vi.fn(async () => undefined))
const parseCodingAgentSessionCommandMock = vi.hoisted(() => vi.fn())
const resolveAuthorizedProviderRuntimeCredentialsMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/modules/coding-agents/services/runtime/run-manager', () => ({
  codingAgentRunManager: managerMock,
}))

vi.mock('../../packages/server/src/bootstrap/coding-agents', () => ({
  startCodingAgentRun: startCodingAgentRunMock,
  sendCodingAgentRunInput: sendCodingAgentRunInputMock,
}))

vi.mock('../../packages/server/src/modules/studio/services/chat-run/model-run-prompt', () => ({
  writeModelRunProfileToken: writeModelRunProfileTokenMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/runs/prompt', () => ({
  getSystemPrompt: getSystemPromptMock,
  studioMcpUsageGuidelines: vi.fn(() => ''),
}))

vi.mock('../../packages/server/src/modules/studio/repositories/session-store', () => ({
  getSession: getSessionMock,
  updateSession: updateSessionMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../packages/server/src/modules/studio/public/authorized-provider-runtime', () => ({
  resolveAuthorizedProviderRuntimeCredentials: resolveAuthorizedProviderRuntimeCredentialsMock,
}))

vi.mock('../../packages/server/src/modules/coding-agents/services/session-command', () => ({
  handleCodingAgentSessionCommand: handleCodingAgentSessionCommandMock,
  parseCodingAgentSessionCommand: parseCodingAgentSessionCommandMock,
}))

vi.mock('../../packages/server/src/modules/studio/public/chat-agent-runtime', () => ({
  getChatCodingAgentMcpServers: vi.fn(() => ({ 'ekko-studio-interaction': { command: 'studio' }, 'ekko-studio-use': { command: 'studio' } })),
  resolveChatEkkoMcpServers: vi.fn(() => ({ 'ekko-studio-use': { command: 'studio' } })),
  chatCodingAgentRunManager: managerMock,
  startChatCodingAgentRun: startCodingAgentRunMock,
  sendChatCodingAgentRunInput: sendCodingAgentRunInputMock,
  handleChatCodingAgentSessionCommand: handleCodingAgentSessionCommandMock,
  parseChatCodingAgentSessionCommand: parseCodingAgentSessionCommandMock,
}))

describe('handleCodingAgentRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getSessionMock.mockReturnValue(null)
    managerMock.isSessionProcessing.mockReturnValue(false)
    writeModelRunProfileTokenMock.mockResolvedValue(undefined)
    getSystemPromptMock.mockReturnValue('system prompt')
    parseCodingAgentSessionCommandMock.mockReturnValue(null)
    resolveAuthorizedProviderRuntimeCredentialsMock.mockResolvedValue({
      apiKey: 'studio-claude-oauth-access-token',
    })
  })

  it('runs global Claude Code without requiring Studio OAuth credentials', async () => {
    resolveAuthorizedProviderRuntimeCredentialsMock.mockRejectedValue(new Error('Studio OAuth is not configured'))
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'hello claude',
      coding_agent_id: 'claude-code',
      mode: 'global',
    }, 'default', sessionMap as any)

    expect(resolveAuthorizedProviderRuntimeCredentialsMock).not.toHaveBeenCalled()
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      'session-1',
      'hello claude',
      'system prompt',
    )
  })

  it('sends a fresh task context on each turn while storing the original user message', async () => {
    managerMock.runIdForSession.mockReturnValue('reused-runtime')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'reused-runtime' })
    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = { messages: [], isWorking: false, events: [], queue: [] }
    const sessions = new Map([['session-1', state]])
    const socket = { join: vi.fn(), emit: vi.fn() }
    for (const context of ['first-turn', 'second-turn']) {
      await handleCodingAgentRun({} as any, socket as any, {
        session_id: 'session-1', coding_agent_id: 'codex', mode: 'global', input: 'Show a task card', task_plan_context_id: context, interaction_context_id: context,
      }, 'default', sessions as any)
    }
    const calls = sendCodingAgentRunInputMock.mock.calls
    expect(calls[0][1]).toContain('context_id="first-turn"')
    expect(calls[1][1]).toContain('context_id="second-turn"')
    expect(calls[1][1]).not.toContain('first-turn')
    for (const args of calls) {
      expect(args[1]).toContain('ekko_studio_clarify')
      expect(args[1]).toContain('<studio_interaction_context>')
      expect(args[2]).not.toContain('context_id=')
      expect(args[4]).toBe('Show a task card')
    }
  })

  it('restarts an existing coding-agent runner when the requested launch mode changes', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(false)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-2' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-2' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'use global codex',
      coding_agent_id: 'codex',
      mode: 'global',
      push_enabled: true,
    }, 'default', sessionMap as any)

    expect(managerMock.isSessionLaunchCompatible).toHaveBeenCalledWith('session-1', {
      agentId: 'codex',
      mode: 'global',
      provider: undefined,
      model: undefined,
    })
    expect(managerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      mode: 'global',
      profile: 'default',
    }), state)
    expect(startCodingAgentRunMock.mock.calls[0][1]).not.toHaveProperty('groupRuntimeScope')
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'use global codex', 'system prompt')
    expect(updateSessionMock).toHaveBeenCalledWith('session-1', { push_enabled: 1 })
  })

  it('restarts an existing scoped runner when the stored session model changed even if the socket payload omits it', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(false)
    getSessionMock.mockReturnValue({
      id: 'session-1',
      source: 'coding_agent',
      agent: 'codex',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-2' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-2' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue with new model',
      coding_agent_id: 'codex',
      mode: 'scoped',
    }, 'default', sessionMap as any)

    expect(managerMock.isSessionLaunchCompatible).toHaveBeenCalledWith('session-1', {
      agentId: 'codex',
      mode: 'scoped',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })
    expect(managerMock.stop).toHaveBeenCalledWith('session-1', { reportClosed: false })
    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      mode: 'scoped',
      profile: 'default',
    }), state)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'continue with new model', 'system prompt')
  })

  it('passes global session source through to the coding-agent runner', async () => {
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'hello codex',
      coding_agent_id: 'codex',
      session_source: 'global_agent',
    }, 'default', sessionMap as any)

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'session-1',
      sessionSource: 'global_agent',
    }), state)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'hello codex', 'system prompt')
  })

  it.each([
    ['claude-code', 'claude'],
    ['pi', 'pi'],
  ] as const)('passes the Hermes system prompt on every scoped %s run', async (codingAgentId, inputName) => {
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: `hello ${inputName}`,
      coding_agent_id: codingAgentId,
    }, 'default', sessionMap as any)

    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', `hello ${inputName}`, 'system prompt')
  })

  it('uses the group-chat system prompt for a group coding-agent run only', async () => {
    managerMock.runIdForSession.mockReturnValue(undefined)
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    startCodingAgentRunMock.mockResolvedValue({ agentSessionId: 'agent-session-1' })
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['group-session-1', state]])
    const socket = {
      data: {},
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'group-session-1',
      input: 'reply in the room',
      coding_agent_id: 'codex',
      source: 'workflow',
      session_source: 'workflow',
      group_system_prompt: 'dynamic group system prompt',
      group_room_id: 'room-1',
      group_agent_id: 'room-agent-codex',
    }, 'default', sessionMap as any)

    expect(startCodingAgentRunMock).toHaveBeenCalledWith('codex', expect.objectContaining({
      sessionId: 'group-session-1',
      groupSystemPrompt: 'dynamic group system prompt',
      groupRuntimeScope: {
        roomId: 'room-1',
        agentId: 'room-agent-codex',
      },
    }), state)
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      'group-session-1',
      'reply in the room',
      'dynamic group system prompt',
    )
    expect(getSystemPromptMock).not.toHaveBeenCalled()
  })

  it('reopens an ended coding-agent session before sending a new input', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })
    getSessionMock.mockReturnValue({
      id: 'session-1',
      source: 'coding_agent',
      agent: 'codex',
      ended_at: 123,
      end_reason: 'complete',
    })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'codex',
    }, 'default', sessionMap as any)

    expect(updateSessionMock).toHaveBeenCalledWith('session-1', expect.objectContaining({
      ended_at: null,
      end_reason: null,
      last_active: expect.any(Number),
    }))
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'continue', 'system prompt')
  })

  it('marks a reopened coding-agent session as errored when input send fails before processing starts', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    managerMock.isSessionProcessing.mockReturnValue(false)
    sendCodingAgentRunInputMock.mockRejectedValue(new Error('send failed'))

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await expect(handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'codex',
    }, 'default', sessionMap as any)).rejects.toThrow('send failed')

    expect(updateSessionMock.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({
        ended_at: null,
        end_reason: null,
        last_active: expect.any(Number),
      }),
      expect.objectContaining({
        ended_at: expect.any(Number),
        end_reason: 'error',
      }),
    ])
    expect(state.isWorking).toBe(false)
  })

  it('keeps profile token handling separate from the system prompt for authenticated users', async () => {
    managerMock.runIdForSession.mockReturnValue('agent-session-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'agent-session-1' })
    writeModelRunProfileTokenMock.mockResolvedValue(undefined)
    getSystemPromptMock.mockReturnValue([
      'system prompt',
      'Ekko Studio MCP usage: call ekko_studio_api_openapi_get before calling unfamiliar Web UI endpoints.',
      'Use ekko_studio_api_request with method, relative path, and JSON body/query fields.',
    ].join('\n'))

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      data: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'hello codex',
      coding_agent_id: 'codex',
    }, 'default', sessionMap as any)

    expect(writeModelRunProfileTokenMock).toHaveBeenCalledWith(
      { id: 1, username: 'admin', role: 'super_admin' },
      'default',
    )
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith(
      'session-1',
      'hello codex',
      expect.stringContaining('system prompt\nEkko Studio MCP usage'),
    )
    const prompt = sendCodingAgentRunInputMock.mock.calls.at(-1)?.[2]
    expect(prompt).toContain('ekko_studio_api_request')
    expect(prompt).not.toContain('run-token')
    expect(prompt).not.toContain('[Current Hermes profile:')
    expect(prompt).not.toContain('Current Hermes Web UI model run token')
    expect(prompt).not.toContain('Hermes Web UI LAN device capabilities are MCP tools')
    expect(prompt).not.toContain('list_mcp_resources')
    expect(prompt).not.toContain('mcp__hermes-studio__')
  })

  it('routes CLI-style coding agent commands before sending input to the CLI', async () => {
    parseCodingAgentSessionCommandMock.mockReturnValue({
      name: 'compact',
      rawName: 'compact',
      args: '',
    })
    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = {
      messages: [],
      isWorking: false,
      isAborting: false,
      events: [],
      queue: [],
    }
    const sessionMap = new Map([['session-1', state]])
    const socket = {
      join: vi.fn(),
      emit: vi.fn(),
    }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: '/compact',
      coding_agent_id: 'claude-code',
    }, 'default', sessionMap as any)

    expect(handleCodingAgentSessionCommandMock).toHaveBeenCalled()
    expect(sendCodingAgentRunInputMock).not.toHaveBeenCalled()
    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
  })

  it('drops task and clarification instructions after disabling MCP on a reused session', async () => {
    const { getChatCodingAgentMcpServers } = await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    managerMock.runIdForSession.mockReturnValue('reused-runtime')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    const sessions = new Map([['session-1', { messages: [], events: [], queue: [], isWorking: false }]])
    const socket = { join: vi.fn(), emit: vi.fn() }
    for (const enabled of [true, false]) {
      vi.mocked(getChatCodingAgentMcpServers).mockReturnValueOnce({ 'ekko-studio-interaction': { enabled } })
      await handleCodingAgentRun({} as any, socket as any, {
        session_id: 'session-1', coding_agent_id: 'codex', input: 'Do work',
        task_plan_context_id: 'plan-context', interaction_context_id: 'clarify-context',
      }, 'research', sessions as any)
    }
    expect(sendCodingAgentRunInputMock.mock.calls[0][1]).toContain('ekko_studio_update_plan')
    expect(sendCodingAgentRunInputMock.mock.calls[1][1]).toBe('Do work')
    expect(getSystemPromptMock).toHaveBeenLastCalledWith(undefined, expect.objectContaining({
      mcpCapabilities: expect.objectContaining({ interaction: false }),
    }))
    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
  })

  it('keeps an active Cursor run when a follow-up still sends scoped', async () => {
    managerMock.runIdForSession.mockReturnValue('cursor-run-1')
    managerMock.isSessionLaunchCompatible.mockReturnValue(true)
    sendCodingAgentRunInputMock.mockResolvedValue({ runId: 'cursor-run-1' })

    const { handleCodingAgentRun } = await import('../../packages/server/src/modules/studio/services/chat-run/handle-coding-agent-run')
    const state = { messages: [], isWorking: false, isAborting: false, events: [], queue: [] }
    const sessionMap = new Map([['session-1', state]])
    const socket = { join: vi.fn(), emit: vi.fn() }

    await handleCodingAgentRun({} as any, socket as any, {
      session_id: 'session-1',
      input: 'continue',
      coding_agent_id: 'cursor',
      mode: 'scoped',
    }, 'default', sessionMap as any)

    expect(managerMock.isSessionLaunchCompatible).toHaveBeenCalledWith('session-1', expect.objectContaining({
      agentId: 'cursor',
      mode: 'global',
    }))
    expect(managerMock.stop).not.toHaveBeenCalled()
    expect(startCodingAgentRunMock).not.toHaveBeenCalled()
    expect(sendCodingAgentRunInputMock).toHaveBeenCalledWith('session-1', 'continue', 'system prompt')
  })

})
