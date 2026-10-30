import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Studio session generation identity', () => {
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

  it('stays stable across ordinary turns and changes on reset or recreation under the same id', async () => {
    const store: any = await import('../../packages/server/src/modules/studio/repositories/session-store')
    expect(typeof store.getSessionGeneration).toBe('function')
    store.createSession({ id: 's', source: 'cli' })
    const first = store.getSessionGeneration('s')
    expect(first).toEqual(expect.any(String))

    store.addMessage({ session_id: 's', role: 'user', content: 'hello' })
    store.addMessage({ session_id: 's', role: 'assistant', content: 'hi' })
    expect(store.getSessionGeneration('s')).toBe(first)

    store.clearSessionMessages('s')
    const afterReset = store.getSessionGeneration('s')
    expect(afterReset).not.toBe(first)

    store.deleteSession('s')
    expect(store.getSessionGeneration('s')).toBeNull()
    store.createSession({ id: 's', source: 'cli' })
    const recreated = store.getSessionGeneration('s')
    expect(recreated).not.toBe(first)
    expect(recreated).not.toBe(afterReset)
  })
})
