import { describe, expect, it } from 'vitest'
import { buildMessageSelectionRows } from '../../packages/client/src/components/hermes/chat/message-selection'
import type { Message } from '../../packages/client/src/stores/hermes/chat'

describe('message selection rows', () => {
  it('selects a run once across assistant fragments, tool cards and plans while keeping the user separate', () => {
    const messages = [
      { id: '10', role: 'user', runMarker: 'r' },
      { id: '11', role: 'assistant', runMarker: 'r' },
      { id: 'tool-run:r', role: 'system', runMarker: 'r', toolMessages: [{ id: '12', role: 'tool' }] },
      { id: '13', role: 'assistant', runMarker: 'r' },
      { id: 'task-plan:p', role: 'system', runMarker: 'r', taskPlan: {} },
    ] as Message[]
    const rows = buildMessageSelectionRows(messages, [
      { id: 10, kind: 'message', messageIds: [10] },
      { id: 11, kind: 'run', runMarker: 'r', messageIds: [11, 12, 13] },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0].messages).toHaveLength(1)
    expect(rows[1].messages).toHaveLength(4)
  })

  it('uses stored identities for legacy synthetic tools and includes the unseen part of a paginated run', () => {
    const rows = buildMessageSelectionRows([
      { id: '123_call', role: 'tool', storedMessageId: 123 },
      { id: '124', role: 'assistant' },
    ] as Message[], [{ id: 120, kind: 'run', messageIds: [120, 121, 122, 123, 124] }])
    expect(rows).toHaveLength(1)
    expect(rows[0].group?.id).toBe(120)
    expect(rows[0].group?.messageIds).toHaveLength(5)
  })
})
