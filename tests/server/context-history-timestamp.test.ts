import { describe, expect, it } from 'vitest'
import { buildDbHistoryFromContextRows } from '../../packages/server/src/modules/studio/services/chat-run/context-history'

describe('context history measurement boundaries', () => {
  it('carries the row timestamp as a non-enumerable boundary marker', () => {
    const history = buildDbHistoryFromContextRows('session-1', [
      { id: 10, session_id: 'session-1', role: 'user', content: 'old', timestamp: 1_700_000_400 },
      { id: 11, session_id: 'session-1', role: 'assistant', content: 'new', timestamp: 1_700_000_600 },
    ] as any, { truncateToolResults: false }) as any[]

    expect(history.map((message) => message.timestamp)).toEqual([1_700_000_400, 1_700_000_600])
    // Same contract as `cursorId`: used for boundaries, never serialized to a model.
    for (const message of history) {
      expect(Object.keys(message)).not.toContain('timestamp')
      expect(JSON.stringify(message)).not.toContain('timestamp')
    }
  })

  it('leaves the timestamp absent when the row has none', () => {
    const history = buildDbHistoryFromContextRows('session-1', [
      { id: 12, session_id: 'session-1', role: 'user', content: 'no stamp' },
    ] as any, { truncateToolResults: false }) as any[]
    expect(history[0].timestamp).toBeUndefined()
  })
})
