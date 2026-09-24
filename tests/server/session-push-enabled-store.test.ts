import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session push setting store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
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

  it('defaults new sessions to pushed and persists explicit changes', async () => {
    const { createSession, getSession, setSessionPushEnabled } = await import(
      '../../packages/server/src/modules/studio/repositories/session-store'
    )

    createSession({ id: 'session-1' })
    expect(getSession('session-1')?.push_enabled).toBe(1)

    expect(setSessionPushEnabled('session-1', true)).toBe(true)
    expect(getSession('session-1')?.push_enabled).toBe(1)

    expect(setSessionPushEnabled('session-1', false)).toBe(true)
    expect(getSession('session-1')?.push_enabled).toBe(0)
  })
  it('preserves explicit false and zero across schema initialization and module reload', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
    store.createSession({ id: 'disabled-false', push_enabled: false })
    store.createSession({ id: 'disabled-zero', push_enabled: 0 })
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    vi.resetModules()
    const reloaded = await import('../../packages/server/src/modules/studio/repositories/session-store')
    expect(reloaded.getSession('disabled-false')?.push_enabled).toBe(0)
    expect(reloaded.getSession('disabled-zero')?.push_enabled).toBe(0)
    reloaded.createSession({ id: 'new-after-upgrade' })
    expect(reloaded.getSession('new-after-upgrade')?.push_enabled).toBe(1)
  })

})
