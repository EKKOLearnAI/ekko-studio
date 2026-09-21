import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BusinessEvent } from '../../packages/server/src/modules/studio/services/webhooks/business-events'

let db: any
beforeEach(async () => {
  vi.resetModules()
  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
    getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:',
  }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
})
afterEach(() => {
  db.close()
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
  vi.resetModules()
})
function completion(messageId?: number, output = ''): BusinessEvent {
  return { schema_version: 1, id: 'completion', type: 'chat.run.completed',
    occurred_at: '2026-09-21T00:00:00Z', profile: 'default', source: 'coding_agent',
    subject: { session_id: 'chat', run_id: 'runtime', ...(messageId ? { message_id: String(messageId) } : {}) },
    payload: { run_id: 'runtime', output } }
}

it('selects the exact final reply across interim messages, tools and subsequent turns', async () => {
  const { createSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { chatCompletionText } = await import('../../packages/server/src/modules/studio/services/notifications/chat-completion-text')
  createSession({ id: 'chat', profile: 'default' })
  addMessage({ session_id: 'chat', role: 'assistant', content: 'First progress reply', timestamp: 1 })
  addMessage({ session_id: 'chat', role: 'tool', content: 'Private tool output', timestamp: 2 })
  const finalId = addMessage({ session_id: 'chat', role: 'assistant', content: 'Final answer', timestamp: 3 })!
  // A delayed consumer must not use the latest row from another turn.
  addMessage({ session_id: 'chat', role: 'assistant', content: 'Next turn answer', timestamp: 4 })
  expect(chatCompletionText(completion(finalId, 'First progress reply\nFinal answer'))).toBe('Final answer')
})

it('prefers display text and excludes unrelated sessions, user text and tool output', async () => {
  const { createSession, addMessage } = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const { chatCompletionText } = await import('../../packages/server/src/modules/studio/services/notifications/chat-completion-text')
  createSession({ id: 'chat', profile: 'default' })
  createSession({ id: 'other', profile: 'default' })
  const finalId = addMessage({ session_id: 'chat', role: 'assistant', content: 'Raw final', display_content: 'Visible final', timestamp: 1 })!
  expect(chatCompletionText(completion(finalId, 'Interim reply'))).toBe('Visible final')
  const rejected = [
    addMessage({ session_id: 'chat', role: 'user', content: 'Private prompt', timestamp: 2 }),
    addMessage({ session_id: 'chat', role: 'tool', content: 'Private output', timestamp: 3 }),
    addMessage({ session_id: 'other', role: 'assistant', content: 'Other session', timestamp: 4 }),
    99999, undefined,
  ]
  for (const id of rejected) {
    expect(chatCompletionText(completion(id ?? undefined))).toBe('')
    expect(chatCompletionText(completion(id ?? undefined, 'Current output'))).toBe('Current output')
  }
  expect(chatCompletionText({ ...completion(finalId), type: 'chat.run.failed' })).toBe('')
})
