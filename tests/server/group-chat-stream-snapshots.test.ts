import { describe, expect, it } from 'vitest'
import { GroupStreamSnapshots } from '../../packages/server/src/modules/studio/services/group-chat/stream-snapshots'

const message = (id = 'part-1', senderId = 'agent-1', roomId = 'room-1') => ({
  id, senderId, roomId, senderAgentRecordId: senderId + '-record', content: '',
  reasoning: '', reasoning_content: '', run_id: 'run-1', role: 'assistant', tool_calls: [] as unknown[],
})
describe('transient group stream snapshots', () => {
  it('keeps one current segment per Agent while isolating rooms, Agents and sessions', () => {
    const streams = new GroupStreamSnapshots<ReturnType<typeof message>>()
    streams.start(message(), 'session-1')
    streams.append('room-1', 'part-1', 'agent-1', 'old-session', 'content', 'stale')
    streams.append('room-1', 'part-1', 'agent-2', 'session-1', 'content', 'foreign')
    streams.append('room-2', 'part-1', 'agent-1', 'session-1', 'content', 'other room')
    streams.append('room-1', 'part-1', 'agent-1', 'session-1', 'content', 'Live')
    streams.start(message(), 'session-1')
    expect(streams.snapshot('room-1', () => true)[0].content).toBe('Live')
    streams.start(message('part-2'), 'session-1')
    streams.start(message('part-3', 'agent-2'), 'session-2')
    expect(streams.snapshot('room-1', () => true).map(item => item.id)).toEqual(['part-2', 'part-3'])
    streams.finish('room-1', 'part-2', 'agent-2')
    expect(streams.snapshot('room-1', () => true)).toHaveLength(2)
  })

  it('returns independent snapshots and drops streams from invalidated sessions', () => {
    const streams = new GroupStreamSnapshots<ReturnType<typeof message>>()
    streams.start(message(), 'session-1')
    const snapshot = streams.snapshot('room-1', () => true)[0]
    streams.append('room-1', 'part-1', 'agent-1', 'session-1', 'reasoning', 'Thinking')
    expect(snapshot.reasoning).toBe('')
    expect(streams.snapshot('room-1', () => false)).toEqual([])
    expect(streams.snapshot('room-1', () => true)).toEqual([])
  })

  it('moves reasoning to a persisted tool message and removes the persisted final response', () => {
    const streams = new GroupStreamSnapshots<ReturnType<typeof message>>()
    streams.start(message(), 'session-1')
    streams.append('room-1', 'part-1', 'agent-1', 'session-1', 'reasoning', 'Before tool')
    streams.persisted({ ...message('tool-1'), tool_calls: [{ id: 'call-1' }] })
    expect(streams.snapshot('room-1', () => true)[0].reasoning).toBe('')
    streams.append('room-1', 'part-1', 'agent-1', 'session-1', 'reasoning', 'After tool')
    expect(streams.snapshot('room-1', () => true)[0].reasoning_content).toBe('After tool')
    streams.persisted({ ...message(), content: 'Final' })
    expect(streams.snapshot('room-1', () => true)).toEqual([])
  })

  it('clears only the selected Agent on disconnect/removal and the entire room on deletion', () => {
    const streams = new GroupStreamSnapshots<ReturnType<typeof message>>()
    streams.start(message(), 'session-1')
    streams.start(message('part-2', 'agent-2'), 'session-2')
    streams.clearSender('room-1', 'agent-1', 'old-session')
    expect(streams.snapshot('room-1', () => true)).toHaveLength(2)
    streams.clear('room-1', 'agent-1-record')
    expect(streams.snapshot('room-1', () => true).map(item => item.senderId)).toEqual(['agent-2'])
    streams.clear('room-1')
    expect(streams.snapshot('room-1', () => true)).toEqual([])
  })
})
