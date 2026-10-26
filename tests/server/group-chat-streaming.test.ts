import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  connectGroupChatClient,
  createTestGroupChatServer,
  emitAck,
  once,
} from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET, groupRuntimeSessionId } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import type { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'

describe('group chat streaming baseline', () => {
  let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
  let groupServer: GroupChatServer
  let port: number

  beforeEach(async () => {
    vi.clearAllMocks()
    harness = await createTestGroupChatServer()
    groupServer = harness.groupServer
    port = harness.port
    vi.spyOn(groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
    groupServer.getStorage().saveRoom('room-1', 'Room 1', 'ROOM1')
    groupServer.getStorage().addRoomAgent('room-1', 'agent-worker', 'default', 'Worker', '', 0)
  })

  afterEach(() => {
    harness?.cleanup()
  })

  async function joinPair() {
    const alice = await connectGroupChatClient(port, 'user-a', 'Alice')
    const bob = await connectGroupChatClient(port, 'user-b', 'Bob')
    const worker = await connectGroupChatClient(port, 'agent-worker', 'Worker', {
      source: 'agent',
      agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
    })
    harness.sockets.push(alice, bob, worker)
    await emitAck(alice, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(bob, 'join', { roomId: 'room-1', inviteCode: 'ROOM1' })
    await emitAck(worker, 'join', { roomId: 'room-1' })
    const agentSessionId = groupRuntimeSessionId('room-1', 'default', 'Worker')
    return { alice, bob, worker, agentSessionId }
  }

  it('relays stream start, content delta, reasoning delta, and stream end to room members', async () => {
    const { worker, bob, agentSessionId } = await joinPair()

    const streamStart = once<any>(bob, 'message_stream_start')
    worker.emit('message_stream_start', { roomId: 'room-1', id: 'stream-1', senderName: 'Spoofed', timestamp: 10, agentSessionId })
    expect(await streamStart).toMatchObject({
      id: 'stream-1',
      roomId: 'room-1',
      senderName: 'Worker',
      role: 'assistant',
      finish_reason: 'streaming',
    })

    const contentDelta = once<any>(bob, 'message_stream_delta')
    worker.emit('message_stream_delta', { roomId: 'room-1', id: 'stream-1', delta: 'hello', agentSessionId })
    expect(await contentDelta).toEqual({ roomId: 'room-1', id: 'stream-1', delta: 'hello' })

    const reasoningDelta = once<any>(bob, 'message_reasoning_delta')
    worker.emit('message_reasoning_delta', { roomId: 'room-1', id: 'stream-1', delta: 'thinking', agentSessionId })
    expect(await reasoningDelta).toEqual({ roomId: 'room-1', id: 'stream-1', delta: 'thinking' })

    const streamEnd = once<any>(bob, 'message_stream_end')
    worker.emit('message_stream_end', { roomId: 'room-1', id: 'stream-1', agentSessionId })
    expect(await streamEnd).toEqual({ roomId: 'room-1', id: 'stream-1' })
  })

  it('ignores stream events emitted by human sockets', async () => {
    const { alice, bob } = await joinPair()
    const unexpectedStart = once<any>(bob, 'message_stream_start', 100)
    const unexpectedDelta = once<any>(bob, 'message_stream_delta', 100)
    const unexpectedReasoning = once<any>(bob, 'message_reasoning_delta', 100)
    const unexpectedEnd = once<any>(bob, 'message_stream_end', 100)

    alice.emit('message_stream_start', { roomId: 'room-1', id: 'stream-human', senderName: 'Worker' })
    alice.emit('message_stream_delta', { roomId: 'room-1', id: 'stream-human', delta: 'hello' })
    alice.emit('message_reasoning_delta', { roomId: 'room-1', id: 'stream-human', delta: 'thinking' })
    alice.emit('message_stream_end', { roomId: 'room-1', id: 'stream-human' })

    await expect(unexpectedStart).rejects.toThrow('timeout waiting for message_stream_start')
    await expect(unexpectedDelta).rejects.toThrow('timeout waiting for message_stream_delta')
    await expect(unexpectedReasoning).rejects.toThrow('timeout waiting for message_reasoning_delta')
    await expect(unexpectedEnd).rejects.toThrow('timeout waiting for message_stream_end')
  })

  it('restores in-progress content and reasoning when switching back to a room', async () => {
    const { worker, bob, agentSessionId } = await joinPair()
    groupServer.getStorage().saveRoom('room-2', 'Room 2', 'ROOM2')
    const start = once<any>(bob, 'message_stream_start')
    worker.emit('message_stream_start', { roomId: 'room-1', id: 'live-1', run_id: 'run-1', agentSessionId })
    await start
    const content = once<any>(bob, 'message_stream_delta')
    worker.emit('message_stream_delta', { roomId: 'room-1', id: 'live-1', delta: 'Partial reply', agentSessionId })
    await content
    const reasoning = once<any>(bob, 'message_reasoning_delta')
    worker.emit('message_reasoning_delta', { roomId: 'room-1', id: 'live-1', delta: 'Still thinking', agentSessionId })
    await reasoning
    await emitAck(bob, 'join', { roomId: 'room-2', inviteCode: 'ROOM2' })
    const restored = await emitAck(bob, 'join', { roomId: 'room-1' })
    expect(restored.messages).toContainEqual(expect.objectContaining({
      id: 'live-1', senderId: 'agent-worker', senderName: 'Worker', run_id: 'run-1',
      content: 'Partial reply', reasoning: 'Still thinking', isStreaming: true,
    }))
    expect(groupServer.getStorage().getRecentMessagesForUI('room-1', 100, 0)).toEqual([])
    const delta = once<any>(bob, 'message_stream_delta')
    worker.emit('message_stream_delta', { roomId: 'room-1', id: 'live-1', delta: ' continues', agentSessionId })
    await delta
    const next = await emitAck(bob, 'join', { roomId: 'room-1' })
    expect(next.messages.find((message: any) => message.id === 'live-1').content).toBe('Partial reply continues')
    const ended = once<any>(bob, 'message_stream_end')
    worker.emit('message_stream_end', { roomId: 'room-1', id: 'live-1', agentSessionId })
    await ended
    expect((await emitAck(bob, 'join', { roomId: 'room-1' })).messages).toEqual([])
  })

  it('ignores a representative invalid stream id', async () => {
    const { alice, bob } = await joinPair()
    const unexpected = once<any>(bob, 'message_stream_start', 100)

    alice.emit('message_stream_start', { roomId: 'room-1', id: 'bad id with spaces' })

    await expect(unexpected).rejects.toThrow('timeout waiting for message_stream_start')
  })
})
