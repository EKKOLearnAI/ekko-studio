import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupRuntimeSessionId } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import { AgentBridgeClient } from '../../packages/server/src/modules/hermes/services/bridge/index'
import { ChatRunSocket } from '../../packages/server/src/modules/studio/sockets/chat-run'
import '../../packages/server/src/bootstrap/chat-agent-runtime-adapter'
import {
  denyPendingEkkoToolApprovals,
  waitForEkkoToolApproval,
} from '../../packages/server/src/modules/ekko/services/approvals'
import {
  cancelPendingEkkoClarifications,
  waitForEkkoClarification,
} from '../../packages/server/src/modules/ekko/services/clarifications'
import type { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'

describe('group chat approval and context baseline', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    vi.spyOn(groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1', { ownerAuthUserId: 1 })
    groupServer.getStorage().addRoomAgent('room-1', 'agent-1', 'default', 'Agent', '', 0)
  })

  afterEach(() => {
    denyPendingEkkoToolApprovals()
    cancelPendingEkkoClarifications()
    harness?.cleanup()
    vi.restoreAllMocks()
  })

  it('restores pending clarification notifications only for rooms the requesting socket can manage', async () => {
    const human = await connectGroupChatClient(port, 'notification-user', 'Notification user')
    harness.sockets.push(human)
    const server = groupServer as any
    vi.spyOn(server, 'pendingClarifySnapshots').mockReturnValue([
      { roomId: 'allowed-room', clarify_id: 'allowed-question', remaining_timeout_ms: 1000 },
      { roomId: 'private-room', clarify_id: 'private-question', remaining_timeout_ms: 1000 },
    ])
    vi.spyOn(server, 'canSocketManageRoom').mockImplementation((socket: any, roomId: unknown) => socket.id === human.id && roomId === 'allowed-room')
    const snapshot = await emitAck<any>(human, 'load_pending_approvals', {})
    expect(snapshot.pendingClarifies).toEqual([
      { roomId: 'allowed-room', clarify_id: 'allowed-question', remaining_timeout_ms: 1000 },
    ])
  })

  it('group reply notifications recheck visibility, never replay duplicate messages', async () => {
    const { bindLegacyAppEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events')
    const allowed = { id: 'notice-allowed', emit: vi.fn(), data: {}, handshake: {auth:{}}, on: vi.fn() }
    const denied = { id: 'notice-denied', emit: vi.fn(), data: {}, handshake: {auth:{}}, on: vi.fn() }
    const server = groupServer as any
    const old = server.nsp.sockets
    server.nsp.sockets = new Map([[allowed.id, allowed], [denied.id, denied]])
    const access = vi.spyOn(server, 'canSocketObserveRoom').mockImplementation((socket: any) => socket.id === allowed.id)
    bindLegacyAppEvents(allowed as any, 'group', event => server.canSocketObserveRoom(allowed, event.subject.room_id))
    bindLegacyAppEvents(denied as any, 'group', event => server.canSocketObserveRoom(denied, event.subject.room_id))
    try {
      const message = { id:'notice-message', roomId:'room-1', senderName:'Pi', senderType:'agent', role:'assistant', content:'Done' }
      server.notifyGroupReply('room-1', message)
      server.notifyGroupReply('room-1', message)
      expect(allowed.emit).toHaveBeenCalledTimes(1)
      expect(denied.emit).not.toHaveBeenCalled()
      access.mockReturnValue(false)
      server.notifyGroupReply('room-1', { ...message, id:'second-message' })
      expect(allowed.emit).toHaveBeenCalledTimes(1)
    } finally { for (const socket of [allowed, denied]) socket.on.mock.calls.find(call=>call[0] === 'disconnect')?.[1](); server.nsp.sockets = old }
  })

  async function joinPair() {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    harness.sockets.push(agent, human)
    groupServer.getIO().of('/group-chat').sockets.get(human.id!)!.data.authUser = {
      id: 1, role: 'user', profiles: ['default'],
    }
    await emitAck(agent, 'join', { roomId: 'room-1' })
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    return { agent, human, agentSessionId }
  }

  function wait(ms = 30) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  it('publishes authenticated group interactions through webhooks with the initiating run target', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const { bindRunPushTarget, linkPushRun } = await import('../../packages/server/src/modules/studio/repositories/run-push-store')
    const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
    const target = bindRunPushTarget({ kind: 'group', profile: 'default', runId: 'human-root' }, 'room-1',
      { userId: 1, deviceId: 'phone-a', studioDeviceId: 'studio-a' })
    linkPushRun('group_runtime', 'room-1', 'agent-runtime', target)
    const events: any[] = []
    const stop = businessEvents.subscribe('test-group-interactions', event => { if (event.type.startsWith('group.')) events.push(event) })
    try {
      for (const [request, resolved, id] of [ ['approval.requested', 'approval.resolved', 'approval_id'], ['clarify.requested', 'clarify.resolved', 'clarify_id'] ]) {
        const requested = once(human, request)
        agent.emit(request, { roomId: 'room-1', agentName: 'Agent', agentSessionId, runId: 'agent-runtime', [id]: id, command: 'SECRET', question: 'SECRET' })
        await requested
        const finished = once(human, resolved)
        agent.emit(resolved, { roomId: 'room-1', agentName: 'Agent', agentSessionId, [id]: id, resolved: true })
        await finished
      }
      expect(events.map(event => event.type)).toEqual(['group.approval.requested', 'group.approval.resolved', 'group.clarification.requested', 'group.clarification.resolved'])
      expect(events.every(event => event.push_target_id === target.id && event.subject.run_id === 'agent-runtime')).toBe(true)
      expect(JSON.stringify(events)).not.toContain('SECRET')
    } finally { stop() }
  })

  it('relays context status without overwriting the persisted room token count', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const statusEvent = once<any>(human, 'context_status')
    const roomUpdated = vi.fn()
    human.on('room_updated', roomUpdated)

    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', totalTokens: 123, agentSessionId })

    expect(await statusEvent).toEqual({ roomId: 'room-1', agentName: 'Agent', status: 'replying' })
    await wait()
    expect(roomUpdated).not.toHaveBeenCalled()
    expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({ totalTokens: 0 })
  })

  it('ignores context status emitted by human sockets', async () => {
    const { human } = await joinPair()

    human.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', totalTokens: 999 })
    await wait()

    expect(groupServer.getStorage().getRoom('room-1')).toMatchObject({ totalTokens: 0 })
    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.contextStatuses).toEqual([])
  })

  it('clears ready context status from join recovery', async () => {
    const { agent, agentSessionId } = await joinPair()
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId })
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'ready', agentSessionId })

    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    expect(joined.contextStatuses).toEqual([])
  })

  it('accepts the matching ready event after a fresh runtime session is disposed', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const replying = once<any>(human, 'context_status')
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId })
    await expect(replying).resolves.toMatchObject({ agentName: 'Agent', status: 'replying' })

    // Fresh group runs are removed from AgentClients immediately after they
    // emit ready. The terminal status must still be matched against the
    // session that created the stored replying state.
    vi.mocked(groupServer.agentClients.agentSessionIsCurrent).mockReturnValue(false)
    const ready = once<any>(human, 'context_status')
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'ready', agentSessionId })
    await expect(ready).resolves.toMatchObject({ agentName: 'Agent', status: 'ready' })

    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.contextStatuses).toEqual([])
  })

  it('does not let a late ready event clear a newer fresh run', async () => {
    const { agent, agentSessionId: firstSessionId } = await joinPair()
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId: firstSessionId })
    await wait()

    const secondSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'replying', agentSessionId: secondSessionId })
    await wait()

    vi.mocked(groupServer.agentClients.agentSessionIsCurrent).mockReturnValue(false)
    agent.emit('context_status', { roomId: 'room-1', agentName: 'Agent', status: 'ready', agentSessionId: firstSessionId })
    await wait()

    const lateJoiner = await connectGroupChatClient(port, 'human-2', 'Late')
    harness.sockets.push(lateJoiner)
    const joined = await emitAck<any>(lateJoiner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.contextStatuses).toEqual([
      expect.objectContaining({ agentName: 'Agent', status: 'replying' }),
    ])
  })

  it('delivers and handles approval globally for the Agent owner who has not joined the source room', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const owner = await connectGroupChatClient(port, 'manager-1', 'Owner')
    harness.sockets.push(agent, owner)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    groupServer.getStorage().addRoomMember('room-1', 'manager-1', 'Manager', '')
    groupServer.getIO().of('/group-chat').sockets.get(owner.id!)!.data.authUser = {
      id: 1, role: 'super_admin', profiles: ['default'],
    }

    const approval = waitForEkkoToolApproval({
      approvalId: 'approval-global',
      toolName: 'terminal_exec',
      key: 'terminal:write',
      command: 'touch global.txt',
      description: 'writes a file',
      choices: ['once', 'deny'],
      allowPermanent: false,
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => agent.emit('approval.requested', {
        roomId: 'room-1',
        agentName: 'Agent',
        agentSessionId,
        approval_id: pending.approvalId,
        command: pending.command,
        description: pending.description,
        choices: pending.choices,
      }),
    })

    await expect(once<any>(owner, 'approval.requested')).resolves.toMatchObject({
      roomId: 'room-1',
      approval_id: 'approval-global',
    })
    await expect(emitAck(owner, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-global',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(approval).resolves.toBe('once')
  })

  it('replays a still-pending approval when the Agent owner comes online later', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(agent)
    await emitAck(agent, 'join', { roomId: 'room-1' })

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-offline-owner',
      command: 'touch offline.txt',
      description: 'writes a file',
      choices: ['once', 'deny'],
    })
    await wait()

    const owner = await connectGroupChatClient(port, 'owner-offline', 'Owner')
    harness.sockets.push(owner)
    groupServer.getIO().of('/group-chat').sockets.get(owner.id!)!.data.authUser = {
      id: 1, role: 'user', profiles: ['default'],
    }

    await expect(emitAck<any>(owner, 'load_pending_approvals', {})).resolves.toEqual({
      pendingClarifies: [],
      pendingApprovals: [expect.objectContaining({
        roomId: 'room-1',
        agentName: 'Agent',
        approval_id: 'approval-offline-owner',
        command: 'touch offline.txt',
      })],
    })
  })

  it('delivers an approval only to the Agent owner, not another room manager or a stranger', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const owner = await connectGroupChatClient(port, 'human-1', 'Owner')
    const manager = await connectGroupChatClient(port, 'manager-1', 'Manager')
    const stranger = await connectGroupChatClient(port, 'stranger-1', 'Stranger')
    harness.sockets.push(agent, owner, manager, stranger)
    groupServer.getIO().of('/group-chat').sockets.get(owner.id!)!.data.authUser = {
      id: 1, role: 'user', profiles: ['default'],
    }
    await emitAck(agent, 'join', { roomId: 'room-1' })
    await emitAck(owner, 'join', { roomId: 'room-1' })
    await emitAck(manager, 'join', { roomId: 'room-1' })

    let managerLeak: unknown = null
    let strangerLeak: unknown = null
    manager.on('approval.requested', payload => { managerLeak = payload })
    stranger.on('approval.requested', payload => { strangerLeak = payload })
    const ownerRequest = once<any>(owner, 'approval.requested')
    const approval = waitForEkkoToolApproval({
      approvalId: 'approval-private-global',
      toolName: 'terminal_exec',
      key: 'terminal:write',
      command: 'cat /private/workspace/secret',
      description: 'reads a private file',
      choices: ['once', 'deny'],
      allowPermanent: false,
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => agent.emit('approval.requested', {
        roomId: 'room-1',
        agentName: 'Agent',
        agentSessionId,
        approval_id: pending.approvalId,
        command: pending.command,
        description: pending.description,
        choices: pending.choices,
      }),
    })

    await expect(ownerRequest).resolves.toMatchObject({ approval_id: 'approval-private-global' })
    await wait()
    expect(managerLeak).toBeNull()
    expect(strangerLeak).toBeNull()
    await expect(emitAck(stranger, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-private-global',
      choice: 'once',
    })).resolves.toEqual({ error: 'Access denied' })
    await expect(emitAck(manager, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-private-global',
      choice: 'once',
    })).resolves.toEqual({ error: 'Access denied' })
    await expect(emitAck(owner, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-private-global',
      choice: 'deny',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(approval).resolves.toBe('deny')
  })

  it('sends a guest Agent approval to its inviter instead of the room owner', async () => {
    groupServer.getStorage().addRoomAgent(
      'room-1',
      'remote-agent',
      'guest-profile',
      'Guest Agent',
      '',
      1,
      { executorType: 'remote', ownerMemberId: 'guest-owner' },
    )
    const agentSessionId = groupRuntimeSessionId('room-1', 'guest-profile', 'Guest Agent')
    const agent = await connectGroupChatClient(port, 'remote-agent', 'Guest Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const inviter = await connectGroupChatClient(port, 'guest-owner', 'Inviter')
    const roomOwner = await connectGroupChatClient(port, 'room-owner', 'Room Owner')
    harness.sockets.push(agent, inviter, roomOwner)
    groupServer.getIO().of('/group-chat').sockets.get(roomOwner.id!)!.data.authUser = {
      id: 1, role: 'user', profiles: ['default'],
    }
    await emitAck(agent, 'join', { roomId: 'room-1' })
    await emitAck(inviter, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(roomOwner, 'join', { roomId: 'room-1' })

    const respondApproval = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Guest Agent',
      respondApproval,
    } as any])
    let roomOwnerLeak: unknown = null
    roomOwner.on('approval.requested', payload => { roomOwnerLeak = payload })
    const inviterRequest = once<any>(inviter, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Guest Agent',
      agentSessionId,
      approval_id: 'approval-guest-agent',
      command: 'touch guest.txt',
      description: 'writes a file',
      choices: ['once', 'deny'],
    })

    await expect(inviterRequest).resolves.toMatchObject({ approval_id: 'approval-guest-agent' })
    await wait()
    expect(roomOwnerLeak).toBeNull()
    await expect(emitAck(roomOwner, 'approval.respond', {
      roomId: 'room-1', approval_id: 'approval-guest-agent', choice: 'once',
    })).resolves.toEqual({ error: 'Access denied' })
    await expect(emitAck(inviter, 'approval.respond', {
      roomId: 'room-1', approval_id: 'approval-guest-agent', choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(respondApproval).toHaveBeenCalledWith('approval-guest-agent', 'once')
  })

  it('does not trust a claimed persisted member identity for off-room approvals when authentication is disabled', async () => {
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Agent')
    const agent = await connectGroupChatClient(port, 'agent-1', 'Agent', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    const impostor = await connectGroupChatClient(port, 'manager-1', 'Impostor')
    harness.sockets.push(agent, impostor)
    await emitAck(agent, 'join', { roomId: 'room-1' })
    groupServer.getStorage().addRoomMember('room-1', 'manager-1', 'Manager', '')

    let leaked: unknown = null
    impostor.on('approval.requested', payload => { leaked = payload })
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-impersonation',
      command: 'cat /private/workspace/secret',
      description: 'reads a private file',
    })
    await wait()

    expect(leaked).toBeNull()
    await expect(emitAck(impostor, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-impersonation',
      choice: 'once',
    })).resolves.toEqual({ error: 'Access denied' })
  })

  it('relays approval requested with default choices', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-1',
      command: 'touch file',
      description: 'needs approval',
    })

    expect(await requested).toMatchObject({
      event: 'approval.requested',
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-1',
      choices: ['once', 'session', 'deny'],
    })
  })

  it('does not relay approval payloads to read-only invite members', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const readonly = await connectGroupChatClient(port, 'human-readonly', 'ReadOnly')
    harness.sockets.push(readonly)
    groupServer.getIO().of('/group-chat').sockets.get(readonly.id!)!.data.authUser = { id: 7, role: 'user', profiles: [] }
    await emitAck(readonly, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    let leaked: unknown = null
    readonly.on('approval.requested', payload => { leaked = payload })
    const managerRequest = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-private',
      command: 'cat /private/workspace/secret',
      description: 'needs approval',
    })

    expect(await managerRequest).toMatchObject({ approval_id: 'approval-private' })
    await wait()
    expect(leaked).toBeNull()
  })

  it('ignores approval events emitted by human sockets', async () => {
    const { human } = await joinPair()
    let requested = false
    let resolved = false
    human.on('approval.requested', () => { requested = true })
    human.on('approval.resolved', () => { resolved = true })

    human.emit('approval.requested', { roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-human' })
    human.emit('approval.resolved', { roomId: 'room-1', agentName: 'Agent', approval_id: 'approval-human', choice: 'deny' })
    await wait()

    expect(requested).toBe(false)
    expect(resolved).toBe(false)
  })

  it('relays approval resolved with normalized choice', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const resolved = once<any>(human, 'approval.resolved')

    agent.emit('approval.resolved', { roomId: 'room-1', agentName: 'Agent', agentSessionId, approval_id: 'approval-1', choice: 'deny' })

    expect(await resolved).toEqual({
      event: 'approval.resolved',
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-1',
      choice: 'deny',
    })
  })

  it('relays and routes a clarification response to the pending Ekko Agent session', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const requested = once<any>(human, 'clarify.requested')
    const clarification = waitForEkkoClarification({
      clarifyId: 'clarify-ekko',
      question: 'Which environment?',
      choices: ['staging', 'production'],
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => agent.emit('clarify.requested', {
        roomId: 'room-1',
        agentName: 'Agent',
        agentSessionId,
        clarify_id: pending.clarifyId,
        question: pending.question,
        choices: pending.choices,
        timeout_ms: pending.timeoutMs,
      }),
    })

    await expect(requested).resolves.toMatchObject({
      event: 'clarify.requested', roomId: 'room-1', agentName: 'Agent',
      clarify_id: 'clarify-ekko', question: 'Which environment?',
    })
    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1', clarify_id: 'clarify-ekko', response: 'staging',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(clarification).resolves.toBe('staging')
  })

  it('settles an Ekko clarification through the real GroupChat interrupt and ChatRun abort chain', async () => {
    const human = await connectGroupChatClient(port, 'human-1', 'Human')
    harness.sockets.push(human)
    groupServer.getIO().of('/group-chat').sockets.get(human.id!)!.data.authUser = {
      id: 1, role: 'user', profiles: ['default'],
    }
    await emitAck(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    const chatRun = new ChatRunSocket(groupServer.getIO())
    ;(chatRun as any).bridge.interrupt = vi.fn(async () => ({ ok: true, synced: true }))
    ;(chatRun as any).bridge.goalPause = vi.fn(async () => ({ ok: true }))
    const abortSession = vi.spyOn(chatRun, 'abortSession')
    const agent = await groupServer.agentClients.createAgent({
      agentId: 'agent-1',
      agent: 'ekko',
      profile: 'default',
      name: 'Agent',
      description: '',
      invited: 0,
      backgroundDelegationEnabled: false,
    }, {}, port)
    await groupServer.agentClients.addAgentToRoom('room-1', agent)
    groupServer.agentClients.setChatRunService(chatRun)

    let runtimeWaiterSettled = false
    let runtimeSessionId = ''
    let clarificationRegistered!: () => void
    const clarificationRegisteredBarrier = new Promise<void>(resolve => {
      clarificationRegistered = resolve
    })
    vi.spyOn(chatRun, 'runAndWait').mockImplementation(async (data, options) => {
      const runtimeRunId = 'runtime-current'
      runtimeSessionId = data.session_id
      // Match the installed event ordering: ChatRun can abort its current
      // controller while the Ekko clarification waiter belongs to the same
      // Session/generation but is no longer attached to that controller.
      ;(chatRun as any).sessionMap.set(data.session_id, {
        messages: [],
        isWorking: true,
        events: [],
        queue: [],
        source: 'group_chat',
        runId: runtimeRunId,
        abortController: new AbortController(),
        profile: 'default',
      })
      const response = await waitForEkkoClarification({
        clarifyId: 'clarify-real-chain',
        question: 'Which city?',
        choices: null,
        timeoutMs: 300_000,
      }, {
        sessionId: data.session_id,
        runId: runtimeRunId,
        onRequested: pending => {
          clarificationRegistered()
          options?.onEvent?.('clarify.requested', {
            event: 'clarify.requested',
            run_id: runtimeRunId,
            clarify_id: pending.clarifyId,
            question: pending.question,
            choices: pending.choices,
            timeout_ms: pending.timeoutMs,
          })
        },
        onResolved: resolution => options?.onEvent?.('clarify.resolved', {
          event: 'clarify.resolved',
          run_id: runtimeRunId,
          clarify_id: 'clarify-real-chain',
          resolved: resolution.reason === 'response',
          reason: resolution.reason,
        }),
      })
      runtimeWaiterSettled = true
      return { ok: false, error: response }
    })

    let delivery: Promise<unknown> | undefined
    try {
      const requested = new Promise<any>(resolve => human.once('clarify.requested', resolve))
      delivery = groupServer.agentClients.processMentions('room-1', {
        messageId: 'message-real-chain',
        content: '@Agent check the weather',
        senderName: 'Human',
        senderId: 'human-1',
        timestamp: Date.now(),
        role: 'user',
        mentions: [{ type: 'agent', participantId: 'agent-1', displayName: 'Agent' }],
      })
      await clarificationRegisteredBarrier
      await expect(requested).resolves.toMatchObject({
        clarify_id: 'clarify-real-chain',
        agentName: 'Agent',
      })

      const resolved = new Promise<any>(resolve => human.once('clarify.resolved', resolve))
      const interrupted = new Promise<any>(resolve => {
        human.emit('interrupt_agent', {
          roomId: 'room-1', agentName: 'Agent',
        }, resolve)
      })
      await expect(interrupted).resolves.toEqual({ ok: true })
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(abortSession).toHaveBeenCalledWith(
        runtimeSessionId,
        'Interrupted by group chat user',
      )
      expect(runtimeWaiterSettled).toBe(true)
      await expect(resolved).resolves.toMatchObject({
        clarify_id: 'clarify-real-chain',
        resolved: false,
      })
      await expect(emitAck(human, 'clarify.respond', {
        roomId: 'room-1', clarify_id: 'clarify-real-chain', response: 'late',
      })).resolves.toEqual({ error: 'Clarification is not pending in this room' })
      const joined = await emitAck<any>(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
      expect(joined.pendingClarifies).toEqual([])
    } finally {
      cancelPendingEkkoClarifications()
      await delivery
      await chatRun.close()
    }
  }, 15_000)

  it('claims only the active Ekko clarification generation before the abort completes', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    let finishAbort!: () => void
    const abortPending = new Promise<void>(resolve => {
      finishAbort = resolve
    })
    const cancelClarify = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      agent: 'ekko',
      cancelClarify,
    } as any])
    vi.spyOn(groupServer.agentClients, 'interruptAgent').mockImplementation(async () => {
      await abortPending
    })

    agent.emit('context_status', {
      roomId: 'room-1',
      agentName: 'Agent',
      status: 'replying',
      agentSessionId,
      runId: 'run-current',
    })
    const currentRequested = new Promise<any>(resolve => human.once('clarify.requested', resolve))
    agent.emit('clarify.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      runId: 'run-current',
      runtimeRunId: 'runtime-current',
      clarify_id: 'clarify-current',
      question: 'Current question?',
    })
    await currentRequested
    const laterRequested = new Promise<any>(resolve => human.once('clarify.requested', resolve))
    agent.emit('clarify.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      runId: 'run-later',
      runtimeRunId: 'runtime-later',
      clarify_id: 'clarify-later',
      question: 'Later question?',
    })
    await laterRequested
    const unscopedRequested = new Promise<any>(resolve => human.once('clarify.requested', resolve))
    agent.emit('clarify.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      clarify_id: 'clarify-unscoped',
      question: 'Unscoped question?',
    })
    await unscopedRequested

    const resolved = new Promise<any>(resolve => human.once('clarify.resolved', resolve))
    const interrupted = new Promise<any>(resolve => {
      human.emit('interrupt_agent', {
        roomId: 'room-1',
        agentName: 'Agent',
      }, resolve)
    })
    await vi.waitFor(() => {
      expect(groupServer.agentClients.interruptAgent).toHaveBeenCalledTimes(1)
    })
    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1',
      clarify_id: 'clarify-current',
      response: 'late',
    })).resolves.toEqual({ error: 'Clarification is not pending in this room' })

    finishAbort()
    await expect(interrupted).resolves.toEqual({ ok: true })
    await expect(resolved).resolves.toMatchObject({
      clarify_id: 'clarify-current',
      resolved: false,
      reason: 'Agent run interrupted',
    })
    expect(cancelClarify).toHaveBeenCalledTimes(1)
    expect(cancelClarify).toHaveBeenCalledWith(
      'clarify-current',
      agentSessionId,
      'runtime-current',
    )

    const joined = await emitAck<any>(human, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
    })
    expect(joined.pendingClarifies).toEqual([
      expect.objectContaining({ clarify_id: 'clarify-later' }),
      expect.objectContaining({ clarify_id: 'clarify-unscoped' }),
    ])

    await expect(emitAck(human, 'interrupt_agent', {
      roomId: 'room-1',
      agentName: 'Agent',
    })).resolves.toEqual({ ok: true })
    expect(cancelClarify).toHaveBeenCalledTimes(1)
  })

  it('routes a clarification response to the Hermes bridge', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeClarify = vi.spyOn(AgentBridgeClient.prototype, 'clarifyRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'clarify.requested')
    agent.emit('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      clarify_id: 'clarify-hermes', question: 'Continue?', choices: null, timeout_ms: 300_000,
    })

    await expect(requested).resolves.toMatchObject({ clarify_id: 'clarify-hermes', question: 'Continue?' })
    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1', clarify_id: 'clarify-hermes', response: 'yes',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(bridgeClarify).toHaveBeenCalledWith('clarify-hermes', 'yes')
  })

  it('restores pending approvals and clarifications to a room manager on rejoin', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      approval_id: 'approval-restored', command: 'touch file', description: 'needs approval',
    })
    agent.emit('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      clarify_id: 'clarify-restored', question: 'Which environment?', choices: null,
    })
    await wait()

    const joined = await emitAck<any>(human, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(joined.pendingApprovals).toEqual([
      expect.objectContaining({ approval_id: 'approval-restored', command: 'touch file' }),
    ])
    expect(joined.pendingClarifies).toEqual([
      expect.objectContaining({ clarify_id: 'clarify-restored', question: 'Which environment?' }),
    ])
    expect(joined.pendingApprovals[0].remaining_timeout_ms).toBeGreaterThan(0)
    expect(joined.pendingApprovals[0].remaining_timeout_ms).toBeLessThanOrEqual(joined.pendingApprovals[0].timeout_ms)
    expect(joined.pendingApprovals[0].requested_at).toEqual(expect.any(Number))
    expect(joined.pendingClarifies[0].remaining_timeout_ms).toBeGreaterThan(0)
    expect(joined.pendingClarifies[0].remaining_timeout_ms).toBeLessThanOrEqual(joined.pendingClarifies[0].timeout_ms)
    expect(joined.pendingClarifies[0].requested_at).toEqual(expect.any(Number))
  })

  it('routes approval responses back to the pending Ekko Agent session', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: false } as any)
    const requested = once<any>(human, 'approval.requested')
    const approval = waitForEkkoToolApproval({
      approvalId: 'approval-ekko',
      toolName: 'terminal_exec',
      key: 'terminal:delete',
      command: 'rm -rf build',
      description: 'deletes files or directories',
      choices: ['once', 'session', 'always', 'deny'],
      allowPermanent: true,
      timeoutMs: 300_000,
    }, {
      sessionId: agentSessionId,
      onRequested: pending => {
        agent.emit('approval.requested', {
          roomId: 'room-1',
          agentName: 'Agent',
          agentSessionId,
          approval_id: pending.approvalId,
          command: pending.command,
          description: pending.description,
          choices: pending.choices,
          allow_permanent: pending.allowPermanent,
        })
      },
    })

    await expect(requested).resolves.toMatchObject({
      roomId: 'room-1',
      agentName: 'Agent',
      approval_id: 'approval-ekko',
    })
    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-ekko',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(approval).resolves.toBe('once')
    expect(bridgeApproval).not.toHaveBeenCalled()
  })

  it('removes a resolved remote approval locator so it cannot be submitted twice', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const respondApproval = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondApproval,
    } as any])
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-remote-once',
      command: 'touch file',
      description: 'needs approval',
    })
    await expect(requested).resolves.toMatchObject({ approval_id: 'approval-remote-once' })

    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-remote-once',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-remote-once',
      choice: 'once',
    })).resolves.toEqual({ error: 'Approval is not pending in this room' })
    expect(respondApproval).toHaveBeenCalledOnce()
  })

  it('falls back to the Hermes bridge when a remote approval responder does not own the request', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const respondApproval = vi.fn(async () => false)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondApproval,
    } as any])
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-hermes-behind-remote',
      command: 'touch file',
      description: 'needs approval',
    })
    await expect(requested).resolves.toMatchObject({ approval_id: 'approval-hermes-behind-remote' })

    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-hermes-behind-remote',
      choice: 'once',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(respondApproval).toHaveBeenCalledWith('approval-hermes-behind-remote', 'once')
    expect(bridgeApproval).toHaveBeenCalledWith('approval-hermes-behind-remote', 'once')
  })

  it('routes a remote clarification response and removes its locator', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const respondClarify = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondClarify,
    } as any])
    const requested = once<any>(human, 'clarify.requested')

    agent.emit('clarify.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      clarify_id: 'clarify-remote-once',
      question: 'Which environment?',
      choices: ['staging', 'production'],
      timeout_ms: 300_000,
    })
    await expect(requested).resolves.toMatchObject({ clarify_id: 'clarify-remote-once' })

    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1',
      clarify_id: 'clarify-remote-once',
      response: 'staging',
    })).resolves.toEqual({ ok: true, resolved: true })
    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1',
      clarify_id: 'clarify-remote-once',
      response: 'production',
    })).resolves.toEqual({ error: 'Clarification is not pending in this room' })
    expect(respondClarify).toHaveBeenCalledWith('clarify-remote-once', 'staging')
  })

  it('falls back to the Hermes bridge when a remote clarification responder does not own the request', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const respondClarify = vi.fn(async () => false)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondClarify,
    } as any])
    const bridgeClarify = vi.spyOn(AgentBridgeClient.prototype, 'clarifyRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'clarify.requested')

    agent.emit('clarify.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      clarify_id: 'clarify-hermes-behind-remote',
      question: 'Continue?',
      choices: ['yes', 'no'],
      timeout_ms: 300_000,
    })
    await expect(requested).resolves.toMatchObject({ clarify_id: 'clarify-hermes-behind-remote' })

    await expect(emitAck(human, 'clarify.respond', {
      roomId: 'room-1',
      clarify_id: 'clarify-hermes-behind-remote',
      response: 'yes',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(respondClarify).toHaveBeenCalledWith('clarify-hermes-behind-remote', 'yes')
    expect(bridgeClarify).toHaveBeenCalledWith('clarify-hermes-behind-remote', 'yes')
  })

  it('expires stale pending interactions and tells the browser to close them', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const approvalRequested = once<any>(human, 'approval.requested')
    const clarifyRequested = once<any>(human, 'clarify.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      approval_id: 'approval-expired', command: 'touch expired', timeout_ms: 300_000,
    })
    agent.emit('clarify.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      clarify_id: 'clarify-expired', question: 'Continue?', timeout_ms: 300_000,
    })
    await approvalRequested
    await clarifyRequested
    const approvalResolved = once<any>(human, 'approval.resolved')
    const clarifyResolved = once<any>(human, 'clarify.resolved')

    groupServer.expirePendingAgentInteractions(
      'room-1',
      'Agent',
      ['approval-expired'],
      ['clarify-expired'],
      'Remote Agent run timed out',
    )

    await expect(approvalResolved).resolves.toMatchObject({
      approval_id: 'approval-expired', choice: 'deny', reason: 'Remote Agent run timed out',
    })
    await expect(clarifyResolved).resolves.toMatchObject({
      clarify_id: 'clarify-expired', resolved: false, reason: 'Remote Agent run timed out',
    })
    await expect(emitAck<any>(human, 'load_pending_approvals', {})).resolves.toEqual({ pendingApprovals: [], pendingClarifies: [] })
  })

  it('interrupts only the active run generation and denies its pending approvals', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const respondApproval = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondApproval,
    } as any])
    vi.spyOn(groupServer.agentClients, 'interruptAgent').mockResolvedValue()

    agent.emit('context_status', {
      roomId: 'room-1', agentName: 'Agent', status: 'replying',
      agentSessionId, runId: 'run-current',
    })
    const currentRequested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId, runId: 'run-current',
      approval_id: 'approval-current', command: 'printf harmless',
    })
    await currentRequested
    const nextRequested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId, runId: 'run-next',
      approval_id: 'approval-next', command: 'printf harmless',
    })
    await nextRequested
    const missingGenerationRequested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      approval_id: 'approval-missing-generation', command: 'printf harmless',
    })
    await missingGenerationRequested
    const resolved = once<any>(human, 'approval.resolved')

    await expect(emitAck(human, 'interrupt_agent', {
      roomId: 'room-1', agentName: 'Agent',
    })).resolves.toEqual({ ok: true })

    await expect(resolved).resolves.toMatchObject({
      approval_id: 'approval-current', choice: 'deny', reason: 'Agent run interrupted',
    })
    expect(respondApproval).toHaveBeenCalledTimes(1)
    expect(respondApproval).toHaveBeenCalledWith('approval-current', 'deny')
    await expect(emitAck<any>(human, 'load_pending_approvals', {})).resolves.toEqual({
      pendingClarifies: [],
      pendingApprovals: [
        expect.objectContaining({ approval_id: 'approval-next' }),
        expect.objectContaining({ approval_id: 'approval-missing-generation' }),
      ],
    })

    await expect(emitAck(human, 'interrupt_agent', {
      roomId: 'room-1', agentName: 'Agent',
    })).resolves.toEqual({ ok: true })
    expect(respondApproval).toHaveBeenCalledTimes(1)
  })

  it('claims the active approval before an interrupt can race with a user response', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    let finishInterrupt!: () => void
    const interruptPending = new Promise<void>(resolve => {
      finishInterrupt = resolve
    })
    const respondApproval = vi.fn(async () => true)
    vi.spyOn(groupServer.agentClients, 'getAgents').mockReturnValue([{
      name: 'Agent',
      respondApproval,
    } as any])
    vi.spyOn(groupServer.agentClients, 'interruptAgent').mockImplementation(async () => {
      await interruptPending
    })

    agent.emit('context_status', {
      roomId: 'room-1', agentName: 'Agent', status: 'replying',
      agentSessionId, runId: 'run-current',
    })
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId, runId: 'run-current',
      approval_id: 'approval-race', command: 'printf harmless',
    })
    await requested

    const interrupted = emitAck(human, 'interrupt_agent', {
      roomId: 'room-1', agentName: 'Agent',
    })
    await vi.waitFor(() => {
      expect(groupServer.agentClients.interruptAgent).toHaveBeenCalledTimes(1)
    })
    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1', approval_id: 'approval-race', choice: 'once',
    })).resolves.toEqual({ error: 'Approval is not pending in this room' })

    finishInterrupt()
    await expect(interrupted).resolves.toEqual({ ok: true })
    expect(respondApproval).toHaveBeenCalledTimes(1)
    expect(respondApproval).toHaveBeenCalledWith('approval-race', 'deny')
  })

  it('keeps Hermes approval responses routed through the Agent Bridge', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'approval.requested')

    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-hermes',
      command: 'touch file',
      description: 'needs approval',
    })
    await expect(requested).resolves.toMatchObject({ approval_id: 'approval-hermes' })

    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1',
      approval_id: 'approval-hermes',
      choice: 'session',
    })).resolves.toEqual({ ok: true, resolved: true })
    expect(bridgeApproval).toHaveBeenCalledWith('approval-hermes', 'session')
  })

  it('dismisses an approval when its runtime already reports it expired', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockRejectedValue(new Error('unknown approval request: approval-stale'))
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1', agentName: 'Agent', agentSessionId,
      approval_id: 'approval-stale', command: 'touch stale', description: 'expired',
    })
    await requested
    const resolved = once<any>(human, 'approval.resolved')

    await expect(emitAck(human, 'approval.respond', {
      roomId: 'room-1', approval_id: 'approval-stale', choice: 'deny',
    })).resolves.toEqual({ ok: true, resolved: true, stale: true })
    await expect(resolved).resolves.toMatchObject({
      approval_id: 'approval-stale', choice: 'deny', reason: 'unknown approval request: approval-stale',
    })
    await expect(emitAck<any>(human, 'load_pending_approvals', {})).resolves.toEqual({ pendingApprovals: [], pendingClarifies: [] })
  })

  it('does not route a pending approval through a different room', async () => {
    const { agent, human, agentSessionId } = await joinPair()
    const bridgeApproval = vi.spyOn(AgentBridgeClient.prototype, 'approvalRespond')
      .mockResolvedValue({ resolved: true } as any)
    const requested = once<any>(human, 'approval.requested')
    agent.emit('approval.requested', {
      roomId: 'room-1',
      agentName: 'Agent',
      agentSessionId,
      approval_id: 'approval-private-room',
      command: 'cat secret',
      description: 'needs approval',
    })
    await requested

    groupServer.getStorage().saveRoom('room-2', 'Room 2', 'ROOM2')
    const otherManager = await connectGroupChatClient(port, 'human-2', 'Other')
    harness.sockets.push(otherManager)
    await emitAck(otherManager, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })

    await expect(emitAck(otherManager, 'approval.respond', {
      roomId: 'room-2',
      approval_id: 'approval-private-room',
      choice: 'once',
    })).resolves.toEqual({ error: 'Approval is not pending in this room' })
    expect(bridgeApproval).not.toHaveBeenCalled()
  })

  it('rejects approval responses from sockets that have not joined the room', async () => {
    const outsider = await connectGroupChatClient(port, 'outsider', 'Outsider')
    harness.sockets.push(outsider)

    await expect(emitAck(outsider, 'approval.respond', { roomId: 'room-1', approval_id: 'approval-1', choice: 'deny' })).resolves.toEqual({ error: 'Not in room' })
  })

  it('emits room_cleared and room_updated when runtime state is cleared', async () => {
    const { human } = await joinPair()
    const cleared = once<any>(human, 'room_cleared')
    const updated = once<any>(human, 'room_updated')

    groupServer.clearRoomRuntimeState('room-1')

    expect(await cleared).toEqual({ roomId: 'room-1', totalTokens: 0 })
    expect(await updated).toEqual({ roomId: 'room-1', totalTokens: 0 })
  })
})
