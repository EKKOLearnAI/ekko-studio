import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session pin persistence', () => {
  let db: DatabaseSync
  beforeEach(() => {
    vi.resetModules()
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, getStoragePath: () => ':memory:',
    }))
  })
  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })
  async function store() {
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    return import('../../packages/server/src/modules/studio/services/sessions/pins')
  }

  it('isolates users and profiles, preserving unrelated device changes', async () => {
    const s = await store()
    s.setSessionPin(1, 'default', 'a', true)
    s.setSessionPin(1, 'default', 'b', true)
    s.setSessionPin(2, 'default', 'other-user', true)
    s.setSessionPin(1, 'work', 'work-session', true)
    expect(s.setSessionPin(1, 'default', 'a', false)).toEqual(['b'])
    expect(s.listSessionPins(2, 'default')).toEqual(['other-user'])
    expect(s.listSessionPins(1, 'work')).toEqual(['work-session'])
    // Reinitializing schema must preserve saved pins.
    expect((await store()).listSessionPins(1, 'default')).toEqual(['b'])
  })

  it('imports old browsers idempotently without resurrecting remote unpins', async () => {
    const s = await store()
    s.migrateSessionPins(1, 'default', ['a', 'b', 'a'])
    s.setSessionPin(1, 'default', 'a', false)
    expect(s.migrateSessionPins(1, 'default', ['a', 'b', 'c'])).toEqual(['b', 'c'])
    expect(s.migrateSessionPins(1, 'default', ['a', 'b', 'c'])).toEqual(['b', 'c'])
    expect(s.setSessionPin(1, 'default', 'a', true)).toContain('a')
  })

  it('rejects invalid payloads before modifying storage', async () => {
    const s = await store()
    expect(() => s.setSessionPin(1, 'default', 'a', 'true')).toThrow(s.SessionPinValidationError)
    expect(() => s.setSessionPin(1, 'default', '', true)).toThrow(s.SessionPinValidationError)
    expect(() => s.migrateSessionPins(1, 'default', ['a', 123])).toThrow(s.SessionPinValidationError)
    expect(s.listSessionPins(1, 'default')).toEqual([])
  })
})
