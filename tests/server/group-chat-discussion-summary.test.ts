import { describe, expect, it, vi } from 'vitest'
import { GroupRoomSummaryService, type GroupRoomSummary, type GroupRoomSummaryStorage } from '../../packages/server/src/modules/studio/services/group-chat/room-summary'

describe('discussion summary compaction', () => {
  it('forces the existing leased summary pipeline while preserving transcript rows', async () => {
    let summary: GroupRoomSummary = { roomId: 'room', summary: '', summaryThroughMessageId: '', summaryThroughMessageTimestamp: 0,
      summarizedTurnCount: 0, status: 'idle', version: 0, updatedAt: 0, lastError: null }
    const messages = [
      { id: 'm1', role: 'user', senderName: 'A', content: 'Constraint', timestamp: 1 },
      { id: 'm2', role: 'assistant', senderName: 'B', content: 'Conclusion', timestamp: 2 },
    ]
    const storage: GroupRoomSummaryStorage = {
      getRoom: () => ({ id: 'room', summaryProfile: 'default', summaryProvider: 'openai', summaryModel: 'test', summaryApiMode: '', summaryEveryTurns: 100 }),
      getMessagesForContext: () => messages,
      getRoomSummary: () => summary,
      saveRoomSummary: next => { summary = next },
      saveRoomSummaryIfCurrent: next => { summary = next; return true },
      claimRoomSummaryRun: () => { summary = { ...summary, status: 'summarizing' }; return true },
      renewRoomSummaryRun: () => true,
      commitRoomSummaryRun: (_room, _token, next) => { summary = next; return true },
      invalidateRoomSummaryRun: () => {},
      recoverExpiredRoomSummaryRun: () => false,
    }
    const generate = vi.fn(async () => 'Constraint and conclusion')
    const result = await new GroupRoomSummaryService(storage, undefined, generate).archiveRoom('room')
    expect(generate).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ archived: true, deletedMessages: 0, summary: { summaryThroughMessageId: 'm2', version: 1 } })
    expect(messages).toHaveLength(2)
  })
})
