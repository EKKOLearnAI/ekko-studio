// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatMessage, MemberInfo, RoomAgent, RoomInfo } from '@/api/studio/group-chat'

const groupChatApiMock = vi.hoisted(() => {
  const handlers = new Map<string, Function[]>()
  let joinAck: any = { members: [], agents: [], typingUsers: [], contextStatuses: [] }
  const socket: any = {
    connected: true,
    id: 'socket-1',
    on: vi.fn((event: string, cb: Function) => {
      const existing = handlers.get(event) || []
      existing.push(cb)
      handlers.set(event, existing)
      return socket
    }),
    once: vi.fn((event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        socket.off(event, wrapped)
        cb(...args)
      }
      return socket.on(event, wrapped)
    }),
    off: vi.fn((event: string, cb?: Function) => {
      if (!cb) {
        handlers.delete(event)
        return socket
      }
      const existing = handlers.get(event) || []
      handlers.set(event, existing.filter(handler => handler !== cb))
      return socket
    }),
    emit: vi.fn((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack(joinAck)
      if (event === 'message' && ack) ack({ id: data?.id })
      if (event === 'approval.respond' && ack) ack({ ok: true, resolved: true })
      return socket
    }),
    disconnect: vi.fn(),
  }
  return {
    handlers,
    socket,
    setJoinAck: (value: any) => { joinAck = value },
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
    updateAgent: vi.fn(),
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
const completionSoundMock = vi.hoisted(() => ({
  primeCompletionSound: vi.fn(),
}))
const settingsStoreMock = vi.hoisted(() => ({
  display: {
    bell_on_complete: false,
    approval_bell: true,
  },
}))

vi.mock('@/api/studio/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => clientApiMock)
vi.mock('@/api/studio/auth', () => authApiMock)
vi.mock('@/api/studio/download', () => ({ getDownloadUrl: vi.fn((path: string) => `/download?path=${path}`) }))
vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: completionSoundMock.primeCompletionSound,
}))
vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => settingsStoreMock,
}))
vi.stubGlobal('fetch', fetchMock)

function emitSocket(event: string, payload: unknown) {
  for (const cb of groupChatApiMock.handlers.get(event) || []) cb(payload)
}

const room: RoomInfo = {
  id: 'room-1',
  name: 'Test Room',
  inviteCode: 'ROOM1',
  totalTokens: 7,
} as RoomInfo

const member: MemberInfo = {
  id: 'member-1',
  userId: 'user-1',
  name: 'tester',
  joinedAt: 1,
  online: true,
  socketId: 'socket-1',
} as MemberInfo

const agent: RoomAgent = {
  id: 'row-agent',
  roomId: 'room-1',
  agentId: 'agent-1',
  profile: 'default',
  name: 'Agent',
  description: '',
  invited: 0,
} as RoomAgent

function userMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'msg-1',
    roomId: 'room-1',
    senderId: 'user-1',
    senderName: 'tester',
    content: 'hello',
    timestamp: 1,
    role: 'user',
    ...overrides,
  }
}

async function loadStore() {
  const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
  return useGroupChatStore()
}

describe('group chat store baseline lifecycle', () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
    localStorage.clear()
    completionSoundMock.primeCompletionSound.mockClear()
    groupChatApiMock.handlers.clear()
    groupChatApiMock.setJoinAck({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
    for (const key of Object.keys(groupChatApiMock)) {
      const value = (groupChatApiMock as any)[key]
      if (value?.mockReset && key !== 'socket') value.mockReset()
    }
    groupChatApiMock.connectGroupChat.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.disconnectGroupChat.mockReset()
    groupChatApiMock.getSocket.mockReturnValue(groupChatApiMock.socket)
    groupChatApiMock.getStoredUserId.mockReturnValue('user-1')
    groupChatApiMock.getStoredUserName.mockReturnValue('Stored User')
    groupChatApiMock.getRoomDetail.mockResolvedValue({ room, messages: [], agents: [], members: [], total: 0, hasMore: false })
    groupChatApiMock.clearRoomContext.mockResolvedValue({ success: true, room: { ...room, totalTokens: 0 } })
    clientApiMock.getApiKey.mockReturnValue('test-token')
    clientApiMock.getBaseUrlValue.mockReturnValue('')
    clientApiMock.getActiveProfileName.mockReturnValue('research')
    clientApiMock.getStoredUsername.mockReturnValue(null)
    authApiMock.fetchCurrentUser.mockReset()
    authApiMock.fetchCurrentUser.mockRejectedValue(new Error('not signed in'))
    fetchMock.mockReset()
    groupChatApiMock.socket.connected = true
    groupChatApiMock.socket.id = 'socket-1'
    groupChatApiMock.socket.on.mockClear()
    groupChatApiMock.socket.once.mockClear()
    groupChatApiMock.socket.off.mockClear()
    groupChatApiMock.socket.emit.mockReset()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
      if (event === 'load_pending_approvals' && ack) ack({ pendingApprovals: [] })
      if (event === 'load_room_agent_activities' && ack) ack({ activities: [] })
      if (event === 'message' && ack) ack({ id: data?.id })
      return groupChatApiMock.socket
    })
    groupChatApiMock.socket.disconnect.mockClear()
  })

  it('connects with stored user data and registers realtime handlers', async () => {
    const store = await loadStore()

    await store.connect()

    expect(groupChatApiMock.connectGroupChat).toHaveBeenCalledWith({
      userId: 'user-1',
      userName: 'Stored User',
      authUserId: undefined,
    })
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('message', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('agents_updated', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('approval.requested', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('room_cleared', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('room_summary_updated', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('execution_queue_updated', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('message_retracted', expect.any(Function))
    expect(groupChatApiMock.socket.on).toHaveBeenCalledWith('room_agent_activity', expect.any(Function))
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'load_room_agent_activities',
      {},
      expect.any(Function),
    )
  })

  it('tracks exact active runs across rooms and settles only the matching run', async () => {
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'load_pending_approvals' && ack) ack({ pendingApprovals: [] })
      if (event === 'load_room_agent_activities' && ack) {
        ack({
          activities: [{
            roomId: 'room-2',
            agentId: 'agent-row-2',
            runId: 'run-2',
            agentName: 'Worker',
            agent: 'codex',
            avatar: '',
            status: 'replying',
          }],
        })
      }
      return groupChatApiMock.socket
    })
    const store = await loadStore()

    await store.connect()
    expect(store.activeAgentRuns.size).toBe(1)

    emitSocket('room_agent_activity', {
      roomId: 'room-1',
      agentId: 'agent-row-1',
      runId: 'run-old',
      agentName: 'Worker',
      agent: 'codex',
      avatar: '',
      status: 'replying',
    })
    emitSocket('room_agent_activity', {
      roomId: 'room-1',
      agentId: 'agent-row-1',
      runId: 'run-new',
      agentName: 'Worker',
      agent: 'codex',
      avatar: '',
      status: 'compressing',
    })
    emitSocket('room_agent_activity', {
      roomId: 'room-1',
      agentId: 'agent-row-1',
      runId: 'run-old',
      agentName: 'Worker',
      agent: 'codex',
      avatar: '',
      status: 'ready',
    })

    expect([...store.activeAgentRuns.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ roomId: 'room-2', runId: 'run-2' }),
      expect.objectContaining({ roomId: 'room-1', runId: 'run-new', status: 'compressing' }),
    ]))
    expect([...store.activeAgentRuns.values()]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run-old' }),
    ]))
    expect(store.activeAgentRunsForRoom('room-1')).toHaveLength(1)
    expect(store.activeAgentIdsForRoom('room-1')).toEqual(['agent-row-1'])
    expect(store.isAgentRunActive('room-1', 'agent-row-1', 'run-new')).toBe(true)
    expect(store.isAgentRunActive('room-1', 'agent-row-1', 'run-old')).toBe(false)
  })

  it('replaces active-run state from reconnect snapshots and clears it while disconnected', async () => {
    const store = await loadStore()
    await store.connect()
    emitSocket('room_agent_activity', {
      roomId: 'room-1',
      agentId: 'agent-row-1',
      runId: 'run-1',
      agentName: 'Worker',
      agent: 'codex',
      avatar: '',
      status: 'replying',
    })
    expect(store.activeAgentRuns.size).toBe(1)

    emitSocket('disconnect', 'transport close')
    expect(store.activeAgentRuns.size).toBe(0)

    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, ack?: Function) => {
      if (event === 'load_pending_approvals' && ack) ack({ pendingApprovals: [] })
      if (event === 'load_room_agent_activities' && ack) {
        ack({
          activities: [{
            roomId: 'room-3',
            agentId: 'agent-row-3',
            runId: 'run-3',
            agentName: 'Other',
            agent: 'claude',
            avatar: '',
            status: 'replying',
          }],
        })
      }
      return groupChatApiMock.socket
    })
    emitSocket('connect', undefined)
    await vi.waitFor(() => expect(store.activeAgentRuns.size).toBe(1))
    expect(store.activeAgentRunsForRoom('room-3')[0]?.runId).toBe('run-3')
  })

  it('restores authoritative queued work and removes a retracted message from local history', async () => {
    localStorage.setItem('gc_execution_queue_capability:room-1', 'c'.repeat(64))
    const queued = {
      id: 'queue-1',
      roomId: 'room-1',
      messageId: 'msg-queued',
      targetAgentId: 'agent-1',
      targetAgentName: 'Agent',
      requesterMemberId: 'user-1',
      textSummary: '@Agent do this',
      sequence: 2,
      position: 1,
      status: 'queued',
      createdAt: 2,
    }
    groupChatApiMock.setJoinAck({
      roomId: 'room-1',
      members: [member],
      agents: [agent],
      messages: [{ id: 'msg-queued', roomId: 'room-1', role: 'user', content: '@Agent do this', timestamp: 2 }],
      executionQueue: [queued],
      typingUsers: [],
      contextStatuses: [],
    })
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [{ id: 'msg-queued', roomId: 'room-1', role: 'user', content: '@Agent do this', timestamp: 2 }],
      agents: [agent],
      members: [member],
      total: 0,
      hasMore: false,
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack(groupChatApiMock.setJoinAck && {
        roomId: 'room-1',
        members: [member],
        agents: [agent],
        messages: [{ id: 'msg-queued', roomId: 'room-1', role: 'user', content: '@Agent do this', timestamp: 2 }],
        executionQueue: [queued],
        typingUsers: [],
        contextStatuses: [],
      })
      if (event === 'cancel_execution_queue_item' && ack) ack({ ok: true, status: 'retracted', messageId: 'msg-queued' })
      return groupChatApiMock.socket
    })
    const store = await loadStore()
    await store.connect()
    store.currentRoomId = 'room-1'
    await (store as any).joinRoom('room-1')

    expect(store.executionQueue).toEqual([queued])
    expect(store.messages).toEqual([expect.objectContaining({ id: 'msg-queued' })])
    emitSocket('message_retracted', {
      roomId: 'room-1',
      messageId: 'msg-queued',
      messageCount: 0,
      totalTokens: 0,
      lastActiveAt: 1,
    })
    expect(store.messages).toEqual([])
    expect(store.executionQueue).toEqual([])

    await store.cancelExecutionQueueItem('queue-1')
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'cancel_execution_queue_item',
      {
        roomId: 'room-1',
        queueId: 'queue-1',
        executionQueueCapability: 'c'.repeat(64),
      },
      expect.any(Function),
    )
  })

  it('invalidates cached handoff stops when another client changes the Room policy', async () => {
    const store = await loadStore()
    await store.connect()
    store.rooms = [{ ...room, agentHandoffEnabled: 1, agentHandoffMaxDepth: 4, agentHandoffUnlimited: 0 }]
    store.currentRoomId = 'room-1'
    store.handoffChains.set('chain-1', {
      chainId: 'chain-1', roomId: 'room-1', sourceMessageId: 'msg-1',
      currentDepth: 4, maxDepth: 4, unlimited: false, targetAgentId: 'agent-1',
      status: 'stopped', stopReason: 'max_depth', continueUsed: false,
      createdAt: 1, updatedAt: 1, lastError: null,
    } as any)

    emitSocket('room_updated', { roomId: 'room-1', agentHandoffMaxDepth: 6 })

    expect(store.rooms[0].agentHandoffMaxDepth).toBe(6)
    expect(store.handoffChains.size).toBe(0)
  })

  it('keeps cached handoff stops for unrelated Room metadata updates', async () => {
    const store = await loadStore()
    await store.connect()
    store.rooms = [{ ...room }]
    store.currentRoomId = 'room-1'
    store.handoffChains.set('chain-1', {
      chainId: 'chain-1', roomId: 'room-1', sourceMessageId: 'msg-1',
    } as any)

    emitSocket('room_updated', { roomId: 'room-1', totalTokens: 9 })

    expect(store.handoffChains.has('chain-1')).toBe(true)
  })

  it('restores directed approvals when the Agent owner comes online without joining the room', async () => {
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'load_pending_approvals' && ack) ack({
        pendingApprovals: [{
          roomId: 'room-offline', agentName: 'Agent', approval_id: 'approval-offline',
          command: 'touch file', description: 'needs approval', choices: ['once', 'deny'],
        }],
      })
      return groupChatApiMock.socket
    })
    const store = await loadStore()

    await store.connect()

    expect([...store.pendingApprovals.values()]).toEqual([
      expect.objectContaining({
        roomId: 'room-offline',
        agentName: 'Agent',
        approvalId: 'approval-offline',
      }),
    ])
  })

  it('uses server persisted activity time instead of an agent display timestamp for live room ordering', async () => {
    const store = await loadStore()
    store.rooms = [
      { ...room, id: 'future-agent', createdAt: 1, lastActiveAt: 1 },
      { ...room, id: 'recent-room', createdAt: 2, lastActiveAt: 2 },
    ]

    await store.connect()
    emitSocket('message', userMessage({
      id: 'future-agent-message',
      roomId: 'future-agent',
      senderId: 'agent-1',
      senderName: 'Agent',
      role: 'assistant',
      timestamp: 9_999_999_999_999,
      persistedAt: 3,
    }))
    emitSocket('message', userMessage({
      id: 'recent-room-message',
      roomId: 'recent-room',
      timestamp: 4,
      persistedAt: 4,
    }))

    expect(store.rooms.map((item: RoomInfo) => item.id)).toEqual(['recent-room', 'future-agent'])
  })

  it('does not let live tool or streaming messages change room ordering', async () => {
    const store = await loadStore()
    store.rooms = [
      { ...room, id: 'visible-room', createdAt: 2, lastActiveAt: 2 },
      { ...room, id: 'internal-room', createdAt: 1, lastActiveAt: 1 },
    ]

    await store.connect()
    emitSocket('message', userMessage({
      id: 'tool-message',
      roomId: 'internal-room',
      role: 'tool',
      persistedAt: 100,
    }))
    emitSocket('message', userMessage({
      id: 'streaming-message',
      roomId: 'internal-room',
      role: 'assistant',
      finish_reason: 'streaming',
      persistedAt: 101,
    }))

    expect(store.rooms.map((item: RoomInfo) => item.id)).toEqual(['visible-room', 'internal-room'])
    expect(store.rooms.find((item: RoomInfo) => item.id === 'internal-room')?.lastActiveAt).toBe(1)

    emitSocket('message', userMessage({
      id: 'visible-message',
      roomId: 'internal-room',
      role: 'assistant',
      finish_reason: 'stop',
      persistedAt: 102,
    }))
    expect(store.rooms.map((item: RoomInfo) => item.id)).toEqual(['internal-room', 'visible-room'])
  })

  it('keeps the REST room order based on the server public lastActiveAt instead of createdAt', async () => {
    const store = await loadStore()
    groupChatApiMock.listRooms.mockResolvedValue({
      rooms: [
        { ...room, id: 'room-old-active', createdAt: 100, lastActiveAt: 300 },
        { ...room, id: 'room-new-created', createdAt: 200, lastActiveAt: 200 },
      ],
    })

    await store.loadRooms()

    expect(store.rooms.map((item: RoomInfo) => item.id)).toEqual(['room-old-active', 'room-new-created'])
  })

  it('binds autoplay events to the responding agent profile', async () => {
    vi.useFakeTimers()
    const store = await loadStore()
    const autoplay = vi.fn()
    window.addEventListener('auto-play-speech', autoplay)

    try {
      await store.connect()
      store.currentRoomId = 'room-1'
      store.agents = [{ ...agent, profile: 'voice-profile' }]
      store.setAutoPlaySpeech(true)

      emitSocket('message', userMessage({
        id: 'assistant-voice',
        senderId: 'agent-1',
        senderName: 'Agent',
        role: 'assistant',
        content: 'Queued profile voice',
      }))
      await vi.advanceTimersByTimeAsync(300)

      expect(autoplay).toHaveBeenCalledOnce()
      expect((autoplay.mock.calls[0][0] as CustomEvent).detail).toEqual({
        messageId: 'assistant-voice',
        content: 'Queued profile voice',
        profile: 'voice-profile',
      })
    } finally {
      window.removeEventListener('auto-play-speech', autoplay)
      vi.useRealTimers()
    }
  })

  it('joins a room from REST detail and realtime ack state', async () => {
    const store = await loadStore()
    const detailMessage = userMessage({ id: 'msg-1' })
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [detailMessage],
      agents: [agent],
      members: [member],
      total: 5,
      hasMore: true,
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) ack({
        roomName: 'Realtime Room',
        members: [{ ...member, name: 'Realtime User' }],
        agents: [agent],
        typingUsers: [],
        contextStatuses: [{ agentName: 'Agent', status: 'replying' }],
      })
      return groupChatApiMock.socket
    })

    await store.connect()
    await store.joinRoom('room-1')

    expect(groupChatApiMock.getRoomDetail).toHaveBeenCalledWith('room-1')
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('join', expect.objectContaining({ roomId: 'room-1' }), expect.any(Function))
    expect(store.currentRoomId).toBe('room-1')
    expect(store.roomName).toBe('Realtime Room')
    expect(store.messages.map((m: ChatMessage) => m.id)).toEqual(['msg-1'])
    expect(store.members.map((m: MemberInfo) => m.name)).toEqual(['Realtime User'])
    expect(store.agents.map((a: RoomAgent) => a.agentId)).toEqual(['agent-1'])
    expect(store.totalMessages).toBe(5)
    expect(store.hasMoreBefore).toBe(true)
    expect(store.contextStatuses.get('Agent')).toEqual({ agentName: 'Agent', status: 'replying' })
  })

  it('persists the create-form member profile with a new room', async () => {
    const store = await loadStore()
    groupChatApiMock.createRoom.mockResolvedValue({
      room,
      agents: [],
    })

    await store.createNewRoom(
      'Family Room',
      'ROOM1',
      undefined,
      undefined,
      undefined,
      { name: '妈妈', description: 'family profile' },
    )

    expect(groupChatApiMock.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Family Room',
      inviteCode: 'ROOM1',
      memberName: '妈妈',
      memberDescription: 'family profile',
    }))
  })

  it('updates only the current room member profile through the joined socket', async () => {
    const store = await loadStore()
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        ack({
          roomName: 'Family Room',
          members: [{ ...member, name: 'alice-login', description: '' }],
          agents: [],
          typingUsers: [],
          contextStatuses: [],
        })
      }
      if (event === 'update_member_profile' && ack) {
        ack({
          members: [{ ...member, name: data.name, description: data.description }],
        })
      }
      return groupChatApiMock.socket
    })

    await store.connect()
    await store.joinRoom('room-1')
    await store.updateCurrentMemberProfile(' 妈妈 ', ' family profile ')

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'update_member_profile',
      {
        roomId: 'room-1',
        name: '妈妈',
        description: 'family profile',
      },
      expect.any(Function),
    )
    expect(store.userName).toBe('妈妈')
    expect(store.members[0]).toEqual(expect.objectContaining({
      name: '妈妈',
      description: 'family profile',
    }))
    expect(localStorage.getItem('gc_user_name')).toBe('妈妈')
  })

  it('replaces a room agent from the update API response', async () => {
    const store = await loadStore()
    const updatedAgent = {
      ...agent,
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'new-model',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
    } as RoomAgent
    store.agents = [agent]
    groupChatApiMock.updateAgent.mockResolvedValue({
      agent: updatedAgent,
      agents: [updatedAgent],
      members: [member],
    })

    await store.updateAgentInRoom('room-1', agent.id, {
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'new-model',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
    })

    expect(groupChatApiMock.updateAgent).toHaveBeenCalledWith('room-1', agent.id, expect.objectContaining({
      agent: 'codex',
      profile: 'research',
      model: 'new-model',
    }))
    expect(store.agents).toEqual([updatedAgent])
    expect(store.members).toEqual([member])
  })

  it('removes an owned remote Agent through the joined room socket', async () => {
    const store = await loadStore()
    const ownedRemoteAgent = {
      ...agent,
      executorType: 'remote' as const,
      ownerMemberId: 'user-1',
      connectionStatus: 'offline' as const,
    }
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        ack({
          roomName: 'Shared Room',
          members: [member],
          agents: [ownedRemoteAgent],
          typingUsers: [],
          contextStatuses: [],
        })
      }
      if (event === 'remove_agent' && ack) {
        ack({ ok: true, agents: [], members: [member] })
      }
      return groupChatApiMock.socket
    })

    await store.connect()
    await store.joinRoom('room-1')
    await store.removeAgentFromRoom('room-1', ownedRemoteAgent.id)

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'remove_agent',
      { roomId: 'room-1', agentId: ownedRemoteAgent.id },
      expect.any(Function),
    )
    expect(groupChatApiMock.removeAgent).not.toHaveBeenCalled()
    expect(store.agents).toEqual([])
  })

  it('keeps remaining Agent owner badges when a removal response omits ownership fields', async () => {
    const store = await loadStore()
    const remainingAgent = {
      ...agent,
      id: 'row-remaining-agent',
      agentId: 'remaining-agent',
      executorType: 'remote' as const,
      ownerMemberId: 'other-owner',
    }
    groupChatApiMock.removeAgent.mockResolvedValue({
      agents: [{
        ...remainingAgent,
        ownerMemberId: undefined,
        connectorId: 'other-owner-secret',
        remoteOrigin: 'http://127.0.0.1:9999',
      }],
      members: [member],
    })
    store.agents = [agent, remainingAgent]

    await store.removeAgentFromRoom('room-1', agent.id)

    expect(store.agents).toEqual([
      expect.objectContaining({
        id: 'row-remaining-agent',
        ownerMemberId: 'other-owner',
      }),
    ])
    expect(store.agents[0]).not.toHaveProperty('connectorId')
    expect(store.agents[0]).not.toHaveProperty('remoteOrigin')
  })

  it('keeps the current room agent roster in sync with realtime broadcasts', async () => {
    const store = await loadStore()
    const updatedAgent = { ...agent, name: 'Realtime Agent' }

    await store.connect()
    store.rooms = [{ ...room, agents: [] }]
    store.currentRoomId = 'room-1'
    store.agents = [agent]

    emitSocket('agents_updated', { roomId: 'room-2', agents: [] })
    expect(store.agents).toEqual([agent])

    emitSocket('agents_updated', { roomId: 'room-1', agents: [updatedAgent] })
    expect(store.agents).toEqual([updatedAgent])
    expect(store.roomAgentsForRoom('room-1')).toEqual([
      expect.objectContaining({ id: agent.id, name: 'Realtime Agent' }),
    ])

    emitSocket('agents_updated', { roomId: 'room-1', agents: [] })
    expect(store.agents).toEqual([])
    expect(store.roomAgentsForRoom('room-1')).toEqual([])
  })

  it('snapshots Agent display metadata before a realtime removal changes historical messages', async () => {
    const store = await loadStore()
    const avatar = JSON.stringify({ type: 'generated', seed: 'agent-history' })
    const displayAgent = {
      ...agent,
      agent: 'codex' as const,
      provider: 'openai',
      model: 'gpt-5',
      avatar,
      ownerMemberId: 'owner-1',
    }

    await store.connect()
    store.currentRoomId = 'room-1'
    store.agents = [displayAgent]
    store.messages = [userMessage({
      id: 'agent-message',
      senderId: displayAgent.agentId,
      senderName: displayAgent.name,
      role: 'assistant',
    })]

    emitSocket('agents_updated', { roomId: 'room-1', agents: [] })

    expect(store.agents).toEqual([])
    expect(store.messages[0]).toMatchObject({
      senderType: 'agent',
      senderAgentRecordId: displayAgent.id,
      senderAvatar: avatar,
      senderAgentType: 'codex',
      senderAgentProvider: 'openai',
      senderAgentModel: 'gpt-5',
      senderOwnerMemberId: 'owner-1',
    })
  })

  it('keeps securely issued ownership fields across the public Agent roster update', async () => {
    const store = await loadStore()
    const ownedAgent = {
      ...agent,
      executorType: 'remote' as const,
      ownerMemberId: 'user-1',
      connectorId: '11111111-2222-4333-8444-555555555555',
      remoteOrigin: 'http://127.0.0.1:8648',
    }
    const publicUpdate = {
      ...ownedAgent,
      name: 'Updated Agent',
      ownerMemberId: undefined,
      connectorId: undefined,
      remoteOrigin: undefined,
    }
    const otherOwnedAgent = {
      ...agent,
      id: 'row-other-agent',
      agentId: 'other-agent',
      executorType: 'remote' as const,
      ownerMemberId: 'other-owner',
      connectorId: 'other-owner-secret',
      remoteOrigin: 'http://127.0.0.1:9999',
    }

    await store.connect()
    store.currentRoomId = 'room-1'
    store.agents = [ownedAgent, otherOwnedAgent]
    emitSocket('agents_updated', {
      roomId: 'room-1',
      agents: [publicUpdate, { ...otherOwnedAgent, ownerMemberId: undefined }],
    })

    expect(store.agents[0]).toMatchObject({
      name: 'Updated Agent',
      ownerMemberId: 'user-1',
      connectorId: '11111111-2222-4333-8444-555555555555',
      remoteOrigin: 'http://127.0.0.1:8648',
    })
    expect(store.agents[1]).toMatchObject({
      id: 'row-other-agent',
      ownerMemberId: 'other-owner',
    })
    expect(store.agents[1]).not.toHaveProperty('connectorId')
    expect(store.agents[1]).not.toHaveProperty('remoteOrigin')
  })

  it('joins invite-only rooms entirely over realtime when the socket starts disconnected', async () => {
    const store = await loadStore()
    const order: string[] = []

    groupChatApiMock.socket.connected = false
    groupChatApiMock.getSocket.mockImplementation((options?: { requireConnected?: boolean }) => (
      groupChatApiMock.socket.connected || options?.requireConnected === false ? groupChatApiMock.socket : null
    ))
    groupChatApiMock.socket.once.mockImplementation((event: string, cb: Function) => {
      if (event === 'connect') {
        setTimeout(() => {
          groupChatApiMock.socket.connected = true
          cb()
        }, 0)
      }
      return groupChatApiMock.socket
    })
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        order.push(data?.inviteCode ? 'invite-join' : 'detail-join')
        ack({ roomName: 'Realtime Room', members: [member], agents: [], typingUsers: [], contextStatuses: [] })
      }
      return groupChatApiMock.socket
    })
    groupChatApiMock.joinRoomByCode.mockResolvedValue({ room })
    await store.joinByCode('ROOM1', { guest: true })

    expect(groupChatApiMock.connectGroupChat).toHaveBeenCalledWith(expect.objectContaining({
      inviteCode: 'ROOM1',
    }))
    expect(authApiMock.fetchCurrentUser).not.toHaveBeenCalled()
    expect(groupChatApiMock.getRoomDetail).not.toHaveBeenCalled()
    expect(order).toEqual(['invite-join'])
    expect(store.currentRoomId).toBe('room-1')
  })

  it('sends text-only messages through the room socket', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    await store.sendMessage('hello room')

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      content: 'hello room',
      executionQueueCapability: expect.stringMatching(/^[a-f0-9]{64}$/),
    }), expect.any(Function))
    expect(store.error).toBeNull()
  })

  it('primes approval sound on group send when completion sound is disabled', async () => {
    const store = await loadStore()
    settingsStoreMock.display.bell_on_complete = false
    settingsStoreMock.display.approval_bell = true
    await store.connect()
    await store.joinRoom('room-1')

    await store.sendMessage('request approval')

    expect(completionSoundMock.primeCompletionSound).toHaveBeenCalledOnce()
  })

  it('does not prime notification sound on group send when both sound settings are disabled', async () => {
    const store = await loadStore()
    settingsStoreMock.display.bell_on_complete = false
    settingsStoreMock.display.approval_bell = false
    await store.connect()
    await store.joinRoom('room-1')

    await store.sendMessage('silent request')

    expect(completionSoundMock.primeCompletionSound).not.toHaveBeenCalled()
  })

  it('waits for a reconnect room join before sending the next message', async () => {
    const store = await loadStore()
    let reconnectJoinAck: Function | undefined
    groupChatApiMock.getSocket.mockImplementation((options?: { requireConnected?: boolean }) => (
      groupChatApiMock.socket.connected || options?.requireConnected === false ? groupChatApiMock.socket : null
    ))
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join' && ack) {
        if (groupChatApiMock.socket.id === 'socket-1') {
          ack({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
        } else {
          reconnectJoinAck = ack
        }
      }
      if (event === 'message' && ack) ack({ id: data?.id })
      return groupChatApiMock.socket
    })

    await store.connect()
    await store.joinRoom('room-1')
    groupChatApiMock.socket.emit.mockClear()

    groupChatApiMock.socket.connected = false
    emitSocket('disconnect', 'transport close')
    groupChatApiMock.socket.id = 'socket-2'
    groupChatApiMock.socket.connected = true
    emitSocket('connect', undefined)

    const sending = store.sendMessage('after reconnect')
    await Promise.resolve()

    expect(reconnectJoinAck).toEqual(expect.any(Function))
    expect(groupChatApiMock.socket.emit).not.toHaveBeenCalledWith(
      'message',
      expect.anything(),
      expect.any(Function),
    )

    reconnectJoinAck?.({ members: [], agents: [], typingUsers: [], contextStatuses: [] })
    await sending

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ roomId: 'room-1', content: 'after reconnect' }),
      expect.any(Function),
    )
  })

  it('throttles typing heartbeats and stops after the input becomes idle', async () => {
    vi.useFakeTimers()
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')
    groupChatApiMock.socket.emit.mockClear()

    store.emitTyping()
    store.emitTyping()
    store.emitTyping()

    expect(groupChatApiMock.socket.emit.mock.calls.filter(call => call[0] === 'typing')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(2499)
    store.emitTyping()
    expect(groupChatApiMock.socket.emit.mock.calls.filter(call => call[0] === 'typing')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    store.emitTyping()
    expect(groupChatApiMock.socket.emit.mock.calls.filter(call => call[0] === 'typing')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(4000)
    expect(groupChatApiMock.socket.emit.mock.calls.filter(call => call[0] === 'stop_typing')).toHaveLength(1)
  })

  it('refreshes and expires the remote avatar typing state', async () => {
    vi.useFakeTimers()
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    emitSocket('typing', { roomId: 'room-1', userId: 'user-2', userName: 'Bob' })
    expect(store.isUserTyping('user-2')).toBe(true)

    await vi.advanceTimersByTimeAsync(4000)
    emitSocket('typing', { roomId: 'room-1', userId: 'user-2', userName: 'Bob' })
    await vi.advanceTimersByTimeAsync(4999)
    expect(store.isUserTyping('user-2')).toBe(true)

    await vi.advanceTimersByTimeAsync(1)
    expect(store.isUserTyping('user-2')).toBe(false)
  })

  it('sends a group reference with explicit agent markup and clears the draft reference', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')
    store.setMessageReference('room-1', {
      id: 'quoted-1',
      role: 'assistant',
      content: '@Agent previous answer',
      sender: 'Agent',
    })

    await store.sendMessage('@Agent continue')

    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
      roomId: 'room-1',
      content: [
        '<quoted_message sender="Agent">',
        '@Agent previous answer',
        '</quoted_message>',
        '',
        '@Agent continue',
      ].join('\n'),
    }), expect.any(Function))
    expect(store.activeMessageReference).toBeNull()
  })

  it('clears local room context from API response and room_cleared event', async () => {
    const store = await loadStore()
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [userMessage()],
      agents: [agent],
      members: [member],
      total: 1,
      hasMore: false,
    })
    await store.connect()
    await store.joinRoom('room-1')
    store.rooms = [room]
    emitSocket('typing', { roomId: 'room-1', userId: 'user-2', userName: 'Bob' })
    store.contextStatuses.set('Agent', { agentName: 'Agent', status: 'replying' })
    store.roomSummaryStates.set('room-1', {
      roomId: 'room-1',
      summary: 'old summary',
      summaryThroughMessageId: 'msg-1',
      summaryThroughMessageTimestamp: 1,
      summarizedTurnCount: 1,
      status: 'success',
      version: 1,
      updatedAt: 1,
      lastError: null,
    })
    store.pendingApprovals.set('approval-1', {
      roomId: 'room-1',
      agentName: 'Agent',
      approvalId: 'approval-1',
      command: 'touch file',
      description: 'needs approval',
      choices: ['once', 'session', 'deny'],
      allowPermanent: false,
      isMemoryWrite: false,
      requestedAt: 1,
    })

    await store.clearCurrentRoomContext()

    expect(groupChatApiMock.clearRoomContext).toHaveBeenCalledWith('room-1')
    expect(store.messages).toEqual([])
    expect(store.typingNames).toEqual([])
    expect(store.contextStatuses.size).toBe(0)
    expect(store.roomSummaryStates.has('room-1')).toBe(false)
    expect(store.rooms[0].totalTokens).toBe(0)

    emitSocket('room_cleared', { roomId: 'room-1', totalTokens: 0 })
    expect(store.pendingApprovals.size).toBe(0)
  })

  it('keeps the cleared room Agent avatars after switching away and back', async () => {
    const store = await loadStore()
    const roster = [1, 2, 3].map(index => ({ ...agent, id: `agent-${index}`, name: `Worker ${index}`, avatar: JSON.stringify({ type: 'generated', seed: `worker-${index}` }) }))
    groupChatApiMock.getRoomDetail.mockImplementation(async (id: string) => ({
      room: { ...room, id }, messages: [], agents: id === room.id ? roster : [], members: [], total: 0, hasMore: false,
    }))
    groupChatApiMock.socket.emit.mockImplementation((event: string, data?: any, ack?: Function) => {
      if (event === 'join') ack?.({ roomId: data.roomId, agents: data.roomId === room.id ? roster : [] })
      return groupChatApiMock.socket
    })
    await store.connect()
    await store.joinRoom(room.id)
    const avatars = store.roomAgentsForRoom(room.id)
    expect(avatars).toHaveLength(3)
    await store.clearCurrentRoomContext()
    expect(store.roomAgentsForRoom(room.id)).toEqual(avatars)
    await store.joinRoom('room-2')
    expect(store.roomAgentsForRoom(room.id)).toEqual(avatars)
    await store.joinRoom(room.id)
    expect(store.roomAgentsForRoom(room.id)).toEqual(avatars)
    await store.joinRoom('room-2')
    expect(store.roomAgentsForRoom(room.id)).toEqual(avatars)
  })

  it('applies a delayed clear response only to the room that was cleared', async () => {
    const store = await loadStore()
    store.rooms = [{ ...room, agents: [] }, { ...room, id: 'room-2', totalTokens: 20 }]
    store.currentRoomId = room.id
    let finish!: (value: any) => void
    groupChatApiMock.clearRoomContext.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const clearing = store.clearCurrentRoomContext()
    store.currentRoomId = 'room-2'
    store.messages = [userMessage({ roomId: 'room-2', content: 'Keep this' })]
    finish({ success: true, room: { ...room, totalTokens: 0 } })
    await clearing
    expect(store.messages[0]?.content).toBe('Keep this')
    expect(store.rooms.map(item => item.id)).toEqual(['room-1', 'room-2'])
    expect(store.rooms.find(item => item.id === room.id)?.totalTokens).toBe(0)
    expect(store.rooms.find(item => item.id === 'room-2')?.totalTokens).toBe(20)
  })

  it('tracks live rolling-summary status by room', async () => {
    const store = await loadStore()
    await store.connect()

    emitSocket('room_summary_updated', {
      roomId: 'room-1',
      summary: 'Current state',
      summaryThroughMessageId: 'message-8',
      summaryThroughMessageTimestamp: 8,
      summarizedTurnCount: 8,
      status: 'success',
      version: 2,
      updatedAt: 9,
      lastError: null,
    })

    expect(store.roomSummaryStates.get('room-1')).toMatchObject({
      summary: 'Current state',
      status: 'success',
      summarizedTurnCount: 8,
      summaryThroughMessageId: 'message-8',
    })
  })

  it('settles local agent activity when interrupt succeeds', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')
    store.contextStatuses.set('Agent', { agentName: 'Agent', status: 'replying' })
    store.messages = [{
      id: 'agent-stream',
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Agent',
      content: 'partial answer',
      timestamp: 2,
      role: 'assistant',
      isStreaming: true,
    }]
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data?: any, ack?: Function) => {
      if (event === 'interrupt_agent' && ack) ack({ ok: true })
      return groupChatApiMock.socket
    })

    await store.interruptAgent('Agent')

    expect(store.contextStatuses.has('Agent')).toBe(false)
    expect(store.messages[0]).toMatchObject({
      id: 'agent-stream',
      content: 'partial answer',
      isStreaming: false,
    })
  })

  it('tracks pending approvals and removes them when resolved', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    emitSocket('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-1',
      command: 'touch file',
      description: 'needs approval',
      choices: ['once', 'session', 'deny'],
    })

    expect([...store.pendingApprovals.values()]).toContainEqual(expect.objectContaining({
      roomId: 'room-1',
      agentName: 'Agent',
      approvalId: 'approval-1',
      choices: ['once', 'session', 'deny'],
    }))
    emitSocket('approval.resolved', { roomId: 'room-1', approval_id: 'approval-1' })
    expect(store.pendingApprovals.size).toBe(0)
  })

  it('tracks group clarifications and removes them when resolved', async () => {
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    emitSocket('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', clarify_id: 'clarify-1',
      question: 'Which environment?', choices: ['staging', 'production'], timeout_ms: 300000,
    })

    expect([...store.pendingClarifies.values()]).toContainEqual(expect.objectContaining({
      roomId: 'room-1', agentName: 'Agent', clarifyId: 'clarify-1',
      question: 'Which environment?', choices: ['staging', 'production'],
    }))
    emitSocket('clarify.resolved', { roomId: 'room-1', clarify_id: 'clarify-1' })
    expect(store.pendingClarifies.size).toBe(0)
  })

  it('does not use the browser clock to expire old group interactions', async () => {
    const store = await loadStore()
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)
    await store.connect()
    emitSocket('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-1', choices: ['once', 'deny'], timeout_ms: 1,
    })
    emitSocket('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', clarify_id: 'clarify-1', question: 'Continue?', timeout_ms: 1,
    })
    for (const pending of store.pendingApprovals.values()) pending.requestedAt = Date.now() - 10
    for (const pending of store.pendingClarifies.values()) pending.requestedAt = Date.now() - 10
    groupChatApiMock.socket.emit.mockImplementation((event: string, _data: any, ack?: Function) => {
      if (event === 'approval.respond' || event === 'clarify.respond') ack?.({ ok: true, resolved: true })
      return groupChatApiMock.socket
    })

    expect(await store.respondApprovalFor('room-1', 'approval-1', 'once')).toBe('submitted')
    expect(await store.respondClarifyFor('room-1', 'clarify-1', 'Continue')).toBe('submitted')

    expect(store.pendingApprovals.size).toBe(0)
    expect(store.pendingClarifies.size).toBe(0)
    expect(expired).not.toHaveBeenCalled()
    expect(groupChatApiMock.socket.emit.mock.calls.filter(call => call[0] === 'approval.respond' || call[0] === 'clarify.respond')).toHaveLength(2)
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })

  it('reports a server-confirmed stale group approval and removes it', async () => {
    const store = await loadStore()
    const expired = vi.fn()
    window.addEventListener('hermes:pending-interaction-expired', expired)
    await store.connect()
    emitSocket('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-stale', choices: ['once', 'deny'], timeout_ms: 300_000,
    })
    groupChatApiMock.socket.emit.mockImplementationOnce((event: string, _data: any, ack?: Function) => {
      if (event === 'approval.respond') ack?.({ ok: true, resolved: true, stale: true })
      return groupChatApiMock.socket
    })

    expect(await store.respondApprovalFor('room-1', 'approval-stale', 'once')).toBe('expired')
    expect(store.pendingApprovals.size).toBe(0)
    expect(expired).toHaveBeenCalledOnce()
    window.removeEventListener('hermes:pending-interaction-expired', expired)
  })

  it('responds to a clarification from an inactive room without switching rooms', async () => {
    const store = await loadStore()
    await store.connect()
    store.currentRoomId = 'room-a'
    emitSocket('clarify.requested', {
      roomId: 'room-b', agentName: 'Agent', clarify_id: 'clarify-b',
      question: 'Which environment?', choices: null,
    })
    groupChatApiMock.socket.emit.mockImplementationOnce((event: string, data: any, ack?: Function) => {
      if (event === 'clarify.respond') ack?.({ ok: true, resolved: true })
      return groupChatApiMock.socket
    })

    await store.respondClarifyFor('room-b', 'clarify-b', 'staging')

    expect(store.currentRoomId).toBe('room-a')
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('clarify.respond', {
      roomId: 'room-b', clarify_id: 'clarify-b', response: 'staging',
    }, expect.any(Function))
    expect(store.pendingClarifies.size).toBe(0)
  })

  it('restores pending room interactions when joining after a refresh', async () => {
    groupChatApiMock.socket.emit.mockImplementation((event: string, data: any, ack?: Function) => {
      if (event === 'join' && ack) ack({
        roomId: 'room-1', members: [], agents: [], typingUsers: [], contextStatuses: [],
        pendingApprovals: [{
          roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-restored',
          command: 'touch file', description: 'needs approval', choices: ['once', 'deny'],
          timeout_ms: 300000, remaining_timeout_ms: 45_000,
        }],
        pendingClarifies: [{
          roomId: 'room-1', agentName: 'Agent', clarify_id: 'clarify-restored',
          question: 'Which environment?', choices: null, timeout_ms: 300000,
          remaining_timeout_ms: 20_000,
        }],
      })
      return groupChatApiMock.socket
    })
    const store = await loadStore()
    await store.connect()
    await store.joinRoom('room-1')

    expect([...store.pendingApprovals.values()]).toContainEqual(expect.objectContaining({ approvalId: 'approval-restored' }))
    expect([...store.pendingClarifies.values()]).toContainEqual(expect.objectContaining({ clarifyId: 'clarify-restored' }))
    expect(store.activePendingApproval!.countdownDeadline - performance.now()).toBeGreaterThan(44_000)
    expect(store.activePendingClarify!.countdownDeadline - performance.now()).toBeGreaterThan(19_000)
  })

  it('keeps same-id approvals isolated across rooms', async () => {
    const store = await loadStore()
    await store.connect()
    emitSocket('approval.requested', {
      roomId: 'room-a', agentName: 'Agent A', approval_id: 'approval-shared',
      command: 'touch a', description: 'room a', choices: ['once', 'deny'],
    })
    emitSocket('approval.requested', {
      roomId: 'room-b', agentName: 'Agent B', approval_id: 'approval-shared',
      command: 'touch b', description: 'room b', choices: ['once', 'deny'],
    })

    expect([...store.pendingApprovals.values()].map(item => item.roomId).sort()).toEqual(['room-a', 'room-b'])
    emitSocket('approval.resolved', { roomId: 'room-a', approval_id: 'approval-shared' })
    expect([...store.pendingApprovals.values()]).toEqual([
      expect.objectContaining({ roomId: 'room-b', approvalId: 'approval-shared' }),
    ])
  })

  it('responds to an approval from an inactive room without joining or switching rooms', async () => {
    const store = await loadStore()
    await store.connect()
    store.currentRoomId = 'room-a'
    emitSocket('approval.requested', {
      roomId: 'room-b', agentName: 'Agent', approval_id: 'approval-b',
      command: 'touch file', description: 'needs approval', choices: ['once', 'deny'],
    })
    groupChatApiMock.socket.emit.mockClear()
    groupChatApiMock.socket.emit.mockImplementationOnce((event: string, data: any, ack?: Function) => {
      if (event === 'approval.respond') ack?.({ ok: true, resolved: true })
      return groupChatApiMock.socket
    })

    await store.respondApprovalFor('room-b', 'approval-b', 'once')

    expect(store.currentRoomId).toBe('room-a')
    expect(groupChatApiMock.socket.emit).toHaveBeenCalledWith('approval.respond', {
      roomId: 'room-b', approval_id: 'approval-b', choice: 'once',
    }, expect.any(Function))
    expect(groupChatApiMock.socket.emit).not.toHaveBeenCalledWith('join', expect.anything(), expect.anything())
  })

  it('keeps an inactive-room approval pending when the authoritative response is unresolved', async () => {
    const store = await loadStore()
    await store.connect()
    emitSocket('approval.requested', {
      roomId: 'room-b', agentName: 'Agent', approval_id: 'approval-b',
      command: 'touch file', description: 'needs approval', choices: ['once', 'deny'],
    })
    groupChatApiMock.socket.emit.mockImplementationOnce((event: string, data: any, ack?: Function) => {
      if (event === 'approval.respond') ack?.({ ok: true, resolved: false })
      return groupChatApiMock.socket
    })

    await store.respondApprovalFor('room-b', 'approval-b', 'once')

    expect([...store.pendingApprovals.values()]).toContainEqual(expect.objectContaining({ roomId: 'room-b', approvalId: 'approval-b' }))
  })

  it('updates the current room name and token display on room_updated', async () => {
    const store = await loadStore()
    store.rooms = [{ ...room, totalTokens: 7 }]
    store.currentRoomId = 'room-1'
    store.roomName = 'Room 1'
    await store.connect()

    emitSocket('room_updated', { roomId: 'room-1', name: 'Renamed Room', totalTokens: 42 })

    expect(store.rooms[0].totalTokens).toBe(42)
    expect(store.rooms[0].name).toBe('Renamed Room')
    expect(store.roomName).toBe('Renamed Room')
  })

  it('hydrates and live-updates durable handoff stops for the current room', async () => {
    const store = await loadStore()
    const chain = {
      chainId: 'chain-1',
      roomId: 'room-1',
      sourceMessageId: 'msg-1',
      currentDepth: 4,
      maxDepth: 4,
      unlimited: 0,
      targetAgentId: 'agent-1',
      status: 'stopped',
      stopReason: 'max_depth',
      continueUsed: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room,
      messages: [],
      agents: [],
      members: [],
      handoffChains: [chain],
      total: 0,
      hasMore: false,
    })

    await store.connect()
    await store.joinRoom('room-1')
    expect(store.handoffChains.get('chain-1')).toMatchObject({ status: 'stopped' })

    emitSocket('handoff_updated', { ...chain, status: 'claimed', attemptId: 'attempt-1', updatedAt: 2 })
    expect(store.handoffChains.get('chain-1')).toMatchObject({
      status: 'claimed',
      attemptId: 'attempt-1',
      updatedAt: 2,
    })
  })
})
