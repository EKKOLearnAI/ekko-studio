// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage, RoomInfo } from '@/api/studio/group-chat'

const groupChatApiMock = vi.hoisted(() => {
  const handlers = new Map<string, Function[]>()
  const socket: any = {
    connected: true,
    id: 'socket-1',
    on: vi.fn((event: string, cb: Function) => {
      const existing = handlers.get(event) || []
      existing.push(cb)
      handlers.set(event, existing)
      return socket
    }),
    emit: vi.fn((event: string, _data?: unknown, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      return socket
    }),
    disconnect: vi.fn(),
  }
  return {
    handlers,
    socket,
    connectGroupChat: vi.fn(() => socket),
    disconnectGroupChat: vi.fn(),
    getSocket: vi.fn(() => socket),
    getStoredUserId: vi.fn(() => 'user-1'),
    getStoredUserName: vi.fn(() => 'tester'),
    createRoom: vi.fn(),
    listRooms: vi.fn(),
    getRoomDetail: vi.fn(),
    joinRoomByCode: vi.fn(),
    addAgent: vi.fn(),
    listAgents: vi.fn(),
    removeAgent: vi.fn(),
    cloneRoom: vi.fn(),
    deleteRoom: vi.fn(),
    clearRoomContext: vi.fn(),
    updateInviteCode: vi.fn(),
  }
})
const clientApiMock = vi.hoisted(() => ({
  getApiKey: vi.fn(() => 'test-token'),
  getBaseUrlValue: vi.fn(() => ''),
  getActiveProfileName: vi.fn(() => 'research'),
  getStoredUsername: vi.fn(() => null),
}))
const authApiMock = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
}))
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/studio/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => clientApiMock)
vi.mock('@/api/studio/auth', () => authApiMock)
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: vi.fn((path: string) => `/download?path=${path}`) }))
vi.stubGlobal('fetch', fetchMock)

function emitSocket(event: string, payload: unknown) {
  for (const cb of groupChatApiMock.handlers.get(event) || []) cb(payload)
}

const room: RoomInfo = {
  id: 'room-1',
  name: 'Test Room',
  inviteCode: 'ROOM1',
  workspace: '',
}

function assistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'bot',
    content: '',
    timestamp: 1,
    role: 'assistant',
    ...overrides,
  }
}

async function createJoinedStore(initialMessages: ChatMessage[] = []) {
  groupChatApiMock.getRoomDetail.mockResolvedValue({
    room,
    messages: initialMessages,
    agents: [],
    members: [],
  })
  const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
  const store = useGroupChatStore()
  store.connect()
  await store.joinRoom('room-1')
  groupChatApiMock.getRoomDetail.mockClear()
  return store
}

describe('group chat store streaming merge', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    groupChatApiMock.handlers.clear()
    for (const key of Object.keys(groupChatApiMock)) {
      const value = (groupChatApiMock as any)[key]
      if (value?.mockReset && key !== 'socket') value.mockReset()
    }
    groupChatApiMock.connectGroupChat.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.getSocket.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.getStoredUserId.mockReturnValue('user-1')
    groupChatApiMock.getStoredUserName.mockReturnValue('tester')
    clientApiMock.getApiKey.mockReturnValue('test-token')
    clientApiMock.getBaseUrlValue.mockReturnValue('')
    clientApiMock.getActiveProfileName.mockReturnValue('research')
    clientApiMock.getStoredUsername.mockReturnValue(null)
    authApiMock.fetchCurrentUser.mockRejectedValue(new Error('not signed in'))
    fetchMock.mockReset()
    groupChatApiMock.socket.on.mockClear()
    groupChatApiMock.socket.emit.mockReset()
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: unknown, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      return groupChatApiMock.socket
    })
    groupChatApiMock.socket.disconnect.mockClear()
  })

  it('restores live text and reasoning on repeated room switches and keeps consuming deltas', async () => {
    vi.useFakeTimers()
    const store = await createJoinedStore()
    const snapshots = new Map<string, ChatMessage[]>([
      ['room-1', [assistantMessage({ content: 'Stage one', reasoning: 'Thinking one', isStreaming: true, finish_reason: 'streaming' })]],
      ['room-2', []],
    ])
    groupChatApiMock.getRoomDetail.mockImplementation(async (id: string) => ({
      room: { ...room, id }, messages: [], agents: [], members: [],
    }))
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join') ack?.({ messages: structuredClone(snapshots.get(data.roomId)), members: [], agents: [] })
      return groupChatApiMock.socket
    })

    for (let round = 0; round < 2; round++) {
      await store.joinRoom('room-2')
      expect(store.messages).toHaveLength(0)
      emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: 'hidden' })
      await store.joinRoom('room-1')
      expect(store.messages).toEqual([expect.objectContaining({ content: 'Stage one', reasoning: 'Thinking one', isStreaming: true })])
      emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' continued' })
      emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: ' continued' })
      await vi.advanceTimersByTimeAsync(100)
      expect(store.messages[0]).toMatchObject({ content: 'Stage one continued', reasoning: 'Thinking one continued' })
    }
    emitSocket('message', assistantMessage({ content: 'Done', finish_reason: 'stop' }))
    expect(store.messages[0]).toMatchObject({ content: 'Done', isStreaming: false })
  })

  it('flushes queued deltas before merging a reconnect snapshot that already includes them', async () => {
    vi.useFakeTimers()
    const store = await createJoinedStore()
    emitSocket('message_stream_start', assistantMessage({ content: 'A' }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: 'B' })
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: 'thinking' })
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, ack?: Function) => {
      if (event === 'join') ack?.({ messages: [assistantMessage({ content: 'AB', reasoning: 'thinking', reasoning_content: 'thinking', isStreaming: true })] })
      return groupChatApiMock.socket
    })
    emitSocket('connect', undefined)
    await vi.advanceTimersByTimeAsync(100)
    expect(store.messages[0]).toMatchObject({ content: 'AB', reasoning: 'thinking', isStreaming: true })
  })

  it('settles a live row from a persisted reconnect snapshot and does not revive it with a stale live row', async () => {
    const store = await createJoinedStore()
    emitSocket('message_stream_start', assistantMessage({ content: 'Partial' }))
    let snapshot = assistantMessage({ content: 'Complete', finish_reason: 'stop' })
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, ack?: Function) => {
      if (event === 'join') ack?.({ messages: [snapshot] })
      return groupChatApiMock.socket
    })
    emitSocket('connect', undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.messages[0]).toMatchObject({ content: 'Complete', isStreaming: false })
    snapshot = assistantMessage({ content: 'Partial', isStreaming: true, finish_reason: 'streaming' })
    emitSocket('connect', undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(store.messages[0]).toMatchObject({ content: 'Complete', isStreaming: false })
  })

  it('clears previous room typing and context before the new join acknowledgment arrives', async () => {
    const store = await createJoinedStore()
    emitSocket('typing', { roomId: 'room-1', userId: 'other', userName: 'Other' })
    emitSocket('context_status', { roomId: 'room-1', agentName: 'Old Worker', status: 'compressing' })
    store.emitTyping()
    let ack: Function | undefined
    groupChatApiMock.getRoomDetail.mockResolvedValue({ room: { ...room, id: 'room-2' }, messages: [], agents: [], members: [] })
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, callback?: Function) => {
      if (event === 'join') ack = callback
      return groupChatApiMock.socket
    })
    const joining = store.joinRoom('room-2')
    await vi.waitFor(() => expect(ack).toBeDefined())
    expect(store.currentRoomId).toBe('room-2')
    expect(store.typingNames).toEqual([])
    expect(store.contextStatus).toBeNull()
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('stop_typing', { roomId: 'room-1' })
    ack?.({ contextStatuses: [{ agentName: 'New Worker', status: 'replying' }], typingUsers: [{ userId: 'new', userName: 'New' }] })
    await joining
    expect(store.typingNames).toEqual(['New'])
    expect(store.contextStatus?.agentName).toBe('New Worker')
  })

  it('ignores slower previous room requests when switching quickly', async () => {
    const store = await createJoinedStore()
    let resolveOld!: (value: any) => void
    groupChatApiMock.getRoomDetail.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const old = store.joinRoom('room-2')
    groupChatApiMock.getRoomDetail.mockResolvedValueOnce({ room: { ...room, id: 'room-3' }, messages: [], agents: [], members: [] })
    await store.joinRoom('room-3')
    resolveOld({ room: { ...room, id: 'room-2' }, messages: [], agents: [], members: [] })
    await old
    expect(store.currentRoomId).toBe('room-3')
    expect(store.isJoining).toBe(false)
  })

  it('restores room summary snapshots and ignores older updates within the same summary version', async () => {
    const store = await createJoinedStore()
    const summary = (status: string, updatedAt: number) => ({ roomId: 'room-1', version: 1, status, updatedAt, summary: '' })
    emitSocket('room_summary_updated', summary('summarizing', 10))
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, ack?: Function) => {
      if (event === 'join') ack?.({ roomSummary: summary('idle', 20) })
      return groupChatApiMock.socket
    })
    emitSocket('connect', undefined)
    await vi.waitFor(() => expect(store.roomSummaryStates.get('room-1')?.status).toBe('idle'))
    emitSocket('room_summary_updated', summary('summarizing', 10))
    store.applyRoomSummaryState(summary('summarizing', 15) as any)
    expect(store.roomSummaryStates.get('room-1')?.status).toBe('idle')
    emitSocket('room_summary_updated', { ...summary('summarizing', 30), roomId: 'room-2' })
    expect(store.roomSummaryStates.get('room-1')?.status).toBe('idle')
  })

  it('clears transient indicators on disconnect and restores only the new snapshot', async () => {
    const store = await createJoinedStore()
    emitSocket('typing', { roomId: 'room-1', userId: 'other', userName: 'Other' })
    emitSocket('context_status', { roomId: 'room-1', agentName: 'Worker', status: 'replying' })
    emitSocket('disconnect', 'transport close')
    expect(store.typingNames).toEqual([])
    expect(store.contextStatus).toBeNull()
    emitSocket('connect', undefined)
    await Promise.resolve()
    expect(store.typingNames).toEqual([])
    expect(store.contextStatus).toBeNull()
  })

  it('settles a historical Tool call without a persisted result instead of spinning forever', async () => {
    const store = await createJoinedStore([
      assistantMessage({
        id: 'run-orphan_part_0_toolcall_call-orphan',
        run_id: 'run-orphan',
        senderName: 'QA Engineer',
        tool_calls: [{
          id: 'call-orphan',
          type: 'function',
          function: { name: 'Bash', arguments: JSON.stringify({ command: 'pwd' }) },
        }],
        finish_reason: 'tool_calls',
      }),
    ])

    expect(store.sortedMessages).toEqual([
      expect.objectContaining({
        toolCallId: 'call-orphan',
        toolStatus: 'interrupted',
      }),
    ])
  })

  it('keeps an unmatched Tool call running while its streamed message is live', async () => {
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({
      id: 'run-live_part_0',
      run_id: 'run-live',
    }))
    emitSocket('context_status', { roomId: 'room-1', agentName: 'bot', status: 'replying' })
    emitSocket('message', assistantMessage({
      id: 'run-live_part_0_toolcall_call-live',
      run_id: 'run-live',
      isStreaming: true,
      tool_calls: [{
        id: 'call-live',
        type: 'function',
        function: { name: 'Bash', arguments: JSON.stringify({ command: 'pwd' }) },
      }],
      finish_reason: 'tool_calls',
    }))

    expect(store.sortedMessages.find((message: ChatMessage) => message.toolCallId === 'call-live')).toEqual(
      expect.objectContaining({ toolStatus: 'running' }),
    )
  })

  it('keeps persisted Tools inside the live Agent run when transport sender ids differ', async () => {
    const store = await createJoinedStore()
    const { groupAgentRunMessages } = await import('@/stores/hermes/group-chat')

    emitSocket('message_stream_start', assistantMessage({
      id: 'run-owned_part_0',
      senderId: 'transport-socket-id',
      senderAgentRecordId: 'agent-record-1',
      run_id: 'run-owned',
      finish_reason: 'streaming',
    }))
    emitSocket('message_reasoning_delta', {
      roomId: 'room-1',
      id: 'run-owned_part_0',
      delta: 'Inspecting.',
    })
    emitSocket('message', assistantMessage({
      id: 'run-owned_part_0_toolresult_call-owned',
      senderId: 'agent-stable-id',
      senderAgentRecordId: 'agent-record-1',
      timestamp: 2,
      run_id: 'run-owned',
      role: 'tool',
      tool_call_id: 'call-owned',
      tool_name: 'read_file',
      content: 'result',
    }))
    emitSocket('message', assistantMessage({
      id: 'run-owned_part_1',
      senderId: 'agent-stable-id',
      senderAgentRecordId: 'agent-record-1',
      timestamp: 3,
      run_id: 'run-owned',
      content: 'Finished.',
    }))

    const grouped = groupAgentRunMessages(store.sortedMessages)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]).toMatchObject({
      role: 'agent_run',
      run_id: 'run-owned',
      senderAgentRecordId: 'agent-record-1',
    })
    expect(grouped[0].runItems).toEqual([
      expect.objectContaining({ id: 'run-owned_part_0', reasoning: 'Inspecting.' }),
      expect.objectContaining({ role: 'tool', toolCallId: 'call-owned' }),
      expect.objectContaining({ id: 'run-owned_part_1', content: 'Finished.' }),
    ])
  })

  it('does not revive an older orphaned Tool call when the same agent starts a newer run', async () => {
    const store = await createJoinedStore([
      assistantMessage({
        id: 'run-old_part_0_toolcall_call-old',
        run_id: 'run-old',
        senderName: 'bot',
        timestamp: 1,
        tool_calls: [{
          id: 'call-old',
          type: 'function',
          function: { name: 'Bash', arguments: JSON.stringify({ command: 'old' }) },
        }],
        finish_reason: 'tool_calls',
      }),
      assistantMessage({
        id: 'run-live_part_0_toolcall_call-live',
        run_id: 'run-live',
        senderName: 'bot',
        timestamp: 2,
        tool_calls: [{
          id: 'call-live',
          type: 'function',
          function: { name: 'Bash', arguments: JSON.stringify({ command: 'live' }) },
        }],
        finish_reason: 'tool_calls',
      }),
    ])

    emitSocket('context_status', { roomId: 'room-1', agentName: 'bot', status: 'replying' })

    expect(store.sortedMessages.find((message: ChatMessage) => message.toolCallId === 'call-old')?.toolStatus)
      .toBe('interrupted')
    expect(store.sortedMessages.find((message: ChatMessage) => message.toolCallId === 'call-live')?.toolStatus)
      .toBe('running')
  })

  it('preserves streamed reasoning when the final message supplies content only', async () => {
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: 'thinking...' })
    emitSocket('message', assistantMessage({ id: 'msg-1', content: '收到', reasoning: null, reasoning_content: null }))

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: '收到',
      reasoning: 'thinking...',
      reasoning_content: 'thinking...',
      isStreaming: false,
    })
  })

  it('batches rapid content and reasoning deltas without replacing the live message', async () => {
    vi.useFakeTimers()
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-batched' }))
    const liveMessage = store.messages[0]
    const renderedMessage = store.sortedMessages[0]
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-batched', delta: 'hello' })
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-batched', delta: ' world' })
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-batched', delta: 'think' })
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-batched', delta: ' twice' })

    expect(store.messages[0]).toBe(liveMessage)
    expect(store.messages[0].content).toBe('')
    expect(store.messages[0].reasoning).toBeUndefined()

    await vi.advanceTimersByTimeAsync(49)
    expect(store.messages[0].content).toBe('')

    await vi.advanceTimersByTimeAsync(1)
    expect(store.messages[0]).toBe(liveMessage)
    expect(store.sortedMessages[0]).toBe(renderedMessage)
    expect(store.messages[0]).toMatchObject({
      content: 'hello world',
      reasoning: 'think twice',
      reasoning_content: 'think twice',
      isStreaming: true,
    })
  })

  it('flushes a queued delta immediately when the stream ends', async () => {
    vi.useFakeTimers()
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-ending' }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-ending', delta: 'complete' })
    emitSocket('message_stream_end', { roomId: 'room-1', id: 'msg-ending' })

    expect(store.messages[0]).toMatchObject({
      content: 'complete',
      isStreaming: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves streamed content when the final message payload is blank', async () => {
    const store = await createJoinedStore()

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1' }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: 'final' })
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' answer' })
    emitSocket('message', assistantMessage({ id: 'msg-1', content: '', reasoning: 'thinking...' }))

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores late content deltas for a completed message', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({ id: 'msg-1', content: 'final answer', reasoning: 'thinking...' }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' stale' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores late reasoning deltas for a completed message', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({ id: 'msg-1', content: 'final answer', reasoning: 'thinking...' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: ' stale' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('preserves stable message order via sortedMessages when agents finish out of sequence', async () => {
    const store = await createJoinedStore()

    // Agent A starts first
    emitSocket('message_stream_start', assistantMessage({ id: 'msg-a', senderId: 'agent-a', senderName: 'Agent A', timestamp: 100 }))
    // Agent B starts second
    emitSocket('message_stream_start', assistantMessage({ id: 'msg-b', senderId: 'agent-b', senderName: 'Agent B', timestamp: 200 }))

    // Agent B finishes first (completes with a later timestamp)
    emitSocket('message', assistantMessage({ id: 'msg-b', senderId: 'agent-b', senderName: 'Agent B', content: 'fast reply', timestamp: 300 }))
    // Agent A finishes last (but started first)
    emitSocket('message', assistantMessage({ id: 'msg-a', senderId: 'agent-a', senderName: 'Agent A', content: 'slow reply', timestamp: 400 }))

    // sortedMessages should keep A (firstSeenAt=100) before B (firstSeenAt=200)
    expect(store.sortedMessages).toHaveLength(2)
    expect(store.sortedMessages[0].id).toBe('msg-a')
    expect(store.sortedMessages[0].content).toBe('slow reply')
    expect(store.sortedMessages[1].id).toBe('msg-b')
    expect(store.sortedMessages[1].content).toBe('fast reply')
  })

  it('ignores a late empty stream start for a completed message', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({ id: 'msg-1', content: 'final answer', reasoning: 'thinking...' }))
    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1', content: '', timestamp: 2 }))

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final answer',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('ignores a late stream start for a completed empty tool-call message', async () => {
    const store = await createJoinedStore()
    const toolCalls = [{ id: 'tool-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]

    emitSocket('message', assistantMessage({ id: 'msg-1', content: '', tool_calls: toolCalls }))
    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1', content: '', timestamp: 2 }))
    emitSocket('message_stream_delta', { roomId: 'room-1', id: 'msg-1', delta: ' stale' })

    expect(store.messages).toHaveLength(1)
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: '',
      tool_calls: toolCalls,
      isStreaming: false,
    })
  })

  it('refetches room detail when a stream ends with reasoning but no final content', async () => {
    vi.useFakeTimers()
    const store = await createJoinedStore()
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      agents: [],
      members: [],
      messages: [assistantMessage({ id: 'msg-1', content: 'final from db', reasoning: 'thinking...' })],
    })

    emitSocket('message_stream_start', assistantMessage({ id: 'msg-1' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'msg-1', delta: 'thinking...' })
    emitSocket('message_stream_end', { roomId: 'room-1', id: 'msg-1' })

    await vi.runAllTimersAsync()

    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledWith('room-1')
    expect(store.messages[0]).toMatchObject({
      id: 'msg-1',
      content: 'final from db',
      reasoning: 'thinking...',
      isStreaming: false,
    })
  })

  it('moves a sealed reasoning-only segment into the matching live tool row', async () => {
    const store = await createJoinedStore()
    const reasoning = 'Check the room data before calling lookup.'

    emitSocket('message_stream_start', assistantMessage({ id: 'run-1_part_0' }))
    emitSocket('message_reasoning_delta', {
      roomId: 'room-1',
      id: 'run-1_part_0',
      delta: reasoning,
    })
    emitSocket('message_stream_end', { roomId: 'room-1', id: 'run-1_part_0' })
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolcall_call-1',
      content: '',
      reasoning,
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"room":"room-1"}' },
      }],
    }))
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolresult_call-1',
      role: 'tool',
      tool_call_id: 'call-1',
      content: '{"ok":true}',
    }))

    expect(store.sortedMessages).toEqual([
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'call-1',
        reasoning,
        toolResult: '{"ok":true}',
      }),
    ])
  })

  it('keeps an empty tool completion after the agent reports ready', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolcall_call-1',
      run_id: 'run-1',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'terminal_exec', arguments: '{"command":"curl"}' },
      }],
    }))
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolresult_call-1',
      run_id: 'run-1',
      role: 'tool',
      tool_call_id: 'call-1',
      tool_name: 'terminal_exec',
      content: '',
    }))
    emitSocket('context_status', { roomId: 'room-1', agentName: 'bot', status: 'ready' })

    expect(store.messages).toHaveLength(2)
    expect(store.sortedMessages).toEqual([
      expect.objectContaining({
        toolCallId: 'call-1',
        toolName: 'terminal_exec',
        toolStatus: 'done',
      }),
    ])
  })

  it('projects a failed tool completion as an error', async () => {
    const store = await createJoinedStore()

    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolcall_call-1',
      run_id: 'run-1',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"secret.txt"}' },
      }],
    }))
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolresult_call-1',
      run_id: 'run-1',
      role: 'tool',
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      content: 'permission denied',
      finish_reason: 'error',
    }))

    expect(store.sortedMessages).toEqual([
      expect.objectContaining({
        toolCallId: 'call-1',
        toolName: 'read_file',
        toolResult: 'permission denied',
        toolStatus: 'error',
      }),
    ])
  })

  it('keeps reasoning split across consecutive tool calls in one agent run', async () => {
    const store = await createJoinedStore()
    const { groupAgentRunMessages } = await import('@/stores/hermes/group-chat')

    emitSocket('message_stream_start', assistantMessage({ id: 'run-1_part_0', run_id: 'run-1' }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'run-1_part_0', delta: 'first thought' })
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolcall_call-1',
      run_id: 'run-1',
      timestamp: 2,
      reasoning: 'first thought',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'first_tool', arguments: '{}' } }],
    }))
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolresult_call-1',
      run_id: 'run-1',
      timestamp: 3,
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'first result',
    }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'run-1_part_0', delta: 'second thought' })
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolcall_call-2',
      run_id: 'run-1',
      timestamp: 4,
      reasoning: 'second thought',
      tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'second_tool', arguments: '{}' } }],
    }))
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0_toolresult_call-2',
      run_id: 'run-1',
      timestamp: 5,
      role: 'tool',
      tool_call_id: 'call-2',
      content: 'second result',
    }))
    emitSocket('message_reasoning_delta', { roomId: 'room-1', id: 'run-1_part_0', delta: 'final thought' })
    emitSocket('message', assistantMessage({
      id: 'run-1_part_0',
      run_id: 'run-1',
      timestamp: 6,
      content: 'final answer',
      reasoning: 'final thought',
    }))

    const grouped = groupAgentRunMessages(store.sortedMessages)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].runItems).toEqual([
      expect.objectContaining({ toolCallId: 'call-1', reasoning: 'first thought', toolStatus: 'done' }),
      expect.objectContaining({ toolCallId: 'call-2', reasoning: 'second thought', toolStatus: 'done' }),
      expect.objectContaining({ content: 'final answer', reasoning: 'final thought' }),
    ])
  })

  it('projects historical cumulative reasoning snapshots as incremental segments', async () => {
    const store = await createJoinedStore([
      assistantMessage({
        id: 'run-1_part_0_toolcall_call-1',
        run_id: 'run-1',
        timestamp: 2,
        reasoning: 'first thought',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'first_tool', arguments: '{}' } }],
      }),
      assistantMessage({
        id: 'run-1_part_0_toolresult_call-1',
        run_id: 'run-1',
        timestamp: 3,
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'first result',
      }),
      assistantMessage({
        id: 'run-1_part_0_toolcall_call-2',
        run_id: 'run-1',
        timestamp: 4,
        reasoning: 'first thoughtsecond thought',
        tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'second_tool', arguments: '{}' } }],
      }),
      assistantMessage({
        id: 'run-1_part_0_toolresult_call-2',
        run_id: 'run-1',
        timestamp: 5,
        role: 'tool',
        tool_call_id: 'call-2',
        content: 'second result',
      }),
      assistantMessage({
        id: 'run-1_part_0',
        run_id: 'run-1',
        timestamp: 6,
        content: 'final answer',
        reasoning: 'first thoughtsecond thoughtfinal thought',
      }),
    ])
    const { groupAgentRunMessages } = await import('@/stores/hermes/group-chat')

    const grouped = groupAgentRunMessages(store.sortedMessages)
    expect(grouped[0].runItems).toEqual([
      expect.objectContaining({ toolCallId: 'call-1', reasoning: 'first thought' }),
      expect.objectContaining({ toolCallId: 'call-2', reasoning: 'second thought' }),
      expect.objectContaining({ content: 'final answer', reasoning: 'final thought' }),
    ])
  })

  it('maps non-string and falsy tool payloads from room history', async () => {
    const store = await createJoinedStore([
      assistantMessage({
        id: 'msg-tool-call',
        content: '',
        reasoning: 'Check the room data before calling lookup.',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: false } }],
      } as unknown as Partial<ChatMessage>),
      assistantMessage({
        id: 'msg-tool-result',
        role: 'tool',
        tool_call_id: 'call-1',
        content: { ok: true },
      } as unknown as Partial<ChatMessage>),
    ])

    expect(store.sortedMessages).toHaveLength(1)
    expect(store.sortedMessages[0]).toMatchObject({
      role: 'tool',
      toolName: 'lookup',
      toolArgs: false,
      toolResult: { ok: true },
      reasoning: 'Check the room data before calling lookup.',
      toolStatus: 'done',
    })
  })

  it('locks interleaved agent tool chains to their own response run cards', async () => {
    const store = await createJoinedStore([
      assistantMessage({
        id: 'agent-a-call',
        senderId: 'agent-a',
        senderName: 'Agent A',
        run_id: 'run-a',
        timestamp: 1,
        tool_calls: [{ id: 'shared-call', type: 'function', function: { name: 'lookup_a', arguments: '{"agent":"a"}' } }],
      }),
      assistantMessage({
        id: 'agent-b-call',
        senderId: 'agent-b',
        senderName: 'Agent B',
        run_id: 'run-b',
        timestamp: 2,
        tool_calls: [{ id: 'shared-call', type: 'function', function: { name: 'lookup_b', arguments: '{"agent":"b"}' } }],
      }),
      assistantMessage({
        id: 'agent-a-result',
        senderId: 'agent-a',
        senderName: 'Agent A',
        run_id: 'run-a',
        timestamp: 3,
        role: 'tool',
        tool_call_id: 'shared-call',
        content: 'result-a',
      }),
      assistantMessage({
        id: 'agent-b-result',
        senderId: 'agent-b',
        senderName: 'Agent B',
        run_id: 'run-b',
        timestamp: 4,
        role: 'tool',
        tool_call_id: 'shared-call',
        content: 'result-b',
      }),
      assistantMessage({
        id: 'agent-a-answer',
        senderId: 'agent-a',
        senderName: 'Agent A',
        run_id: 'run-a',
        timestamp: 5,
        content: 'answer-a',
      }),
      assistantMessage({
        id: 'agent-b-answer',
        senderId: 'agent-b',
        senderName: 'Agent B',
        run_id: 'run-b',
        timestamp: 6,
        content: 'answer-b',
      }),
    ])
    const { groupAgentRunMessages } = await import('@/stores/hermes/group-chat')

    const grouped = groupAgentRunMessages(store.sortedMessages)

    expect(grouped).toHaveLength(2)
    expect(grouped[0]).toMatchObject({
      senderName: 'Agent A',
      run_id: 'run-a',
      runItems: [
        expect.objectContaining({ toolName: 'lookup_a', toolResult: 'result-a' }),
        expect.objectContaining({ content: 'answer-a' }),
      ],
    })
    expect(grouped[1]).toMatchObject({
      senderName: 'Agent B',
      run_id: 'run-b',
      runItems: [
        expect.objectContaining({ toolName: 'lookup_b', toolResult: 'result-b' }),
        expect.objectContaining({ content: 'answer-b' }),
      ],
    })
  })

  it('rejoins the active room after socket reconnect and restores transient room state', async () => {
    const store = await createJoinedStore()
    store.loadedMessageCount = 300
    store.totalMessages = 500
    store.hasMoreBefore = true
    store.rooms = [room]
    groupChatApiMock.socket.emit.mockClear()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        ack({
          members: [{ id: 'human-1', name: 'Human', online: true }],
          agents: [{ id: 'agent-row-1', agentId: 'agent-1', profile: 'worker', name: 'Worker' }],
          rooms: ['room-1', 'room-2'],
          messages: [assistantMessage({ id: 'missed-1', content: 'missed while offline', timestamp: 2 })],
          typingUsers: [{ userId: 'agent-1', userName: 'Worker' }],
          contextStatuses: [{ agentName: 'Worker', status: 'replying' }],
        })
      }
      return groupChatApiMock.socket
    })

    emitSocket('connect', undefined)
    await Promise.resolve()

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'join',
      expect.objectContaining({ roomId: 'room-1', name: 'tester' }),
      expect.any(Function),
    )
    expect(store.members).toEqual([expect.objectContaining({ id: 'human-1', name: 'Human' })])
    expect(store.agents).toEqual([expect.objectContaining({ profile: 'worker', name: 'Worker' })])
    expect(store.rooms).toEqual([room])
    expect(store.messages).toEqual([expect.objectContaining({ id: 'missed-1', content: 'missed while offline' })])
    expect(store.loadedMessageCount).toBe(300)
    expect(store.totalMessages).toBe(500)
    expect(store.hasMoreBefore).toBe(true)
    expect(store.typingNames).toEqual(['Worker'])
    expect(store.contextStatus).toEqual(expect.objectContaining({ agentName: 'Worker', status: 'replying' }))
  })

  it('loads stable-cursor history beyond 600 messages without duplicates', async () => {
    const newest = Array.from({ length: 150 }, (_, index) =>
      assistantMessage({ id: `message-${651 + index}`, timestamp: 651 + index, content: `message ${651 + index}` }),
    )
    const store = await createJoinedStore(newest)
    store.loadedMessageCount = 150
    store.totalMessages = 800
    store.hasMoreBefore = true
    const page = Array.from({ length: 151 }, (_, index) =>
      assistantMessage({ id: `message-${501 + index}`, timestamp: 501 + index, content: `message ${501 + index}` }),
    )
    groupChatApiMock.getRoomDetail.mockResolvedValueOnce({
      room,
      messages: page,
      agents: [],
      members: [],
      total: 800,
      limit: 150,
      hasMore: true,
    })

    await expect(store.loadOlderMessages()).resolves.toBe(true)

    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledWith('room-1', {
      before: 'message-651',
      limit: 150,
      history: true,
    })
    expect(store.messages).toHaveLength(300)
    expect(new Set(store.messages.map(message => message.id)).size).toBe(300)
    expect(store.messages[0]?.id).toBe('message-501')
    expect(store.messages.at(-1)?.id).toBe('message-800')
    expect(store.loadedMessageCount).toBe(300)
    expect(store.totalMessages).toBe(800)
    expect(store.hasMoreBefore).toBe(true)
  })

  it('prevents concurrent older-page requests and supports retry after failure', async () => {
    const store = await createJoinedStore([
      assistantMessage({ id: 'message-651', timestamp: 651, content: 'message 651' }),
    ])
    store.loadedMessageCount = 150
    store.totalMessages = 800
    store.hasMoreBefore = true
    let resolvePage!: (value: any) => void
    groupChatApiMock.getRoomDetail.mockImplementationOnce(() => new Promise(resolve => {
      resolvePage = resolve
    }))

    const first = store.loadOlderMessages()
    await expect(store.loadOlderMessages()).resolves.toBe(false)
    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledTimes(1)
    resolvePage({
      room,
      messages: [],
      agents: [],
      members: [],
      total: 800,
      hasMore: true,
    })
    await expect(first).resolves.toBe(false)

    groupChatApiMock.getRoomDetail.mockRejectedValueOnce(new Error('temporary failure'))
    await expect(store.loadOlderMessages()).resolves.toBe(false)
    expect(store.olderMessagesError).toBe('temporary failure')

    groupChatApiMock.getRoomDetail.mockResolvedValueOnce({
      room,
      messages: [assistantMessage({ id: 'message-650', timestamp: 650, content: 'message 650' })],
      agents: [],
      members: [],
      total: 800,
      hasMore: true,
    })
    await expect(store.loadOlderMessages()).resolves.toBe(true)
    expect(store.olderMessagesError).toBeNull()
    expect(store.messages.map(message => message.id)).toEqual(['message-650', 'message-651'])
  })

  it('stops requesting after the server confirms the earliest message', async () => {
    const store = await createJoinedStore([
      assistantMessage({ id: 'message-2', timestamp: 2, content: 'message 2' }),
    ])
    store.loadedMessageCount = 799
    store.totalMessages = 800
    store.hasMoreBefore = true
    groupChatApiMock.getRoomDetail.mockResolvedValueOnce({
      room,
      messages: [assistantMessage({ id: 'message-1', timestamp: 1, content: 'message 1' })],
      agents: [],
      members: [],
      total: 800,
      hasMore: false,
    })

    await expect(store.loadOlderMessages()).resolves.toBe(true)
    expect(store.hasMoreBefore).toBe(false)
    groupChatApiMock.getRoomDetail.mockClear()
    await expect(store.loadOlderMessages()).resolves.toBe(false)
    expect(groupChatApiMock.getRoomDetail).not.toHaveBeenCalled()
  })

  it('ignores a stale reconnect join ack after the user switches rooms', async () => {
    const store = await createJoinedStore()
    let joinAck: Function | undefined
    groupChatApiMock.socket.emit.mockClear()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join') joinAck = ack
      return groupChatApiMock.socket
    })

    emitSocket('connect', undefined)
    await Promise.resolve()
    expect(joinAck).toBeDefined()

    const roomTwoMessage = assistantMessage({ id: 'room-2-msg', roomId: 'room-2', content: 'current room', timestamp: 3 })
    store.currentRoomId = 'room-2'
    store.members = [{ id: 'human-2', name: 'Room 2 Human', online: true }]
    store.messages = [roomTwoMessage]

    joinAck?.({
      members: [{ id: 'human-1', name: 'Old Room Human', online: true }],
      messages: [assistantMessage({ id: 'old-room-msg', content: 'old room', timestamp: 2 })],
      typingUsers: [{ userId: 'agent-1', userName: 'Worker' }],
      contextStatuses: [{ agentName: 'Worker', status: 'replying' }],
    })
    await Promise.resolve()

    expect(store.currentRoomId).toBe('room-2')
    expect(store.members).toEqual([expect.objectContaining({ id: 'human-2', name: 'Room 2 Human' })])
    expect(store.messages).toEqual([roomTwoMessage])
    expect(store.typingNames).toEqual([])
  })

  it('does not rejoin when socket connects without an active room', async () => {
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    await store.connect()
    groupChatApiMock.socket.emit.mockClear()

    emitSocket('connect', undefined)
    await Promise.resolve()

    expect(groupChatApiMock.socket.emit).not.toHaveBeenCalledWith(
      'join',
      expect.anything(),
      expect.any(Function),
    )
  })

  it('uses authenticated account identity and restores the persisted room member name', async () => {
    groupChatApiMock.getStoredUserId.mockReturnValue('browser-local-id')
    groupChatApiMock.getStoredUserName.mockReturnValue(null)
    clientApiMock.getStoredUsername.mockReturnValue('alice-login')
    authApiMock.fetchCurrentUser.mockResolvedValue({
      id: 42,
      username: 'alice-login',
      role: 'admin',
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_login_at: null,
      avatar: '',
    })
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [],
      agents: [],
      members: [],
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        expect(data).toMatchObject({ roomId: 'room-1' })
        expect(data.name).toBeUndefined()
        ack({
          members: [{ id: 'member-1', userId: 'auth:42', name: 'Alice Display', description: '', joinedAt: 1 }],
          agents: [],
          typingUsers: [],
          contextStatuses: [],
        })
      }
      return groupChatApiMock.socket
    })
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()

    await store.connect()
    await store.joinRoom('room-1')

    expect(groupChatApiMock.connectGroupChat).toHaveBeenCalledWith({
      userId: 'auth:42',
      userName: undefined,
      authUserId: 42,
    })
    expect(store.userId).toBe('auth:42')
    expect(store.userName).toBe('Alice Display')
  })

  it('restores the browser-persisted identity when switching from an account to an invite guest', async () => {
    groupChatApiMock.getStoredUserId.mockReturnValue('browser-guest-id')
    authApiMock.fetchCurrentUser.mockResolvedValue({
      id: 42,
      username: 'alice-login',
      role: 'admin',
      status: 'active',
      created_at: 1,
      updated_at: 1,
      last_login_at: null,
      avatar: '',
    })
    authApiMock.fetchCurrentUser.mockClear()
    groupChatApiMock.joinRoomByCode.mockResolvedValue({ room })
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        ack({
          members: [{ id: 'member-guest', userId: 'browser-guest-id', name: 'Guest', description: '', joinedAt: 1 }],
          agents: [],
          messages: [],
          typingUsers: [],
          contextStatuses: [],
        })
      }
      return groupChatApiMock.socket
    })
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()

    await store.connect()
    expect(store.userId).toBe('auth:42')
    store.disconnect()

    await store.joinByCode('ROOM1', { guest: true })

    expect(store.userId).toBe('browser-guest-id')
    expect(groupChatApiMock.connectGroupChat).toHaveBeenLastCalledWith({
      userId: 'browser-guest-id',
      userName: 'tester',
      authUserId: undefined,
      inviteCode: 'ROOM1',
    })
    expect(authApiMock.fetchCurrentUser).toHaveBeenCalledOnce()
  })

  it('uploads authenticated room attachments only through the group chat endpoint', async () => {
    const store = await createJoinedStore()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ files: [{ name: 'note.txt', path: '/tmp/note.txt' }] }),
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: unknown, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      if (event === 'message' && ack) ack({ id: 'msg-server' })
      return groupChatApiMock.socket
    })

    await store.sendMessage('hello', [{
      id: 'file-1',
      name: 'note.txt',
      type: 'text/plain',
      size: 5,
      url: '',
      file: new File(['hello'], 'note.txt', { type: 'text/plain' }),
    }])

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, options] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/studio/group-chat/rooms/room-1/attachments')
    expect(options.method).toBe('POST')
    expect(options.headers.Authorization).toBe('Bearer test-token')
    expect(options.headers['X-Hermes-Profile']).toBeUndefined()
    expect(options.body).toBeInstanceOf(FormData)
  })
})
