import { GroupStreamSnapshots } from '../../packages/server/src/modules/studio/services/group-chat/stream-snapshots'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { socketHandlers, mockSocket, mockIo } = vi.hoisted(() => {
  const socketHandlers = new Map<string, (...args: any[]) => void>()
  const mockSocket: any = {
    id: 'socket-1',
    connected: true,
    io: { on: vi.fn() },
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      socketHandlers.set(event, handler)
      if (event === 'connect') queueMicrotask(() => handler())
      return mockSocket
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }
  const mockIo = vi.fn(() => mockSocket)
  return { socketHandlers, mockSocket, mockIo }
})

vi.mock('socket.io-client', () => ({
  io: mockIo,
}))

vi.mock('../../packages/server/src/modules/studio/services/auth/token-auth', () => ({
  getToken: vi.fn(async () => 'test-token'),
}))

import { AgentClients, groupBridgeSessionId } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'
import type { GroupRoomSummaryService } from '../../packages/server/src/modules/studio/services/group-chat/room-summary'
import { canManageGroupChatRoom, isGroupChatRoomOwner } from '../../packages/server/src/modules/studio/services/group-chat/access'
import { groupChatRoutes, setGroupChatServer } from '../../packages/server/src/modules/studio/routes/group-chat'
import {
  resetAgentStatusRegistryForTests,
  updateAgentStatus,
} from '../../packages/server/src/modules/studio/public/agent-status-registry'

function routeHandler(path: string, method: string) {
  const layer = (groupChatRoutes as any).stack.find((item: any) => item.path === path && item.methods.includes(method))
  if (!layer) throw new Error(`Route not found: ${method} ${path}`)
  return layer.stack[0]
}

function createRoomSummaryServiceMock(): Pick<GroupRoomSummaryService, 'getState'> {
  return {
    getState: vi.fn((roomId: string) => ({
      roomId,
      summary: '',
      summaryThroughMessageId: '',
      summaryThroughMessageTimestamp: 0,
      summarizedTurnCount: 0,
      status: 'idle',
      version: 0,
      updatedAt: 0,
      lastError: null,
    })),
  }
}

function createServerStub(): any {
  return Object.assign(Object.create(GroupChatServer.prototype), { streamSnapshots: new GroupStreamSnapshots() })
}

describe('Group Chat member/agent identity sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    socketHandlers.clear()
    resetAgentStatusRegistryForTests()
    updateAgentStatus('hermes', {
      installed: true,
      source: 'user-cli',
      path: '/usr/local/bin/hermes',
    })
  })

  afterEach(() => {
    resetAgentStatusRegistryForTests()
  })

  it('distinguishes profile-based room managers from the room owner for @all', () => {
    const room = { id: 'room-1', ownerAuthUserId: 7 }
    const storage = {
      getRoom: vi.fn(() => room),
      getRoomsForProfiles: vi.fn(() => [room]),
    } as any
    const profileManager = { id: 8, role: 'admin', profiles: ['default'] }
    const owner = { id: 7, role: 'admin', profiles: [] }

    expect(canManageGroupChatRoom(storage, room.id, profileManager)).toBe(true)
    expect(isGroupChatRoomOwner(storage, room.id, profileManager)).toBe(false)
    expect(isGroupChatRoomOwner(storage, room.id, owner)).toBe(true)
  })

  it('broadcasts typing only for a socket that is currently joined to the room', () => {
    const broadcast = vi.fn()
    const onlineMember = {
      id: 'member-1',
      userId: 'human-1',
      name: 'Human',
      description: '',
      joinedAt: 1,
      online: true,
      socketId: 'socket-1',
      source: 'human',
      avatar: '',
    }
    const roomState = {
      getOnlineMemberBySocketId: vi.fn((socketId: string) => (
        socketId === 'socket-1' ? onlineMember : undefined
      )),
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', roomState]])
    server.typingState = new Map()
    const socket = {
      id: 'socket-1',
      to: vi.fn(() => ({ emit: broadcast })),
    }

    server.handleTyping(socket, { roomId: 'room-1' })

    expect(broadcast).toHaveBeenCalledWith('typing', {
      roomId: 'room-1',
      userId: 'human-1',
      userName: 'Human',
    })
    expect(server.typingState.get('room-1').has('human-1')).toBe(true)

    server.handleStopTyping(socket, { roomId: 'room-1' })
    expect(broadcast).toHaveBeenCalledWith('stop_typing', {
      roomId: 'room-1',
      userId: 'human-1',
    })
    expect(server.typingState.has('room-1')).toBe(false)

    broadcast.mockClear()
    server.handleTyping({ ...socket, id: 'outsider-socket' }, { roomId: 'room-1' })
    server.handleStopTyping({ ...socket, id: 'outsider-socket' }, { roomId: 'room-1' })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('preserves typing when another socket for the same user disconnects', () => {
    const broadcast = vi.fn()
    const member = {
      id: 'member-1',
      userId: 'human-1',
      name: 'Human',
      description: '',
      joinedAt: 1,
      online: true,
      socketId: 'socket-1',
      source: 'human',
      avatar: '',
    }
    const roomState = {
      getOnlineMemberBySocketId: vi.fn((socketId: string) => (
        socketId === 'socket-1' || socketId === 'socket-2' ? member : undefined
      )),
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', roomState]])
    server.typingState = new Map()
    server.socketUserMap = new Map([
      ['socket-1', 'human-1'],
      ['socket-2', 'human-1'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['socket-1', 'human'],
      ['socket-2', 'human'],
    ])
    server.socketAuthUserIdMap = new Map()
    server.userInfoMap = new Map([['human-1', { name: 'Human', description: '' }]])
    server.guestAgentRequestTokens = new Map()
    server.nsp = { to: vi.fn(() => ({ emit: broadcast })) }
    server.leaveAllRooms = vi.fn()
    const typingSocket = {
      id: 'socket-1',
      data: {},
      to: vi.fn(() => ({ emit: broadcast })),
    }
    const otherSocket = {
      id: 'socket-2',
      data: {},
    }

    server.handleTyping(typingSocket, { roomId: 'room-1' })
    broadcast.mockClear()
    server.handleDisconnect(otherSocket)

    expect(server.typingState.get('room-1')?.has('human-1')).toBe(true)
    expect(broadcast).not.toHaveBeenCalledWith('stop_typing', {
      roomId: 'room-1',
      userId: 'human-1',
    })
  })

  it('ignores stop-typing from another socket for the same user', () => {
    const broadcast = vi.fn()
    const member = {
      id: 'member-1',
      userId: 'human-1',
      name: 'Human',
      description: '',
      joinedAt: 1,
      online: true,
      socketId: 'socket-1',
      source: 'human',
      avatar: '',
    }
    const roomState = {
      getOnlineMemberBySocketId: vi.fn((socketId: string) => (
        socketId === 'socket-1' || socketId === 'socket-2' ? member : undefined
      )),
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', roomState]])
    server.typingState = new Map()
    const typingSocket = {
      id: 'socket-1',
      to: vi.fn(() => ({ emit: broadcast })),
    }
    const otherSocket = {
      id: 'socket-2',
      to: vi.fn(() => ({ emit: broadcast })),
    }

    server.handleTyping(typingSocket, { roomId: 'room-1' })
    broadcast.mockClear()
    server.handleStopTyping(otherSocket, { roomId: 'room-1' })

    expect(server.typingState.get('room-1')?.has('human-1')).toBe(true)
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('clears typing exactly once when the owning socket disconnects', () => {
    const broadcast = vi.fn()
    const member = {
      id: 'member-1',
      userId: 'human-1',
      name: 'Human',
      description: '',
      joinedAt: 1,
      online: true,
      socketId: 'socket-1',
      source: 'human',
      avatar: '',
    }
    const roomState = {
      getOnlineMemberBySocketId: vi.fn(() => member),
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', roomState]])
    server.typingState = new Map()
    server.socketUserMap = new Map([['socket-1', 'human-1']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map()
    server.userInfoMap = new Map([['human-1', { name: 'Human', description: '' }]])
    server.guestAgentRequestTokens = new Map()
    server.nsp = { to: vi.fn(() => ({ emit: broadcast })) }
    server.leaveAllRooms = vi.fn()
    const socket = {
      id: 'socket-1',
      data: {},
      to: vi.fn(() => ({ emit: broadcast })),
    }

    server.handleTyping(socket, { roomId: 'room-1' })
    broadcast.mockClear()
    server.handleDisconnect(socket)

    expect(server.typingState.has('room-1')).toBe(false)
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith('stop_typing', {
      roomId: 'room-1',
      userId: 'human-1',
    })
  })

  it('clears typing when an active room member is removed', () => {
    const broadcast = vi.fn()
    const kickedSocket = {
      id: 'socket-1',
      rooms: new Set(['room-1']),
      emit: vi.fn(),
      leave: vi.fn(),
    }
    const member = {
      id: 'member-1',
      userId: 'human-1',
      name: 'Human',
      description: '',
      joinedAt: 1,
      online: true,
      socketId: 'socket-1',
      source: 'human',
      avatar: '',
    }
    const roomState = {
      members: new Map([['human-1', member]]),
      removeUser: vi.fn(() => true),
      getMembersList: vi.fn(() => []),
    }
    const timer = setTimeout(() => {}, 30000)
    const server = createServerStub()
    server.rooms = new Map([['room-1', roomState]])
    server.typingState = new Map([['room-1', new Map([['human-1', {
      userName: 'Human',
      socketId: 'socket-1',
      timer,
    }]])]])
    server.socketUserMap = new Map([['socket-1', 'human-1']])
    server.nsp = {
      sockets: new Map([['socket-1', kickedSocket]]),
      to: vi.fn(() => ({ emit: broadcast })),
    }
    server.storage = {
      getMemberByUserId: vi.fn(() => member),
      removeRoomMember: vi.fn(),
    }
    server.getRoomMemberViews = vi.fn(() => [])

    server.removeRoomMember('room-1', 'human-1')

    expect(server.typingState.has('room-1')).toBe(false)
    expect(broadcast).toHaveBeenCalledWith('stop_typing', {
      roomId: 'room-1',
      userId: 'human-1',
    })
  })

  it('uses the persisted group-chat agent id as the runtime agent id and socket user id', async () => {
    const clients = new AgentClients()

    const client = await clients.createAgent({
      agentId: 'agent-stable-1',
      profile: 'default',
      name: 'Worker',
      description: '',
      invited: 0,
    } as any)

    expect(client.agentId).toBe('agent-stable-1')
    expect(mockIo).toHaveBeenCalledWith(
      'http://127.0.0.1:8648/group-chat',
      expect.objectContaining({
        auth: expect.objectContaining({
          token: 'test-token',
          userId: 'agent-stable-1',
          name: 'Worker',
          source: 'agent',
          agentSocketSecret: expect.any(String),
        }),
      }),
    )
  })

  it('passes the same persisted agent id into the runtime client when adding an agent', async () => {
    const calls: string[] = []
    const addRoomAgent = vi.fn((roomId: string, agentId: string, profile: string, name: string, description: string, invited: number) => {
      calls.push('persist-agent')
      return { id: 'row-1', roomId, agentId, profile, name, description, invited }
    })
    const chatServer = {
      getStorage: () => ({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent: vi.fn(),
      }),
      broadcastRoomAgents: vi.fn(() => []),
      agentClients: {
        createAgent: vi.fn(async () => ({ agentId: 'runtime-agent' })),
        addAgentToRoom: vi.fn(async () => { calls.push('join-room') }),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    const persisted = ctx.body.agent
    expect(persisted.agentId).toBeTruthy()
    expect(calls).toEqual(['persist-agent', 'join-room'])
    expect(chatServer.agentClients.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentId: persisted.agentId,
      profile: 'default',
      name: 'Worker',
    }))
  })

  it('does not persist an agent when the runtime client cannot connect', async () => {
    const addRoomAgent = vi.fn()
    const chatServer = {
      getStorage: () => ({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
      }),
      agentClients: {
        createAgent: vi.fn(async () => {
          throw new Error('Connection timeout')
        }),
        addAgentToRoom: vi.fn(),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'Connection timeout',
    })
    expect(addRoomAgent).not.toHaveBeenCalled()
  })

  it('disconnects a newly created runtime agent when persistence fails before room join', async () => {
    const runtimeClient = { agentId: 'agent-stable-1', disconnect: vi.fn() }
    const addRoomAgent = vi.fn(() => {
      throw new Error('database locked')
    })
    const chatServer = {
      getStorage: () => ({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent: vi.fn(),
      }),
      agentClients: {
        createAgent: vi.fn(async () => runtimeClient),
        addAgentToRoom: vi.fn(),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'database locked',
    })
    expect(chatServer.agentClients.addAgentToRoom).not.toHaveBeenCalled()
    expect(runtimeClient.disconnect).toHaveBeenCalled()
    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
  })

  it('does not leave a persisted agent row and disconnects runtime state when room join fails', async () => {
    const addRoomAgent = vi.fn((roomId: string, agentId: string, profile: string, name: string, description: string, invited: number) => ({ id: 'row-1', roomId, agentId, profile, name, description, invited }))
    const removeRoomAgent = vi.fn()
    const runtimeClient = { agentId: 'agent-stable-1' }
    const chatServer = {
      getStorage: () => ({
        getRoomAgents: vi.fn(() => []),
        addRoomAgent,
        removeRoomAgent,
      }),
      agentClients: {
        createAgent: vi.fn(async () => runtimeClient),
        addAgentToRoom: vi.fn(async () => {
          throw new Error('join failed')
        }),
        removeAgentFromRoom: vi.fn(),
      },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/agents', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      request: { body: { profile: 'default', name: 'Worker' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(502)
    expect(ctx.body).toMatchObject({
      code: 'PROFILE_AGENT_CONNECT_FAILED',
      profile: 'default',
      reason: 'join failed',
    })
    expect(addRoomAgent).toHaveBeenCalledWith(
      'room-1',
      expect.any(String),
      'default',
      'Worker',
      '',
      0,
      { agent: 'hermes', agentMode: 'scoped', provider: '', model: '', apiMode: '', reasoningEffort: '' },
    )
    expect(removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-1')
    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
  })

  it('rolls back AgentClients room state when joining a room fails', async () => {
    const clients = new AgentClients()
    const runtimeClient = {
      agentId: 'agent-stable-1',
      name: 'Worker',
      joinRoom: vi.fn(async () => {
        throw new Error('join failed')
      }),
      disconnect: vi.fn(),
    }

    await expect(clients.addAgentToRoom('room-1', runtimeClient as any)).rejects.toThrow('join failed')

    expect(runtimeClient.disconnect).toHaveBeenCalled()
    expect(clients.getAgents('room-1')).toEqual([])
  })

  it('removes the runtime agent by persisted agentId and returns synchronized room state', async () => {
    const agentsBefore = [{ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker', description: '', invited: 0 }]
    const storage = {
      getRoomAgent: vi.fn(() => agentsBefore[0]),
      getRoomAgents: vi.fn(() => []),
      removeRoomMembersForAgent: vi.fn(),
      removeRoomAgent: vi.fn(),
      getRoomMembers: vi.fn(() => [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }]),
    }
    const chatServer = {
      getStorage: () => storage,
      broadcastRoomAgents: vi.fn(() => []),
      agentClients: { removeAgentFromRoom: vi.fn() },
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/agents/:agentId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1', agentId: 'row-1' },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(chatServer.agentClients.removeAgentFromRoom).toHaveBeenCalledWith('room-1', 'agent-stable-1')
    expect(storage.removeRoomMembersForAgent).toHaveBeenCalledWith('room-1', agentsBefore[0])
    expect(storage.removeRoomAgent).toHaveBeenCalledWith('room-1', 'row-1')
    expect(chatServer.broadcastRoomAgents).toHaveBeenCalledWith('room-1')
    expect(ctx.body).toEqual({
      success: true,
      agents: [],
      members: [{ id: 'member-1', userId: 'human-1', name: 'Han', description: '', joinedAt: 1 }],
    })
  })

  it('interrupts runtime room state before deleting persisted room data', async () => {
    const calls: string[] = []
    const storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1', ownerAuthUserId: 7 })),
      deleteRoom: vi.fn(() => { calls.push('storage-delete') }),
    }
    const chatServer = {
      getStorage: () => storage,
      getRoomSummaryService: () => ({ runExclusive: async (_roomId: string, task: () => unknown) => task() }),
      deleteRoomRuntimeState: vi.fn(async () => { calls.push('runtime-delete') }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(calls).toEqual(['runtime-delete', 'storage-delete'])
    expect(chatServer.deleteRoomRuntimeState).toHaveBeenCalledWith('room-1')
    expect(ctx.body).toEqual({ success: true })
  })

  it('does not delete persisted room data when runtime interrupt does not complete', async () => {
    const storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room 1', ownerAuthUserId: 7 })),
      deleteRoom: vi.fn(),
    }
    const chatServer = {
      getStorage: () => storage,
      getRoomSummaryService: () => ({ runExclusive: async (_roomId: string, task: () => unknown) => task() }),
      deleteRoomRuntimeState: vi.fn(async () => { throw Object.assign(new Error('still running'), { status: 409 }) }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId', 'DELETE')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual({ error: 'still running' })
    expect(storage.deleteRoom).not.toHaveBeenCalled()
  })

  it('interrupts agents before evicting in-memory room sockets so deleted rooms reject late realtime messages', async () => {
    const calls: string[] = []
    const socketsLeave = vi.fn(() => { calls.push('sockets-leave') })
    const saveMessageAndRefreshRoom = vi.fn()
    const server = createServerStub()
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.typingState = new Map([['room-1', new Map([['human-1', { userName: 'Human', timer: setTimeout(() => {}, 1000) }]])]])
    server.contextStatusState = new Map([['room-1', new Map([['Worker', { agentName: 'Worker', status: 'replying' }]])]])
    server.agentClients = {
      interruptRoom: vi.fn(async () => { calls.push('interrupt') }),
      disconnectRoom: vi.fn(() => { calls.push('disconnect') }),
    }
    server.nsp = {
      in: vi.fn(() => ({ socketsLeave })),
      to: vi.fn(() => ({ emit: vi.fn() })),
    }
    server.storage = { saveMessageAndRefreshRoom }

    await server.deleteRoomRuntimeState('room-1')
    const ack = vi.fn()
    server.handleMessage({ id: 'socket-1' }, { roomId: 'room-1', content: 'late', role: 'user' }, ack)

    expect(calls).toEqual(['interrupt', 'disconnect', 'sockets-leave'])
    expect(server.rooms.has('room-1')).toBe(false)
    expect(server.agentClients.disconnectRoom).toHaveBeenCalledWith('room-1')
    expect(server.nsp.in).toHaveBeenCalledWith('room-1')
    expect(socketsLeave).toHaveBeenCalledWith('room-1')
    expect(saveMessageAndRefreshRoom).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledWith({ error: 'Not in room' })
  })

  it('persists and broadcasts uploaded attachments as the owning Agent', () => {
    const emit = vi.fn()
    const saveMessageAndRefreshRoom = vi.fn((message: any) => ({
      message,
      totalTokens: 17,
    }))
    const server = createServerStub()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1' })),
      getRoomAgentByAgentId: vi.fn(() => ({
        id: 'agent-record-1',
        agentId: 'agent-1',
        name: 'Worker',
      })),
      saveMessageAndRefreshRoom,
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }

    const message = server.publishAgentAttachmentMessage({
      roomId: 'room-1',
      agentId: 'agent-1',
      runId: 'run-1',
      workspacePath: 'renders/final.png',
      attachment: {
        type: 'image',
        name: 'final.png',
        path: '0123456789abcdef0123456789abcdef.png',
        media_type: 'image/png',
      },
    })

    expect(saveMessageAndRefreshRoom).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      senderId: 'agent-1',
      senderName: 'Worker',
      senderType: 'agent',
      senderAgentRecordId: 'agent-record-1',
      role: 'assistant',
      run_id: 'run-1',
      content: JSON.stringify([
        { type: 'text', text: 'renders/final.png' },
        {
          type: 'image',
          name: 'final.png',
          path: '0123456789abcdef0123456789abcdef.png',
          media_type: 'image/png',
        },
      ]),
    }))
    expect(message.senderId).toBe('agent-1')
    expect(emit).toHaveBeenCalledWith('message', message)
    expect(emit).toHaveBeenCalledWith('room_updated', { roomId: 'room-1', totalTokens: 17 })
  })

  it('uses the run identity snapshot when the uploading Agent was removed mid-run', () => {
    const saveMessageAndRefreshRoom = vi.fn((message: any) => ({ message, totalTokens: 9 }))
    const server = createServerStub()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      saveMessageAndRefreshRoom,
    }
    server.nsp = { to: vi.fn(() => ({ emit: vi.fn() })) }

    server.publishAgentAttachmentMessage({
      roomId: 'room-1',
      agentId: 'remote-agent-1',
      runId: 'run-1',
      workspacePath: 'result.md',
      agentSnapshot: {
        name: 'Remote Worker',
        agent: 'hermes',
        profile: 'default',
        provider: 'openrouter',
        model: 'model-1',
        description: 'Remote Agent',
        avatar: 'avatar-json',
        ownerMemberId: 'member-1',
      },
      attachment: {
        type: 'file',
        name: 'result.md',
        path: '0123456789abcdef0123456789abcdef.md',
        media_type: 'text/markdown',
      },
    })

    expect(saveMessageAndRefreshRoom).toHaveBeenCalledWith(expect.objectContaining({
      senderId: 'remote-agent-1',
      senderName: 'Remote Worker',
      senderAgentRecordId: '',
      senderAgentType: 'hermes',
      senderAgentProfile: 'default',
      senderAgentProvider: 'openrouter',
      senderAgentModel: 'model-1',
      senderAgentDescription: 'Remote Agent',
      senderAvatar: 'avatar-json',
      senderOwnerMemberId: 'member-1',
    }))
  })

  it('rejects stale agent context and stream side-channel events after session rotation', () => {
    const broadcastEmit = vi.fn()
    const roomEmit = vi.fn()
    const updateRoomTotalTokens = vi.fn()
    const agentMember = {
      id: 'agent-socket-1',
      userId: 'agent-stable-1',
      name: 'Worker',
      description: '',
      joinedAt: Date.now(),
      online: true,
      socketId: 'agent-socket-1',
      source: 'agent',
      avatar: '',
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', {
      getOnlineMemberBySocketId: vi.fn(() => agentMember),
    }]])
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-2' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker' })),
      updateRoomTotalTokens,
    }
    server.nsp = { to: vi.fn(() => ({ emit: broadcastEmit })) }
    const socket = { id: 'agent-socket-1', to: vi.fn(() => ({ emit: roomEmit })) }
    const staleSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-1')
    const currentSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-2')

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 123,
      agentSessionId: staleSessionId,
    })
    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'late-stream',
      agentSessionId: staleSessionId,
    })

    expect(updateRoomTotalTokens).not.toHaveBeenCalled()
    expect(roomEmit).not.toHaveBeenCalled()
    expect(broadcastEmit).not.toHaveBeenCalled()
    expect(server.contextStatusState.size).toBe(0)

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      totalTokens: 456,
      agentSessionId: currentSessionId,
    })
    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'current-stream',
      agentSessionId: currentSessionId,
    })

    expect(updateRoomTotalTokens).not.toHaveBeenCalled()
    expect(roomEmit).toHaveBeenCalledWith('context_status', expect.objectContaining({ roomId: 'room-1', agentName: 'Worker', status: 'replying' }))
    expect(broadcastEmit).not.toHaveBeenCalledWith('room_updated', expect.anything())
    expect(broadcastEmit).toHaveBeenCalledWith('message_stream_start', expect.objectContaining({
      id: 'current-stream',
      senderId: 'agent-stable-1',
      senderAgentRecordId: 'row-1',
      senderName: 'Worker',
    }))
  })

  it('broadcasts stable run activity only to authorized human room observers', () => {
    const joinedRoomEmit = vi.fn()
    const memberEmit = vi.fn()
    const outsiderEmit = vi.fn()
    const agentEmit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map([['room-1', {
      getOnlineMemberBySocketId: vi.fn((socketId: string) => socketId === 'agent-socket'
        ? {
            id: 'agent-member',
            userId: 'runtime-agent-id',
            name: 'Worker',
            source: 'agent',
          }
        : null),
    }]])
    server.contextStatusState = new Map()
    server.socketRequestedSourceMap = new Map([
      ['agent-socket', 'agent'],
      ['member-socket', 'human'],
      ['outsider-socket', 'human'],
    ])
    server.socketUserMap = new Map([
      ['member-socket', 'auth:7'],
      ['outsider-socket', 'auth:8'],
    ])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', sessionSeed: 'seed-1' })),
      getRoomAgentByAgentId: vi.fn(() => ({
        id: 'agent-row-1',
        roomId: 'room-1',
        agentId: 'runtime-agent-id',
        agent: 'codex',
        profile: 'default',
        name: 'Worker',
        avatar: 'worker.png',
      })),
      getRoomAgents: vi.fn(() => [{
        id: 'agent-row-1',
        roomId: 'room-1',
        agentId: 'runtime-agent-id',
        agent: 'codex',
        profile: 'default',
        name: 'Worker',
        avatar: 'worker.png',
      }]),
      getMemberByUserId: vi.fn((_roomId: string, userId: string) => (
        userId === 'auth:7' ? { userId, source: 'human' } : null
      )),
    }
    server.agentClients = { agentSessionIsCurrent: vi.fn(() => true) }
    server.nsp = {
      sockets: new Map([
        ['agent-socket', { id: 'agent-socket', data: {}, emit: agentEmit }],
        ['member-socket', { id: 'member-socket', data: { authUser: { id: 7 } }, emit: memberEmit }],
        ['outsider-socket', { id: 'outsider-socket', data: { authUser: { id: 8 } }, emit: outsiderEmit }],
      ]),
      to: vi.fn(() => ({ emit: joinedRoomEmit })),
    }
    const socket = {
      id: 'agent-socket',
      to: vi.fn(() => ({ emit: joinedRoomEmit })),
    }

    server.handleContextStatus(socket, {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'replying',
      runId: 'run-1',
      agentSessionId: 'session-1',
    })

    expect(memberEmit).toHaveBeenCalledWith('room_agent_activity', {
      roomId: 'room-1',
      agentId: 'agent-row-1',
      runId: 'run-1',
      agentName: 'Worker',
      agent: 'codex',
      avatar: 'worker.png',
      status: 'replying',
    })
    expect(outsiderEmit).not.toHaveBeenCalledWith('room_agent_activity', expect.anything())
    expect(agentEmit).not.toHaveBeenCalledWith('room_agent_activity', expect.anything())
  })

  it('returns all active runs for rooms the human socket may observe', () => {
    const server = createServerStub()
    server.roomAgentActivityState = new Map([
      ['room-1', new Map([
        ['agent-row-1\u0000run-1', {
          roomId: 'room-1',
          agentId: 'agent-row-1',
          runId: 'run-1',
          agentName: 'Worker',
          agent: 'codex',
          avatar: '',
          status: 'replying',
          agentSessionId: 'session-1',
        }],
      ])],
      ['room-2', new Map([
        ['agent-row-2\u0000run-2', {
          roomId: 'room-2',
          agentId: 'agent-row-2',
          runId: 'run-2',
          agentName: 'Secret',
          agent: 'claude',
          avatar: '',
          status: 'replying',
          agentSessionId: 'session-2',
        }],
      ])],
    ])
    server.socketRequestedSourceMap = new Map([['member-socket', 'human']])
    server.socketUserMap = new Map([['member-socket', 'auth:7']])
    server.storage = {
      getMemberByUserId: vi.fn((roomId: string, userId: string) => (
        roomId === 'room-1' && userId === 'auth:7' ? { userId, source: 'human' } : null
      )),
    }
    const ack = vi.fn()

    server.handleLoadRoomAgentActivities({ id: 'member-socket', data: { authUser: { id: 7 } } }, {}, ack)

    expect(ack).toHaveBeenCalledWith({
      activities: [expect.objectContaining({ roomId: 'room-1', runId: 'run-1' })],
    })
  })

  it('accepts side-channel events for the persisted non-Hermes runtime session', () => {
    const broadcastEmit = vi.fn()
    const agentMember = {
      id: 'agent-socket-1',
      userId: 'agent-ekko-1',
      name: 'ekko-agent',
      description: '',
      joinedAt: Date.now(),
      online: true,
      socketId: 'agent-socket-1',
      source: 'agent',
      avatar: '',
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', {
      getOnlineMemberBySocketId: vi.fn(() => agentMember),
    }]])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-1' })),
      getRoomAgentByAgentId: vi.fn(() => ({
        id: 'row-ekko-1',
        roomId: 'room-1',
        agentId: 'agent-ekko-1',
        agent: 'ekko',
        profile: 'default',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        reasoningEffort: '',
        name: 'ekko-agent',
      })),
    }
    server.nsp = { to: vi.fn(() => ({ emit: broadcastEmit })) }
    const socket = { id: 'agent-socket-1' }
    const sessionId = groupBridgeSessionId('room-1', 'default', 'ekko-agent', 'seed-1', {
      agent: 'ekko',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: '',
    })

    server.handleMessageStreamStart(socket, {
      roomId: 'room-1',
      id: 'ekko-stream',
      agentSessionId: sessionId,
    })

    expect(broadcastEmit).toHaveBeenCalledWith(
      'message_stream_start',
      expect.objectContaining({
        id: 'ekko-stream',
        senderId: 'agent-ekko-1',
        senderAgentRecordId: 'row-ekko-1',
        senderName: 'ekko-agent',
      }),
    )
  })

  it('does not drop queued mentions when room interrupt is not synchronized', async () => {
    const clients = new AgentClients() as any
    const agent = { name: 'Worker', interrupt: vi.fn(async () => false) }
    clients.rooms = new Map([['room-1', new Map([['agent-stable-1', agent]])]])
    clients._mentionQueue = new Map([
      ['room-1', [{ agent, msg: { content: '@Worker one', senderName: 'Han', senderId: 'user-1', timestamp: 1 } }]],
      ['room-1:Worker', [{ agent, msg: { content: '@Worker two', senderName: 'Han', senderId: 'user-1', timestamp: 2 } }]],
    ])

    await expect(clients.interruptRoom('room-1')).rejects.toMatchObject({ status: 409 })

    expect(clients._mentionQueue.has('room-1')).toBe(true)
    expect(clients._mentionQueue.has('room-1:Worker')).toBe(true)
  })

  it('rejects stale agent assistant/tool messages at persistence time after session rotation', () => {
    const emit = vi.fn()
    const saveMessageAndRefreshRoom = vi.fn()
    const agentMember = {
      id: 'agent-socket-1',
      userId: 'agent-stable-1',
      name: 'Worker',
      description: '',
      joinedAt: Date.now(),
      online: true,
      socketId: 'agent-socket-1',
      source: 'agent',
      avatar: '',
    }
    const server = createServerStub()
    server.rooms = new Map([['room-1', {
      hasOnlineMember: vi.fn(() => true),
      getOnlineMemberBySocketId: vi.fn(() => agentMember),
    }]])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-2' })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker' })),
      saveMessageAndRefreshRoom,
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const ack = vi.fn()
    const staleSessionId = groupBridgeSessionId('room-1', 'default', 'Worker', 'seed-1')

    server.handleMessage({ id: 'agent-socket-1' }, {
      roomId: 'room-1',
      content: 'late',
      role: 'assistant',
      agentSessionId: staleSessionId,
    }, ack)

    expect(ack).toHaveBeenCalledWith({ error: 'Stale room session' })
    expect(saveMessageAndRefreshRoom).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('clears runtime state before rotating persisted room context', async () => {
    const calls: string[] = []
    const room = { id: 'room-1', name: 'Room 1', inviteCode: 'invite', ownerAuthUserId: 7, workspace: '/tmp/workspace' }
    const storage = {
      getRoom: vi.fn(() => room),
      clearRoomContext: vi.fn(() => { calls.push('storage-clear') }),
    }
    const chatServer = {
      getStorage: () => storage,
      getRoomSummaryService: () => ({ runExclusive: async (_roomId: string, task: () => unknown) => task() }),
      clearRoomRuntimeState: vi.fn(async () => { calls.push('runtime-clear') }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/clear-context', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(calls).toEqual(['runtime-clear', 'storage-clear'])
    expect(chatServer.clearRoomRuntimeState).toHaveBeenCalledWith('room-1')
    expect(ctx.body).toEqual({ success: true, room: expect.objectContaining({ id: 'room-1', workspace: '/tmp/workspace' }) })
  })

  it('does not clear persisted context when runtime interrupt does not complete', async () => {
    const room = { id: 'room-1', name: 'Room 1', inviteCode: 'invite', ownerAuthUserId: 7, workspace: '/tmp/workspace' }
    const storage = {
      getRoom: vi.fn(() => room),
      clearRoomContext: vi.fn(),
    }
    const chatServer = {
      getStorage: () => storage,
      getRoomSummaryService: () => ({ runExclusive: async (_roomId: string, task: () => unknown) => task() }),
      clearRoomRuntimeState: vi.fn(async () => { throw Object.assign(new Error('still running'), { status: 409 }) }),
    }
    setGroupChatServer(chatServer as any)

    const handler = routeHandler('/api/studio/group-chat/rooms/:roomId/clear-context', 'POST')
    const ctx: any = {
      params: { roomId: 'room-1' },
      state: { user: { id: 1, username: 'root', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(ctx.status).toBe(409)
    expect(ctx.body).toEqual({ error: 'still running' })
    expect(storage.clearRoomContext).not.toHaveBeenCalled()
  })

  it('rejects authenticated Socket.IO room joins without invite, membership, owner, or profile scope', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['other'] } },
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(ack).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.storage.addRoomMember).not.toHaveBeenCalled()
    expect(socket.join).not.toHaveBeenCalled()
  })

  it('scopes invite guests to one room and denies realtime management', () => {
    const server = createServerStub()
    server.socketRequestedSourceMap = new Map([['guest-socket', 'human']])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Shared Room', inviteCode: 'secret' })),
    }
    const socket = {
      id: 'guest-socket',
      data: { inviteGuestRoomId: 'room-1' },
    }

    expect(server.canSocketJoinRoom(socket, 'room-1', { id: 'room-1' }, null)).toBe(true)
    expect(server.canSocketJoinRoom(socket, 'room-2', { id: 'room-2' }, null)).toBe(false)
    expect(server.canSocketManageRoom(socket, 'room-1')).toBe(false)
  })

  it('loads stable-cursor history only for a socket already joined to the room', () => {
    const member = { source: 'human' }
    const server = createServerStub()
    server.rooms = new Map([['room-1', {
      getOnlineMemberBySocketId: vi.fn(() => member),
    }]])
    server.storage = {
      getHistoryPageForUI: vi.fn(() => ({
        messages: [{ id: 'older-1' }],
        hasMore: true,
        cursorFound: true,
      })),
      getMessageCount: vi.fn(() => 725),
    }
    const ack = vi.fn()

    server.handleLoadMessages(
      { id: 'guest-socket' },
      { roomId: 'room-1', before: 'message-651', limit: 1, history: true },
      ack,
    )

    expect(server.storage.getHistoryPageForUI).toHaveBeenCalledWith('room-1', 1, 'message-651')
    expect(ack).toHaveBeenCalledWith({
      messages: [{ id: 'older-1' }],
      total: 725,
      offset: 0,
      limit: 1,
      hasMore: true,
      historyTruncated: true,
    })
  })

  it('broadcasts the complete room agent roster after mutations', () => {
    const agents = [{ id: 'row-agent', agentId: 'agent-1', name: 'Agent', executorType: 'server' }]
    const emit = vi.fn()
    const to = vi.fn(() => ({ emit }))
    const server = createServerStub()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', ownerAuthUserId: 7 })),
      getRoomAgents: vi.fn(() => agents),
    }
    server.agentClients = { getAgent: vi.fn(() => ({ connected: true })) }
    server.rooms = new Map()
    server.nsp = { to }

    expect(server.broadcastRoomAgents('room-1')).toEqual([
      { ...agents[0], connectionStatus: 'online', ownerMemberId: 'auth:7' },
    ])
    expect(to).toHaveBeenCalledWith('room-1')
    expect(emit).toHaveBeenCalledWith('agents_updated', {
      roomId: 'room-1',
      agents: [{ ...agents[0], connectionStatus: 'online', ownerMemberId: 'auth:7' }],
    })
  })

  it('denies read-only room members realtime management actions', async () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', ownerAuthUserId: 7, inviteCode: 'secret' })),
      getRoomsForProfiles: vi.fn(() => []),
    }
    server.agentClients = { interruptAgent: vi.fn() }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'member', role: 'admin', profiles: ['other'] } },
    }
    const interruptAck = vi.fn()
    const approvalAck = vi.fn()

    await server.handleInterruptAgent(socket, { roomId: 'room-1', agentName: 'Worker' }, interruptAck)
    await server.handleApprovalRespond(socket, { roomId: 'room-1', approval_id: 'approval-1', choice: 'once' }, approvalAck)

    expect(interruptAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(approvalAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.agentClients.interruptAgent).not.toHaveBeenCalled()
  })

  it('clears reconnectable replying state after an agent interrupt succeeds', async () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.contextStatusState = new Map([['room-1', new Map([[
      'Worker',
      {
        agentName: 'Worker',
        status: 'replying',
        agentSessionId: 'fresh-run-1',
      },
    ]])]])
    server.agentClients = { interruptAgent: vi.fn(async () => {}) }
    server.canSocketManageRoom = vi.fn(() => true)
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const ack = vi.fn()

    await server.handleInterruptAgent(
      { id: 'socket-1' },
      { roomId: 'room-1', agentName: 'Worker' },
      ack,
    )

    expect(server.contextStatusState.size).toBe(0)
    expect(emit).toHaveBeenCalledWith('context_status', {
      roomId: 'room-1',
      agentName: 'Worker',
      status: 'ready',
    })
    expect(ack).toHaveBeenCalledWith({ ok: true })
  })

  it('allows a member to interrupt only their own remote Agent', async () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.contextStatusState = new Map()
    server.canSocketManageRoom = vi.fn(() => false)
    server.socketRequestedSourceMap = new Map()
    server.socketUserMap = new Map([['owner-socket', 'guest-owner']])
    server.storage = {
      getRoomAgents: vi.fn(() => [
        {
          name: 'Owned Remote',
          executorType: 'remote',
          ownerMemberId: 'guest-owner',
        },
        {
          name: 'Other Remote',
          executorType: 'remote',
          ownerMemberId: 'guest-other',
        },
      ]),
    }
    server.agentClients = { interruptAgent: vi.fn(async () => {}) }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const socket = { id: 'owner-socket' }
    const ownedAck = vi.fn()
    const otherAck = vi.fn()

    await server.handleInterruptAgent(socket, {
      roomId: 'room-1',
      agentName: 'Owned Remote',
    }, ownedAck)
    await server.handleInterruptAgent(socket, {
      roomId: 'room-1',
      agentName: 'Other Remote',
    }, otherAck)

    expect(ownedAck).toHaveBeenCalledWith({ ok: true })
    expect(otherAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.agentClients.interruptAgent).toHaveBeenCalledTimes(1)
    expect(server.agentClients.interruptAgent).toHaveBeenCalledWith('room-1', 'Owned Remote')
  })

  it('denies runtime agent sockets realtime management actions even after they join the room', async () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map([['room-1', { hasOnlineMember: vi.fn(() => true) }]])
    server.socketRequestedSourceMap = new Map([['agent-socket', 'agent']])
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', ownerAuthUserId: 7, inviteCode: 'secret' })),
      getRoomsForProfiles: vi.fn(() => []),
    }
    server.agentClients = { interruptAgent: vi.fn() }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const socket = { id: 'agent-socket', data: {} }
    const interruptAck = vi.fn()
    const approvalAck = vi.fn()

    await server.handleInterruptAgent(socket, { roomId: 'room-1', agentName: 'Worker' }, interruptAck)
    await server.handleApprovalRespond(socket, { roomId: 'room-1', approval_id: 'approval-1', choice: 'once' }, approvalAck)

    expect(interruptAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(approvalAck).toHaveBeenCalledWith({ error: 'Access denied' })
    expect(server.agentClients.interruptAgent).not.toHaveBeenCalled()
  })

  it('allows pre-persisted agent sockets to join without creating human membership', () => {
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-agent', 'agent-stable-1']])
    server.socketRequestedSourceMap = new Map([['socket-agent', 'agent']])
    server.socketAuthUserIdMap = new Map()
    server.userInfoMap = new Map([['agent-stable-1', { name: 'Worker', description: 'runtime agent' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-stable-1', profile: 'default', name: 'Worker', description: '', invited: 0 })),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-agent',
      data: {},
      join: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.roomSummaryService.getState).toHaveBeenCalledWith('room-1')
    expect(ack.mock.calls[0][0].roomSummary).toMatchObject({ roomId: 'room-1', status: 'idle' })
    expect(server.storage.getRoomAgentByAgentId).toHaveBeenCalledWith('room-1', 'agent-stable-1')
    expect(server.storage.addRoomMember).not.toHaveBeenCalled()
    expect(socket.join).toHaveBeenCalledWith('room-1')
    expect(ack.mock.calls[0][0]).toEqual(expect.objectContaining({ roomId: 'room-1', messages: [], agents: [] }))
  })

  it('allows Socket.IO room joins with the matching invite code and then persists membership', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: 'secret', ownerAuthUserId: 7 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['other'] } },
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1', inviteCode: 'secret' }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith('room-1', 'auth:42', 'alice', '', expect.any(String), 42)
    expect(socket.join).toHaveBeenCalledWith('room-1')
    expect(ack.mock.calls[0][0]).toEqual(expect.objectContaining({ roomId: 'room-1', messages: [], agents: [] }))
  })

  it('keeps every joined socket valid when one authenticated user opens the room twice', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([
      ['socket-1', 'auth:42'],
      ['socket-2', 'auth:42'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['socket-1', 'human'],
      ['socket-2', 'human'],
    ])
    server.socketAuthUserIdMap = new Map([
      ['socket-1', 42],
      ['socket-2', 42],
    ])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: null, ownerAuthUserId: 42 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1',
        userId: 'auth:42',
        name: 'alice',
        description: '',
        joinedAt: 1,
        avatar: '',
        authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const createSocket = (id: string) => ({
      id,
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['default'] } },
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    })

    server.handleJoin(createSocket('socket-1'), { roomId: 'room-1' }, vi.fn())
    server.handleJoin(createSocket('socket-2'), { roomId: 'room-1' }, vi.fn())

    const room = server.rooms.get('room-1')
    expect(room.getMembersList()).toHaveLength(1)
    expect(room.hasOnlineMember('socket-1')).toBe(true)
    expect(room.hasOnlineMember('socket-2')).toBe(true)
    expect(room.getOnlineMemberBySocketId('socket-1')?.userId).toBe('auth:42')
    expect(room.getOnlineMemberBySocketId('socket-2')?.userId).toBe('auth:42')
  })

  it('keeps the user online when one of their joined room sockets disconnects', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([
      ['socket-1', 'auth:42'],
      ['socket-2', 'auth:42'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['socket-1', 'human'],
      ['socket-2', 'human'],
    ])
    server.socketAuthUserIdMap = new Map([
      ['socket-1', 42],
      ['socket-2', 42],
    ])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.nsp = { to: vi.fn(() => ({ emit })) }
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: null, ownerAuthUserId: 42 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1',
        userId: 'auth:42',
        name: 'alice',
        description: '',
        joinedAt: 1,
        avatar: '',
        authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const createSocket = (id: string) => ({
      id,
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['default'] } },
      join: vi.fn(),
      leave: vi.fn(),
      to: vi.fn(() => ({ emit })),
    })
    const socket1 = createSocket('socket-1')
    const socket2 = createSocket('socket-2')
    server.handleJoin(socket1, { roomId: 'room-1' }, vi.fn())
    server.handleJoin(socket2, { roomId: 'room-1' }, vi.fn())
    emit.mockClear()

    server.leaveAllRooms(socket2, 'socket-2')

    const room = server.rooms.get('room-1')
    expect(room.hasOnlineMember('socket-1')).toBe(true)
    expect(room.hasOnlineMember('socket-2')).toBe(false)
    expect(room.getMembersList()).toEqual([
      expect.objectContaining({ userId: 'auth:42', online: true }),
    ])
    expect(socket2.leave).toHaveBeenCalledWith('room-1')
    expect(emit).not.toHaveBeenCalledWith('member_left', expect.anything())
  })

  it('marks the user offline only after their last joined room socket disconnects', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([
      ['socket-1', 'auth:42'],
      ['socket-2', 'auth:42'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['socket-1', 'human'],
      ['socket-2', 'human'],
    ])
    server.socketAuthUserIdMap = new Map([
      ['socket-1', 42],
      ['socket-2', 42],
    ])
    server.userInfoMap = new Map([['auth:42', { name: 'alice', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.nsp = { to: vi.fn(() => ({ emit })) }
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', inviteCode: null, ownerAuthUserId: 42 })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1', userId: 'auth:42', name: 'alice', description: '', joinedAt: 1, avatar: '', authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const createSocket = (id: string) => ({
      id,
      data: { authUser: { id: 42, username: 'alice', role: 'admin', profiles: ['default'] } },
      join: vi.fn(),
      leave: vi.fn(),
      to: vi.fn(() => ({ emit })),
    })
    const socket1 = createSocket('socket-1')
    const socket2 = createSocket('socket-2')
    server.handleJoin(socket1, { roomId: 'room-1' }, vi.fn())
    server.handleJoin(socket2, { roomId: 'room-1' }, vi.fn())
    emit.mockClear()

    server.leaveAllRooms(socket2, 'socket-2')
    server.leaveAllRooms(socket1, 'socket-1')

    const room = server.rooms.get('room-1')
    expect(room.hasOnlineMember('socket-1')).toBe(false)
    expect(room.hasOnlineMember('socket-2')).toBe(false)
    expect(room.getMembersList()).toEqual([
      expect.objectContaining({ userId: 'auth:42', online: false }),
    ])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('member_left', expect.objectContaining({
      roomId: 'room-1',
      memberId: 'auth:42',
      memberName: 'alice',
    }))
  })

  it('reuses an authenticated member name when the browser has no local group-chat name', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice-login', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null),
      getMemberByAuthUserId: vi.fn(() => ({
        id: 'member-old',
        userId: 'browser-local-id',
        name: 'Alice Display',
        description: 'saved description',
        joinedAt: 1,
        avatar: '',
        authUserId: 42,
      })),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-1',
      'auth:42',
      'Alice Display',
      'saved description',
      '',
      42,
    )
    expect(ack.mock.calls[0][0].members).toEqual([
      expect.objectContaining({ userId: 'auth:42', name: 'Alice Display' }),
    ])
  })

  it('persists the room creator profile from the create form before realtime join', async () => {
    const addRoomMember = vi.fn()
    const storage = {
      setRoomOwnerAuthUserId: vi.fn(),
      addRoomMember,
      saveRoom: vi.fn(),
      getRoom: vi.fn((roomId: string) => ({
        id: roomId,
        name: 'Family Room',
        inviteCode: 'secret',
        ownerAuthUserId: 42,
      })),
    }
    setGroupChatServer({
      getStorage: () => storage,
      agentClients: {},
      ensureDefaultRoomWorkspace: (roomId: string, profile: string) => `/managed/group-chat/${profile}/${roomId}`,
    } as any)

    const handler = routeHandler('/api/studio/group-chat/rooms', 'POST')
    const ctx: any = {
      state: { user: { id: 42, username: 'alice-login', role: 'admin' } },
      request: {
        body: {
          name: 'Family Room',
          inviteCode: 'secret',
          memberName: '妈妈',
          memberDescription: 'family profile',
        },
      },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(addRoomMember).toHaveBeenCalledWith(
      expect.any(String),
      'auth:42',
      '妈妈',
      'family profile',
      '',
      42,
    )
    expect(ctx.body.room).toEqual(expect.objectContaining({ name: 'Family Room' }))
  })

  it('updates an explicitly requested human profile only in the joined room', () => {
    const emit = vi.fn()
    const liveMember: any = {
      id: 'socket-1',
      userId: 'auth:42',
      name: 'alice-login',
      description: '',
      source: 'human',
      avatar: 'avatar-data',
      online: true,
      socketId: 'socket-1',
    }
    const room = {
      getOnlineMemberBySocketId: vi.fn(() => liveMember),
      addOrUpdateMember: vi.fn((
        _socketId: string,
        _userId: string,
        name: string,
        description: string,
      ) => {
        liveMember.name = name
        liveMember.description = description
        return liveMember
      }),
      getMembersList: vi.fn(() => [liveMember]),
    }
    const server = createServerStub()
    server.rooms = new Map([['room-family', room]])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'alice-login', description: '' }]])
    server.storage = { addRoomMember: vi.fn() }
    server.nsp = { to: vi.fn(() => ({ emit })) }
    const socket = { id: 'socket-1' }
    const ack = vi.fn()

    server.handleUpdateMemberProfile(socket, {
      roomId: 'room-family',
      name: '妈妈',
      description: 'family profile',
    }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-family',
      'auth:42',
      '妈妈',
      'family profile',
      'avatar-data',
      42,
    )
    expect(server.userInfoMap.get('auth:42')).toEqual({
      name: '妈妈',
      description: 'family profile',
    })
    expect(emit).toHaveBeenCalledWith('member_updated', expect.objectContaining({
      roomId: 'room-family',
      memberName: '妈妈',
    }))
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({
      member: expect.objectContaining({ name: '妈妈' }),
    }))
  })

  it('filters room list to rooms containing one of the regular admin profiles', async () => {
    const allRooms = [
      { id: 'room-default', name: 'Default', inviteCode: null },
      { id: 'room-private', name: 'Private', inviteCode: null },
    ]
    const visibleRooms = [allRooms[0]]
    const storage = {
      getAllRooms: vi.fn(() => allRooms),
      getRoomsForProfiles: vi.fn(() => visibleRooms),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/studio/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 2, username: 'ops', role: 'admin', profiles: ['default', 'research'] } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getRoomsForProfiles).toHaveBeenCalledWith(['default', 'research'])
    expect(storage.getAllRooms).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [expect.objectContaining({ id: 'room-default', inviteCode: null, canManage: true })] })
  })

  it('keeps room list unrestricted for super admins', async () => {
    const rooms = [{ id: 'room-1', name: 'All', inviteCode: null }]
    const storage = {
      getAllRooms: vi.fn(() => rooms),
      getRoomsForProfiles: vi.fn(() => []),
    }
    setGroupChatServer({ getStorage: () => storage } as any)

    const handler = routeHandler('/api/studio/group-chat/rooms', 'GET')
    const ctx: any = {
      state: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: undefined,
    }
    await handler(ctx, async () => {})

    expect(storage.getAllRooms).toHaveBeenCalledOnce()
    expect(storage.getRoomsForProfiles).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ rooms: [expect.objectContaining({ id: 'room-1', inviteCode: null, canManage: true })] })
  })

  it('routes trusted @mentions and always checks persisted public messages', async () => {
    const server = createServerStub()
    server.notifiedGroupMessages = new Set<string>()
    const emit = vi.fn()
    server.rooms = new Map([
      ['room-1', {
        hasOnlineMember: vi.fn(() => true),
        getOnlineMemberBySocketId: vi.fn((socketId: string) => socketId === 'agent-socket'
          ? { userId: 'agent-1', name: '丫鬟', source: 'agent' }
          : { userId: 'human-1', name: 'Human', source: 'human' }),
      }],
    ])
    server.socketUserMap = new Map([
      ['human-socket', 'human-1'],
      ['agent-socket', 'agent-1'],
    ])
    server.socketRequestedSourceMap = new Map([
      ['human-socket', 'human'],
      ['agent-socket', 'agent'],
    ])
    server.userInfoMap = new Map([
      ['human-1', { name: 'Human', description: '' }],
      ['agent-1', { name: '丫鬟', description: '' }],
    ])
    const processSummaryCheck = vi.fn(async () => undefined)
    server.agentClients = { processMentions: vi.fn(async () => undefined), processSummaryCheck }
    const agentSessionId = groupBridgeSessionId('room-1', 'default', '丫鬟', 'seed-1')
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room', sessionSeed: 'seed-1' })),
      getMemberByUserId: vi.fn((_roomId: string, userId: string) => userId === 'human-1'
        ? { id: 'member-human-1', roomId: 'room-1', userId: 'human-1', source: 'human' }
        : null),
      getRoomAgentByAgentId: vi.fn(() => ({ id: 'row-1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: '丫鬟' })),
      getRoomAgents: vi.fn(() => [
        { id: 'row-1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: '丫鬟' },
        { id: 'row-2', roomId: 'room-1', agentId: 'agent-2', profile: 'default', name: 'Reviewer' },
      ]),
      consumeTrustedAgentMessageMetadata: vi.fn()
        .mockReturnValueOnce({ mentionDepth: 1, handoffChainId: 'trusted-chain' })
        .mockReturnValueOnce({ mentionDepth: 4, handoffChainId: 'trusted-chain' })
        .mockReturnValueOnce(null),
      getRoomAgentHandoffPolicy: vi.fn(() => ({ enabled: true, maxDepth: 4, unlimited: false })),
      completeHandoffTarget: vi.fn(),
      saveMessageAndRefreshRoom: vi.fn((msg: any) => ({ message: msg, totalTokens: 123 })),
    }
    server.nsp = { to: vi.fn(() => ({ emit })) }

    server.handleMessage({ id: 'human-socket' }, { roomId: 'room-1', content: '@all hi', role: 'user' }, vi.fn())
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@all hi',
      senderId: 'human-1',
      mentionDepth: 0,
    }))

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, {
      roomId: 'room-1',
      content: '@Reviewer agent says hi',
      role: 'assistant',
      mentionDepth: 1,
      agentSessionId,
      mentions: [{ type: 'agent', participantId: 'agent-2', displayName: 'Reviewer' }],
    }, vi.fn())
    expect(server.agentClients.processMentions).toHaveBeenCalledTimes(1)
    expect(server.agentClients.processMentions).toHaveBeenLastCalledWith('room-1', expect.objectContaining({
      content: '@Reviewer agent says hi',
      senderId: 'agent-1',
      mentionDepth: 1,
      mentions: [{ type: 'agent', participantId: 'agent-2' }],
    }))

    server.agentClients.processMentions.mockClear()
    server.handleMessage({ id: 'agent-socket' }, {
      roomId: 'room-1',
      content: '@Reviewer too deep',
      role: 'assistant',
      mentionDepth: 4,
      agentSessionId,
      mentions: [{ type: 'agent', participantId: 'agent-2', displayName: 'Reviewer' }],
    }, vi.fn())
    expect(server.agentClients.processMentions).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(processSummaryCheck).toHaveBeenCalledTimes(3))

    server.handleMessage({ id: 'agent-socket' }, {
      id: 'forged-agent-message',
      roomId: 'room-1',
      content: 'forged continuation',
      role: 'assistant',
      mentionDepth: 1,
      handoffChainId: 'forged-chain',
      continuationAttemptId: 'forged-attempt',
      agentSessionId,
    }, vi.fn())
    expect(server.storage.completeHandoffTarget).not.toHaveBeenCalled()
  })

  it('preserves per-room member name on rejoin when global userInfoMap has a different name', () => {
    // Reproduces hermes-agent #54774 / hermes-studio per-room member name bug:
    // switching rooms should not overwrite a member's per-room display name.
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    // User joined room B last, so global userInfoMap has "郑工" (work name).
    // But room A's DB record has "爸爸" (family name).
    server.userInfoMap = new Map([['auth:42', { name: '郑工', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Family Room', inviteCode: 'secret' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      // Room A's existing DB record has "爸爸" (per-room name)
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1',
        userId: 'auth:42',
        name: '爸爸',
        description: 'family persona',
        joinedAt: 1000,
        avatar: '',
        authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    // Per-room DB name ("爸爸") must be preserved, NOT overwritten by
    // the global userInfoMap entry ("郑工").
    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-1',
      'auth:42',
      '爸爸',
      'family persona',
      expect.any(String),
      42,
    )
  })

  it('uses requestedName on first join when no existing member record exists', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', { name: 'default-name', description: '' }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-2', name: 'Work Room', inviteCode: 'work123' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => null), // no existing member → first join
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    // Client passes name from the create-room form, plus invite code to pass
    // canSocketJoinRoom gate.
    server.handleJoin(socket, {
      roomId: 'room-2',
      inviteCode: 'work123',
      name: '郑工',
      description: 'work persona',
    }, ack)

    // On first join, requestedName is used
    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-2',
      'auth:42',
      '郑工',
      'work persona',
      expect.any(String),
      42,
    )
  })

  it('preserves per-room member description on rejoin when global userInfoMap has stale description', () => {
    const emit = vi.fn()
    const server = createServerStub()
    server.rooms = new Map()
    server.socketUserMap = new Map([['socket-1', 'auth:42']])
    server.socketRequestedSourceMap = new Map([['socket-1', 'human']])
    server.socketAuthUserIdMap = new Map([['socket-1', 42]])
    server.userInfoMap = new Map([['auth:42', {
      name: 'global-stale-name',
      description: 'global-stale-desc',
    }]])
    server.typingState = new Map()
    server.contextStatusState = new Map()
    server.roomSummaryService = createRoomSummaryServiceMock()
    server.storage = {
      getRoom: vi.fn(() => ({ id: 'room-1', name: 'Room' })),
      getRoomAgentByAgentId: vi.fn(() => null),
      getMemberByUserId: vi.fn(() => ({
        id: 'member-1',
        userId: 'auth:42',
        name: '爸爸',
        description: 'per-room-family-desc',
        joinedAt: 1000,
        avatar: '',
        authUserId: 42,
      })),
      getMemberByAuthUserId: vi.fn(() => null),
      getRoomsForProfiles: vi.fn(() => []),
      saveRoom: vi.fn(),
      addRoomMember: vi.fn(),
      getRecentMessagesForUI: vi.fn(() => []),
      getRoomAgents: vi.fn(() => []),
    }
    const socket = {
      id: 'socket-1',
      join: vi.fn(),
      to: vi.fn(() => ({ emit })),
    }
    const ack = vi.fn()

    server.handleJoin(socket, { roomId: 'room-1' }, ack)

    expect(server.storage.addRoomMember).toHaveBeenCalledWith(
      'room-1',
      'auth:42',
      '爸爸',
      'per-room-family-desc',
      expect.any(String),
      42,
    )
  })

})
