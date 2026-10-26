import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'

describe('group chat authoritative execution queue', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  const ownerCapability = 'a'.repeat(64)
  const attackerCapability = 'b'.repeat(64)

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    harness.groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    harness.groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  it.each([false, true])('checks the current message hash in the auto-routing transaction (edited=%s)', edited => {
    const storage = harness.groupServer.getStorage()
    storage.addRoomMember('room-1', 'human-1', 'Owner', '', '')
    const message = { id: 'auto-message', roomId: 'room-1', senderId: 'human-1', senderName: 'Owner',
      content: 'Analyze logs', mentions: [], timestamp: Date.now(), role: 'user' }
    storage.saveMessageAndRefreshRoom(message as any)
    const messageHash = createHash('sha256').update(JSON.stringify({ id: message.id, roomId: message.roomId,
      senderId: message.senderId, content: message.content, mentions: message.mentions, timestamp: message.timestamp })).digest('hex')
    storage.saveMessageRoutingContext({ messageId: message.id, roomId: message.roomId, messageHash, requesterMemberId: message.senderId })
    if (edited) storage.saveMessageAndRefreshRoom({ ...message, content: 'Cancel this task' } as any)
    const result = storage.claimAndEnqueueAutoRouting({ messageId: message.id, roomId: message.roomId, messageHash,
      candidateHash: 'candidates', configHash: 'config', targetAgentId: 'agent-worker', targetAgentName: 'Worker',
      mode: 'auto', status: 'suggested', queueId: null, confidence: .99, handoffComplete: true, loopDetected: false,
      createdAt: Date.now(), updatedAt: Date.now() }, message.senderId, message.content)
    if (edited) {
      expect(result).toBeNull()
      expect(storage.listQueuedExecutionItems(message.roomId)).toHaveLength(0)
    } else {
      expect(result).toMatchObject({ status: 'queued', messageId: message.id })
      expect(storage.listQueuedExecutionItems(message.roomId)).toHaveLength(1)
    }
  })

  it('atomically retracts queued work and its message after commit for every connected client', async () => {
    let finishFirst!: () => void
    let started = 0
    const executor = {
      agentId: 'agent-worker',
      name: 'Worker',
      connected: true,
      replyToMention: vi.fn(async () => {
        started += 1
        if (started === 1) await new Promise<void>(resolve => { finishFirst = resolve })
      }),
    }
    harness.groupServer.agentClients.registerAgentForRoom('room-1', executor as any)

    const owner = await connectGroupChatClient(harness.port, 'human-1', 'Owner')
    const observer = await connectGroupChatClient(harness.port, 'human-2', 'Observer')
    harness.sockets.push(owner, observer)
    await emitAck(owner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(observer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'message-running',
      content: '@Worker first',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    await vi.waitFor(() => expect(executor.replyToMention).toHaveBeenCalledTimes(1))

    const queueUpdate = once<any>(owner, 'execution_queue_updated')
    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'message-queued',
      content: '@Worker second task with a longer body',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    const queued = await queueUpdate
    expect(queued.items).toEqual([
      expect.objectContaining({
        roomId: 'room-1',
        messageId: 'message-queued',
        targetAgentId: 'agent-worker',
        targetAgentName: 'Worker',
        requesterMemberId: 'human-1',
        textSummary: '@Worker second task with a longer body',
        position: 1,
        status: 'queued',
      }),
    ])

    const restored = await emitAck<any>(observer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(restored.executionQueue).toEqual(queued.items)
    expect(JSON.stringify(restored.executionQueue)).not.toContain(ownerCapability)
    expect(JSON.stringify(restored.executionQueue)).not.toContain('cancelCapability')

    owner.disconnect()
    const impersonator = await connectGroupChatClient(harness.port, 'human-1', 'Owner', {
      inviteCode: 'ROOM1',
    })
    harness.sockets.push(impersonator)
    const impersonated = await emitAck<any>(impersonator, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
      name: 'Owner',
    })
    expect(impersonated.executionQueue).toEqual(queued.items)
    const forged = await emitAck<any>(impersonator, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.items[0].id,
      executionQueueCapability: attackerCapability,
    })
    expect(forged).toMatchObject({ error: 'Access denied' })
    const otherMember = await emitAck<any>(observer, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.items[0].id,
      executionQueueCapability: ownerCapability,
    })
    expect(otherMember).toMatchObject({ error: 'Access denied' })

    impersonator.disconnect()
    const reconnectedOwner = await connectGroupChatClient(harness.port, 'human-1', 'Owner', {
      inviteCode: 'ROOM1',
    })
    harness.sockets.push(reconnectedOwner)
    const reconnected = await emitAck<any>(reconnectedOwner, 'join', {
      roomId: 'room-1',
      inviteCode: 'ROOM1',
      name: 'Owner',
    })
    expect(reconnected.executionQueue).toEqual(queued.items)

    const ownerRetraction = once<any>(reconnectedOwner, 'message_retracted')
    const observerRetraction = once<any>(observer, 'message_retracted')
    const ownerQueueAfterRetraction = once<any>(reconnectedOwner, 'execution_queue_updated')
    const observerQueueAfterRetraction = once<any>(observer, 'execution_queue_updated')
    const cancelled = await emitAck<any>(reconnectedOwner, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.items[0].id,
      executionQueueCapability: ownerCapability,
    })
    expect(cancelled).toMatchObject({ ok: true, status: 'retracted', messageId: 'message-queued' })
    expect(await ownerRetraction).toMatchObject({ roomId: 'room-1', messageId: 'message-queued' })
    expect(await observerRetraction).toMatchObject({ roomId: 'room-1', messageId: 'message-queued' })
    expect(await ownerQueueAfterRetraction).toMatchObject({ roomId: 'room-1', items: [] })
    expect(await observerQueueAfterRetraction).toMatchObject({ roomId: 'room-1', items: [] })
    expect(harness.groupServer.getStorage().getMessage('message-queued')).toBeNull()
    expect(harness.groupServer.getStorage().listQueuedExecutionItems('room-1')).toEqual([])

    const refreshed = await emitAck<any>(observer, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    expect(refreshed.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'message-queued' }),
    ]))

    finishFirst()
    await vi.waitFor(() => expect(executor.replyToMention).toHaveBeenCalledTimes(1))
  })

  it('allows the same authenticated account to retract queued work from another device', async () => {
    let finishFirst!: () => void
    const executor = {
      agentId: 'agent-worker',
      name: 'Worker',
      connected: true,
      replyToMention: vi.fn(async () => {
        if (executor.replyToMention.mock.calls.length === 1) {
          await new Promise<void>(resolve => { finishFirst = resolve })
        }
      }),
    }
    harness.groupServer.agentClients.registerAgentForRoom('room-1', executor as any)

    const mobile = await connectGroupChatClient(harness.port, 'auth:1', 'Owner')
    const web = await connectGroupChatClient(harness.port, 'auth:1', 'Owner')
    harness.sockets.push(mobile, web)
    for (const client of [mobile, web]) {
      harness.groupServer.getIO().of('/group-chat').sockets.get(client.id!)!.data.authUser = {
        id: 1, role: 'user', profiles: ['default'],
      }
      await emitAck(client, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    }

    await emitAck(mobile, 'message', {
      roomId: 'room-1',
      id: 'mobile-running',
      content: '@Worker first',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    await vi.waitFor(() => expect(executor.replyToMention).toHaveBeenCalledTimes(1))

    await emitAck(mobile, 'message', {
      roomId: 'room-1',
      id: 'mobile-queued',
      content: '@Worker second',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    await vi.waitFor(() => expect(
      harness.groupServer.getStorage().listQueuedExecutionItems('room-1'),
    ).toHaveLength(1))
    const [queued] = harness.groupServer.getStorage().listQueuedExecutionItems('room-1')

    const otherAccount = await connectGroupChatClient(harness.port, 'auth:2', 'Other')
    harness.sockets.push(otherAccount)
    harness.groupServer.getIO().of('/group-chat').sockets.get(otherAccount.id!)!.data.authUser = {
      id: 2, role: 'user', profiles: ['default'],
    }
    await emitAck(otherAccount, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await expect(emitAck<any>(otherAccount, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.id,
      executionQueueCapability: ownerCapability,
    })).resolves.toEqual({ error: 'Access denied' })

    await expect(emitAck<any>(web, 'cancel_execution_queue_item', {
      roomId: 'room-1',
      queueId: queued.id,
      executionQueueCapability: attackerCapability,
    })).resolves.toMatchObject({ ok: true, status: 'retracted', messageId: 'mobile-queued' })
    expect(harness.groupServer.getStorage().getMessage('mobile-queued')).toBeNull()

    finishFirst()
  })

  it('retracts every target for one message all-or-nothing and rejects after any target starts', () => {
    const storage = harness.groupServer.getStorage() as any
    const capabilityHash = 'c'.repeat(64)
    storage.saveMessageAndRefreshRoom({
      id: 'multi-message',
      roomId: 'room-1',
      senderId: 'human-1',
      senderName: 'Owner',
      content: '@Worker @Reviewer queued',
      timestamp: 1,
      role: 'user',
    })
    const worker = storage.enqueueExecutionQueueItem({
      roomId: 'room-1',
      messageId: 'multi-message',
      targetAgentId: 'agent-worker',
      targetAgentName: 'Worker',
      requesterMemberId: 'human-1',
      cancelCapabilityHash: capabilityHash,
      textSummary: 'multi',
    })
    storage.enqueueExecutionQueueItem({
      roomId: 'room-1',
      messageId: 'multi-message',
      targetAgentId: 'agent-reviewer',
      targetAgentName: 'Reviewer',
      requesterMemberId: 'human-1',
      cancelCapabilityHash: capabilityHash,
      textSummary: 'multi',
    })
    expect(storage.retractQueuedMessage(
      'room-1',
      worker.id,
      'human-1',
      capabilityHash,
    )).toMatchObject({ messageId: 'multi-message', queueIds: expect.any(Array) })
    expect(storage.getMessage('multi-message')).toBeNull()
    expect(storage.listQueuedExecutionItems('room-1')).toEqual([])

    storage.saveMessageAndRefreshRoom({
      id: 'race-message',
      roomId: 'room-1',
      senderId: 'human-1',
      senderName: 'Owner',
      content: '@Worker @Reviewer race',
      timestamp: 2,
      role: 'user',
    })
    const running = storage.enqueueExecutionQueueItem({
      roomId: 'room-1',
      messageId: 'race-message',
      targetAgentId: 'agent-worker',
      targetAgentName: 'Worker',
      requesterMemberId: 'human-1',
      cancelCapabilityHash: capabilityHash,
      textSummary: 'race',
    })
    storage.enqueueExecutionQueueItem({
      roomId: 'room-1',
      messageId: 'race-message',
      targetAgentId: 'agent-reviewer',
      targetAgentName: 'Reviewer',
      requesterMemberId: 'human-1',
      cancelCapabilityHash: capabilityHash,
      textSummary: 'race',
    })
    expect(storage.startExecutionQueueItem(running.id)).toBe(true)

    expect(storage.retractQueuedMessage(
      'room-1',
      running.id,
      'human-1',
      capabilityHash,
    )).toBeNull()
    expect(storage.getMessage('race-message')).not.toBeNull()
    expect(storage.listQueuedExecutionItems('room-1')).toHaveLength(1)
  })

  it('serializes work per Agent while allowing different Agents to run in parallel', async () => {
    harness.groupServer.getStorage().addRoomAgent('room-1', 'agent-reviewer', 'default', 'Reviewer', '', 1)

    let finishWorkerFirst!: () => void
    const workerCalls: string[] = []
    const reviewerCalls: string[] = []
    const worker = {
      agentId: 'agent-worker',
      name: 'Worker',
      connected: true,
      replyToMention: vi.fn(async (_roomId: string, msg: { content: string }) => {
        workerCalls.push(msg.content)
        if (workerCalls.length === 1) {
          await new Promise<void>(resolve => { finishWorkerFirst = resolve })
        }
      }),
    }
    const reviewer = {
      agentId: 'agent-reviewer',
      name: 'Reviewer',
      connected: true,
      replyToMention: vi.fn(async (_roomId: string, msg: { content: string }) => {
        reviewerCalls.push(msg.content)
      }),
    }
    harness.groupServer.agentClients.registerAgentForRoom('room-1', worker as any)
    harness.groupServer.agentClients.registerAgentForRoom('room-1', reviewer as any)

    const owner = await connectGroupChatClient(harness.port, 'human-1', 'Owner')
    harness.sockets.push(owner)
    await emitAck(owner, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })

    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'worker-first',
      content: '@Worker first',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    await vi.waitFor(() => expect(worker.replyToMention).toHaveBeenCalledTimes(1))

    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'worker-second',
      content: '@Worker second',
      mentions: [{ type: 'agent', participantId: 'agent-worker', displayName: 'Worker' }],
      executionQueueCapability: ownerCapability,
    })
    await emitAck(owner, 'message', {
      roomId: 'room-1',
      id: 'reviewer-first',
      content: '@Reviewer independent',
      mentions: [{ type: 'agent', participantId: 'agent-reviewer', displayName: 'Reviewer' }],
      executionQueueCapability: ownerCapability,
    })

    await vi.waitFor(() => expect(reviewer.replyToMention).toHaveBeenCalledTimes(1))
    expect(worker.replyToMention).toHaveBeenCalledTimes(1)
    expect(reviewerCalls).toEqual(['@Reviewer independent'])

    const queued = harness.groupServer.getStorage().listQueuedExecutionItems('room-1')
    expect(queued).toEqual([
      expect.objectContaining({
        messageId: 'worker-second',
        targetAgentId: 'agent-worker',
        position: 1,
        status: 'queued',
      }),
    ])

    finishWorkerFirst()
    await vi.waitFor(() => expect(worker.replyToMention).toHaveBeenCalledTimes(2))
    expect(workerCalls).toEqual(['@Worker first', '@Worker second'])
  })
})
