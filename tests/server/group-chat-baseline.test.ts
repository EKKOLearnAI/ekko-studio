import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { io as socketIo } from 'socket.io-client'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
  rejectGroupChatClient,
} from './group-chat-test-helpers'
import {
  defaultGroupChatWorkspace,
  type GroupChatServer,
} from '../../packages/server/src/modules/studio/sockets/group-chat'
import {
  GroupAgentRelayServer,
  GroupAgentOutboundRelayManager,
  redactRelaySecrets,
  relayRoomWorkspace,
  validateRelayRunRequest,
} from '../../packages/server/src/modules/studio/services/group-chat/agent-relay'
import { AgentClient } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import {
  authenticateRemoteWorkspaceGrant,
  resetRemoteWorkspaceGrantsForTest,
} from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-auth'
import { performRemoteWorkspaceAction } from '../../packages/server/src/modules/studio/services/group-chat/remote-workspace-files'

describe('group chat baseline behavior', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number
  let originalPort: string | undefined
  const temporaryDirectories: string[] = []

  beforeEach(async () => {
    vi.clearAllMocks()
    originalPort = process.env.PORT
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
  })

  afterEach(() => {
    harness?.cleanup()
    resetRemoteWorkspaceGrantsForTest()
    for (const path of temporaryDirectories.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
    if (originalPort === undefined) delete process.env.PORT
    else process.env.PORT = originalPort
  })

  it('derives a stable local workspace for remote room runs', () => {
    const room = { id: 'room-1', summaryProfile: 'research' }

    expect(relayRoomWorkspace(room)).toBe(defaultGroupChatWorkspace('research', 'room-1'))
    expect(relayRoomWorkspace(room)).toBe(relayRoomWorkspace(room))
    expect(() => relayRoomWorkspace({ id: '..', summaryProfile: 'research' })).toThrow('Invalid Relay room id')
    expect(() => relayRoomWorkspace({ id: 'room-1', summaryProfile: '..' })).toThrow(
      'Invalid Relay room summary profile',
    )
  })

  it('redacts short-lived workspace grants from nested relay events', () => {
    const secret = 'a'.repeat(43)

    expect(redactRelaySecrets({
      command: `curl -H "Authorization: Bearer ${secret}" https://group.example`,
      tool_calls: [{ arguments: JSON.stringify({ token: secret }) }],
    }, [secret])).toEqual({
      command: 'curl -H "Authorization: Bearer [REDACTED]" https://group.example',
      tool_calls: [{ arguments: JSON.stringify({ token: '[REDACTED]' }) }],
    })
  })

  it('accepts Relay mention depths governed by bounded or unlimited room policy', () => {
    const request = {
      protocolVersion: 2,
      runId: '11111111-2222-4333-8444-555555555555',
      room: { id: 'room-1', name: 'Room 1' },
      members: [],
      agents: [],
      message: {
        messageId: 'source-1',
        content: '@Remote continue',
        senderName: 'Source',
        senderId: 'agent-source',
        timestamp: 1,
        role: 'assistant',
        mentionDepth: 100,
      },
      runtimeContext: { summary: '', history: [] },
      attachments: [],
    }

    expect(() => validateRelayRunRequest(request)).not.toThrow()
    request.message.mentionDepth = Number.MAX_SAFE_INTEGER
    expect(() => validateRelayRunRequest(request)).not.toThrow()
  })

  it('joins an existing room and returns room-level history and membership', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    storage.saveMessageAndRefreshRoom({
      id: 'msg-1',
      roomId: 'room-1',
      senderId: 'user-a',
      senderName: 'Alice',
      content: 'existing',
      timestamp: 1,
      role: 'user',
    } as any)

    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    harness.sockets.push(alice)
    const joined = await emitAck<any>(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(joined).toMatchObject({ roomId: 'room-1' })
    expect(joined.messages.map((m: any) => m.id)).toEqual(['msg-1'])
    expect(joined.members.map((m: any) => m.name)).toContain('Alice')
    expect(joined.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Alice', connectionStatus: 'online' }),
    ]))
  })

  it('includes the current summary state when entering or reconnecting to a room', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-summary', 'Summary Room', 'SUMMARY1')
    const summary = groupServer.getRoomSummaryService().getState('room-summary')
    expect(storage.claimRoomSummaryRun('room-summary', summary, 'summary-run', Date.now() + 60_000)).toBe(true)
    const guest = await connectGroupChatClient(port, 'summary-guest', 'Guest')
    harness.sockets.push(guest)
    const joined = await emitAck<any>(guest, 'join', { roomId: 'room-summary', inviteCode: 'SUMMARY1' })
    expect(joined.roomSummary).toMatchObject({ roomId: 'room-summary', status: 'summarizing' })
    storage.saveRoomSummary({ ...joined.roomSummary, status: 'success', summary: 'Updated summary', updatedAt: Date.now() })
    const rejoined = await emitAck<any>(guest, 'join', { roomId: 'room-summary', inviteCode: 'SUMMARY1' })
    expect(rejoined.roomSummary).toMatchObject({ status: 'success', summary: 'Updated summary' })
  })

  it('honors the requested initial history page size when joining', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-history-limit', 'History Limit', 'HISTORY1')
    for (let index = 1; index <= 200; index += 1) {
      storage.saveMessageAndRefreshRoom({
        id: `msg-${String(index).padStart(3, '0')}`,
        roomId: 'room-history-limit',
        senderId: 'user-a',
        senderName: 'Alice',
        content: `message ${index}`,
        timestamp: index,
        role: 'user',
      } as any)
    }

    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    harness.sockets.push(alice)
    const joined = await emitAck<any>(alice, 'join', {
      roomId: 'room-history-limit',
      inviteCode: 'HISTORY1',
      historyLimit: 50,
    })

    expect(joined.messages).toHaveLength(50)
    expect(joined.messages[0]?.id).toBe('msg-151')
    expect(joined.messages.at(-1)?.id).toBe('msg-200')
    expect(joined).toMatchObject({ total: 200, hasMore: true })
  })

  it('broadcasts persisted human members as offline after their socket disconnects', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-presence', 'Presence Room', 'PRESENCE1')
    const alice = await connectGroupChatClient(port, 'user-alice', 'Alice')
    const bob = await connectGroupChatClient(port, 'user-bob', 'Bob')
    harness.sockets.push(alice, bob)
    await emitAck(alice, 'join', { roomId: 'room-presence', inviteCode: 'PRESENCE1' })
    await emitAck(bob, 'join', { roomId: 'room-presence', inviteCode: 'PRESENCE1' })

    const memberLeft = once<any>(bob, 'member_left')
    alice.disconnect()

    await expect(memberLeft).resolves.toMatchObject({
      roomId: 'room-presence',
      memberId: 'user-alice',
      members: expect.arrayContaining([
        expect.objectContaining({ userId: 'user-alice', connectionStatus: 'offline' }),
        expect.objectContaining({ userId: 'user-bob', connectionStatus: 'online' }),
      ]),
    })
  })

  it('removes a live human member from the room and notifies that member', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const guest = await connectGroupChatClient(port, 'guest-remove', 'Guest')
    harness.sockets.push(guest)
    await emitAck(guest, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const kicked = once<any>(guest, 'member_kicked')
    const members = groupServer.removeRoomMember('room-1', 'guest-remove')

    await expect(kicked).resolves.toEqual({ roomId: 'room-1' })
    expect(members).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'guest-remove' }),
    ]))
    expect(storage.getMemberByUserId('room-1', 'guest-remove')).toBeNull()
  })

  it('authenticates an invite-only socket and scopes it to the invited room', async () => {
    harness.cleanup()
    harness = await createTestGroupChatServer({ authEnabled: true })
    groupServer = harness.groupServer
    port = harness.port

    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.saveRoom('room-2', 'Other Room', 'ROOM2')

    const guest = await connectGroupChatClient(port, 'guest-1', 'Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest)

    const joined = await emitAck<any>(guest, 'join', { roomId: 'room-1', name: 'Guest' })
    const denied = await emitAck<any>(guest, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })

    expect(joined).toMatchObject({ roomId: 'room-1', rooms: ['room-1'] })
    expect(denied).toEqual({ error: 'Access denied' })
  })

  it('keeps invite-only sockets scoped when account authentication is disabled', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.saveRoom('room-2', 'Other Room', 'ROOM2')

    const guest = await connectGroupChatClient(port, 'guest-1', 'Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest)

    const joined = await emitAck<any>(guest, 'join', { roomId: 'room-1', name: 'Guest' })
    const denied = await emitAck<any>(guest, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })
    const managementDenied = await emitAck<any>(guest, 'interrupt_agent', {
      roomId: 'room-1',
      agentName: 'Agent',
    })

    expect(joined).toMatchObject({ roomId: 'room-1', rooms: ['room-1'] })
    expect(denied).toEqual({ error: 'Access denied' })
    expect(managementDenied).toEqual({ error: 'Access denied' })
    await expect(rejectGroupChatClient(port, {
      userId: 'invalid-guest',
      name: 'Invalid Guest',
      inviteCode: 'INVALID',
    })).resolves.toBe('Unauthorized')
  })

  it('atomically binds mobile human messages to separate group roots', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('push-room', 'Push Room', 'PUSH')
    const phone = await connectGroupChatClient(port, 'owner', 'Owner')
    harness.sockets.push(phone)
    await emitAck(phone, 'join', { roomId: 'push-room', name: 'Owner', inviteCode: 'PUSH' })
    const serverSocket = groupServer.getIO().of('/group-chat').sockets.get(phone.id!)!
    serverSocket.data.pushActor = { userId: 7, deviceId: 'phone-a', studioDeviceId: 'studio-a' }
    const first = await emitAck<any>(phone, 'message', { roomId: 'push-room', content: 'First', handoffChainId: 'spoof' })
    const second = await emitAck<any>(phone, 'message', { roomId: 'push-room', content: 'Second' })
    expect(first.error).toBeUndefined()
    expect(second.error).toBeUndefined()
    const targets = harness.db.prepare('SELECT * FROM run_push_targets ORDER BY created_at').all() as any[]
    expect(targets.map(target => target.run_id)).toEqual([first.id, second.id])
    expect(targets.every(target => target.device_id === 'phone-a' && target.studio_device_id === 'studio-a' && target.kind === 'group')).toBe(true)
    expect(storage.getRecentMessagesForUI('push-room')).toHaveLength(2)
  })

  it('allows only the room owner to broadcast with @all', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')

    const guest = await connectGroupChatClient(port, 'guest-1', 'Guest', { inviteCode: 'ROOM1' })
    const owner = await connectGroupChatClient(port, 'owner-1', 'Owner')
    harness.sockets.push(guest, owner)
    await emitAck(guest, 'join', { roomId: 'room-1', name: 'Guest' })
    await emitAck(owner, 'join', { roomId: 'room-1', name: 'Owner', inviteCode: 'ROOM1' })

    const denied = await emitAck<any>(guest, 'message', {
      roomId: 'room-1',
      content: '@all guest broadcast',
    })
    const allowed = await emitAck<any>(owner, 'message', {
      roomId: 'room-1',
      content: '@all owner broadcast',
    })

    expect(denied).toEqual({
      code: 'GROUP_CHAT_ALL_MENTION_FORBIDDEN',
      error: 'Only the room owner can mention @all',
    })
    expect(allowed.id).toEqual(expect.any(String))
    expect(storage.getRecentMessagesForUI('room-1').map(message => message.content))
      .toEqual(['@all owner broadcast'])
  })

  it('issues a room-member-bound proof for guest Agent pairing requests', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')

    const guest = await connectGroupChatClient(port, 'guest-agent-owner', 'Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest)
    const joined = await emitAck<any>(guest, 'join', { roomId: 'room-1', name: 'Guest' })

    expect(joined.agentLinkToken).toEqual(expect.any(String))
    expect(joined.agentLinkToken.length).toBeGreaterThan(32)
    expect(groupServer.authorizeGuestAgentRequestToken(
      'room-1',
      'guest-agent-owner',
      joined.agentLinkToken,
    )).toBe(true)
    expect(groupServer.authorizeGuestAgentRequestToken(
      'room-1',
      'another-member',
      joined.agentLinkToken,
    )).toBe(false)
    expect(groupServer.authorizeGuestAgentRequestToken(
      'another-room',
      'guest-agent-owner',
      joined.agentLinkToken,
    )).toBe(false)
    expect(groupServer.authorizeGuestAgentRequestToken(
      'room-1',
      'guest-agent-owner',
      'forged-token',
    )).toBe(false)
  })

  it('reveals remote Agent management fields only to its owning guest', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.addRoomAgent('room-1', 'remote-owned', 'default', 'Owned Agent', '', 1, {
      executorType: 'remote',
      ownerMemberId: 'guest-owner',
      connectorId: '11111111-2222-4333-8444-555555555555',
      remoteOrigin: 'http://127.0.0.1:8648',
    })

    const owner = await connectGroupChatClient(port, 'guest-owner', 'Owner Guest', { inviteCode: 'ROOM1' })
    const other = await connectGroupChatClient(port, 'guest-other', 'Other Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(owner, other)
    const ownerJoin = await emitAck<any>(owner, 'join', { roomId: 'room-1', name: 'Owner Guest' })
    const otherJoin = await emitAck<any>(other, 'join', { roomId: 'room-1', name: 'Other Guest' })

    expect(ownerJoin.agents[0]).toMatchObject({
      ownerMemberId: 'guest-owner',
      connectorId: '11111111-2222-4333-8444-555555555555',
      remoteOrigin: 'http://127.0.0.1:8648',
    })
    expect(otherJoin.agents[0]).toMatchObject({ ownerMemberId: 'guest-owner' })
    expect(otherJoin.agents[0]).not.toHaveProperty('connectorId')
    expect(otherJoin.agents[0]).not.toHaveProperty('remoteOrigin')
    const managerView = groupServer.getRoomAgentViews('room-1', true)
    expect(managerView[0]).toMatchObject({ ownerMemberId: 'guest-owner' })
    expect(managerView[0]).not.toHaveProperty('connectorId')
    expect(managerView[0]).not.toHaveProperty('remoteOrigin')
  })

  it('returns an offline Agent owner avatar to other room members', async () => {
    const storage = groupServer.getStorage()
    const ownerAvatar = JSON.stringify({ type: 'generated', seed: 'offline-owner' })
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.addRoomMember('room-1', 'guest-owner', 'Offline Owner', '', ownerAvatar)
    storage.addRoomAgent('room-1', 'remote-owned', 'default', 'Owned Agent', '', 1, {
      executorType: 'remote',
      ownerMemberId: 'guest-owner',
      remoteOrigin: 'http://127.0.0.1:8648',
    })

    const viewer = await connectGroupChatClient(port, 'guest-viewer', 'Viewer', { inviteCode: 'ROOM1' })
    harness.sockets.push(viewer)
    const joined = await emitAck<any>(viewer, 'join', { roomId: 'room-1', name: 'Viewer' })

    expect(joined.agents).toEqual([
      expect.objectContaining({
        ownerMemberId: 'guest-owner',
        connectionStatus: 'offline',
      }),
    ])
    expect(joined.members).toEqual(expect.arrayContaining([
      expect.objectContaining({
        userId: 'guest-owner',
        name: 'Offline Owner',
        avatar: ownerAvatar,
      }),
    ]))
  })

  it('allows an invite member to remove only their own remote Agent', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    const owned = storage.addRoomAgent('room-1', 'owned-remote', 'default', 'Owned Remote', '', 1, {
      executorType: 'remote',
      ownerMemberId: 'guest-owner',
      remoteOrigin: 'http://127.0.0.1:8648',
    })
    const other = storage.addRoomAgent('room-1', 'other-remote', 'default', 'Other Remote', '', 1, {
      executorType: 'remote',
      ownerMemberId: 'guest-other',
      remoteOrigin: 'http://127.0.0.1:8748',
    })
    const owner = await connectGroupChatClient(port, 'guest-owner', 'Owner Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(owner)
    await emitAck(owner, 'join', { roomId: 'room-1', name: 'Owner Guest' })

    const denied = await emitAck<any>(owner, 'remove_agent', {
      roomId: 'room-1',
      agentId: other.id,
    })
    const removed = await emitAck<any>(owner, 'remove_agent', {
      roomId: 'room-1',
      agentId: owned.id,
    })

    expect(denied).toEqual({ error: 'Access denied' })
    expect(removed).toMatchObject({
      ok: true,
      agents: [expect.objectContaining({ id: other.id, ownerMemberId: 'guest-other' })],
    })
    expect(storage.getRoomAgents('room-1')).toEqual([
      expect.objectContaining({ id: other.id }),
    ])
  })

  it('attributes server-local room Agents to the persisted room owner', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-owned', 'Owned Room', 'OWNED1', {
      summaryProfile: 'default',
      summaryProvider: '',
      summaryModel: '',
      summaryApiMode: 'chat_completions',
      summaryEveryTurns: 20,
      ownerAuthUserId: 7,
    })
    storage.addRoomMember('room-owned', 'auth:7', 'Room Owner', '', '', 7)
    storage.addRoomAgent('room-owned', 'local-agent', 'default', 'Local Agent', '', 1)

    expect(groupServer.getRoomAgentViews('room-owned', false)[0]).toMatchObject({
      executorType: 'server',
      ownerMemberId: 'auth:7',
    })
  })

  it('keeps pairing tickets single-use and replaces them with revocable reconnect credentials', async () => {
    const relayStore = await import('../../packages/server/src/modules/studio/services/group-chat/agent-relay-store')
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.updateRoomGuestAgentPolicy('room-1', {
      allowGuestAgents: true,
      maxGuestAgentsPerMember: 1,
      allowRemoteWorkspaceAccess: false,
    })
    const roomAgent = storage.addRoomAgent('room-1', 'remote-agent', 'default', 'Remote', '', 1, {
      executorType: 'remote',
      ownerMemberId: 'guest-agent-owner',
      remoteOrigin: 'http://127.0.0.1:8648',
    })
    const created = relayStore.createGroupAgentPairingRequest({
      roomId: 'room-1',
      ownerMemberId: 'guest-agent-owner',
      ownerName: 'Guest',
      targetOrigin: 'http://127.0.0.1:8648',
      agent: relayStore.normalizeRemoteGroupAgentDescriptor({
        agent: 'pi',
        profile: 'default',
        provider: 'openai',
        model: 'pi-remote-model',
        apiMode: 'codex_responses',
        name: 'Remote Pi',
      }),
      now: 1_000,
    })
    expect(created.request.agent).toMatchObject({
      agent: 'pi',
      model: 'pi-remote-model',
      apiMode: 'codex_responses',
      name: 'Remote Pi',
    })

    expect(relayStore.getGroupAgentPairingRequestForRequester(
      created.request.id,
      'wrong-secret',
      1_100,
    )).toBeNull()
    expect(relayStore.decideGroupAgentPairingRequest(created.request.id, true, 1, 2_000)?.status)
      .toBe('approved')
    expect(relayStore.claimGroupAgentPairingTicket(created.pairingTicket, 2_100)?.status)
      .toBe('connecting')
    expect(relayStore.claimGroupAgentPairingTicket(created.pairingTicket, 2_100)).toBeNull()

    relayStore.releaseGroupAgentPairingClaim(created.request.id, 2_200)
    expect(relayStore.claimGroupAgentPairingTicket(created.pairingTicket, 2_300)?.status)
      .toBe('connecting')
    const completed = relayStore.completeGroupAgentPairing({
      requestId: created.request.id,
      roomAgentId: roomAgent.id,
      agentId: roomAgent.agentId,
      now: 2_400,
    })

    expect(completed?.connector.status).toBe('online')
    expect(relayStore.claimGroupAgentPairingTicket(created.pairingTicket, 2_500)).toBeNull()
    expect(relayStore.authenticateGroupAgentConnector(
      completed!.connector.id,
      'wrong-credential',
    )).toBeNull()
    expect(relayStore.authenticateGroupAgentConnector(
      completed!.connector.id,
      completed!.credential,
    )).toMatchObject({ id: completed!.connector.id, roomId: 'room-1' })
    storage.updateRoomAgentRelayMetadata('room-1', roomAgent.id, {
      connectorId: completed!.connector.id,
      remoteOrigin: 'http://127.0.0.1:8648',
    })
    relayStore.revokeGroupAgentConnector(completed!.connector.id, 2_600)
    expect(relayStore.authenticateGroupAgentConnector(
      completed!.connector.id,
      completed!.credential,
    )).toBeNull()
    expect(storage.getRoomAgents('room-1')).toEqual([])

    const { getDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
    getDb()!.prepare('UPDATE gc_room_agents SET removedAt = 0 WHERE id = ?').run(roomAgent.id)
    expect(storage.getRoomAgents('room-1')).toHaveLength(1)
    storage.init()
    expect(storage.getRoomAgents('room-1')).toEqual([])
  })

  it('keeps Agent handoffs draft until the target service submits the selected Agent', async () => {
    const relayStore = await import('../../packages/server/src/modules/studio/services/group-chat/agent-relay-store')
    const requestSecret = 'request_secret_abcdefghijklmnopqrstuvwxyz123456'
    const pairingTicket = 'pairing_ticket_abcdefghijklmnopqrstuvwxyz123456'
    const draft = relayStore.createGroupAgentPairingHandoff({
      requestId: '11111111-2222-4333-8444-555555555555',
      requestSecret,
      pairingTicket,
      roomId: 'room-handoff',
      ownerMemberId: 'guest-handoff',
      ownerName: 'Guest',
      targetOrigin: 'http://127.0.0.1:8648',
      now: 1_000,
    })
    const agent = relayStore.normalizeRemoteGroupAgentDescriptor({
      agent: 'pi',
      profile: 'default',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      name: 'Remote Pi',
    })

    expect(draft.status).toBe('draft')
    expect(relayStore.listPendingGroupAgentPairingRequests('room-handoff', 1_100)).toEqual([])
    expect(relayStore.submitGroupAgentPairingHandoff(
      draft.id,
      'wrong_request_secret_abcdefghijklmnopqrstuvwxyz',
      agent,
      1_100,
    )).toBeNull()
    expect(relayStore.submitGroupAgentPairingHandoff(
      draft.id,
      requestSecret,
      agent,
      1_100,
    )).toMatchObject({
      status: 'pending',
      agent: { agent: 'pi', name: 'Remote Pi', apiMode: 'codex_responses' },
    })
    expect(relayStore.submitGroupAgentPairingHandoff(
      draft.id,
      requestSecret,
      agent,
      1_200,
    )?.status).toBe('pending')
    expect(relayStore.listPendingGroupAgentPairingRequests('room-handoff', 1_200))
      .toHaveLength(1)

    expect(relayStore.failGroupAgentPairingRequestForRequester(
      draft.id,
      requestSecret,
      'local relay failed',
    )).toMatchObject({ status: 'failed', failureReason: 'local relay failed' })
    expect(relayStore.claimGroupAgentPairingTicket(pairingTicket, 1_300)).toBeNull()
  })

  it('connects and edits an approved Agent through the real outbound and inbound relay sockets', async () => {
    const relayStore = await import('../../packages/server/src/modules/studio/services/group-chat/agent-relay-store')
    const storage = groupServer.getStorage()
    storage.saveRoom('room-approved', 'Approved Room', 'APPROVED1')
    storage.updateRoomGuestAgentPolicy('room-approved', {
      allowGuestAgents: true,
      maxGuestAgentsPerMember: 1,
      allowRemoteWorkspaceAccess: false,
    })
    const agent = relayStore.normalizeRemoteGroupAgentDescriptor({
      agent: 'hermes', profile: 'default', name: 'Approved Agent',
    })
    const created = relayStore.createGroupAgentPairingRequest({
      roomId: 'room-approved', ownerMemberId: 'guest-approved', ownerName: 'Guest',
      targetOrigin: 'http://127.0.0.1:8648', agent,
    })
    relayStore.decideGroupAgentPairingRequest(created.request.id, true, 1)
    vi.spyOn(AgentClient.prototype, 'connect').mockResolvedValue()
    vi.spyOn(AgentClient.prototype, 'joinRoom').mockResolvedValue({
      roomId: 'room-approved', roomName: 'Approved Room', inviteCode: 'APPROVED1',
      members: [], messages: [], rooms: ['room-approved'],
    })
    const relayServer = new GroupAgentRelayServer(groupServer.getIO(), groupServer)
    const manager = new GroupAgentOutboundRelayManager(() => null)
    const persist = vi.spyOn(manager, 'persist').mockResolvedValue()
    try {
      const connected = await manager.connect({
        cloudOrigin: `http://127.0.0.1:${port}`, targetOrigin: 'http://127.0.0.1:8648',
        pairingTicket: created.pairingTicket, agent,
      })
      expect(connected.roomId).toBe('room-approved')
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ agent }))
      expect(relayStore.getGroupAgentPairingRequest(created.request.id)?.status).toBe('consumed')
      const updated = await manager.updateConnection(connected.connectorId, { ...agent, description: 'Updated remotely' })
      expect(updated.agent.description).toBe('Updated remotely')
      expect(storage.getRoomAgents('room-approved')[0].description).toBe('Updated remotely')
    } finally {
      manager.shutdown()
      relayServer.shutdown()
    }
  })

  it('identifies whether missing Agent data came from the connection request or relay confirmation', async () => {
    const { normalizeRemoteGroupAgentDescriptor } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-relay-store')
    for (const value of [undefined, null, 'hermes', []]) {
      expect(() => normalizeRemoteGroupAgentDescriptor(value, 'connection request'))
        .toThrow('Invalid remote Agent in connection request')
      expect(() => normalizeRemoteGroupAgentDescriptor(value, 'relay confirmation'))
        .toThrow('Invalid remote Agent in relay confirmation')
    }
  })

  it('releases a pairing claim after an origin mismatch and accepts the intended target once', async () => {
    const relayStore = await import('../../packages/server/src/modules/studio/services/group-chat/agent-relay-store')
    const storage = groupServer.getStorage()
    const relayWorkspace = mkdtempSync(join(tmpdir(), 'group-chat-relay-diff-'))
    temporaryDirectories.push(relayWorkspace)
    storage.saveRoom('room-relay', 'Relay Room', 'RELAY1', {
      workspace: relayWorkspace,
    })
    storage.updateRoomGuestAgentPolicy('room-relay', {
      allowGuestAgents: true,
      maxGuestAgentsPerMember: 1,
      allowRemoteWorkspaceAccess: true,
    })
    storage.addRoomMember('room-relay', 'guest-relay', 'Relay Guest', '')
    storage.addRoomMember('room-relay', 'auth:7', 'Relay Observer', '')
    const created = relayStore.createGroupAgentPairingRequest({
      roomId: 'room-relay',
      ownerMemberId: 'guest-relay',
      ownerName: 'Relay Guest',
      targetOrigin: 'http://127.0.0.1:8648',
      agent: relayStore.normalizeRemoteGroupAgentDescriptor({
        agent: 'pi',
        profile: 'default',
        provider: 'openai',
        model: 'pi-relay-model',
        apiMode: 'codex_responses',
        name: 'Remote Relay Agent',
      }),
    })
    relayStore.decideGroupAgentPairingRequest(created.request.id, true, 1)
    const relayServer = new GroupAgentRelayServer(groupServer.getIO(), groupServer)
    process.env.PORT = String(port)
    vi.spyOn(AgentClient.prototype, 'connect').mockResolvedValue()
    vi.spyOn(AgentClient.prototype, 'joinRoom').mockResolvedValue({
      roomId: 'room-relay',
      roomName: 'Relay Room',
      inviteCode: 'RELAY1',
      members: [],
      messages: [],
      rooms: ['room-relay'],
    })
    const proxySendMessage = vi.spyOn(AgentClient.prototype, 'sendMessage').mockResolvedValue('cloud-message')
    const proxyApprovalRequested = vi.spyOn(AgentClient.prototype, 'emitApprovalRequested').mockImplementation(() => {})
    const proxyApprovalResolved = vi.spyOn(AgentClient.prototype, 'emitApprovalResolved').mockImplementation(() => {})
    const proxyClarifyRequested = vi.spyOn(AgentClient.prototype, 'emitClarifyRequested').mockImplementation(() => {})
    const proxyClarifyResolved = vi.spyOn(AgentClient.prototype, 'emitClarifyResolved').mockImplementation(() => {})

    const wrongTarget = socketIo(`http://127.0.0.1:${port}/group-chat-agent-relay`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        protocolVersion: 2,
        pairingTicket: created.pairingTicket,
        targetOrigin: 'http://127.0.0.1:8748',
      },
    })
    const rejected = once<Error>(wrongTarget as any, 'connect_error')
    wrongTarget.connect()
    await expect(rejected).resolves.toMatchObject({
      message: 'Invalid or expired pairing ticket',
    })
    wrongTarget.disconnect()
    expect(relayStore.getGroupAgentPairingRequestForRequester(
      created.request.id,
      created.requestSecret,
    )?.status).toBe('approved')

    const intendedTarget = socketIo(`http://127.0.0.1:${port}/group-chat-agent-relay`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        protocolVersion: 2,
        pairingTicket: created.pairingTicket,
        targetOrigin: 'http://127.0.0.1:8648',
      },
    })
    const ready = Promise.race([
      once<any>(intendedTarget as any, 'relay.ready', 15_000),
      once<any>(intendedTarget as any, 'relay.error', 15_000).then(payload => {
        throw new Error(`relay error: ${payload?.error || 'unknown'}`)
      }),
    ])
    intendedTarget.connect()
    const readyPayload = await ready
    expect(readyPayload).toMatchObject({
      protocolVersion: 2,
      roomId: 'room-relay',
      roomName: 'Relay Room',
      inviteCode: 'RELAY1',
      agent: {
        agent: 'pi',
        model: 'pi-relay-model',
        apiMode: 'codex_responses',
        name: 'Remote Relay Agent',
      },
    })
    expect(relayStore.getGroupAgentPairingRequestForRequester(
      created.request.id,
      created.requestSecret,
    )?.status).toBe('consumed')
    expect(storage.getRoomAgents('room-relay')).toEqual([
      expect.objectContaining({
        agent: 'pi',
        model: 'pi-relay-model',
        name: 'Remote Relay Agent',
        executorType: 'remote',
        remoteOrigin: 'http://127.0.0.1:8648',
      }),
    ])
    expect(storage.getMentionableRoomAgents('room-relay')).toEqual([
      expect.objectContaining({ name: 'Remote Relay Agent' }),
    ])
    expect(groupServer.getRoomAgentViews('room-relay')[0]).toMatchObject({
      name: 'Remote Relay Agent',
      connectionStatus: 'online',
    })

    const executor = groupServer.agentClients.getAgents('room-relay')[0]
    const runRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    const reply = executor.replyToMention('room-relay', {
      messageId: 'source-message',
      content: '@Remote Relay Agent hello',
      senderName: 'Relay Guest',
      senderId: 'guest-relay',
      timestamp: Date.now(),
      role: 'user',
      mentionDepth: 100,
      handoffChainId: 'trusted-chain',
      continuationAttemptId: 'trusted-attempt',
    })
    const run = await runRequested
    expect(run.room).toMatchObject({
      id: 'room-relay',
      name: 'Relay Room',
      summaryProfile: 'default',
    })
    expect(run.message).toMatchObject({
      mentionDepth: 100,
      handoffChainId: 'trusted-chain',
      continuationAttemptId: 'trusted-attempt',
    })
    expect(run.workspaceApi).toMatchObject({
      access: 'read-write',
      token: expect.stringMatching(/^[a-zA-Z0-9_-]{43}$/),
    })
    const workspaceToken = run.workspaceApi.token
    expect(authenticateRemoteWorkspaceGrant(workspaceToken)).toMatchObject({
      roomId: 'room-relay',
      agentId: expect.any(String),
    })
    await expect(performRemoteWorkspaceAction(relayWorkspace, {
      action: 'write',
      path: 'remote-notes.txt',
      content: 'changed by the remote Agent',
    })).resolves.toMatchObject({
      ok: true,
      path: 'remote-notes.txt',
    })
    intendedTarget.emit('run.accepted', { runId: run.runId })
    const eventResult = await emitAck<any>(intendedTarget as any, 'agent.event', {
      runId: run.runId,
      seq: 1,
      event: 'message',
      data: {
        id: 'existing-cloud-message-id',
        content: 'safe remote reply',
        agentSessionId: 'remote-session',
        extra: {
          role: 'assistant',
          mentions: [
            { type: 'agent', participantId: 'agent-first', displayName: 'First' },
            { type: 'agent', participantId: 'agent-second', displayName: 'Second' },
          ],
          roomId: 'another-room',
          content: 'forged content',
          id: 'forged-id',
          senderId: 'forged-sender',
          mentionDepth: 1,
          handoffChainId: 'forged-chain',
          continuationAttemptId: 'forged-attempt',
        },
      },
    })
    expect(eventResult).toEqual({ ok: true })
    intendedTarget.emit('run.completed', { runId: run.runId })
    await reply
    expect(authenticateRemoteWorkspaceGrant(workspaceToken)).toBeNull()
    expect(proxySendMessage).toHaveBeenCalledWith(
      'room-relay',
      'safe remote reply',
      expect.stringMatching(/^gcr_[a-f0-9]{32}$/),
      {
        role: 'assistant',
        mentions: [
          { type: 'agent', participantId: 'agent-first', displayName: 'First' },
          { type: 'agent', participantId: 'agent-second', displayName: 'Second' },
        ],
        mentionDepth: 101,
        handoffChainId: 'trusted-chain',
        continuationAttemptId: 'trusted-attempt',
      },
      'remote-session',
    )
    const workspaceDiffMessage = storage.getRecentMessagesForUI('room-relay')
      .find(message => message.tool_name === 'workspace_diff')
    expect(workspaceDiffMessage).toBeTruthy()
    expect(JSON.parse(workspaceDiffMessage!.content)).toMatchObject({
      kind: 'workspace_diff',
      status: 'completed',
      parent_message_id: 'cloud-message',
      files: [
        expect.objectContaining({
          path: 'remote-notes.txt',
          change_type: 'added',
        }),
      ],
    })

    const { OutboundRelayEventSink, supportsAgentEventBatching } = await import('../../packages/server/src/modules/studio/services/group-chat/agent-relay-event-sink')
    const streamStart = vi.spyOn(AgentClient.prototype, 'emitMessageStreamStart').mockImplementation(() => {})
    const streamDelta = vi.spyOn(AgentClient.prototype, 'emitMessageStreamDelta').mockImplementation(() => {})
    const reasoningDelta = vi.spyOn(AgentClient.prototype, 'emitMessageReasoningDelta').mockImplementation(() => {})
    const streamEnd = vi.spyOn(AgentClient.prototype, 'emitMessageStreamEnd').mockImplementation(() => {})
    const batchRunRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    const batchReply = executor.replyToMention('room-relay', {
      messageId: 'batch-source', content: 'burst output', senderName: 'Relay Guest',
      senderId: 'guest-relay', timestamp: Date.now(), role: 'user',
    })
    const batchRun = await batchRunRequested
    intendedTarget.emit('run.accepted', { runId: batchRun.runId })
    expect(supportsAgentEventBatching(readyPayload, false)).toBe(true)
    const sink = new OutboundRelayEventSink(intendedTarget, data => data)
    sink.setBatching(true)
    sink.begin(batchRun.runId)
    sink.emit('message_stream_start', { id: 'batch-message' })
    for (let i = 0; i < 200; i++) {
      sink.emit('message_reasoning_delta', { id: 'batch-message', delta: '思考' })
      sink.emit('message_stream_delta', { id: 'batch-message', delta: String(i) })
    }
    await sink.sendMessage('room-relay', 'complete batch answer', 'batch-message', { role: 'assistant' })
    sink.emit('message_stream_end', { id: 'batch-message' })
    await sink.drain()
    intendedTarget.emit('run.completed', { runId: batchRun.runId })
    await batchReply
    sink.end(batchRun.runId)
    const mappedMessageId = streamStart.mock.calls[0][1]
    expect(reasoningDelta).toHaveBeenCalledTimes(200)
    expect(streamDelta.mock.calls.map(call => call[2])).toEqual(Array.from({ length: 200 }, (_, i) => String(i)))
    expect(streamDelta.mock.calls.every(call => call[1] === mappedMessageId)).toBe(true)
    expect(proxySendMessage).toHaveBeenCalledWith('room-relay', 'complete batch answer', mappedMessageId, expect.objectContaining({ role: 'assistant' }), undefined)
    expect(streamEnd).toHaveBeenCalledWith('room-relay', mappedMessageId, undefined)
    for (const events of [[], Array.from({ length: 65 }, () => ({ runId: 'invalid', seq: 1 })), [{ runId: 'invalid', seq: 1, data: { delta: 'x'.repeat(16 * 1024) } }]]) {
      await expect(emitAck<any>(intendedTarget as any, 'agent.events', { events })).resolves.toEqual({ error: 'Invalid remote Agent event batch' })
    }

    const interactionRunRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    const interactionReply = executor.replyToMention('room-relay', {
      messageId: 'interaction-source-message',
      content: '@Remote Relay Agent ask before continuing',
      senderName: 'Relay Guest',
      senderId: 'guest-relay',
      timestamp: Date.now(),
      role: 'user',
    })
    const interactionRun = await interactionRunRequested
    intendedTarget.emit('run.accepted', { runId: interactionRun.runId })
    await expect(emitAck<any>(intendedTarget as any, 'agent.event', {
      runId: interactionRun.runId,
      seq: 1,
      event: 'approval.requested',
      data: {
        approval_id: 'remote-approval',
        command: 'touch relay.txt',
        choices: ['once', 'deny'],
        timeout_ms: 300_000,
        agentSessionId: 'remote-session',
      },
    })).resolves.toEqual({ ok: true })
    const cloudApprovalId = String(proxyApprovalRequested.mock.calls.at(-1)?.[1]?.approval_id || '')
    expect(cloudApprovalId).toMatch(/^gca_[a-f0-9]{32}$/)

    await expect(emitAck<any>(intendedTarget as any, 'agent.event', {
      runId: interactionRun.runId,
      seq: 2,
      event: 'clarify.requested',
      data: {
        clarify_id: 'remote-clarify',
        question: 'Which environment?',
        choices: ['staging', 'production'],
        timeout_ms: 300_000,
        agentSessionId: 'remote-session',
      },
    })).resolves.toEqual({ ok: true })
    const cloudClarifyId = String(proxyClarifyRequested.mock.calls.at(-1)?.[1]?.clarify_id || '')
    expect(cloudClarifyId).toMatch(/^gcc_[a-f0-9]{32}$/)

    intendedTarget.once('approval.respond', (data: any, ack: (response: any) => void) => {
      expect(data).toEqual({ approvalId: 'remote-approval', choice: 'once' })
      ack({ resolved: true })
    })
    await expect(executor.respondApproval!(cloudApprovalId, 'once')).resolves.toBe(true)
    intendedTarget.once('clarify.respond', (data: any, ack: (response: any) => void) => {
      expect(data).toEqual({ clarifyId: 'remote-clarify', response: 'staging' })
      ack({ resolved: true })
    })
    await expect(executor.respondClarify!(cloudClarifyId, 'staging')).resolves.toBe(true)

    await expect(emitAck<any>(intendedTarget as any, 'agent.event', {
      runId: interactionRun.runId,
      seq: 3,
      event: 'approval.resolved',
      data: { approval_id: 'remote-approval', choice: 'once', agentSessionId: 'remote-session' },
    })).resolves.toEqual({ ok: true })
    await expect(emitAck<any>(intendedTarget as any, 'agent.event', {
      runId: interactionRun.runId,
      seq: 4,
      event: 'clarify.resolved',
      data: {
        clarify_id: 'remote-clarify',
        resolved: true,
        reason: 'response',
        agentSessionId: 'remote-session',
      },
    })).resolves.toEqual({ ok: true })
    expect(proxyApprovalResolved).toHaveBeenCalledWith('room-relay', expect.objectContaining({
      approval_id: cloudApprovalId,
    }))
    expect(proxyClarifyResolved).toHaveBeenCalledWith('room-relay', expect.objectContaining({
      clarify_id: cloudClarifyId,
    }))
    intendedTarget.emit('run.completed', { runId: interactionRun.runId })
    await interactionReply

    const nameConflict = await emitAck<any>(intendedTarget as any, 'agent.config.update', {
      agent: 'codex',
      profile: 'default',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Relay Guest',
      description: '',
      avatar: '',
    })
    expect(nameConflict).toMatchObject({
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })

    ;(groupServer.agentClients as any)._pausedRooms.add('room-relay')
    const queuedReply = groupServer.agentClients.processMentions('room-relay', {
      messageId: 'queued-config-fence',
      content: '@Remote Relay Agent queued',
      senderName: 'Relay Guest',
      senderId: 'guest-relay',
      timestamp: Date.now(),
      role: 'user',
      mentions: [{ type: 'agent', participantId: executor.agentId }],
    })
    const queuedUpdate = await emitAck<any>(intendedTarget as any, 'agent.config.update', {
      agent: 'codex', profile: 'default', provider: 'openai', model: 'should-not-apply',
      apiMode: 'codex_responses', reasoningEffort: 'high', name: 'Queued Mutation', description: '', avatar: '',
    })
    expect(queuedUpdate).toMatchObject({ code: 'GROUP_AGENT_BUSY' })
    const queuedRunRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    ;(groupServer.agentClients as any)._pausedRooms.delete('room-relay')
    const drainQueued = (groupServer.agentClients as any)._drainRoomQueue('room-relay')
    const queuedRun = await queuedRunRequested
    expect(queuedRun.message).toMatchObject({ messageId: 'queued-config-fence' })
    intendedTarget.emit('run.accepted', { runId: queuedRun.runId })
    intendedTarget.emit('run.completed', { runId: queuedRun.runId })
    await drainQueued
    await queuedReply

    const updated = await emitAck<any>(intendedTarget as any, 'agent.config.update', {
      agent: 'codex',
      profile: 'default',
      provider: 'openai',
      model: 'gpt-updated',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Updated Relay Agent',
      description: 'Updated locally',
      avatar: '',
    })
    expect(updated).toMatchObject({
      ok: true,
      agent: {
        agent: 'codex',
        model: 'gpt-updated',
        name: 'Updated Relay Agent',
      },
    })
    expect(storage.getRoomAgents('room-relay')[0]).toMatchObject({
      agent: 'codex',
      model: 'gpt-updated',
      name: 'Updated Relay Agent',
      ownerMemberId: 'guest-relay',
    })
    expect(groupServer.agentClients.getAgent('room-relay', readyPayload.agent.agentId)).toMatchObject({
      agent: 'codex',
      model: 'gpt-updated',
      name: 'Updated Relay Agent',
    })

    const allRunRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    const processAll = groupServer.agentClients.processMentions('room-relay', {
      messageId: 'all-source-message',
      content: '@all status update',
      senderName: 'Relay Guest',
      senderId: 'guest-relay',
      timestamp: Date.now(),
      role: 'user',
    })
    const allRun = await allRunRequested
    expect(allRun.message).toMatchObject({
      messageId: 'all-source-message',
      content: '@all status update',
    })
    intendedTarget.emit('run.accepted', { runId: allRun.runId })
    intendedTarget.emit('run.completed', { runId: allRun.runId })
    await processAll

    const failedRunRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    const failedReply = executor.replyToMention('room-relay', {
      messageId: 'known-failure-message',
      content: '@Updated Relay Agent fail with a terminal result',
      senderName: 'Relay Guest',
      senderId: 'guest-relay',
      timestamp: Date.now(),
      role: 'user',
    })
    const failedRun = await failedRunRequested
    intendedTarget.emit('run.accepted', { runId: failedRun.runId })
    intendedTarget.emit('run.failed', { runId: failedRun.runId, error: 'Known remote failure' })
    const failedError = await failedReply.then(
      () => null,
      error => error as Error & { code?: string; outcomeUnknown?: boolean },
    )
    expect(failedError).toMatchObject({ code: 'GROUP_AGENT_REMOTE_RUN_FAILED' })
    expect(failedError?.outcomeUnknown).not.toBe(true)

    const uncertainRunRequested = once<any>(intendedTarget as any, 'run.request', 2_000)
    const responseRunId = 'remote-response-disconnect'
    vi.spyOn(AgentClient.prototype, 'emitContextStatus').mockImplementation((roomId, status, extra) => {
      ;(groupServer as any).updateRoomAgentActivity(
        roomId,
        'Updated Relay Agent',
        status,
        typeof extra?.runId === 'string' ? extra.runId : '',
      )
    })
    const uncertainReply = executor.replyToMention('room-relay', {
      messageId: 'transport-loss-message',
      content: '@Updated Relay Agent keep running across a transport loss',
      senderName: 'Relay Guest',
      senderId: 'guest-relay',
      timestamp: Date.now(),
      role: 'user',
    }, { summary: '', history: [] }, (status, extra) => {
      ;(groupServer as any).updateRoomAgentActivity(
        'room-relay',
        'Updated Relay Agent',
        status,
        typeof extra?.runId === 'string' ? extra.runId : '',
      )
    })
    const uncertainRun = await uncertainRunRequested
    intendedTarget.emit('run.accepted', { runId: uncertainRun.runId })
    await expect(emitAck<any>(intendedTarget as any, 'agent.event', {
      runId: uncertainRun.runId,
      seq: 1,
      event: 'context_status',
      data: {
        status: 'replying',
        runId: responseRunId,
      },
    })).resolves.toEqual({ ok: true })
    const loadActivities = () => {
      const ack = vi.fn()
      ;(groupServer as any).handleLoadRoomAgentActivities(
        { id: 'observer-socket', data: { authUser: { id: 7 } } },
        {},
        ack,
      )
      return ack.mock.calls[0]?.[0]
    }
    expect(loadActivities()).toEqual({
      activities: [expect.objectContaining({
        roomId: 'room-relay',
        runId: responseRunId,
        status: 'replying',
      })],
    })
    intendedTarget.disconnect()
    await expect(uncertainReply).rejects.toMatchObject({
      code: 'GROUP_AGENT_OFFLINE',
      outcomeUnknown: true,
    })
    expect(loadActivities()).toEqual({ activities: [] })
    await vi.waitFor(() => {
      expect(storage.getMentionableRoomAgents('room-relay')).toEqual([])
    })
    expect(storage.getRoomAgents('room-relay')).toEqual([
      expect.objectContaining({ name: 'Updated Relay Agent' }),
    ])
    expect(groupServer.getRoomAgentViews('room-relay')[0]).toMatchObject({
      name: 'Updated Relay Agent',
      connectionStatus: 'offline',
    })

    const reconnectingTarget = socketIo(`http://127.0.0.1:${port}/group-chat-agent-relay`, {
      autoConnect: false,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        protocolVersion: 2,
        connectorId: readyPayload.connectorId,
        credential: readyPayload.credential,
        targetOrigin: 'http://127.0.0.1:8648',
      },
    })
    const reconnectReady = once<any>(reconnectingTarget as any, 'relay.ready', 15_000)
    reconnectingTarget.connect()
    await expect(reconnectReady).resolves.toMatchObject({
      connectorId: readyPayload.connectorId,
      roomId: 'room-relay',
      roomName: 'Relay Room',
    })
    const revokedNotice = once<any>(reconnectingTarget as any, 'connector.revoked', 2_000)
    relayStore.revokeGroupAgentConnector(readyPayload.connectorId)

    await expect(revokedNotice).resolves.toMatchObject({
      connectorId: readyPayload.connectorId,
      roomId: 'room-relay',
    })
    await vi.waitFor(() => expect(reconnectingTarget.connected).toBe(false))
    expect(storage.getRoomAgents('room-relay')).toEqual([])
    reconnectingTarget.disconnect()
    relayServer.shutdown()
  }, 20_000)

  it('requires invite guests to choose a unique room participant name', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)

    const unnamed = await connectGroupChatClient(port, 'guest-unnamed', 'Ignored', { inviteCode: 'ROOM1' })
    const alice = await connectGroupChatClient(port, 'guest-alice', 'Alice', { inviteCode: 'ROOM1' })
    const duplicateUser = await connectGroupChatClient(port, 'guest-alice-2', 'Alice 2', { inviteCode: 'ROOM1' })
    const duplicateAgent = await connectGroupChatClient(port, 'guest-worker', 'Worker Guest', { inviteCode: 'ROOM1' })
    harness.sockets.push(unnamed, alice, duplicateUser, duplicateAgent)

    await expect(emitAck<any>(unnamed, 'join', { roomId: 'room-1' })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_NAME_REQUIRED',
      error: 'Name is required',
    })
    await expect(emitAck<any>(alice, 'join', { roomId: 'room-1', name: 'Alice' })).resolves.toMatchObject({
      roomId: 'room-1',
    })
    await expect(emitAck<any>(duplicateUser, 'join', { roomId: 'room-1', name: '  alice  ' })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })
    await expect(emitAck<any>(duplicateAgent, 'join', { roomId: 'room-1', name: 'worker' })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_NAME_CONFLICT',
      error: 'Name is already in use in this room',
    })
  })

  it('stores only validated room-scoped avatars for invite guests', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    const validAvatar = JSON.stringify({
      type: 'image',
      dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    })

    const guest = await connectGroupChatClient(port, 'guest-avatar', 'Guest', { inviteCode: 'ROOM1' })
    const invalidGuest = await connectGroupChatClient(port, 'guest-avatar-invalid', 'Guest 2', { inviteCode: 'ROOM1' })
    harness.sockets.push(guest, invalidGuest)

    const joined = await emitAck<any>(guest, 'join', {
      roomId: 'room-1',
      name: 'Avatar Guest',
      avatar: validAvatar,
    })
    expect(joined.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: 'guest-avatar', avatar: validAvatar }),
    ]))
    expect(storage.getMemberByUserId('room-1', 'guest-avatar')).toMatchObject({
      avatar: validAvatar,
    })

    await expect(emitAck<any>(invalidGuest, 'join', {
      roomId: 'room-1',
      name: 'Invalid Avatar Guest',
      avatar: JSON.stringify({
        type: 'image',
        dataUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      }),
    })).resolves.toEqual({
      code: 'ROOM_PARTICIPANT_AVATAR_INVALID',
      error: 'Invalid member avatar',
    })
  })

  it('rejects duplicate names across member and Agent persistence paths', () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    storage.addRoomMember('room-1', 'user-alice', 'Alice', '')
    const worker = storage.addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)

    expect(() => storage.addRoomAgent('room-1', 'agent-alice', 'default', 'alice', '', 0))
      .toThrowError(expect.objectContaining({ code: 'ROOM_PARTICIPANT_NAME_CONFLICT' }))
    expect(() => storage.addRoomMember('room-1', 'user-worker', 'WORKER', ''))
      .toThrowError(expect.objectContaining({ code: 'ROOM_PARTICIPANT_NAME_CONFLICT' }))
    expect(() => storage.updateRoomAgent('room-1', worker.id, 'default', 'ALICE', ''))
      .toThrowError(expect.objectContaining({ code: 'ROOM_PARTICIPANT_NAME_CONFLICT' }))
  })

  it('keeps one credential-free Agent record for historical avatars until chat history is cleared', () => {
    const storage = groupServer.getStorage()
    const avatar = JSON.stringify({ type: 'generated', seed: 'historical-worker' })
    storage.saveRoom('room-1', 'Shared Room', 'ROOM1')
    const worker = storage.addRoomAgent(
      'room-1',
      'agent-worker',
      'default',
      'Worker',
      'Historical worker',
      0,
      {
        agent: 'codex',
        avatar,
        executorType: 'remote',
        connectorId: 'connector-secret',
        remoteOrigin: 'http://127.0.0.1:8648',
      },
    )
    storage.saveMessageAndRefreshRoom({
      id: 'agent-history-message',
      roomId: 'room-1',
      senderId: worker.agentId,
      senderName: worker.name,
      content: 'historical answer',
      timestamp: 1,
      role: 'assistant',
    } as any)
    storage.saveMessageAndRefreshRoom({
      id: 'agent-history-message-2',
      roomId: 'room-1',
      senderId: worker.agentId,
      senderName: worker.name,
      content: 'another historical answer',
      timestamp: 2,
      role: 'assistant',
    } as any)

    storage.removeRoomAgent('room-1', worker.id)

    expect(storage.getRoomAgents('room-1')).toEqual([])
    const history = storage.getRecentMessagesForUI('room-1')
    expect(history).toHaveLength(2)
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        senderType: 'agent',
        senderAgentRecordId: worker.id,
      }),
    ]))
    expect(history.filter(message => message.senderAvatar === avatar)).toHaveLength(1)
    expect(history.filter(message => message.senderAgentType === 'codex')).toHaveLength(1)
    expect(harness.db.prepare(
      'SELECT removedAt, connectorId, remoteOrigin FROM gc_room_agents WHERE id = ?',
    ).get(worker.id)).toMatchObject({
      connectorId: '',
      remoteOrigin: '',
    })
    expect(Number((harness.db.prepare(
      'SELECT removedAt FROM gc_room_agents WHERE id = ?',
    ).get(worker.id) as { removedAt: number }).removedAt)).toBeGreaterThan(0)
    expect((harness.db.prepare('PRAGMA table_info(gc_messages)').all() as Array<{ name: string }>)
      .map(column => column.name)).not.toContain('senderAvatar')

    storage.clearRoomContext('room-1')

    expect(harness.db.prepare(
      'SELECT COUNT(*) AS count FROM gc_room_agents WHERE id = ?',
    ).get(worker.id)).toEqual({ count: 0 })
  })

  it('persists a sent message and broadcasts it to other room members', async () => {
    const storage = groupServer.getStorage()
    storage.saveRoom('room-1', 'Room 1', 'ROOM1')
    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    const bob = await connectGroupChatClient(port, 'user-b', 'Bob')
    harness.sockets.push(alice, bob)
    await emitAck(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(bob, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const seenByBob = once<any>(bob, 'message')
    const ack = await emitAck<any>(alice, 'message', { roomId: 'room-1', id: 'client-msg-1', content: 'hello room' })
    const broadcast = await seenByBob

    expect(ack).toEqual({ id: 'client-msg-1' })
    expect(broadcast).toMatchObject({ id: 'client-msg-1', roomId: 'room-1', senderName: 'Alice', content: 'hello room', role: 'user' })
    expect(storage.getMessage('client-msg-1')).toMatchObject({ content: 'hello room', senderName: 'Alice' })
  })
})
