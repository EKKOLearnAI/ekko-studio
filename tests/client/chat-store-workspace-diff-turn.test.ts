// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { alignWorkspaceChangeAssistantMessage, attachWorkspaceChangesToExactTurns, useChatStore } from '@/stores/hermes/chat'

const sessionApi = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchSessionMessagesPage: vi.fn(),
}))

const chatApi = vi.hoisted(() => ({
  resumePayload: null as any,
  resumeSession: vi.fn((sessionId: string, callback: (data: any) => void) => {
    callback({ ...chatApi.resumePayload, session_id: sessionId })
    return {} as any
  }),
  startRunViaSocket: vi.fn(() => ({ abort: vi.fn() })),
}))

vi.mock('@/api/studio/sessions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  fetchSessionMessagesPage: sessionApi.fetchSessionMessagesPage,
  fetchSessions: sessionApi.fetchSessions,
  fetchWorkspaceRunChangeFile: vi.fn(async () => null),
  setSessionModel: vi.fn(),
}))

vi.mock('@/api/studio/chat', () => ({
  startRunViaSocket: chatApi.startRunViaSocket,
  resumeSession: chatApi.resumeSession,
  registerSessionHandlers: vi.fn(),
  unregisterSessionHandlers: vi.fn(),
  getChatRunSocket: vi.fn(() => ({ emit: vi.fn() })),
  respondToolApproval: vi.fn(),
  respondClarify: vi.fn(),
  onPeerUserMessage: vi.fn(() => vi.fn()),
  onSessionCommand: vi.fn(() => vi.fn()),
  onSessionTitleUpdated: vi.fn(() => vi.fn()),
  onSessionWorkspaceUpdated: vi.fn(() => vi.fn()),
  onSessionSettingsUpdated: vi.fn(() => vi.fn()),
}))

vi.mock('@/api/client', () => ({ getActiveProfileName: () => 'default' }))
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: (_path: string, name: string) => `/download/${name}` }))
vi.mock('@/utils/completion-sound', () => ({ primeCompletionSound: vi.fn(), playCompletionSound: vi.fn() }))
vi.mock('@/utils/completion-notification', () => ({ showCompletionNotification: vi.fn() }))
vi.mock('@/utils/session-sync', () => ({ subscribeSessionSync: vi.fn(() => vi.fn()), publishSessionSync: vi.fn() }))

function summary() {
  return {
    id: 'session-1', profile: 'default', source: 'coding_agent', agent: 'codex', title: 'Turn changes',
    preview: '', started_at: 1, ended_at: 2, last_active: 2, message_count: 4, tool_call_count: 0,
    input_tokens: 0, output_tokens: 0, model: 'gpt-test', provider: 'test',
  }
}

function change(id: string, assistantMessageId?: string) {
  return {
    change_id: id,
    assistant_message_id: assistantMessageId || '',
    session_id: 'session-1', run_id: 'run-1', source: 'run', workspace: '/tmp/repo', workspace_kind: 'git',
    started_at: 1, finished_at: 2, files_changed: 1, additions: 2, deletions: 1,
    truncated: false, total_patch_bytes: 20, created_at: 2,
    files: [{
      id: id === 'change-1' ? 1 : 2, change_id: id, session_id: 'session-1', path: `${id}.ts`, old_path: null,
      change_type: 'modified', additions: 2, deletions: 1, size_before: 1, size_after: 2,
      patch_bytes: 20, truncated: false, binary: false, created_at: 2,
    }],
  }
}

describe('chat workspace diff turn association', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    setActivePinia(createPinia())
    sessionApi.fetchSessions.mockResolvedValueOnce([summary()]).mockResolvedValueOnce([])
    sessionApi.fetchSessionMessagesPage.mockReset()
    chatApi.resumePayload = {
      isWorking: false,
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'first', timestamp: 1 },
        { id: 2, session_id: 'session-1', role: 'assistant', content: 'first done', timestamp: 2 },
        { id: 3, session_id: 'session-1', role: 'user', content: 'second', timestamp: 3 },
        { id: 4, session_id: 'session-1', role: 'assistant', content: 'second done', timestamp: 4 },
      ],
      events: [], queueLength: 0, messageLoadedCount: 4, messageTotal: 4, hasMoreBefore: false,
    }
  })

  it('restores each completed run summary on its own reply, including a summary-only assistant', async () => {
    const usage = { runId: 'first', assistantMessageId: '2', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheHitRate: 0.5, costUsd: 0.001, tokensPerSecond: 10, speedSource: 'run', isEstimated: false }
    chatApi.resumePayload.messages[1].run_usage = usage
    chatApi.resumePayload.messages[3].run_usage = { ...usage, runId: 'second', assistantMessageId: '4', outputTokens: 0, tokensPerSecond: null }
    chatApi.resumePayload.messages[3].content = ''
    chatApi.resumePayload.messages[3].tool_calls = [{ id: 'last-tool', function: { name: 'read_file', arguments: '{}' } }]
    const store = useChatStore()
    await store.loadSessions()
    expect(store.activeSession?.messages.find(message => message.id === '2')?.runUsage).toEqual(usage)
    expect(store.activeSession?.messages.find(message => message.id === '4')?.runUsage).toMatchObject({ runId: 'second', outputTokens: 0, tokensPerSecond: null })
    expect(store.activeSession?.messages.filter(message => message.role === 'user').every(message => !message.runUsage)).toBe(true)
    expect(store.activeSession?.messages.find(message => message.toolCallId === 'last-tool')?.toolName).toBe('read_file')
  })

  it('attaches each persisted change to its exact assistant turn without synthetic cards', async () => {
    chatApi.resumePayload.workspaceRunChanges = [
      change('change-1', '2'),
      change('change-2', '4'),
      change('change-3', '4'),
    ]

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSession?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(store.activeSession?.messages.find(message => message.id === '2')?.workspaceChanges?.map(item => item.change_id)).toEqual([
      'change-1',
    ])
    expect(store.activeSession?.messages.find(message => message.id === '4')?.workspaceChanges?.map(item => item.change_id)).toEqual([
      'change-2',
      'change-3',
    ])
  })

  it('does not restore a tool-call workspace card when the change has no assistant message id', async () => {
    chatApi.resumePayload.messages.splice(3, 0, {
      id: 5,
      session_id: 'session-1',
      role: 'tool',
      content: 'workspace result',
      tool_call_id: 'tool-change',
      timestamp: 3.5,
    })
    chatApi.resumePayload.workspaceRunChanges = [change('tool-change')]

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSession?.messages.find(message => message.toolCallId === 'tool-change')).toBeDefined()
    expect(store.activeSession?.messages.some(message => message.id.startsWith('workspace-run-change:'))).toBe(false)
  })

  it('does not render a standalone fallback for legacy changes without an assistant message id', async () => {
    chatApi.resumePayload.workspaceRunChanges = [
      change('legacy-change-1'),
      change('legacy-change-2'),
    ]

    const store = useChatStore()
    await store.loadSessions()

    const legacy = store.activeSession?.messages.filter(message => message.id.startsWith('workspace-run-change:'))
    expect(legacy).toEqual([])
  })

  it('does not render a standalone card when an attributed assistant is not loaded', async () => {
    chatApi.resumePayload.workspaceRunChanges = [
      change('unresolved-change', 'missing-assistant'),
    ]

    const store = useChatStore()
    await store.loadSessions()

    expect(store.activeSession?.messages).toHaveLength(4)
    expect(store.activeSession?.messages.some(message => message.id.startsWith('workspace-run-change:'))).toBe(false)
    expect(store.activeSession?.messages.every(message => (message.workspaceChanges?.length || 0) === 0)).toBe(true)
  })

  it('aligns a live assistant temporary id with the persisted attribution id', () => {
    const messages = [{
      id: 'temporary-assistant',
      role: 'assistant' as const,
      content: 'third done',
      timestamp: 5,
      isStreaming: false,
    }]
    const attributedChange = change('change-live', '42')

    expect(alignWorkspaceChangeAssistantMessage(messages, attributedChange, 'temporary-assistant')).toBe('42')
    expect(messages[0].id).toBe('42')
    attachWorkspaceChangesToExactTurns(messages, [attributedChange])
    expect(messages[0].workspaceChanges?.map(item => item.change_id)).toEqual(['change-live'])
  })

  it('hides an unresolved explicit association until pagination loads its assistant', () => {
    const unresolved = change('change-page-1', '2')
    const messages = [
      { id: '4', role: 'assistant' as const, content: 'newer', timestamp: 4 },
    ]

    attachWorkspaceChangesToExactTurns(messages, [unresolved])
    expect(messages).toHaveLength(1)
    expect(messages[0].workspaceChanges).toEqual([])

    messages.unshift({ id: '2', role: 'assistant', content: 'older', timestamp: 2 })
    attachWorkspaceChangesToExactTurns(messages, [unresolved])
    expect(messages[0].workspaceChanges?.map(item => item.change_id)).toEqual(['change-page-1'])
  })

  it('drops unattributed changes without creating standalone messages', () => {
    const messages = [
      { id: '4', role: 'assistant' as const, content: 'newer', timestamp: 4 },
    ]

    attachWorkspaceChangesToExactTurns(messages, [change('legacy-change')])
    expect(messages).toHaveLength(1)
    expect(messages[0].workspaceChanges).toEqual([])
  })

  it('never attaches workspace changes to tool messages', () => {
    const messages = [{
      id: 'tool-1', role: 'tool' as const, content: '', timestamp: 1,
    }]

    attachWorkspaceChangesToExactTurns(messages, [change('turn-change', 'tool-1')])

    expect(messages[0].workspaceChanges).toEqual([])
  })

  it('merges workspace changes only when their older message page is loaded', async () => {
    chatApi.resumePayload = {
      ...chatApi.resumePayload,
      messages: chatApi.resumePayload.messages.slice(2),
      workspaceRunChanges: [change('change-2', '4')],
      messageLoadedCount: 2,
      messageTotal: 4,
      hasMoreBefore: true,
    }
    sessionApi.fetchSessionMessagesPage.mockResolvedValue({
      session: summary(),
      messages: [
        { id: 1, session_id: 'session-1', role: 'user', content: 'first', timestamp: 1 },
        { id: 2, session_id: 'session-1', role: 'assistant', content: 'first done', timestamp: 2 },
      ],
      workspaceRunChanges: [change('change-1', '2')],
      total: 4,
      offset: 2,
      limit: 150,
      hasMore: false,
    })

    const store = useChatStore()
    await store.loadSessions()
    expect(store.activeSession?.messages.find(message => message.id === '4')?.workspaceChanges?.[0]?.change_id).toBe('change-2')

    await store.loadOlderMessages('session-1')

    expect(store.activeSession?.messages.find(message => message.id === '2')?.workspaceChanges?.[0]?.change_id).toBe('change-1')
    expect(store.activeSession?.messages.find(message => message.id === '4')?.workspaceChanges?.[0]?.change_id).toBe('change-2')
    expect(sessionApi.fetchSessionMessagesPage).toHaveBeenCalledWith('session-1', 2, 150, 'default')
  })
})
