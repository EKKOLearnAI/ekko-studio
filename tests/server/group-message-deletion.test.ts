import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestGroupChatServer, connectGroupChatClient, emitAck, once } from './group-chat-test-helpers'
import { deleteGroupMessages } from '../../packages/server/src/modules/studio/repositories/group-message-deletion'
import { setGroupChatServer, getRoomMessageSelection, deleteRoomMessages } from '../../packages/server/src/modules/studio/controllers/group-chat'

describe('group message selection and deletion', () => {
  let h: Awaited<ReturnType<typeof createTestGroupChatServer>>
  const roomId = 'delete-room'
  const message = (id: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
    id, roomId, senderId: 'member', senderName: 'Member', role: 'user', content: `content ${id}`, timestamp, ...extra,
  })
  const seed = (id: string, timestamp: number, extra = {}) => h.groupServer.getStorage().saveMessageAndRefreshRoom(message(id, timestamp, extra) as any)
  const summary = (id = 'old', timestamp = 1) => h.groupServer.getStorage().saveRoomSummary({
    roomId, summary: 'Keep this summary', summaryThroughMessageId: id, summaryThroughMessageTimestamp: timestamp,
    summarizedTurnCount: 1, status: 'success', version: 3, updatedAt: 42, lastError: null,
  })
  const selection = () => h.groupServer.getMessageSelection(roomId)
  const remove = (ids: string[], revision = selection().historyRevision) => h.groupServer.deleteMessages(roomId, ids, revision)
  beforeEach(async () => {
    h = await createTestGroupChatServer()
    h.groupServer.getStorage().saveRoom(roomId, 'Deletion room', 'DELETE-ROOM', { summaryEveryTurns: 1000, ownerAuthUserId: 7 })
    setGroupChatServer(h.groupServer)
  })
  afterEach(() => { setGroupChatServer(null); h.cleanup() })

  it('deletes a complete run across history pages, preserves unselected rows and summary, and rebuilds future context', async () => {
    seed('old', 1); summary()
    seed('run_part_0', 2, { role: 'assistant', senderId: 'agent', run_id: 'run' })
    seed('tool', 3, { role: 'tool', senderId: 'agent', run_id: 'run', tool_name: 'terminal', tool_call_id: 'call' })
    for (let i = 0; i < 160; i++) seed(`keep-${i}`, 10 + i)
    seed('run_part_1', 180, { role: 'assistant', senderId: 'agent', run_id: 'run' })
    const before = h.db.prepare('SELECT * FROM gc_room_summaries WHERE roomId = ?').get(roomId)
    const retained = h.db.prepare("SELECT * FROM gc_messages WHERE roomId = ? AND COALESCE(run_id, '') != 'run' ORDER BY id").all(roomId)
    const result = await remove(['run_part_1'])
    expect(result.messageIds.sort()).toEqual(['run_part_0', 'run_part_1', 'tool'])
    expect(result).toMatchObject({ deletedGroups: 1, messageCount: 161, messageDeletionRevision: 1 })
    expect(h.db.prepare('SELECT * FROM gc_room_summaries WHERE roomId = ?').get(roomId)).toEqual(before)
    expect(h.db.prepare('SELECT * FROM gc_messages WHERE roomId = ? ORDER BY id').all(roomId)).toEqual(retained)
    expect(h.groupServer.getStorage().getRoom(roomId)?.messageDeletionRevision).toBe(1)
    const context = await h.groupServer.getRoomSummaryService().prepareForMessage(roomId)
    expect(context.summary).toBe('Keep this summary')
    expect(context.history.some(row => result.messageIds.includes(row.id))).toBe(false)
    expect(context.history.some(row => row.id === 'keep-159')).toBe(true)
  })

  it('locks the summarized prefix and every part of a run crossing the anchor', async () => {
    seed('old', 1)
    seed('run_part_0', 2, { role: 'assistant', run_id: 'run' })
    seed('anchor', 3); summary('anchor', 3)
    seed('run_part_1', 4, { role: 'assistant', run_id: 'run' })
    seed('tail', 5)
    expect(selection().groups.find(g => g.messageIds.includes('run_part_1'))?.deleteBlockedReason).toBe('summarized')
    await expect(remove(['tail', 'run_part_1'])).rejects.toMatchObject({ status: 409 })
    expect(h.groupServer.getStorage().getMessage('tail')).not.toBeNull()
    await expect(remove(['tail'])).resolves.toMatchObject({ messageCount: 4 })
  })

  it.each(['missing', 'wrong-timestamp', 'no-anchor'])('fails closed with an inconsistent summary boundary: %s', async kind => {
    seed('old', 1); seed('tail', 2)
    summary(kind === 'missing' ? 'gone' : kind === 'no-anchor' ? '' : 'old', kind === 'wrong-timestamp' ? 9 : 1)
    expect(selection().groups.every(g => g.deleteBlockedReason === 'summary_boundary_unknown')).toBe(true)
    await expect(remove(['tail'])).rejects.toMatchObject({ status: 409 })
  })

  it('protects legacy snapshot cursors and retains the exact snapshot', async () => {
    seed('old', 1); seed('tail', 2)
    h.db.prepare('INSERT INTO gc_context_snapshots VALUES (?, ?, ?, ?, ?)').run(roomId, 'Legacy summary', 'old', 1, 10)
    const snapshot = h.db.prepare('SELECT * FROM gc_context_snapshots').all()
    await expect(remove(['old'])).rejects.toMatchObject({ status: 409 })
    await remove(['tail'])
    expect(h.db.prepare('SELECT * FROM gc_context_snapshots').all()).toEqual(snapshot)
  })

  it.each(['new-message', 'edited-message', 'new-summary', 'deleted-message'])('rejects stale selections after %s', async kind => {
    seed('old', 1); seed('tail', 2)
    const revision = selection().historyRevision
    if (kind === 'new-message') seed('new', 3)
    if (kind === 'edited-message') seed('tail', 2, { content: 'changed' })
    if (kind === 'new-summary') summary()
    if (kind === 'deleted-message') await remove(['old'])
    await expect(remove(['tail'], revision)).rejects.toMatchObject({ status: 409 })
    expect(h.groupServer.getStorage().getMessage('tail')).not.toBeNull()
  })

  it('keeps same-named runs from different agents separate and clears only an unfinished summary drain', async () => {
    seed('old', 1); summary()
    seed('a', 2, { senderId: 'agent-a', role: 'assistant', run_id: 'same-run' })
    seed('b', 3, { senderId: 'agent-b', role: 'assistant', run_id: 'same-run' })
    h.db.prepare("UPDATE gc_room_summaries SET summaryDrainThroughMessageId = 'a', status = 'failed'").run()
    const state = h.groupServer.getRoomSummaryService().getState(roomId)
    const generation = h.groupServer.getStorage().getRoom(roomId)!.summaryGeneration || 0
    const result = await remove(['a'])
    expect(result.messageIds).toEqual(['a'])
    expect(h.groupServer.getStorage().getMessage('b')).not.toBeNull()
    expect(h.groupServer.getRoomSummaryService().getState(roomId)).toEqual(state)
    expect(h.db.prepare('SELECT summaryDrainThroughMessageId AS cutoff FROM gc_room_summaries').get()).toMatchObject({ cutoff: '' })
    expect(h.groupServer.getStorage().saveRoomSummaryIfCurrent({ ...state, summary: 'Stale review' }, generation, state.version, state.summaryThroughMessageId)).toBe(false)
  })

  it('scopes message ids to the room and rolls back every selected item on failure', async () => {
    seed('tail', 1)
    h.groupServer.getStorage().saveRoom('other', 'Other')
    h.groupServer.getStorage().saveMessageAndRefreshRoom(message('foreign', 2, { roomId: 'other' }) as any)
    await expect(remove(['tail', 'foreign'])).rejects.toMatchObject({ status: 404 })
    const revision = selection().historyRevision
    expect(() => deleteGroupMessages(roomId, ['tail'], revision, () => { throw new Error('refresh failed') })).toThrow('refresh failed')
    expect(selection().historyRevision).toBe(revision)
    expect(h.groupServer.getStorage().getMessage('tail')).not.toBeNull()
  })

  it.each(['summary', 'runtime', 'queue', 'stream'])('blocks deletion while %s is active', async kind => {
    seed('old', 1)
    const revision = selection().historyRevision
    if (kind === 'summary') { summary(); h.db.prepare("UPDATE gc_room_summaries SET status = 'summarizing'").run() }
    if (kind === 'runtime') vi.spyOn(h.groupServer.agentClients, 'hasRoomWork').mockReturnValue(true)
    if (kind === 'queue') h.groupServer.getStorage().enqueueExecutionQueueItem({ roomId, messageId: 'old', targetAgentId: 'a', targetAgentName: 'A', requesterMemberId: 'member', cancelCapabilityHash: '', textSummary: 'queued' })
    if (kind === 'stream') seed('stream', 2, { role: 'assistant', finish_reason: 'streaming' })
    expect(selection).toThrow(/busy/)
    await expect(remove(['old'], revision)).rejects.toMatchObject({ status: 409 })
    expect(h.groupServer.getStorage().getMessage('old')).not.toBeNull()
  })

  it('validates request shape and enforces management permission', async () => {
    seed('tail', 1)
    const ctx = (user: unknown, body?: unknown): any => ({ params: { roomId }, state: { user }, request: { body } })
    const denied = ctx({ id: 8, role: 'user', profiles: [] })
    await getRoomMessageSelection(denied)
    expect(denied.status).toBe(403)
    await deleteRoomMessages(denied)
    expect(denied.status).toBe(403)
    const owner = ctx({ id: 7, role: 'user', profiles: [] })
    await getRoomMessageSelection(owner)
    expect(owner.body.groups).toHaveLength(1)
    const bad = ctx({ id: 7 }, { messageIds: [], historyRevision: owner.body.historyRevision })
    await deleteRoomMessages(bad)
    expect(bad.status).toBe(400)
    const valid = ctx({ id: 7 }, { messageIds: ['tail'], historyRevision: owner.body.historyRevision })
    await deleteRoomMessages(valid)
    expect(valid.body.messageIds).toEqual(['tail'])
  })

  it('broadcasts exact deleted ids and sends the persisted revision to reconnecting clients', async () => {
    seed('old', 1); seed('tail', 2); summary()
    h.groupServer.getStorage().addRoomMember(roomId, 'viewer', 'Viewer', '', '')
    const client = await connectGroupChatClient(h.port, 'viewer', 'Viewer')
    h.sockets.push(client)
    const joined = await emitAck(client, 'join', { roomId, userName: 'Viewer' })
    expect(joined.messageDeletionRevision).toBe(0)
    const event = once(client, 'messages_deleted')
    await remove(['tail'])
    expect(await event).toMatchObject({ roomId, messageIds: ['tail'], messageDeletionRevision: 1 })
    const rejoined = await emitAck(client, 'join', { roomId, userName: 'Viewer' })
    expect(rejoined.messageDeletionRevision).toBe(1)
    expect(rejoined.messages.map((m: any) => m.id)).toEqual(['old'])
    expect(rejoined.roomSummary.summary).toBe('Keep this summary')
  })
})
