import { beforeEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { io } from 'socket.io-client'
import { AgentClient, AgentClients, type GroupChatRunService, type MentionMessage } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import { providerAccountId, providerRequestProfile, withProviderAccount } from '../../packages/server/src/modules/studio/public/provider-account'
import { GroupChatServer, type RoomInfo } from '../../packages/server/src/modules/studio/sockets/group-chat'

const { bridgeChat } = vi.hoisted(() => ({ bridgeChat: vi.fn() }))
beforeEach(() => { bridgeChat.mockReset() })

vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({
  getDb: () => null,
}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store', () => ({
  findUserById: (id: number) => ({ id, username: 'member', role: 'user', status: 'active' }),
  listUserProfiles: () => [{ profile_name: 'target-profile' }],
  listUsers: () => [7, 9].map(id => ({ id, status: 'active', profiles: ['target-profile'] })),
  userCanAccessProfile: (id: number, profile: string) => id === 7 && profile === 'target-profile',
}))
vi.mock('../../packages/server/src/modules/studio/services/chat-run/studio-mcp', () => ({
  hermesStudioMcpCapabilities: async () => ({}),
}))
vi.mock('../../packages/server/src/modules/studio/public/group-chat-agent-runtime', () => ({
  createGroupPrimaryAgentBridge: () => ({
    chat: bridgeChat,
    async *streamOutput() { yield { status: 'completed', delta: 'Handoff complete' } },
    destroy: async () => {},
  }),
}))

const handoff: MentionMessage = {
  messageId: 'agent-reply',
  handoffChainId: 'original-message',
  role: 'assistant',
  senderId: 'first-agent',
  senderName: 'First Agent',
  content: '@Target please continue',
  timestamp: 1,
  mentions: [{ type: 'agent', participantId: 'target' }],
}

function setup(agent: 'hermes' | 'ekko', rootRoomId = 'room') {
  const sendMessage = vi.fn(async () => 'response')
  const target = new AgentClient({
    agentId: 'target', agent, profile: 'target-profile', name: 'Target',
    provider: 'test-provider', model: 'test-model', description: '', invited: 0,
    backgroundDelegationEnabled: false,
  }, {}, { connected: true, emit: vi.fn(), sendMessage })
  const clients = new AgentClients()
  clients.setStorage({
    getRoom: () => ({ name: 'Room' }),
    getMessage: (id: string) => id === 'original-message'
      ? { roomId: rootRoomId, role: 'user', senderId: 'member' }
      : null,
    getMemberByUserId: (_roomId: string, id: string) => id === 'member' ? { authUserId: 7 } : null,
  })
  clients.registerAgentForRoom('room', target)
  return { clients, target, sendMessage }
}

it('runs the receiving Hermes Agent under the original member and the target Profile', async () => {
  const { clients, sendMessage } = setup('hermes')
  bridgeChat.mockImplementationOnce(async (_sessionId, _input, _history, _instructions, profile) => {
    await Promise.resolve()
    expect(providerAccountId(profile)).toBe(7)
    expect(providerRequestProfile()).toBe('target-profile')
    expect(profile).toBe('target-profile')
    return { run_id: 'bridge-run' }
  })

  await clients.processMentions('room', handoff)

  expect(sendMessage).toHaveBeenCalledWith('room', 'Handoff complete', expect.any(String), expect.objectContaining({
    role: 'assistant', handoffChainId: 'original-message',
  }), expect.any(String))
})

it('passes the same trusted identity through the non-Hermes chat runner', async () => {
  const { clients, target, sendMessage } = setup('ekko')
  const runAndWait = vi.fn<GroupChatRunService['runAndWait']>(async (data, options) => {
    expect(data.profile).toBe('target-profile')
    expect(options).toMatchObject({ profile: 'target-profile', user: { id: 7 } })
    expect(options?.groupRunIsCurrent?.()).toBe(true)
    expect(providerAccountId()).toBe(7)
    return { ok: true, output: 'Handoff complete' }
  })
  target.setChatRunService({ runAndWait, abortSession: async () => {} })

  await clients.processMentions('room', handoff)

  expect(sendMessage).toHaveBeenCalledWith('room', 'Handoff complete', expect.any(String), expect.anything(), expect.any(String))
})

it('cannot borrow a Provider account from another room or the enclosing queue', async () => {
  const { clients, sendMessage } = setup('hermes', 'another-room')

  await withProviderAccount(9, () => clients.processMentions('room', handoff), 'queue-profile')

  expect(bridgeChat).not.toHaveBeenCalled()
  expect(sendMessage).toHaveBeenCalledWith('room', 'Error: Provider access requires a Studio user context', expect.any(String),
    expect.objectContaining({ finish_reason: 'error' }), expect.any(String))
})

it('keeps invite guests separate from authenticated room members', async () => {
  const http = createServer()
  const server = new GroupChatServer(http)
  const storage = server.getStorage()
  const room = { id: 'room', name: 'Room', inviteCode: 'test-invite' } as RoomInfo
  const inviteRoom = vi.spyOn(storage, 'getRoomByInviteCode').mockReturnValue(room)
  const getRoom = vi.spyOn(storage, 'getRoom').mockReturnValue(room)
  const addMember = vi.spyOn(storage, 'addRoomMember').mockImplementation(() => {})

  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  const guest = io(`http://127.0.0.1:${address.port}/group-chat`, {
    auth: { inviteCode: room.inviteCode, userId: 'auth:7', authUserId: 7 },
    transports: ['websocket'],
  })
  try {
    await once(guest, 'connect', { signal: AbortSignal.timeout(2000) })
    const joined = await guest.timeout(2000).emitWithAck('join', { roomId: room.id, name: 'Guest' })
    expect(joined).toMatchObject({ roomId: room.id })
    expect(addMember).toHaveBeenCalledWith(room.id, guest.id, 'Guest', '', '', undefined)
  } finally {
    guest.disconnect()
    await server.getIO().close()
    inviteRoom.mockRestore()
    getRoom.mockRestore()
    addMember.mockRestore()
  }
})
