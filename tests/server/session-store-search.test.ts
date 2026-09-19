import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session store filtering', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      isSqliteAvailable: () => true,
      getStoragePath: () => ':memory:',
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('stores pins on sessions, retains categories, and includes old pins before pagination', async () => {
    const { createSession, getSession, listSessions, setSessionPinned } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'old', profile: 'default', category_id: 1 })
    createSession({ id: 'new', profile: 'default' })
    createSession({ id: 'other', profile: 'work' })
    db.prepare('UPDATE sessions SET last_active = 1 WHERE id = ?').run('old')
    expect(getSession('old')?.is_pinned).toBe(0)
    expect(setSessionPinned('old', true)).toBe(true)
    expect(getSession('old')).toMatchObject({ is_pinned: 1, category_id: 1 })
    expect(listSessions('default', undefined, 1).map(s => s.id)).toEqual(['old'])
    expect(listSessions('default', undefined, 100, { pinned: true }).map(s => s.id)).toEqual(['old'])
    expect(listSessions('work', undefined, 100, { pinned: true })).toEqual([])
    expect(listSessions('default', undefined, 1, { pinned: false }).map(s => s.id)).toEqual(['new'])
    expect(listSessions('default', undefined, 10, { pinned: false, categoryId: 1 })).toEqual([])
    expect(setSessionPinned('old', false)).toBe(true)
    expect(listSessions('default', undefined, 100, { pinned: true })).toEqual([])
    expect(setSessionPinned('missing', true)).toBe(false)
  })

  it('filters database pins before pagination and category counts', async () => {
    const { createSession, listSessions, countSessions, setSessionPinned } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { createSessionCategory } = await import('../../packages/server/src/modules/studio/repositories/session-category-store')
    const category = createSessionCategory('Work')
    for (let i = 0; i < 25; i++) {
      createSession({ id: `session-${i}`, profile: 'default', category_id: category.id })
      setSessionPinned(`session-${i}`, i < 12)
    }
    const options = { pinned: false, categoryId: category.id }
    expect(countSessions('default', undefined, options)).toBe(13)
    const first = listSessions('default', undefined, 10, options)
    const next = listSessions('default', undefined, 10, { ...options, offset: 10 })
    expect(first).toHaveLength(10)
    expect(next).toHaveLength(3)
    expect(new Set([...first, ...next].map(s => s.id)).size).toBe(13)
    expect([...first, ...next].every(s => s.is_pinned === 0)).toBe(true)
  })

  it('resolves notification title for untitled sessions and bounds assistant preview', async () => {
    const { createSession, addMessage, getSessionNotificationPreview } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'untitled-notice', profile: 'default', source: 'coding_agent' })
    addMessage({ session_id: 'untitled-notice', role: 'user', content: 'First user question', timestamp: 1 })
    addMessage({ session_id: 'untitled-notice', role: 'assistant', content: 'a'.repeat(1000), timestamp: 2 })
    addMessage({ session_id: 'untitled-notice', role: 'tool', content: 'private tool output', timestamp: 3 })
    expect(getSessionNotificationPreview('untitled-notice')).toEqual({ title: 'First user question', preview: 'a'.repeat(240) })
    expect(getSessionNotificationPreview('missing')).toBeNull()
    createSession({ id: 'structured-notice', profile: 'default', source: 'coding_agent' })
    addMessage({ session_id: 'structured-notice', role: 'user', content: JSON.stringify([
      { type: 'text', text: 'Readable App title' }, { type: 'image', path: '/private/image.png' },
    ]), timestamp: 1 })
    expect(getSessionNotificationPreview('structured-notice')).toEqual({ title: 'Readable App title', preview: '' })
  })

  it('finds rendered text when Markdown markers split the stored phrase', async () => {
    const { addMessage, createSession, searchSessions } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    createSession({ id: 'markdown-session', profile: 'default', source: 'cli', title: 'Background tasks' })
    const messageId = addMessage({
      session_id: 'markdown-session',
      role: 'assistant',
      content: '1. **单个任务** — 给一个目标，子agent独立跑完返回结果',
      timestamp: 100,
    })

    const results = searchSessions(
      undefined,
      '单个任务 — 给一个目标，子agent独立跑完返回结果',
      10,
      { sources: ['cli'], profiles: ['default'], includeArchived: false },
    )

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(expect.objectContaining({
      id: 'markdown-session',
      matched_message_id: messageId,
      rank: 3,
    }))
  })

  it('ranks an exact coding-agent title before newer body matches and filters before limiting', async () => {
    const { addMessage, createSession, searchSessions } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    createSession({ id: 'coding-agent', profile: 'default', source: 'coding_agent', title: 'test' })
    createSession({ id: 'recent-chat', profile: 'default', source: 'cli', title: 'Recent conversation' })
    addMessage({ session_id: 'recent-chat', role: 'assistant', content: 'A test appeared in the body', timestamp: 400 })
    createSession({ id: 'workflow', profile: 'default', source: 'workflow', title: 'test' })
    createSession({ id: 'archived-chat', profile: 'default', source: 'cli', title: 'test' })
    db.prepare('UPDATE sessions SET last_active = 100 WHERE id = ?').run('coding-agent')
    db.prepare('UPDATE sessions SET last_active = 400 WHERE id = ?').run('recent-chat')
    db.prepare('UPDATE sessions SET last_active = 500 WHERE id = ?').run('workflow')
    db.prepare('UPDATE sessions SET last_active = 600, is_archived = 1 WHERE id = ?').run('archived-chat')

    const results = searchSessions(undefined, 'test', 1, {
      sources: ['api_server', 'cli', 'coding_agent', 'global_agent'],
      profiles: ['default'],
      includeArchived: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(expect.objectContaining({
      id: 'coding-agent',
      source: 'coding_agent',
      rank: 0,
    }))
  })

  it('filters hidden session sources before applying the list limit', async () => {
    const { createSession, listSessions } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    createSession({ id: 'visible-chat', profile: 'default', source: 'cli', title: 'Visible chat' })
    createSession({ id: 'latest-workflow', profile: 'default', source: 'workflow', title: 'Workflow node' })
    db.prepare('UPDATE sessions SET last_active = 100 WHERE id = ?').run('visible-chat')
    db.prepare('UPDATE sessions SET last_active = 200 WHERE id = ?').run('latest-workflow')

    const results = listSessions(undefined, undefined, 1, {
      sources: ['api_server', 'cli', 'coding_agent', 'global_agent'],
      profiles: ['default'],
      includeArchived: false,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toEqual(expect.objectContaining({ id: 'visible-chat', source: 'cli' }))
  })

  it('paginates after visibility filters with stable ordering for equal activity times', async () => {
    const { createSession, listSessions, countSessions } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )
    for (const id of ['chat-a', 'chat-b', 'chat-c', 'archived', 'deleted']) {
      createSession({ id, profile: 'default', source: 'cli' })
    }
    createSession({ id: 'other-profile', profile: 'travel', source: 'cli' })
    createSession({ id: 'workflow', profile: 'default', source: 'workflow' })
    db.prepare('UPDATE sessions SET last_active = 100').run()
    db.prepare("UPDATE sessions SET is_archived = 1 WHERE id = 'archived'").run()
    const options = {
      profiles: ['default'], sources: ['cli'], includeArchived: false, excludeSessionIds: ['deleted'],
    }
    const first = listSessions(undefined, undefined, 2, options)
    const second = listSessions(undefined, undefined, 2, { ...options, offset: 2 })
    expect(first.map(session => session.id)).toEqual(['chat-c', 'chat-b'])
    expect(second.map(session => session.id)).toEqual(['chat-a'])
    expect(listSessions(undefined, undefined, 2, { ...options, offset: 3 })).toEqual([])
    expect(countSessions(undefined, undefined, { ...options, offset: 100 })).toBe(3)
    expect(countSessions(undefined, undefined, { ...options, profiles: [] })).toBe(0)
    expect(countSessions('travel', 'cli', { includeArchived: false })).toBe(1)
  })

  it('pages each category and pinned selection independently before applying the limit', async () => {
    const { createSession, listSessions, countSessions } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const { createSessionCategory, setSessionCategory } = await import('../../packages/server/src/modules/studio/repositories/session-category-store')
    const category = createSessionCategory('Work')
    for (let index = 0; index < 25; index++) {
      const id = `work-${String(index).padStart(2, '0')}`
      createSession({ id, profile: 'default', source: 'cli' })
      setSessionCategory(id, category.id)
      createSession({ id: `none-${index}`, profile: 'default', source: 'cli' })
    }
    db.prepare('UPDATE sessions SET last_active = 100').run()
    const options = { categoryId: category.id, excludeSessionIds: ['work-24'], includeArchived: false }
    const first = listSessions(undefined, undefined, 10, options)
    const next = listSessions(undefined, undefined, 10, { ...options, offset: 10 })
    expect(first.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => `work-${23 - i}`))
    expect(next.map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => `work-${String(13 - i).padStart(2, '0')}`))
    const none = listSessions(undefined, undefined, 10, { categoryId: null })
    expect(none).toHaveLength(10)
    expect(none.every(row => row.id.startsWith('none-'))).toBe(true)
    expect(listSessions(undefined, undefined, 10, { includeSessionIds: ['work-24'] }).map(row => row.id)).toEqual(['work-24'])
    expect(listSessions(undefined, undefined, 10, { includeSessionIds: [] })).toEqual([])
    expect(countSessions(undefined, undefined, options)).toBe(24)
    expect(countSessions(undefined, undefined, { ...options, offset: 20 })).toBe(24)
    expect(countSessions(undefined, undefined, { categoryId: null })).toBe(25)
    expect(countSessions(undefined, undefined, { includeSessionIds: ['work-24', 'missing'] })).toBe(1)
    expect(countSessions(undefined, undefined, { includeSessionIds: [] })).toBe(0)
    db.prepare("UPDATE sessions SET category_id = 999 WHERE id = 'work-00'").run()
    expect(countSessions(undefined, undefined, { categoryId: null })).toBe(26)
  })

  it('updates display-only message content without changing model context content', async () => {
    const {
      addMessage,
      createSession,
      getSessionDetail,
      updateMessageDisplayContent,
    } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'subagent-display', profile: 'default', source: 'cli', title: 'Subagent display' })
    const messageId = addMessage({
      session_id: 'subagent-display',
      role: 'tool',
      content: '{"status":"running"}',
      tool_call_id: 'delegate-call',
      tool_name: 'delegate_task',
      timestamp: 100,
    })!

    expect(updateMessageDisplayContent(
      'subagent-display',
      messageId,
      '{"status":"completed"}',
    )).toBe(true)
    expect(getSessionDetail('subagent-display')?.messages).toEqual([
      expect.objectContaining({
        id: messageId,
        content: '{"status":"running"}',
        display_content: '{"status":"completed"}',
      }),
    ])
  })
})
