// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const chatApi = vi.hoisted(() => ({
  startRunViaSocket: vi.fn(),
  socketEmit: vi.fn(),
}))
const sessionsApi = vi.hoisted(() => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
  fetchSessions: vi.fn(),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: vi.fn(),
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: chatApi.socketEmit })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onRunUsageUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({
  getActiveProfileName: () => 'default',
  hasApiKey: () => false,
}))

vi.mock('@/api/studio/sessions', () => ({
  deleteSession: sessionsApi.deleteSession,
  fetchSessionMessagesPage: sessionsApi.fetchSessionMessagesPage,
  fetchSessions: sessionsApi.fetchSessions,
  fetchWorkspaceRunChangesForSession: vi.fn(async () => []),
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: sessionsApi.setSessionModel,
}))

vi.mock('@/api/studio/download', () => ({
  getDownloadUrl: (_path: string, name: string) => `/download/${name}`,
}))

vi.mock('@/api/hermes/system', () => ({
  checkHealth: vi.fn(),
  fetchAvailableModels: vi.fn(),
  addCustomModel: vi.fn(),
  removeCustomModel: vi.fn(),
  updateDefaultModel: vi.fn(),
  updateModelVisibility: vi.fn(),
  triggerUpdate: vi.fn(),
  updateModelAlias: vi.fn(),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
  playCompletionSound: vi.fn(),
}))

import { useChatStore, type Session } from '@/stores/hermes/chat'
import type { RunEvent } from '@/api/studio/chat'

function makeSession(): Session {
  return {
    id: 'session-1',
    title: 'session',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('chat store reasoning/tool boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    setActivePinia(createPinia())
    chatApi.startRunViaSocket.mockReturnValue({ abort: vi.fn() })
    sessionsApi.deleteSession.mockResolvedValue(true)
    sessionsApi.setSessionModel.mockResolvedValue(true)
  })

  it('keeps reasoning with the assistant segment that follows each tool boundary', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run a tool')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })
    onEvent({ event: 'reasoning.delta', session_id: 'session-1', delta: 'think before. ' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: 'Before tool.' })
    onEvent({
      event: 'tool.started',
      session_id: 'session-1',
      run_marker: 'run-1',
      tool_call_id: 'tool-1',
      tool: 'shell',
      arguments: '{}',
    } as RunEvent)
    onEvent({ event: 'reasoning.delta', session_id: 'session-1', delta: 'think after. ' })
    onEvent({
      event: 'tool.completed',
      session_id: 'session-1',
      run_marker: 'run-1',
      tool_call_id: 'tool-1',
      output: 'tool output',
    } as RunEvent)
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: 'After tool.' })

    expect(store.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(store.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Before tool.',
      reasoning: 'think before. ',
      isStreaming: false,
    }))
    expect(store.messages[2]).toEqual(expect.objectContaining({
      role: 'tool',
      toolStatus: 'done',
      toolResult: 'tool output',
      reasoning: 'think before. ',
      runMarker: 'run-1',
    }))
    expect(store.messages[3]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'After tool.',
      reasoning: 'think after. ',
      isStreaming: true,
    }))

    onEvent({ event: 'run.completed', session_id: 'session-1', output: 'After tool.' })

    expect(store.messages.filter(message => message.role === 'assistant')).toEqual([
      expect.objectContaining({
        content: 'Before tool.',
        reasoning: 'think before. ',
        isStreaming: false,
      }),
      expect.objectContaining({
        content: 'After tool.',
        reasoning: 'think after. ',
        isStreaming: false,
      }),
    ])
  })

  it('restores persisted tool-call reasoning on the expandable tool message', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue({
      session: { id: 'session-1', title: 'session' },
      messages: [
        {
          id: 1,
          role: 'assistant',
          content: '',
          reasoning: 'I should inspect the file before answering.',
          tool_calls: [{
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"README.md"}',
            },
          }],
          timestamp: 1,
          finish_reason: 'tool_calls',
        },
        {
          id: 2,
          role: 'tool',
          content: 'file contents',
          tool_call_id: 'tool-1',
          run_marker: 'run-1',
          timestamp: 2,
        },
      ],
      total: 2,
      hasMore: false,
    })

    await store.refreshActiveSession()

    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'tool',
        toolName: 'read_file',
        toolCallId: 'tool-1',
        reasoning: 'I should inspect the file before answering.',
        toolResult: 'file contents',
        runMarker: 'run-1',
      }),
    ])
  })

  it('restores repeated tool ids with metadata from their own runs', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue({
      session: { id: 'session-1', title: 'session' },
      messages: [
        {
          id: 1,
          role: 'assistant',
          content: '',
          reasoning: 'reasoning for run A',
          run_marker: 'run-a',
          tool_calls: [{
            id: 'item_2',
            type: 'function',
            function: { name: 'Command', arguments: '{"command":"pwd"}' },
          }],
          timestamp: 1,
          finish_reason: 'tool_calls',
        },
        {
          id: 2,
          role: 'tool',
          content: 'result A',
          tool_call_id: 'item_2',
          run_marker: 'run-a',
          timestamp: 2,
        },
        {
          id: 3,
          role: 'assistant',
          content: '',
          reasoning: 'reasoning for run B',
          run_marker: 'run-b',
          tool_calls: [{
            id: 'item_2',
            type: 'function',
            function: { name: 'Web Search', arguments: '{"query":"Hermes"}' },
          }],
          timestamp: 3,
          finish_reason: 'tool_calls',
        },
        {
          id: 4,
          role: 'tool',
          content: 'result B',
          tool_call_id: 'item_2',
          run_marker: 'run-b',
          timestamp: 4,
        },
      ],
      total: 4,
      hasMore: false,
    })

    await store.refreshActiveSession()

    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'item_2',
        runMarker: 'run-a',
        toolName: 'Command',
        toolArgs: '{"command":"pwd"}',
        reasoning: 'reasoning for run A',
        toolResult: 'result A',
      }),
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'item_2',
        runMarker: 'run-b',
        toolName: 'Web Search',
        toolArgs: '{"query":"Hermes"}',
        reasoning: 'reasoning for run B',
        toolResult: 'result B',
      }),
    ])
  })

  it('keeps repeated coding-agent tool ids separate across live runs', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'codex'
    session.codingAgentId = 'codex'
    session.messages = [{
      id: 'old-tool',
      role: 'tool',
      content: '',
      timestamp: Date.now() - 1_000,
      toolName: 'Command',
      toolCallId: 'item_2',
      toolArgs: '{"command":"pwd"}',
      toolResult: 'old result',
      toolStatus: 'done',
      runMarker: 'run-a',
    }]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run another command')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1', run_marker: 'run-b' })
    onEvent({
      event: 'tool.started',
      session_id: 'session-1',
      run_marker: 'run-b',
      tool_call_id: 'item_2',
      tool: 'Command',
      arguments: '{"command":"ls"}',
    } as RunEvent)

    expect(store.messages.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        id: 'old-tool',
        runMarker: 'run-a',
        toolStatus: 'done',
        toolResult: 'old result',
      }),
      expect.objectContaining({
        runMarker: 'run-b',
        toolStatus: 'running',
        toolArgs: '{"command":"ls"}',
      }),
    ])

    onEvent({
      event: 'tool.completed',
      session_id: 'session-1',
      run_marker: 'run-b',
      tool_call_id: 'item_2',
      tool: 'Command',
      output: 'new result',
    } as RunEvent)

    expect(store.messages.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        id: 'old-tool',
        runMarker: 'run-a',
        toolStatus: 'done',
        toolResult: 'old result',
      }),
      expect.objectContaining({
        runMarker: 'run-b',
        toolStatus: 'done',
        toolResult: 'new result',
      }),
    ])
  })

  it('creates a scoped tool row when completion arrives without a start event', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.messages = [{
      id: 'old-tool',
      role: 'tool',
      content: '',
      timestamp: Date.now() - 1_000,
      toolName: 'Command',
      toolCallId: 'item_2',
      toolResult: 'old result',
      toolStatus: 'done',
      runMarker: 'run-a',
    }]
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('resume the run')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({
      event: 'tool.completed',
      session_id: 'session-1',
      run_marker: 'run-b',
      tool_call_id: 'item_2',
      tool: 'Command',
      output: 'replayed result',
    } as RunEvent)

    expect(store.messages.filter(message => message.role === 'tool')).toEqual([
      expect.objectContaining({
        id: 'old-tool',
        runMarker: 'run-a',
        toolResult: 'old result',
      }),
      expect.objectContaining({
        runMarker: 'run-b',
        toolStatus: 'done',
        toolResult: 'replayed result',
      }),
    ])
  })

  it('attaches completion output to post-tool reasoning when no body delta arrived', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('inspect and summarize')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })
    onEvent({ event: 'reasoning.delta', session_id: 'session-1', delta: 'Before tool.' })
    onEvent({
      event: 'tool.started',
      session_id: 'session-1',
      tool_call_id: 'tool-1',
      tool: 'read_file',
      arguments: '{}',
    } as RunEvent)
    onEvent({
      event: 'tool.completed',
      session_id: 'session-1',
      tool_call_id: 'tool-1',
      output: 'tool output',
    } as RunEvent)
    onEvent({ event: 'reasoning.delta', session_id: 'session-1', delta: 'After tool.' })
    onEvent({
      event: 'run.completed',
      session_id: 'session-1',
      output: 'Final answer without a body delta.',
    })

    expect(store.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(store.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: '',
      reasoning: 'Before tool.',
      isStreaming: false,
    }))
    expect(store.messages[3]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Final answer without a body delta.',
      reasoning: 'After tool.',
      isStreaming: false,
    }))
  })

  it('uses interim assistant text as authoritative and seals each segment', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('verify the result')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: 'partial' })
    onEvent({
      event: 'message.interim',
      session_id: 'session-1',
      text: 'partial answer',
      already_streamed: true,
    })
    onEvent({
      event: 'message.interim',
      session_id: 'session-1',
      text: 'callback-only commentary',
      already_streamed: false,
    })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: 'final answer' })

    expect(store.messages.filter(message => message.role === 'assistant')).toEqual([
      expect.objectContaining({ content: 'partial answer', isStreaming: false }),
      expect.objectContaining({ content: 'callback-only commentary', isStreaming: false }),
      expect.objectContaining({ content: 'final answer', isStreaming: true }),
    ])
  })

  it('renders MoA reference and aggregating events as tools before the final assistant message', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('你好')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({
      event: 'session.command',
      session_id: 'session-1',
      action: 'moa',
      started: true,
      terminal: false,
      preset: 'default',
      moa: {
        preset: 'default',
        reference_models: ['xai-oauth:grok-4.3', 'custom:fun-codex:gpt-5.5'],
        aggregator: 'glm:glm-5.2',
      },
    } as RunEvent)
    onEvent({ event: 'run.started', session_id: 'session-1' })
    onEvent({
      event: 'moa.reference',
      session_id: 'session-1',
      label: 'grok-4.3',
      text: 'reference answer',
      index: 1,
      count: 2,
    })
    onEvent({
      event: 'moa.aggregating',
      session_id: 'session-1',
      aggregator: 'deepseek-v4-pro',
    })
    onEvent({ event: 'run.completed', session_id: 'session-1', output: 'final answer' })

    expect(store.messages.map(message => message.role)).toEqual(['user', 'tool', 'tool', 'assistant'])
    expect(store.messages[1]).toEqual(expect.objectContaining({
      role: 'tool',
      toolName: 'moa_reference',
      toolPreview: '1/2 grok-4.3',
      toolStatus: 'done',
      toolResult: 'reference answer',
    }))
    expect(store.messages[2]).toEqual(expect.objectContaining({
      role: 'tool',
      toolName: 'moa_aggregating',
      toolPreview: 'deepseek-v4-pro',
      toolStatus: 'done',
      toolArgs: { aggregator: 'deepseek-v4-pro' },
    }))
    expect(store.messages[3]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'final answer',
    }))
    expect(store.messages.some(message => message.role === 'system' && message.content.includes('Agent returned no output'))).toBe(false)
  })

  it('does not add a front-end MoA discussion placeholder from session.command start', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('你好')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({
      event: 'session.command',
      session_id: 'session-1',
      action: 'moa',
      started: true,
      terminal: false,
      preset: 'default',
      moa: { preset: 'default', reference_models: ['a:model'], aggregator: 'agg:model' },
    } as RunEvent)

    expect(store.messages.some(message => message.toolName === 'moa_discussion')).toBe(false)
    expect(store.messages.map(message => message.role)).toEqual(['user'])
  })

  it('restores persisted MoA tool rows from session history', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    sessionsApi.fetchSessionMessagesPage.mockResolvedValue({
      session: { id: 'session-1', title: 'session' },
      messages: [
        {
          id: 1,
          role: 'command',
          content: '/moa 你好',
          timestamp: 1,
        },
        {
          id: 2,
          role: 'moa',
          display_role: 'tool',
          content: JSON.stringify({
            label: 'xai-oauth:grok-4.3',
            preview: '1/2 xai-oauth:grok-4.3',
            text: 'reference answer',
            index: 1,
            count: 2,
          }),
          tool_name: 'moa_reference',
          tool_call_id: 'moa:reference:run-1:1',
          timestamp: 2,
        },
        {
          id: 3,
          role: 'moa',
          display_role: 'tool',
          content: JSON.stringify({
            aggregator: 'glm:glm-5.2',
            preview: 'glm:glm-5.2',
            text: 'glm:glm-5.2',
          }),
          tool_name: 'moa_aggregating',
          tool_call_id: 'moa:aggregating:run-1',
          timestamp: 3,
        },
      ],
      total: 3,
      hasMore: false,
    })

    await store.refreshActiveSession()

    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'command',
        content: '/moa 你好',
      }),
      expect.objectContaining({
        role: 'tool',
        toolName: 'moa_reference',
        toolPreview: '1/2 xai-oauth:grok-4.3',
        toolResult: 'reference answer',
        toolStatus: 'done',
      }),
      expect.objectContaining({
        role: 'tool',
        toolName: 'moa_aggregating',
        toolPreview: 'glm:glm-5.2',
        toolResult: 'glm:glm-5.2',
        toolStatus: 'done',
      }),
    ])
  })

  it('settles running coding-agent tools when the run completes without a tool.completed event', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'claude'
    session.codingAgentId = 'claude-code'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('run pwd')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })
    onEvent({
      event: 'tool.started',
      session_id: 'session-1',
      tool_call_id: 'tool-1',
      tool: 'Bash',
      arguments: '{"command":"pwd"}',
    } as RunEvent)
    expect(store.messages.find(message => message.role === 'tool')).toEqual(expect.objectContaining({
      toolStatus: 'running',
    }))

    onEvent({ event: 'run.completed', session_id: 'session-1', output: 'done' })

    expect(store.messages.find(message => message.role === 'tool')).toEqual(expect.objectContaining({
      toolStatus: 'done',
    }))
  })

  it('does not drop repeated small markdown delimiters while streaming', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('show code')

    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: '```' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: 'ts' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: '\n' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: 'const value = 1' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: '\n' })
    onEvent({ event: 'message.delta', session_id: 'session-1', delta: '```' })

    expect(store.messages.find(message => message.role === 'assistant')?.content).toBe([
      '```ts',
      'const value = 1',
      '```',
    ].join('\n'))
  })

  it('queues active coding agent follow-up messages without command styling', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'claude'
    session.codingAgentId = 'claude-code'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('first input')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({
      event: 'agent.event',
      session_id: 'session-1',
      source: 'coding_agent',
      kind: 'status',
      text: 'Input sent to coding agent.',
    })
    expect(store.messages).toHaveLength(1)

    onEvent({ event: 'run.started', session_id: 'session-1' })

    await store.sendMessage('/not-a-hermes-command')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(2)
    expect(store.queuedUserMessages.get('session-1')).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '/not-a-hermes-command',
        queued: true,
        systemType: undefined,
      }),
    ])
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'first input',
        queued: false,
      }),
    ])
  })

  it('queues unknown slash commands in bridge sessions as normal user input', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('first input')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })

    await store.sendMessage('/terminal pwd')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(2)
    expect(store.queuedUserMessages.get('session-1')).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '/terminal pwd',
        queued: true,
        systemType: undefined,
      }),
    ])
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'first input',
        queued: false,
      }),
    ])
  })

  it('queues /moa commands in active bridge sessions without adding a visible command echo', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('first input')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })

    await store.sendMessage('/moa 你好')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(2)
    expect(store.queuedUserMessages.get('session-1')).toEqual([
      expect.objectContaining({
        role: 'command',
        content: '/moa 你好',
        queued: true,
        systemType: 'command',
      }),
    ])
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'first input',
        queued: false,
      }),
    ])
  })

  it('sends unknown slash commands in idle bridge sessions as normal user input', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'cli'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('/terminal pwd')

    expect(chatApi.startRunViaSocket).toHaveBeenCalledTimes(1)
    expect(chatApi.startRunViaSocket.mock.calls[0][0]).toEqual(expect.objectContaining({
      input: '/terminal pwd',
      session_id: 'session-1',
      source: 'cli',
    }))
    expect(store.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '/terminal pwd',
        queued: false,
        systemType: undefined,
      }),
    ])
  })

  it('starts global coding-agent runs without provider credentials', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'codex'
    session.codingAgentId = 'codex'
    session.codingAgentMode = 'global'
    session.provider = 'should-not-send'
    session.model = 'should-not-send'
    session.baseUrl = 'http://example.invalid'
    session.apiKey = 'secret'
    session.apiMode = 'chat_completions'
    session.reasoningEffort = 'high'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('use global codex auth')

    const body = chatApi.startRunViaSocket.mock.calls[0][0]
    expect(body).toEqual(expect.objectContaining({
      source: 'coding_agent',
      coding_agent_id: 'codex',
      mode: 'global',
    }))
    expect(body.provider).toBeUndefined()
    expect(body.model).toBeUndefined()
    expect(body.baseUrl).toBeUndefined()
    expect(body.apiKey).toBeUndefined()
    expect(body.apiMode).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('sends the hidden API mode when starting a scoped Ekko run', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'ekko-agent'
    session.codingAgentId = 'ekko-agent'
    session.codingAgentMode = 'scoped'
    session.provider = 'custom:fun-codex'
    session.model = 'gpt-5.5'
    session.baseUrl = 'https://api.apikey.fan/v1'
    session.apiMode = 'codex_responses'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('check the weather')

    expect(chatApi.startRunViaSocket.mock.calls[0][0]).toEqual(expect.objectContaining({
      source: 'coding_agent',
      coding_agent_id: 'ekko-agent',
      mode: 'scoped',
      provider: 'custom:fun-codex',
      model: 'gpt-5.5',
      apiMode: 'codex_responses',
    }))
  })

  it('clears stale coding-agent runtime credentials when switching providers', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'codex'
    session.codingAgentId = 'codex'
    session.codingAgentMode = 'scoped'
    session.provider = 'xiaomi'
    session.model = 'mimo-v2.5-pro'
    session.baseUrl = 'https://api.xiaomimimo.com/v1'
    session.apiKey = 'sk-xiaomi'
    session.apiMode = 'chat_completions'
    session.reasoningEffort = 'high'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    const ok = await store.switchSessionModel('deepseek-v4-pro', 'deepseek', 'session-1', 'chat_completions')

    expect(ok).toBe(true)
    expect(sessionsApi.setSessionModel).toHaveBeenCalledWith(
      'session-1',
      'deepseek-v4-pro',
      'deepseek',
      'chat_completions',
    )
    expect(session.provider).toBe('deepseek')
    expect(session.model).toBe('deepseek-v4-pro')
    expect(session.baseUrl).toBeUndefined()
    expect(session.apiKey).toBeUndefined()
    expect(session.apiMode).toBe('chat_completions')
    expect(session.reasoningEffort).toBeUndefined()
  })

  it('keeps a local-only session workspace when switching models before the first message', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.isLocalOnly = true
    session.workspace = 'D:\\projects\\hermes'
    session.provider = 'deepseek'
    session.model = 'deepseek-chat'
    session.reasoningEffort = 'max'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    const ok = await store.switchSessionModel('deepseek-reasoner', 'deepseek', 'session-1')

    expect(ok).toBe(true)
    expect(sessionsApi.setSessionModel).not.toHaveBeenCalled()
    expect(session.model).toBe('deepseek-reasoner')
    expect(session.provider).toBe('deepseek')
    expect(session.reasoningEffort).toBeUndefined()
    expect(session.workspace).toBe('D:\\projects\\hermes')
    expect(session.isLocalOnly).toBe(true)

    await store.sendMessage('inspect this workspace')

    expect(chatApi.startRunViaSocket.mock.calls[0][0]).toEqual(expect.objectContaining({
      session_id: 'session-1',
      model: 'deepseek-reasoner',
      provider: 'deepseek',
      workspace: 'D:\\projects\\hermes',
    }))
  })

  it('preserves a scoped coding-agent API mode when reselecting the same provider', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'codex'
    session.codingAgentId = 'codex'
    session.codingAgentMode = 'scoped'
    session.provider = 'fun-codex'
    session.model = 'gpt-5.4'
    session.apiMode = 'chat_completions'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    const ok = await store.switchSessionModel('gpt-5.5', 'fun-codex', 'session-1')

    expect(ok).toBe(true)
    expect(sessionsApi.setSessionModel).toHaveBeenCalledWith(
      'session-1',
      'gpt-5.5',
      'fun-codex',
      'chat_completions',
    )
    expect(session.apiMode).toBe('chat_completions')
  })

  it('sends the selected workspace when starting a coding-agent run', async () => {
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'claude'
    session.codingAgentId = 'claude-code'
    session.codingAgentMode = 'scoped'
    session.provider = 'openrouter'
    session.model = 'anthropic/claude-sonnet-4.6'
    session.baseUrl = 'https://openrouter.ai/api/v1'
    session.apiKey = 'sk-test'
    session.apiMode = 'anthropic_messages'
    session.workspace = '/workspace/project-a'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('use this project')

    expect(chatApi.startRunViaSocket.mock.calls[0][0]).toEqual(expect.objectContaining({
      source: 'coding_agent',
      coding_agent_id: 'claude-code',
      mode: 'scoped',
      workspace: '/workspace/project-a',
    }))
  })

  it('keeps a local stream controller for active coding-agent runs', async () => {
    const abort = vi.fn()
    chatApi.startRunViaSocket.mockReturnValue({ abort })
    const store = useChatStore()
    const session = makeSession()
    session.source = 'coding_agent'
    session.agent = 'claude'
    session.codingAgentId = 'claude-code'
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session

    await store.sendMessage('long running task')
    const onEvent = chatApi.startRunViaSocket.mock.calls[0][1] as (event: RunEvent) => void
    onEvent({ event: 'run.started', session_id: 'session-1' })

    store.stopStreaming()

    expect(abort).toHaveBeenCalledTimes(1)
    expect(chatApi.socketEmit).not.toHaveBeenCalled()
    expect(store.abortState).toEqual(expect.objectContaining({ aborting: true }))
  })

  it('keeps a session in the local list when server deletion fails', async () => {
    const store = useChatStore()
    const session = makeSession()
    store.sessions = [session]
    store.activeSessionId = 'session-1'
    store.activeSession = session
    sessionsApi.deleteSession.mockResolvedValue(false)

    await expect(store.deleteSession('session-1')).resolves.toBe(false)

    expect(store.sessions).toEqual([session])
    expect(store.activeSessionId).toBe('session-1')
  })
})
