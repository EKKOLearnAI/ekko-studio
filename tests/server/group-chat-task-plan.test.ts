import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestGroupChatServer, connectGroupChatClient, emitAck, once } from './group-chat-test-helpers'
import { GROUP_CHAT_AGENT_SOCKET_SECRET } from '../../packages/server/src/modules/studio/services/group-chat/agent-clients'
import { groupTaskPlanMessage } from '../../packages/server/src/modules/studio/services/group-chat/task-plan'
import { buildProjectedGroupChatHistory } from '../../packages/server/src/modules/studio/services/group-chat/context-projection'

let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>
const snapshot = (revision = 1) => ({
  session_id: 'agent-session', run_id: 'native-run', plan_id: 'plan', revision,
  execution_state: revision === 1 ? 'running' : 'interrupted', created_at: 1000, updated_at: 1000 + revision,
  plan: [{ id: 'a', step: 'Inspect code', status: 'completed' }, { id: 'b', step: 'Verify', status: 'pending' }],
})
beforeEach(async () => {
  harness = await createTestGroupChatServer()
  vi.spyOn(harness.groupServer.agentClients, 'agentSessionIsCurrent').mockReturnValue(true)
  harness.groupServer.getStorage().saveRoom('room', 'Room', 'ROOM1')
  harness.groupServer.getStorage().addRoomAgent('room', 'worker', 'default', 'Worker', '', 0)
})
afterEach(() => { harness?.cleanup(); vi.restoreAllMocks() })

it('broadcasts one versioned card, persists it for history, and rejects stale updates', async () => {
  const human = await connectGroupChatClient(harness.port, 'human', 'Human')
  const agent = await connectGroupChatClient(harness.port, 'worker', 'Worker', { source: 'agent', agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET })
  harness.sockets.push(human, agent)
  await emitAck(human, 'join', { roomId: 'room', inviteCode: 'ROOM1', name: 'Human' })
  await emitAck(agent, 'join', { roomId: 'room', inviteCode: 'ROOM1', name: 'Worker' })
  const message = (revision: number) => {
    const card = groupTaskPlanMessage('room', 'agent-session', 'group-run', snapshot(revision))!
    return { roomId: 'room', id: card.id, content: card.content, ...card.extra, agentSessionId: 'agent-session' }
  }
  for (const [revision, expected] of [[1, 1], [2, 2], [1, 2]]) {
    const received = once<any>(human, 'message')
    const ack = await emitAck(agent, 'message', message(revision))
    expect(ack.error).toBeUndefined()
    expect(JSON.parse((await received).content).revision).toBe(expected)
  }
  const stored = harness.groupServer.getStorage().getMessage(message(1).id)!
  expect(JSON.parse(stored.content)).toMatchObject({ run_id: 'group-run', revision: 2, execution_state: 'interrupted' })
  expect(harness.groupServer.getStorage().getMessageCount('room')).toBe(1)
  expect(stored.timestamp).toBe(1000)
  expect(buildProjectedGroupChatHistory('', [stored], { name: 'Worker', agentId: 'worker' })).toEqual([])
  const rejoin = await emitAck<any>(human, 'join', { roomId: 'room', inviteCode: 'ROOM1', name: 'Human' })
  expect(rejoin.messages).toEqual(expect.arrayContaining([expect.objectContaining({ id: stored.id, content: stored.content })]))
})

it('isolates room and session identities and rejects malformed or foreign snapshots', () => {
  const a = groupTaskPlanMessage('room', 'agent-session', 'run', snapshot())!
  expect(groupTaskPlanMessage('other', 'agent-session', 'run', snapshot())!.id).not.toBe(a.id)
  expect(groupTaskPlanMessage('room', 'other-session', 'run', { ...snapshot(), session_id: 'other-session' })!.id).not.toBe(a.id)
  expect(groupTaskPlanMessage('room', 'wrong-session', 'run', snapshot())).toBeNull()
  expect(groupTaskPlanMessage('room', 'agent-session', 'run', { ...snapshot(), plan: [] })).toBeNull()
  const storage = harness.groupServer.getStorage()
  const stored = { ...a.extra, id: a.id, content: a.content, roomId: 'room', senderId: 'worker', senderName: 'Worker' }
  storage.saveMessageAndRefreshRoom(stored)
  expect(() => storage.saveMessageAndRefreshRoom({ ...stored, senderId: 'other' })).toThrow('identity mismatch')
})

it('marks persisted running plans interrupted during server recovery', () => {
  const card = groupTaskPlanMessage('room', 'agent-session', 'run', snapshot())!
  const storage = harness.groupServer.getStorage()
  storage.saveMessageAndRefreshRoom({ ...card.extra, id: card.id, content: card.content, roomId: 'room', senderId: 'worker', senderName: 'Worker' })
  storage.init()
  expect(JSON.parse(storage.getMessage(card.id)!.content)).toMatchObject({ execution_state: 'interrupted', revision: 2 })
  storage.init()
  expect(JSON.parse(storage.getMessage(card.id)!.content).revision).toBe(2)
})
