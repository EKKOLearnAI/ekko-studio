import { createServer } from 'node:http'
import { io, type Socket } from 'socket.io-client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const database = vi.hoisted(() => {
  const { DatabaseSync } = require('node:sqlite')
  return new DatabaseSync(':memory:')
})
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => database }))

import { initAllHermesTables } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { GroupChatServer } from '../../packages/server/src/modules/studio/sockets/group-chat'
import type { DiscussionRow } from '../../packages/server/src/modules/studio/services/group-chat/discussion'

const row = (roomId: string, status = 'running'): DiscussionRow => ({
  id: `discussion-${roomId}`, roomId, goal: 'Review the plan', agentOrder: '["worker"]', reporterId: 'worker',
  maxRounds: 8, maxMessages: 60, minRounds: 0, judgeProfile: 'default', judgeProvider: 'openai', judgeModel: 'test', judgeApiMode: '',
  status, currentRound: 1, judgeNotes: '[]', reportMessageId: '', summaryFilePath: '', deliverables: '[]', lastError: null,
  createdAt: Date.now(), updatedAt: Date.now(),
})

describe('discussion integration with the upstream group runtime', () => {
  const http = createServer()
  let group: GroupChatServer
  let client: Socket
  beforeAll(async () => {
    initAllHermesTables()
    group = new GroupChatServer(http)
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address() as { port: number }
    const storage = group.getStorage()
    storage.saveRoom('room', 'Room', 'INVITE')
    storage.addRoomAgent('room', 'worker', 'default', 'Worker', '', 0)
    vi.spyOn(storage, 'getMentionableRoomAgents').mockImplementation(roomId => storage.getRoomAgents(roomId))
    client = io(`http://127.0.0.1:${address.port}/group-chat`, {
      auth: { userId: 'human', name: 'Human', inviteCode: 'INVITE' }, transports: ['websocket'], reconnection: false,
    })
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject) })
    const joined = await client.timeout(2000).emitWithAck('join', { roomId: 'room', inviteCode: 'INVITE', name: 'Human' })
    expect(joined.error).toBeUndefined()
  })
  afterAll(async () => {
    client?.disconnect()
    if (group) await new Promise<void>(resolve => group.getIO().close(() => resolve()))
    database.close()
  })

  it('persists one discussion per room and excludes tool plumbing from the speech budget', () => {
    const storage = group.getStorage()
    storage.saveDiscussion(row('room'))
    storage.saveDiscussion({ ...row('room'), id: 'replacement' })
    expect(storage.listDiscussions()).toHaveLength(1)
    expect(storage.getDiscussionByRoom('room')?.id).toBe('replacement')
    storage.addMessage({ id: 'text', roomId: 'room', senderId: 'worker', senderName: 'Worker', role: 'assistant', content: 'A conclusion', timestamp: 1 })
    storage.addMessage({ id: 'placeholder', roomId: 'room', senderId: 'worker', senderName: 'Worker', role: 'assistant', content: '', timestamp: 2 })
    storage.addMessage({ id: 'tool', roomId: 'room', senderId: 'worker', senderName: 'Worker', role: 'tool', content: 'Read a file', timestamp: 3 })
    expect(storage.getSubstantiveMessageCount('room')).toBe(1)
  })

  it('suspends mention routing during discussion and restores it after the run stops', async () => {
    const route = vi.spyOn(group.agentClients, 'processMentions').mockResolvedValue(undefined)
    group.getStorage().saveDiscussion(row('room'))
    const post = () => client.timeout(2000).emitWithAck('message', {
      roomId: 'room', content: '@Worker evaluate', mentions: [{ type: 'agent', participantId: 'worker', displayName: 'Worker' }],
    })
    expect((await post()).error).toBeUndefined()
    expect(route).not.toHaveBeenCalled()
    group.getStorage().updateDiscussion('room', { status: 'stopped' })
    expect((await post()).error).toBeUndefined()
    expect(route).toHaveBeenCalledOnce()
  })
})
