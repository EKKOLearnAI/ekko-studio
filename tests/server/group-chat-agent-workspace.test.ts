import { beforeEach, describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])

const mockSocket = vi.hoisted(() => ({
  id: 'agent-socket-1',
  connected: true,
  io: { on: vi.fn() },
  on: vi.fn((event: string, handler: (...args: any[]) => void) => {
    if (event === 'connect') queueMicrotask(() => handler())
    return mockSocket
  }),
  emit: vi.fn((event: string, data?: any, ack?: Function) => {
    if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
    return mockSocket
  }),
  disconnect: vi.fn(),
}))

const bridgeMock = vi.hoisted(() => ({
  chat: vi.fn(async (_sessionId: string) => {
    order.push('chat')
    return { ok: true, run_id: 'bridge-run-id', session_id: _sessionId, status: 'running' }
  }),
  streamOutput: vi.fn(async function* (runId: string) {
    yield {
      ok: true,
      run_id: runId,
      session_id: 'session-1',
      status: 'complete',
      delta: 'done',
      cursor: 1,
      output: 'done',
      done: true,
      events: [],
      event_cursor: 0,
    }
  }),
  contextEstimate: vi.fn(),
  interrupt: vi.fn(),
  destroy: vi.fn(),
}))

const trackerMock = vi.hoisted(() => ({
  startWorkspaceRunCheckpoint: vi.fn(() => order.push('checkpoint')),
  completeWorkspaceRunCheckpointDraft: vi.fn(() => null),
  discardWorkspaceRunCheckpoint: vi.fn(),
}))

vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }))
vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({ getToken: vi.fn(async () => 'test-token') }))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  readConfigYamlForProfile: vi.fn(async () => ({ model: { default: 'model-a', provider: 'provider-a' }, mcp_servers: { 'ekko-studio-interaction': { command: 'studio' } } })),
}))
vi.mock('../../packages/server/src/modules/studio/repositories/usage-store', () => ({ updateUsage: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({
  createGroupPrimaryAgentBridge: vi.fn(() => bridgeMock),
  cancelGroupEkkoClarification: vi.fn(() => ({ resolved: false })),
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker', () => trackerMock)

describe('group chat agent workspace bridge runs', () => {
  beforeEach(() => {
    order.length = 0
    vi.clearAllMocks()
    mockSocket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'message' && ack) ack({ id: data?.id || 'msg-id' })
      return mockSocket
    })
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReset()
    trackerMock.completeWorkspaceRunCheckpointDraft.mockReturnValue(null)
    bridgeMock.chat.mockImplementation(async (_sessionId: string) => {
      order.push('chat')
      return { ok: true, run_id: 'bridge-run-id', session_id: _sessionId, status: 'running' }
    })
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'done',
        cursor: 1,
        output: 'done',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })
    bridgeMock.interrupt.mockResolvedValue(undefined)
    bridgeMock.destroy.mockResolvedValue(undefined)
  })

  function workspaceDraft(runId: string, sessionId = 'session-1') {
    return {
      session_id: sessionId,
      run_id: runId,
      workspace: '/tmp/workspace',
      files_changed: 1,
      additions: 1,
      deletions: 0,
      truncated: false,
      files: [{
        path: 'file.txt',
        change_type: 'modified',
        additions: 1,
        deletions: 0,
        size_before: 3,
        size_after: 4,
        patch: '+new',
        binary: false,
        truncated: false,
      }],
    }
  }

  async function workerSessionId(seed = 'seed-1') {
    const { groupBridgeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    return groupBridgeSessionId('room-1', 'default', 'Worker', seed)
  }

  it('keeps the session key freshness suffix when long names force bridge session id truncation', async () => {
    const { groupBridgeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const longAgentName = 'Worker'.repeat(40)

    const first = groupBridgeSessionId('room-1', 'default', longAgentName, 'seed-1')
    const second = groupBridgeSessionId('room-1', 'default', longAgentName, 'seed-2')
    const roomA = `room-${'a'.repeat(130)}`
    const roomB = `room-${'a'.repeat(129)}b`
    const collidingPrefixA = groupBridgeSessionId(roomA, 'default', longAgentName, '0')
    const collidingPrefixB = groupBridgeSessionId(roomB, 'default', longAgentName, '0')

    const nonAsciiA = groupBridgeSessionId('room-1', 'default', '丫鬟', '0')
    const nonAsciiB = groupBridgeSessionId('room-1', 'default', '书童', '0')
    const selectedModelA = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      provider: 'provider-a',
      model: 'model-a',
      reasoningEffort: 'low',
    })
    const selectedModelB = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      provider: 'provider-a',
      model: 'model-b',
      reasoningEffort: 'low',
    })

    expect(first).toHaveLength(120)
    expect(second).toHaveLength(120)
    expect(first).not.toBe(second)
    expect(first).toMatch(/_h_[0-9a-f]{16}$/)
    expect(second).toMatch(/_h_[0-9a-f]{16}$/)
    expect(collidingPrefixA).not.toBe(collidingPrefixB)
    expect(nonAsciiA).not.toBe(nonAsciiB)
    expect(selectedModelA).not.toBe(selectedModelB)

    const hermesSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'hermes',
      provider: 'provider-a',
      model: 'model-a',
    })
    const codexSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'codex',
      provider: 'provider-a',
      model: 'model-a',
    })
    const codexResponsesSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'codex',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: 'codex_responses',
    })
    const codexChatSession = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'codex',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: 'chat_completions',
    })
    const hermesWithIgnoredApiMode = groupBridgeSessionId('room-1', 'default', 'Worker', '0', {
      agent: 'hermes',
      provider: 'provider-a',
      model: 'model-a',
      apiMode: 'anthropic_messages',
    })
    expect(hermesSession).not.toBe(codexSession)
    expect(codexResponsesSession).not.toBe(codexChatSession)
    expect(hermesWithIgnoredApiMode).toBe(hermesSession)
  }, 15_000)

  it.each([
    ['codex', 'codex'],
    ['claude', 'claude-code'],
    ['dsh', 'dsh'],
    ['ekko', 'ekko-agent'],
  ] as const)('keeps %s tool output mention text non-routable', async (agent, codingAgentId) => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('tool.started', {
        tool_call_id: `tool-${agent}`,
        name: 'read_file',
        arguments: { path: '/tmp/source.txt' },
      })
      options.onEvent?.('tool.completed', {
        tool_call_id: `tool-${agent}`,
        name: 'read_file',
        output: 'source fixture: @all and @Reviewer are plain tool output',
      })
      return { ok: true, output: `${agent} answer` }
    })
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: `agent-${agent}`,
      agent,
      agentPreset: agent === 'dsh' ? 'minimal' : undefined,
      profile: 'default',
      name: agent,
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '', maxHistoryTokens: 32000 })),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention(`room-${agent}`, {
      messageId: `message-${agent}`,
      content: `@${agent} inspect the source`,
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    expect(runAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ coding_agent_id: codingAgentId, ...(agent === 'dsh' ? { agent_preset: 'minimal' } : {}) }),
      expect.anything(),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: `room-${agent}`,
        role: 'tool',
        tool_call_id: `tool-${agent}`,
        content: 'source fixture: @all and @Reviewer are plain tool output',
      }),
      expect.any(Function),
    )
    const toolPayload = mockSocket.emit.mock.calls
      .find(([event, payload]) => event === 'message' && payload?.tool_call_id === `tool-${agent}`)?.[1]
    expect(toolPayload).not.toHaveProperty('mentions')
  })

  it('keeps Hermes bridge failed tool output mention text non-routable and preserves the error', async () => {
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'Hermes answer',
        cursor: 1,
        output: 'Hermes answer',
        done: true,
        events: [
          { event: 'tool.started', tool_call_id: 'tool-hermes', name: 'read_file', arguments: { path: '/tmp/source.txt' } },
          {
            event: 'tool.failed',
            tool_call_id: 'tool-hermes',
            name: 'read_file',
            output: 'permission denied: @all and @Reviewer are plain tool output',
            error: 'permission denied',
          },
        ],
        event_cursor: 2,
      } as any
    })
    const client = await createClient('')

    await client.replyToMention('room-1', {
      messageId: 'message-hermes',
      content: '@Worker inspect the source',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'tool',
        tool_call_id: 'tool-hermes',
        content: 'permission denied: @all and @Reviewer are plain tool output',
        finish_reason: 'error',
      }),
      expect.any(Function),
    )
    const toolPayload = mockSocket.emit.mock.calls
      .find(([event, payload]) => event === 'message' && payload?.tool_call_id === 'tool-hermes')?.[1]
    expect(toolPayload).not.toHaveProperty('mentions')
  })

  it('clears exhausted ChatRun tool recovery state after surfacing terminal persistence loss', async () => {
    let toolResultAttempts = 0
    mockSocket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'message' && data?.role === 'tool') {
        toolResultAttempts += 1
        ack?.({ error: 'persistent Room persistence failure' })
      } else if (event === 'message') {
        ack?.({ id: data?.id || 'msg-id' })
      }
      return mockSocket
    })
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('tool.started', {
        tool_call_id: 'tool-codex-terminal-loss',
        name: 'read_file',
        arguments: { path: '/tmp/source.txt' },
      })
      options.onEvent?.('tool.completed', {
        tool_call_id: 'tool-codex-terminal-loss',
        name: 'read_file',
        output: 'result that cannot be persisted',
      })
      return { ok: true, output: 'Codex answer' }
    })
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: 'agent-codex-terminal-loss', agent: 'codex', profile: 'default', name: 'Codex',
      description: '', invited: 0, backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '', maxHistoryTokens: 32000 })),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention('room-codex-terminal-loss', {
      messageId: 'message-codex-terminal-loss', content: '@Codex inspect the source',
      senderName: 'Human', senderId: 'human-1', timestamp: 1, role: 'user',
    })

    expect(toolResultAttempts).toBe(3)
    expect(client.pendingToolCallIds.size).toBe(0)
    expect(client.pendingToolBaseIds.size).toBe(0)
    expect(client.pendingToolRunIds.size).toBe(0)
    expect(client.pendingToolNames.size).toBe(0)
    expect(client.pendingToolExternalIds.size).toBe(0)
    expect(client.pendingToolCompletionEvents.size).toBe(0)
    client.disconnect()
  })

  it('clears exhausted Hermes tool recovery state after surfacing terminal persistence loss', async () => {
    let toolResultAttempts = 0
    mockSocket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'message' && data?.role === 'tool') {
        toolResultAttempts += 1
        ack?.({ error: 'persistent Room persistence failure' })
      } else if (event === 'message') {
        ack?.({ id: data?.id || 'msg-id' })
      }
      return mockSocket
    })
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true, run_id: runId, session_id: 'session-1', status: 'complete',
        delta: 'Hermes answer', cursor: 1, output: 'Hermes answer', done: true,
        events: [
          { event: 'tool.started', tool_call_id: 'tool-hermes-terminal-loss', name: 'read_file', arguments: { path: '/tmp/source.txt' } },
          { event: 'tool.completed', tool_call_id: 'tool-hermes-terminal-loss', name: 'read_file', output: 'result that cannot be persisted' },
        ],
        event_cursor: 2,
      } as any
    })
    const client = await createClient('')

    await client.replyToMention('room-1', {
      messageId: 'message-hermes-terminal-loss', content: '@Worker inspect the source',
      senderName: 'Human', senderId: 'human-1', timestamp: 1, role: 'user',
    })

    expect(toolResultAttempts).toBe(3)
    expect(client.pendingToolCallIds.size).toBe(0)
    expect(client.pendingToolBaseIds.size).toBe(0)
    expect(client.pendingToolRunIds.size).toBe(0)
    expect(client.pendingToolNames.size).toBe(0)
    expect(client.pendingToolExternalIds.size).toBe(0)
    expect(client.pendingToolCompletionEvents.size).toBe(0)
    client.disconnect()
  })

  it('generates one complete entry mention DTO for repeated mentions of the same participant anywhere in a reply', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const author = await clients.createAgent({
      agentId: 'agent-author',
      profile: 'default',
      name: 'Author',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    })
    clients.rooms.set('room-1', new Map([
      ['agent-author', author],
      ['agent-reviewer', { agentId: 'agent-reviewer', name: 'Reviewer' }],
    ]))

    await author.sendMessage(
      'room-1',
      'Please ask @Reviewer to verify this; @Reviewer owns the final check.',
      'handoff-1',
    )

    expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      id: 'handoff-1',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    }), expect.any(Function))
  })

  it('does not generate a structured mention for the replying agent itself', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const author = await clients.createAgent({
      agentId: 'agent-author',
      profile: 'default',
      name: 'Author',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    })
    const replyToMention = vi.fn(async () => {})
    clients.rooms.set('room-1', new Map([
      ['agent-author', author],
      ['agent-reviewer', { agentId: 'agent-reviewer', name: 'Reviewer', replyToMention }],
    ]))

    await author.sendMessage(
      'room-1',
      '@Author status: waiting for @Reviewer.',
      'self-mention-1',
    )

    expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      id: 'self-mention-1',
      content: '@Author status: waiting for @Reviewer.',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
    }), expect.any(Function))
    expect(replyToMention).not.toHaveBeenCalled()
  })

  it('routes each distinct participant once regardless of mention position or repetition', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const author = await clients.createAgent({
      agentId: 'agent-author',
      profile: 'default',
      name: 'Author',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    })
    clients.rooms.set('room-1', new Map([
      ['agent-author', author],
      ['agent-lead', { agentId: 'agent-lead', name: 'Lead' }],
      ['agent-reviewer', { agentId: 'agent-reviewer', name: 'Reviewer' }],
    ]))

    await author.sendMessage(
      'room-1',
      'Lead with this, @Lead; then ask @Reviewer to verify it. @Lead owns follow-up and @Reviewer signs off.',
      'deduplicated-handoff-1',
    )

    expect(mockSocket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      id: 'deduplicated-handoff-1',
      mentions: [
        { type: 'agent', participantId: 'agent-lead', displayName: 'Lead' },
        { type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' },
      ],
    }), expect.any(Function))
  })

  it('dispatches a Codex group agent through chat-run without invoking the Hermes bridge', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      for (const revision of [1, 2]) options.onEvent?.('plan.updated', {
        session_id: _data.session_id, run_id: 'runtime-run', plan_id: 'group-plan', revision,
        execution_state: revision === 1 ? 'running' : 'ended', created_at: 1000, updated_at: 1000 + revision,
        plan: [{ id: 'check', step: 'Check group plan', status: revision === 1 ? 'in_progress' : 'completed' }],
      })
      options.onEvent?.('reasoning.delta', { delta: 'thinking' })
      options.onEvent?.('tool.started', {
        tool_call_id: 'tool-1',
        name: 'list_files',
        arguments: { path: '/tmp' },
      })
      options.onEvent?.('tool.completed', {
        tool_call_id: 'tool-1',
        name: 'list_files',
        output: 'file.txt',
      })
      options.onEvent?.('reasoning.delta', { delta: 'next thought' })
      options.onEvent?.('tool.started', {
        tool_call_id: 'tool-2',
        name: 'read_file',
        arguments: { path: '/tmp/file.txt' },
      })
      options.onEvent?.('tool.failed', {
        tool_call_id: 'tool-2',
        name: 'read_file',
        output: 'permission denied',
        error: 'permission denied',
      })
      options.onEvent?.('message.delta', { delta: 'Codex answer' })
      return { ok: true, output: 'Codex answer', reasoning: 'thinkingnext thought' }
    })
    const chatRunService = {
      runAndWait,
      abortSession: vi.fn(async () => {}),
    }
    const clients = new AgentClients()
    clients.setChatRunService(chatRunService)
    const client = await clients.createAgent({
      agentId: 'agent-codex',
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Coder',
      description: 'Writes code',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({
        name: 'Engineering Room',
        sessionSeed: 'seed-1',
        workspace: '',
        maxHistoryTokens: 32000,
        remoteWorkspaceApi: {
          endpoint: 'https://group.example/api/studio/group-chat/remote-workspace/v1',
          token: 'a'.repeat(43),
          access: 'read-write',
        },
      })),
      getRoomMembers: vi.fn(() => [
        { id: 'member-1', userId: 'human-1', name: 'Human', description: 'Product owner' },
      ]),
      getRoomAgents: vi.fn(() => [
        { id: 'room-agent-1', agentId: 'agent-codex', name: 'Coder', description: 'Writes code' },
        { id: 'room-agent-2', agentId: 'agent-reviewer', name: 'Reviewer', description: 'Reviews changes' },
        { id: 'room-agent-3', agentId: 'agent-sleeping', name: 'Sleeping', description: 'Offline Agent' },
      ]),
      getMentionableRoomAgents: vi.fn(() => [
        { id: 'room-agent-1', agentId: 'agent-codex', name: 'Coder', description: 'Writes code' },
        { id: 'room-agent-2', agentId: 'agent-reviewer', name: 'Reviewer', description: 'Reviews changes' },
      ]),
      getMessagesForContext: vi.fn(() => [{
        id: 'msg-1',
        roomId: 'room-1',
        senderId: 'human-1',
        senderName: 'Human',
        content: '@Coder implement it',
        timestamp: 1,
        role: 'user',
      }]),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention('room-1', {
      messageId: 'msg-1',
      content: '@Coder implement it',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    }, {
      summary: 'Use the shared room architecture.',
      history: [{
        id: 'prior-1',
        timestamp: 0,
        role: 'assistant',
        senderName: 'Reviewer',
        content: 'Keep single chat unchanged.',
      }],
    })

    const cards = mockSocket.emit.mock.calls.filter(call => call[0] === 'message' && call[1]?.tool_name === 'task_plan').map(call => call[1])
    expect(cards).toHaveLength(2)
    expect(cards[0].id).toBe(cards[1].id)
    expect(JSON.parse(cards[1].content)).toMatchObject({ revision: 2, execution_state: 'ended', run_id: cards[1].run_id })
    expect(runAndWait).toHaveBeenCalledWith(expect.objectContaining({
      coding_agent_id: 'codex',
      source: 'group_chat',
      session_source: 'group_chat',
      mode: 'scoped',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoning_effort: 'high',
      group_room_id: 'room-1',
      group_agent_id: 'agent-codex',
      background_delegation_enabled: false,
      context_compression_enabled: false,
    }), expect.objectContaining({
      profile: 'research',
      onEvent: expect.any(Function),
    }))
    expect(runAndWait.mock.calls[0][1]).not.toHaveProperty('timeoutMs')
    expect(String(runAndWait.mock.calls[0][0].input)).toContain('summary covers everything through the summary anchor')
    expect(String(runAndWait.mock.calls[0][0].input)).toContain('Keep single chat unchanged.')
    expect(runAndWait.mock.calls[0][0].instructions).toContain('You are "Coder", an AI assistant in the group chat room "Engineering Room"')
    expect(runAndWait.mock.calls[0][0].instructions).toContain('- [Human member] Human: Product owner')
    expect(runAndWait.mock.calls[0][0].instructions).toContain('- [AI Agent] Reviewer: Reviews changes')
    expect(runAndWait.mock.calls[0][0].instructions).not.toContain('Sleeping')
    expect(runAndWait.mock.calls[0][0].instructions).toContain(
      'https://group.example/api/studio/group-chat/remote-workspace/v1',
    )
    expect(runAndWait.mock.calls[0][0].instructions).toContain(`Bearer ${'a'.repeat(43)}`)
    expect(runAndWait.mock.calls[0][0].instructions).toContain('"action":"read"')
    expect(runAndWait.mock.calls[0][0].instructions).toContain(
      'https://group.example/api/studio/group-chat/remote-workspace/v1/file',
    )
    expect(runAndWait.mock.calls[0][0].instructions).toContain('X-Expected-SHA256')
    expect(runAndWait.mock.calls[0][0].group_system_prompt).toBe(runAndWait.mock.calls[0][0].instructions)
    expect(bridgeMock.chat).not.toHaveBeenCalled()
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        content: 'Codex answer',
        reasoning: null,
      }),
      expect.any(Function),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'tool',
        tool_call_id: 'tool-2',
        tool_name: 'read_file',
        content: 'permission denied',
        finish_reason: 'error',
      }),
      expect.any(Function),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'assistant',
        tool_calls: [expect.objectContaining({
          id: 'tool-1',
          function: expect.objectContaining({ name: 'list_files' }),
        })],
        reasoning: 'thinking',
      }),
      expect.any(Function),
    )
    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        role: 'tool',
        tool_call_id: 'tool-1',
        tool_name: 'list_files',
        content: 'file.txt',
      }),
      expect.any(Function),
    )
    const persistedAgentMessages = mockSocket.emit.mock.calls
      .filter(([event, payload]) => event === 'message' && payload?.roomId === 'room-1')
      .map(([, payload]) => payload)
    expect(persistedAgentMessages
      .filter(payload => payload.role === 'assistant' && payload.tool_calls?.length)
      .map(payload => payload.reasoning)).toEqual(['thinking', 'next thought'])
    expect(new Set(persistedAgentMessages.map(payload => payload.run_id)).size).toBe(1)
    expect(persistedAgentMessages.every(payload => /^gcmsg_/.test(payload.run_id))).toBe(true)
    expect(runAndWait.mock.calls[0][0].session_id).toMatch(/^gc_run_/)
  })

  it('normalizes non-Hermes approval events onto the authoritative group run generation', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('approval.requested', {
        run_id: 'runtime-run-id',
        approval_id: 'approval-1',
        command: 'printf harmless',
      })
      return { ok: true, run_id: 'runtime-run-id', output: 'done' }
    })
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: 'agent-codex',
      agent: 'codex',
      profile: 'default',
      name: 'Coder',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '', maxHistoryTokens: 32000 })),
      getRoomAgents: vi.fn(() => []),
      getMentionableRoomAgents: vi.fn(() => []),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention('room-1', {
      messageId: 'message-1',
      content: '@Coder run safely',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    const streamStart = mockSocket.emit.mock.calls
      .find(([event]) => event === 'message_stream_start')?.[1]
    const approval = mockSocket.emit.mock.calls
      .find(([event]) => event === 'approval.requested')?.[1]
    expect(streamStart?.run_id).toBeTruthy()
    expect(approval).toMatchObject({
      approval_id: 'approval-1',
      runId: streamStart.run_id,
    })
    expect(approval).not.toHaveProperty('run_id')
  })

  it.each([
    ['ekko', 'ekko-agent'],
    ['claude', 'claude-code'],
    ['dsh', 'dsh'],
    ['pi', 'pi'],
  ] as const)('passes the dynamic group system prompt to the %s runtime', async (agent, codingAgentId) => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('clarify.requested', {
        clarify_id: `clarify-${agent}`, question: 'Continue?', choices: ['yes', 'no'], timeout_ms: 300000,
      })
      options.onEvent?.('clarify.resolved', {
        clarify_id: `clarify-${agent}`, resolved: true, reason: 'response',
      })
      options.onEvent?.('message.delta', { delta: 'done' })
      return { ok: true, output: 'done' }
    })
    const clients = new AgentClients()
    clients.setChatRunService({
      runAndWait,
      abortSession: vi.fn(async () => {}),
    })
    const displayName = agent === 'ekko' ? 'Ekko' : agent === 'claude' ? 'Claude' : 'Pi'
    const client = await clients.createAgent({
      agentId: `agent-${agent}`,
      agent,
      profile: 'default',
      name: displayName,
      description: `${agent} room role`,
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ name: 'Runtime Room', workspace: '' })),
      getRoomMembers: vi.fn(() => [
        { id: 'member-1', userId: 'human-1', name: 'Human', description: 'Room owner' },
      ]),
      getRoomAgents: vi.fn(() => [
        {
          id: `room-agent-${agent}`,
          agentId: `agent-${agent}`,
          name: displayName,
          description: `${agent} room role`,
        },
      ]),
    })

    await client.replyToMention('room-runtime', {
      messageId: `msg-${agent}`,
      content: `@${displayName} reply`,
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    const runData = runAndWait.mock.calls[0][0]
    expect(runAndWait.mock.calls[0][1]).not.toHaveProperty('timeoutMs')
    expect(runData.coding_agent_id).toBe(codingAgentId)
    expect(runData.instructions).toContain(`You are "${displayName}", an AI assistant in the group chat room "Runtime Room"`)
    expect(runData.instructions).toContain('- [Human member] Human: Room owner')
    expect(runData.group_system_prompt).toBe(runData.instructions)
    expect(runData.group_room_id).toBe('room-runtime')
    expect(runData.group_agent_id).toBe(`agent-${agent}`)
    if (agent === 'ekko') {
      expect(runData.memory_messages).toEqual([
        expect.objectContaining({
          role: 'user',
          content: 'Human：reply',
          metadata: expect.objectContaining({ senderName: 'Human' }),
        }),
      ])
      expect(runData.memory_write_policy).toBe('automatic')
      expect(runData.memory_origin).toEqual({
        host: 'hermes-studio',
        namespace: 'group-chat',
        contextId: 'room-runtime',
      })
      expect(runData.memory_recall_scopes).toEqual([
        { type: 'profile' },
        { type: 'context', namespace: 'studio.group-chat', id: 'room-runtime' },
        { type: 'session', id: expect.any(String) },
      ])
      expect(runData.memory_default_write_scope).toEqual({
        type: 'context',
        namespace: 'studio.group-chat',
        id: 'room-runtime',
      })
    } else {
      expect(runData).not.toHaveProperty('memory_messages')
      expect(runData).not.toHaveProperty('memory_write_policy')
    }
    expect(mockSocket.emit).toHaveBeenCalledWith('clarify.requested', expect.objectContaining({
      roomId: 'room-runtime', clarify_id: `clarify-${agent}`, question: 'Continue?',
    }))
    expect(mockSocket.emit).toHaveBeenCalledWith('clarify.resolved', expect.objectContaining({
      roomId: 'room-runtime', clarify_id: `clarify-${agent}`, resolved: true,
    }))
  })

  it('runs a global Codex group Agent without scoped provider, model, protocol, or reasoning overrides', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async () => ({ ok: true, output: 'done' }))
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: 'agent-global-codex',
      agent: 'codex',
      agentMode: 'global',
      profile: 'default',
      provider: 'must-not-leak',
      model: 'must-not-leak',
      apiMode: 'chat_completions',
      reasoningEffort: 'high',
      name: 'Global Codex',
      description: 'Uses the user CLI configuration',
      invited: 0,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ name: 'Global Room', workspace: '' })),
      getRoomMembers: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    })

    await client.replyToMention('room-global', {
      messageId: 'msg-global',
      content: '@Global Codex work',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    const runInput = runAndWait.mock.calls[0][0]
    expect(runInput).toMatchObject({
      coding_agent_id: 'codex',
      mode: 'global',
      profile: 'default',
      group_room_id: 'room-global',
      group_agent_id: 'agent-global-codex',
    })
    expect(runInput.instructions).toContain('You are "Global Codex", an AI assistant in the group chat room "Global Room"')
    expect(runInput.group_system_prompt).toBe(runInput.instructions)
    expect(runInput).not.toHaveProperty('provider')
    expect(runInput).not.toHaveProperty('model')
    expect(runInput).not.toHaveProperty('apiMode')
    expect(runInput).not.toHaveProperty('reasoning_effort')
  })

  it('keeps Pi group turns temporary while reinjecting the room history', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async () => ({ ok: true, output: 'done' }))
    const disposeSession = vi.fn(async () => {})
    const clients = new AgentClients()
    clients.setChatRunService({
      runAndWait,
      abortSession: vi.fn(async () => {}),
      disposeSession,
    })
    const client = await clients.createAgent({
      agentId: 'agent-pi-history',
      agent: 'pi',
      profile: 'default',
      name: 'Pi',
      description: 'Keeps up with the room',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ name: 'History Room', workspace: '' })),
      getRoomMembers: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    })

    await client.replyToMention('room-history', {
      messageId: 'msg-1',
      content: '@Pi remember alpha',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })
    await client.replyToMention('room-history', {
      messageId: 'msg-2',
      content: '@Pi what came before?',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 2,
      role: 'user',
    }, {
      summary: '',
      history: [{
        id: 'msg-1',
        timestamp: 1,
        role: 'user',
        senderName: 'Human',
        content: '@Pi remember alpha',
      }],
    })

    const firstRun = runAndWait.mock.calls[0][0]
    const secondRun = runAndWait.mock.calls[1][0]
    expect(firstRun.session_id).toMatch(/^gc_run_/)
    expect(secondRun.session_id).toMatch(/^gc_run_/)
    expect(secondRun.session_id).not.toBe(firstRun.session_id)
    expect(String(secondRun.input)).toContain('Member "Human": @Pi remember alpha')
    expect(disposeSession).toHaveBeenCalledTimes(2)
    expect(disposeSession).toHaveBeenNthCalledWith(1, firstRun.session_id)
    expect(disposeSession).toHaveBeenNthCalledWith(2, secondRun.session_id)
  })

  it('adds the workspace-scoped security policy only when a non-owner mentions the Agent', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any) => ({ ok: true, output: 'done' }))
    const clients = new AgentClients()
    clients.setChatRunService({ runAndWait, abortSession: vi.fn(async () => {}) })
    const client = await clients.createAgent({
      agentId: 'agent-secure',
      agent: 'codex',
      profile: 'default',
      name: 'SecureAgent',
      description: 'Handles shared media work',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any)
    const storage = {
      getRoom: vi.fn(() => ({
        name: 'Secure Room',
        workspace: '/srv/group-chat/secure-room',
        ownerAuthUserId: 42,
      })),
      getRoomMembers: vi.fn(() => [
        { userId: 'auth:42', name: 'Room Owner' },
        { userId: 'member-guest', name: 'Guest' },
      ]),
      getRoomAgents: vi.fn(() => [{
        id: 'room-agent-secure',
        agentId: 'agent-secure',
        name: 'SecureAgent',
        executorType: 'remote',
        ownerMemberId: 'auth:42',
      }]),
    }
    ;(clients as any).rooms.set('room-secure', new Map([[client.agentId, client]]))
    clients.setStorage(storage)

    await clients.processMentions('room-secure', {
      messageId: 'message-guest',
      content: '@SecureAgent render and upload the video',
      senderName: 'Guest',
      senderId: 'member-guest',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-secure' }],
    })

    const guestInstructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(guestInstructions).toContain('# Security context: request from a non-owner')
    expect(guestInstructions).toContain('"requester_id": "member-guest"')
    expect(guestInstructions).toContain('"agent_owner_member_id": "auth:42"')
    expect(guestInstructions).toContain('"authorized_workspace": "/srv/group-chat/secure-room"')
    expect(guestInstructions).toContain('cloud rendering, media generation, storage, and publishing')

    runAndWait.mockClear()
    await clients.processMentions('room-secure', {
      messageId: 'message-owner',
      content: '@SecureAgent render and upload the video',
      senderName: 'Room Owner',
      senderId: 'auth:42',
      timestamp: 2,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-secure' }],
    })

    const ownerInstructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(ownerInstructions).not.toContain('# Security context: request from a non-owner')

    storage.getRoomAgents.mockReturnValue([{
      id: 'room-agent-secure',
      agentId: 'agent-secure',
      name: 'SecureAgent',
      executorType: 'server',
      ownerMemberId: '',
    }])
    runAndWait.mockClear()
    await clients.processMentions('room-secure', {
      messageId: 'message-server-agent-guest',
      content: '@SecureAgent render and upload the video',
      senderName: 'Guest',
      senderId: 'member-guest',
      timestamp: 3,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-secure' }],
    })

    const serverAgentInstructions = String(runAndWait.mock.calls[0]?.[0]?.instructions || '')
    expect(serverAgentInstructions).toContain('"agent_owner_member_id": "auth:42"')
    client.disconnect()
  })

  it('finishes a group-only Codex tool card when chat-run has no matching completed event', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const runAndWait = vi.fn(async (_data: any, options: any) => {
      options.onEvent?.('tool.started', {
        tool_call_id: 'call-write-stdin',
        name: 'write_stdin',
        arguments: { session_id: 86404, chars: '', yield_time_ms: 3000 },
      })
      options.onEvent?.('message.delta', { delta: 'Weather answer' })
      return { ok: true, output: 'Weather answer' }
    })
    const clients = new AgentClients()
    clients.setChatRunService({
      runAndWait,
      abortSession: vi.fn(async () => {}),
    })
    const client = await clients.createAgent({
      agentId: 'agent-codex-terminal-tool',
      agent: 'codex',
      profile: 'default',
      name: 'Codex',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '', maxHistoryTokens: 32000 })),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    })

    await client.replyToMention('room-terminal-tool', {
      messageId: 'msg-terminal-tool',
      content: '@Codex check the weather',
      senderName: 'Human',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
    })

    const persistedMessages = mockSocket.emit.mock.calls
      .filter(([event, payload]) => event === 'message' && payload?.roomId === 'room-terminal-tool')
      .map(([, payload]) => payload)
    const toolCallIndex = persistedMessages.findIndex(payload => payload.role === 'assistant' && payload.tool_calls?.[0]?.id === 'call-write-stdin')
    const toolResultIndex = persistedMessages.findIndex(payload => payload.role === 'tool' && payload.tool_call_id === 'call-write-stdin')
    const finalAnswerIndex = persistedMessages.findIndex(payload => payload.role === 'assistant' && payload.content === 'Weather answer')

    expect(toolCallIndex).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex)
    expect(finalAnswerIndex).toBeGreaterThan(toolResultIndex)
    expect(persistedMessages[toolResultIndex]).toEqual(expect.objectContaining({
      tool_name: 'write_stdin',
      content: '',
      run_id: persistedMessages[toolCallIndex].run_id,
    }))
  })

  it('interrupts a non-Hermes group agent through chat-run only', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const chatRunService = {
      runAndWait: vi.fn(),
      abortSession: vi.fn(async () => {}),
    }
    const clients = new AgentClients()
    clients.setChatRunService(chatRunService)
    const client = await clients.createAgent({
      agentId: 'agent-ekko',
      agent: 'ekko',
      profile: 'default',
      name: 'Ekko',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    client.setStorage({ getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '' })) })
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))
    const activeSessionId = `gc_run_room-1_default_Ekko_${'a'.repeat(32)}`
    client.activeSessions.set('room-1', activeSessionId)

    await clients.interruptAgent('room-1', 'Ekko')

    expect(chatRunService.abortSession).toHaveBeenCalledWith(
      activeSessionId,
      'Interrupted by group chat user',
    )
    expect(bridgeMock.interrupt).not.toHaveBeenCalled()
  })

  it('does not block room-wide interrupts for idle agents with no bridge session', async () => {
    bridgeMock.interrupt.mockRejectedValueOnce(new Error('unknown session'))
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any) as any
    const storage = { getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace: '' })) }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))

    await expect(clients.interruptRoom('room-1')).resolves.toBeUndefined()
    expect(bridgeMock.interrupt).not.toHaveBeenCalled()
  })

  it('does not drain queued mentions while a room interrupt is still pending', async () => {
    let finishStream!: () => void
    let finishInterrupt!: () => void
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      await new Promise<void>(resolve => { finishStream = resolve })
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'done',
        cursor: 1,
        output: 'done',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })
    bridgeMock.interrupt.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finishInterrupt = resolve })
      return { ok: true, synced: true }
    })
    const client = await createClient('/tmp/workspace')
    const clients = client.__testClients
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 30; i += 1) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      throw new Error('timed out waiting for condition')
    }

    const firstMention = clients.processMentions('room-1', {
      content: '@Worker first',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })
    await waitFor(() => bridgeMock.chat.mock.calls.length === 1)
    await clients.processMentions('room-1', {
      content: '@Worker second',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    const interruptPromise = clients.interruptRoom('room-1')
    await waitFor(() => bridgeMock.interrupt.mock.calls.length === 1)
    finishStream()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(bridgeMock.chat).toHaveBeenCalledTimes(1)
    finishInterrupt()
    await interruptPromise
    await firstMention
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(bridgeMock.chat).toHaveBeenCalledTimes(1)
  })

  it('marks a mentioned agent active before rolling-summary preparation finishes', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const statuses: Array<{ agentName: string; status: string }> = []
    let finishSummary!: (value: { summary: string; history: [] }) => void
    const replyToMention = vi.fn(async () => {})
    const agent = {
      id: 'agent-socket-1',
      agentId: 'agent-1',
      name: 'Worker',
      replyToMention,
    }
    clients.rooms.set('room-1', new Map([[agent.agentId, agent]]))
    clients.setActivityBroadcaster((_roomId: string, agentName: string, status: string) => {
      statuses.push({ agentName, status })
    })
    clients.setRoomSummaryService({
      prepareForMessage: vi.fn(() => new Promise(resolve => { finishSummary = resolve })),
    })

    const processing = clients.processMentions('room-1', {
      messageId: 'message-10',
      content: '@Worker check this',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(statuses[0]).toEqual({ agentName: 'Worker', status: 'replying' })
    expect(replyToMention).not.toHaveBeenCalled()

    finishSummary({ summary: 'summary', history: [] })
    await processing
    expect(replyToMention).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toEqual({ agentName: 'Worker', status: 'ready' })
  })

  it('starts every explicitly mentioned Agent in parallel', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const started: string[] = []
    let finishRuns!: () => void
    const running = new Promise<void>(resolve => { finishRuns = resolve })
    const createAgent = (agentId: string, name: string) => ({
      id: `${agentId}-socket`,
      agentId,
      name,
      replyToMention: vi.fn(async () => {
        started.push(name)
        await running
      }),
    })
    const first = createAgent('agent-first', 'First')
    const second = createAgent('agent-second', 'Second')
    clients.rooms.set('room-1', new Map([
      [first.agentId, first],
      [second.agentId, second],
    ]))

    const processing = clients.processMentions('room-1', {
      messageId: 'multi-agent-handoff',
      content: '@First @Second review this together',
      senderName: 'Coordinator',
      senderId: 'agent-coordinator',
      timestamp: 1,
      role: 'assistant',
      mentionDepth: 1,
      mentions: [
        { type: 'agent', participantId: 'agent-first' },
        { type: 'agent', participantId: 'agent-second' },
      ],
    })

    await vi.waitFor(() => expect(started).toEqual(expect.arrayContaining(['First', 'Second'])))
    expect(first.replyToMention).toHaveBeenCalledOnce()
    expect(second.replyToMention).toHaveBeenCalledOnce()
    finishRuns()
    await processing
  })

  it('dispatches an agent handoff after a CJK speaker prefix', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const replyToMention = vi.fn(async () => {})
    const codex = {
      id: 'codex-socket',
      agentId: 'agent-codex',
      name: 'codex',
      replyToMention,
    }
    clients.rooms.set('room-1', new Map([[codex.agentId, codex]]))

    await clients.processMentions('room-1', {
      messageId: 'hermes-handoff-1',
      content: 'hermes：@codex 老板喊你，出来露个脸。',
      senderName: 'hermes',
      senderId: 'agent-hermes',
      timestamp: 1,
      role: 'assistant',
      mentionDepth: 1,
      mentions: [{ type: 'agent', participantId: 'agent-codex' }],
    })

    expect(replyToMention).toHaveBeenCalledWith(
      'room-1',
      expect.objectContaining({
        messageId: 'hermes-handoff-1',
        mentionDepth: 1,
      }),
      { summary: '', history: [] },
      expect.any(Function),
    )
  })

  it('attaches every validated structured mention to an agent reply before it is persisted', async () => {
    const client = await createClient('')
    client.__testStorage.getRoomAgents = vi.fn(() => [
      { agentId: 'agent-1', name: 'Worker' },
      { agentId: 'agent-reviewer', name: 'Reviewer' },
      { agentId: 'agent-auditor', name: 'Auditor' },
    ])
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: '@Reviewer @Auditor please verify this',
        cursor: 1,
        output: '@Reviewer @Auditor please verify this',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })

    await client.replyToMention('room-1', {
      content: '@Worker prepare the patch',
      senderName: 'Alice',
      senderId: 'human-1',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        roomId: 'room-1',
        content: '@Reviewer @Auditor please verify this',
        mentions: [
          { type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' },
          { type: 'agent', participantId: 'agent-auditor', displayName: 'Auditor' },
        ],
      }),
      expect.any(Function),
    )
  })

  it('keeps an agent active until all queued mentions finish', async () => {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients() as any
    const statuses: string[] = []
    let finishFirst!: () => void
    const replyToMention = vi.fn()
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
      .mockResolvedValueOnce(undefined)
    const agent = {
      id: 'agent-socket-1',
      agentId: 'agent-1',
      name: 'Worker',
      replyToMention,
    }
    clients.rooms.set('room-1', new Map([[agent.agentId, agent]]))
    clients.setActivityBroadcaster((_roomId: string, _agentName: string, status: string) => {
      statuses.push(status)
    })

    const first = clients.processMentions('room-1', {
      messageId: 'message-1',
      content: '@Worker first',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })
    await Promise.resolve()
    await clients.processMentions('room-1', {
      messageId: 'message-2',
      content: '@Worker second',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
      role: 'user',
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(statuses).toEqual(['replying'])
    finishFirst()
    await first
    expect(replyToMention).toHaveBeenCalledTimes(2)
    expect(statuses).toEqual(['replying', 'ready'])
  })

  async function createClient(
    workspace = '',
    runtimeConfig: { provider?: string; model?: string; reasoningEffort?: string } = {},
  ) {
    const { AgentClients } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const clients = new AgentClients()
    const client = await clients.createAgent({
      agentId: 'agent-1',
      profile: 'default',
      ...runtimeConfig,
      name: 'Worker',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    } as any)
    const storage = {
      getRoom: vi.fn(() => ({ sessionSeed: 'seed-1', workspace })),
      saveWorkspaceDiffMessageForRun: vi.fn(),
      updateRoomTotalTokens: vi.fn(),
      getMessagesForContext: vi.fn(() => []),
      getContextSnapshot: vi.fn(() => null),
    }
    client.setStorage(storage as any)
    ;(clients as any).rooms.set('room-1', new Map([[client.agentId, client]]))
    ;(client as any).__testStorage = storage
    ;(client as any).__testClients = clients
    return client as any
  }

  it('forwards Hermes bridge clarification events through the group-chat socket', async () => {
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'done',
        cursor: 1,
        output: 'done',
        done: true,
        events: [
          { event: 'clarify.requested', clarify_id: 'clarify-hermes', question: 'Continue?', choices: ['yes', 'no'], timeout_ms: 300000 },
          { event: 'clarify.resolved', clarify_id: 'clarify-hermes', resolved: true, reason: 'response' },
        ],
        event_cursor: 2,
      }
    })
    const client = await createClient('')

    await client.replyToMention('room-1', {
      content: '@Worker continue?', senderName: 'Alice', senderId: 'user-1', timestamp: 1,
    })

    expect(mockSocket.emit).toHaveBeenCalledWith('clarify.requested', expect.objectContaining({
      roomId: 'room-1', agentName: 'Worker', clarify_id: 'clarify-hermes', question: 'Continue?',
    }))
    expect(mockSocket.emit).toHaveBeenCalledWith('clarify.resolved', expect.objectContaining({
      roomId: 'room-1', agentName: 'Worker', clarify_id: 'clarify-hermes', resolved: true,
    }))
  })

  it.each(['ended', 'interrupted', 'failed'] as const)('gives Hermes a plan-only context and persists its %s state', async terminal => {
    const { TaskPlanRuns } = await import('../../packages/server/src/modules/studio/services/task-plan-runs')
    const fallbackPublish = vi.fn()
    const plans = new TaskPlanRuns(vi.fn(), fallbackPublish)
    const client = await createClient('')
    let contextId = ''
    client.setChatRunService({
      runAndWait: vi.fn(), abortSession: vi.fn(),
      beginGroupTaskPlanRun(sessionId: string, profile: string, runId: string, isCurrent: () => boolean, publish: any) {
        contextId = plans.begin(sessionId, profile, () => ({ isWorking: isCurrent(), activeRunMarker: runId }), publish)
        return { contextId, finish: (state: any) => plans.finish(contextId, state) }
      },
    })
    bridgeMock.chat.mockImplementation(async (sessionId: string) => {
      plans.update(contextId, 'default', { plan: [{ id: 'a', step: 'Inspect', status: 'in_progress' }] })
      if (terminal === 'failed') throw new Error('test bridge failure')
      if (terminal === 'interrupted') await client.interrupt('room-1')
      return { ok: true, run_id: 'bridge-run-id', session_id: sessionId, status: 'running' }
    })
    await client.replyToMention('room-1', { content: '@Worker inspect', senderName: 'Alice', senderId: 'user-1', timestamp: 1 })
    const input = String((bridgeMock.chat.mock.calls[0] as any)[1])
    expect(input).toContain(contextId)
    expect(input).toContain('ekko_studio_update_plan')
    expect(input).not.toContain('ekko_studio_clarify')
    const cards = mockSocket.emit.mock.calls.filter(call => call[0] === 'message' && call[1]?.tool_name === 'task_plan').map(call => call[1])
    expect(cards).toHaveLength(2)
    expect(cards[0].id).toBe(cards[1].id)
    expect(JSON.parse(cards[1].content)).toMatchObject({ revision: 2, execution_state: terminal, plan: [{ status: 'pending' }] })
    expect(fallbackPublish).not.toHaveBeenCalled()
    expect(() => plans.update(contextId, 'default', { plan: [] })).toThrow('expired')
  })

  it('does not attach MCP plans or usage guidance to a group bridge run with MCPs disabled', async () => {
    const { readConfigYamlForProfile } = await import('../../packages/server/src/modules/studio/public/profile-config')
    vi.mocked(readConfigYamlForProfile).mockResolvedValueOnce({ mcp_servers: {} })
    const client = await createClient('')
    const beginGroupTaskPlanRun = vi.fn()
    client.setChatRunService({ runAndWait: vi.fn(), abortSession: vi.fn(), beginGroupTaskPlanRun })
    await client.replyToMention('room-1', { content: '@Worker inspect', senderName: 'Alice', senderId: 'user-1', timestamp: 1 })
    expect(beginGroupTaskPlanRun).not.toHaveBeenCalled()
    const call = bridgeMock.chat.mock.calls[0] as any
    expect(String(call[1])).not.toContain('studio_task_plan_context')
    expect(call[3]).not.toContain('ekko_studio_')
    expect(call[3]).toContain('# Output format guidelines')
  })

  it('omits workspace when the room has no workspace', async () => {
    const client = await createClient('')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
      mentions: [{ type: 'agent', participantId: 'agent-1' }],
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.any(Array),
      expect.any(String),
      'default',
      expect.objectContaining({
        background_delegation_enabled: false,
      }),
    )
    expect(String(bridgeMock.chat.mock.calls[0]?.[3])).toContain('You are "Worker", an AI assistant in the group chat room "room-1"')
    expect(String(bridgeMock.chat.mock.calls[0]?.[3])).toContain('supports Agent-to-Agent handoffs through @name')
    expect(bridgeMock.chat.mock.calls[0]?.[5]).not.toHaveProperty('workspace')
    expect(bridgeMock.chat.mock.calls[0]?.[5]).not.toHaveProperty('run_id')
  })

  it('passes the room agent model selection and reasoning effort to the bridge', async () => {
    const client = await createClient('', {
      provider: 'selected-provider',
      model: 'selected-model',
      reasoningEffort: 'high',
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(bridgeMock.chat.mock.calls[0]?.[5]).toMatchObject({
      provider: 'selected-provider',
      model: 'selected-model',
      reasoning_effort: 'high',
    })
  })

  it('does not launch a reply after its fresh session has been superseded', async () => {
    const client = await createClient('/tmp/workspace')
    client.__testStorage.getRoom.mockImplementation(() => {
      client.activeSessions.set('room-1', 'replacement-session')
      return { sessionSeed: 'seed-1', workspace: '/tmp/workspace' }
    })

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('uses and disposes a different temporary bridge session for every reply', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })
    await client.replyToMention('room-1', {
      content: '@Worker again',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 2,
    })

    const sessionIds = bridgeMock.chat.mock.calls.map(call => call[0])
    expect(sessionIds).toHaveLength(2)
    expect(sessionIds[0]).toMatch(/^gc_run_/)
    expect(sessionIds[1]).toMatch(/^gc_run_/)
    expect(sessionIds[0]).not.toBe(sessionIds[1])
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionIds[0], 'default')
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionIds[1], 'default')
  })

  it('does not start a bridge workspace run after the room is deleted before launch', async () => {
    const client = await createClient('/tmp/workspace')
    const storage = (client as any).__testStorage
    storage.getRoom.mockReturnValue(undefined)

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.startWorkspaceRunCheckpoint).not.toHaveBeenCalled()
    expect(bridgeMock.chat).not.toHaveBeenCalled()
  })

  it('starts a checkpoint with the bridge-assigned run_id after bridge.chat starts', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const options = bridgeMock.chat.mock.calls[0][5]
    expect(options.workspace).toBe('/tmp/workspace')
    expect(options).not.toHaveProperty('run_id')
    expect(trackerMock.startWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'bridge-run-id',
      workspace: '/tmp/workspace',
    }))
    expect(order.slice(0, 2)).toEqual(['chat', 'checkpoint'])
  })

  it('uses the bridge-assigned run_id when finalizing the workspace diff', async () => {
    const client = await createClient('/tmp/workspace')

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    expect(trackerMock.completeWorkspaceRunCheckpointDraft).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'bridge-run-id',
      workspace: '/tmp/workspace',
    }))
  })

  it('finalizes an aborted workspace diff on interrupt and ignores a later stream finalizer', async () => {
    const client = await createClient('/tmp/workspace')
    const { groupRuntimeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
    const runId = '0123456789abcdef0123456789abcdef'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))

    await client.interrupt('room-1')

    expect(bridgeMock.interrupt).toHaveBeenCalledWith(sessionId, 'Interrupted by group chat user', 'default')
    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({
      roomId: 'room-1',
      sessionId,
      runId,
      status: 'aborted',
      parentMessageId: null,
    })

    await client.finalizeWorkspaceDiffOnce(state, 'failed', 'late-message-id')

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).toHaveBeenCalledTimes(1)
  })

  it('does not fail a synced interrupt when best-effort UI status emits cannot use the socket', async () => {
    const client = await createClient('/tmp/workspace')
    mockSocket.connected = false
    const { groupRuntimeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
    const runId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))

    try {
      await expect(client.interrupt('room-1')).resolves.toBe(true)
    } finally {
      mockSocket.connected = true
    }

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId, status: 'aborted' })
  })

  it('does not mark workspace diff runs aborted when bridge interrupt fails', async () => {
    bridgeMock.interrupt.mockRejectedValueOnce(new Error('stale session'))
    const client = await createClient('/tmp/workspace')
    const { groupRuntimeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
    const runId = 'dddddddddddddddddddddddddddddddd'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun

    await expect(client.interrupt('room-1')).rejects.toThrow('stale session')

    expect(state.abortRequested).toBe(false)
    expect(client.workspaceDiffRuns.size).toBe(1)
    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', status: 'ready' }))
  })

  it('keeps workspace diff finalization pending when bridge interrupt is not synced yet', async () => {
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    const client = await createClient('/tmp/workspace')
    const { groupRuntimeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
    const runId = 'cccccccccccccccccccccccccccccccc'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })

    await expect(client.interrupt('room-1')).resolves.toBe(false)

    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).not.toHaveBeenCalled()
    expect(client.workspaceDiffRuns.size).toBe(1)
    expect(mockSocket.emit).not.toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', status: 'ready' }))

    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any).mockReturnValueOnce(workspaceDraft(runId, sessionId))
    await client.finalizeWorkspaceDiffOnce(state, 'failed', 'terminal-message-id')

    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId, status: 'failed' })
  })

  it('discards workspace diff finalization when the room session generation changed', async () => {
    const client = await createClient('/tmp/workspace')
    const staleSessionId = await workerSessionId('old-seed')
    const runId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
    const state = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId: staleSessionId, runId, workspace: '/tmp/workspace' })
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun

    await client.finalizeWorkspaceDiffOnce(state, 'completed', 'late-message-id')

    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).not.toHaveBeenCalled()
    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ runId }))
    expect(client.workspaceDiffRuns.size).toBe(0)
  })

  it('drops late assistant output after the active temporary session is replaced', async () => {
    bridgeMock.interrupt.mockResolvedValueOnce({ ok: true, synced: false })
    let activeClient: any
    bridgeMock.streamOutput.mockImplementation(async function* (runId: string) {
      activeClient.activeSessions.set('room-1', 'replacement-session')
      yield {
        ok: true,
        run_id: runId,
        session_id: 'session-1',
        status: 'complete',
        delta: 'late',
        cursor: 1,
        output: 'late',
        done: true,
        events: [],
        event_cursor: 0,
      }
    })
    const client = await createClient('/tmp/workspace')
    activeClient = client

    await client.replyToMention('room-1', {
      content: '@Worker hi',
      senderName: 'Alice',
      senderId: 'user-1',
      timestamp: 1,
    })

    const sessionId = bridgeMock.chat.mock.calls[0][0]
    expect(bridgeMock.interrupt).toHaveBeenCalledWith(
      sessionId,
      'Interrupted because group chat room state changed',
      'default',
    )
    expect(bridgeMock.destroy).toHaveBeenCalledWith(sessionId, 'default')
    expect(client.__testStorage.saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(mockSocket.emit).toHaveBeenCalledWith('message_stream_end', expect.objectContaining({
      roomId: 'room-1',
      agentSessionId: sessionId,
    }))
    expect(mockSocket.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ role: 'assistant' }), expect.any(Function))
    expect(trackerMock.discardWorkspaceRunCheckpoint).toHaveBeenCalledWith({
      sessionId,
      runId: 'bridge-run-id',
    })
    expect(client.workspaceDiffRuns.size).toBe(0)
  })

  it('cleans up no-change workspace runs and keeps overlapping runs isolated', async () => {
    const client = await createClient('/tmp/workspace')
    const saveWorkspaceDiffMessageForRun = client.__testStorage.saveWorkspaceDiffMessageForRun
    saveWorkspaceDiffMessageForRun.mockReturnValue({ message: { id: 'diff-1', roomId: 'room-1' }, totalTokens: 0 })
    const runA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const runB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const { groupRuntimeSessionId } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-clients')
    const sessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    client.activeSessions.set('room-1', sessionId)
    const stateA = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId: runA, workspace: '/tmp/workspace' })
    const stateB = client.beginWorkspaceDiffIfNeeded({ roomId: 'room-1', sessionId, runId: runB, workspace: '/tmp/workspace' })

    ;(trackerMock.completeWorkspaceRunCheckpointDraft as any)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(workspaceDraft(runB, sessionId))

    await client.finalizeWorkspaceDiffOnce(stateA, 'completed', null)
    expect(saveWorkspaceDiffMessageForRun).not.toHaveBeenCalled()
    expect(client.workspaceDiffRuns.size).toBe(1)

    await client.finalizeWorkspaceDiffOnce(stateA, 'completed', null)
    expect(trackerMock.completeWorkspaceRunCheckpointDraft).toHaveBeenCalledTimes(1)

    await client.finalizeWorkspaceDiffOnce(stateB, 'failed', null)
    expect(saveWorkspaceDiffMessageForRun).toHaveBeenCalledTimes(1)
    expect(saveWorkspaceDiffMessageForRun.mock.calls[0][0]).toMatchObject({ runId: runB, status: 'failed' })
    expect(client.workspaceDiffRuns.size).toBe(0)
  })
})
