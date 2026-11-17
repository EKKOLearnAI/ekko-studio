import { it, expect } from 'vitest'
import { EkkoDatabaseManager } from '../../packages/ekko-agent/src/database'
import { EkkoConversationStore } from '../../packages/ekko-agent/src/conversations/store'
import { EKKO_CONVERSATION_MIGRATIONS } from '../../packages/ekko-agent/src/conversations/schema'

it('maintains historical preview, tool counts and latest timestamps across migration and mixed batches', () => {
  const db = new EkkoDatabaseManager({ databasePath: ':memory:' })
  try {
    db.migrate(EKKO_CONVERSATION_MIGRATIONS.slice(0, 1))
    db.connection.exec("INSERT INTO sessions(id,started_at,last_active) VALUES ('old',1,1)")
    db.connection.exec("INSERT INTO messages(session_id,role,content,timestamp) VALUES ('old','user','first',15)")
    const store = new EkkoConversationStore(db)
    store.createSession({ id: 'new' })
    const [blank, call] = store.addMessages([
      { sessionId: 'new', role: 'user', content: '\u00a0', timestamp: 10 },
      { sessionId: 'old', role: 'assistant', content: '', timestamp: 9, toolCalls: [{ id: 't', name: 'tool', arguments: {} }] },
      { sessionId: 'new', role: 'user', content: 'next\nmessage', timestamp: 8 },
    ])
    expect(store.getSession('old')).toMatchObject({ preview: 'first', lastActive: 15, messageCount: 2, toolCallCount: 1, historyRevision: 0 })
    expect(store.getSession('new')).toMatchObject({ preview: 'next message', lastActive: 10, messageCount: 2 })
    store.updateSession('old', { preview: 'custom', lastActive: 100 })
    store.addMessage({ sessionId: 'old', role: 'assistant', content: 'later', timestamp: 11 })
    expect(store.getSession('old')).toMatchObject({ preview: 'first', lastActive: 15, messageCount: 3, toolCallCount: 1 })
    store.updateMessage(blank.id, { content: 'first now' })
    store.deleteMessage(call.id)
    expect(store.getSession('new')?.preview).toBe('first now')
    expect(store.getSession('old')).toMatchObject({ historyRevision: 1, toolCallCount: 0 })
  } finally { db.close() }
})
