import './fixtures/isolated-studio-state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('session notification ledger for terminal completions', () => {
  let db: any
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:',
    }))
  })
  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  const input = (producerKey: string, namespace = 'studio-a') => ({
    namespace, profile: 'default', producerKey, sessionId: 's1', sessionGeneration: 'g1',
    kind: 'process_completion' as const, disposition: 'admitting' as const, payload: { process_id: 'proc_1', exit_code: 0 },
  })

  it('accepts a producer event once; a replay returns null and changes nothing', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-notification-store')
    const first = store.acceptSessionNotification(input('hermes-process:default:proc_1:1'))
    expect(first).toMatchObject({ session_generation: 'g1', kind: 'process_completion', disposition: 'admitting' })
    expect(store.transitionSessionNotification(first!.id, 'admitting', 'admitted')).toBe(true)

    expect(store.acceptSessionNotification({ ...input('hermes-process:default:proc_1:1'), disposition: 'owner_reset' })).toBeNull()
    expect(store.getSessionNotification('studio-a', 'default', 'hermes-process:default:proc_1:1')?.disposition).toBe('admitted')
    // A transition from a disposition another writer already left is refused.
    expect(store.transitionSessionNotification(first!.id, 'admitting', 'cancelled')).toBe(false)
  })

  it('settles admissions interrupted by a crash as unknown, only in its own namespace', async () => {
    const store = await import('../../packages/server/src/modules/studio/repositories/session-notification-store')
    const admitting = store.acceptSessionNotification(input('k-admitting'))!
    const admitted = store.acceptSessionNotification(input('k-admitted'))!
    store.transitionSessionNotification(admitted.id, 'admitting', 'admitted')
    const dispatched = store.acceptSessionNotification(input('k-dispatched'))!
    store.transitionSessionNotification(dispatched.id, 'admitting', 'admitted')
    store.transitionSessionNotification(dispatched.id, 'admitted', 'dispatched')
    const foreign = store.acceptSessionNotification(input('k-foreign', 'studio-b'))!

    expect(store.settleInterruptedProcessAdmissions('studio-a')).toBe(2)
    expect(store.getSessionNotificationById(admitting.id)?.disposition).toBe('unknown')
    expect(store.getSessionNotificationById(admitted.id)?.disposition).toBe('unknown')
    expect(store.getSessionNotificationById(dispatched.id)?.disposition).toBe('dispatched')
    expect(store.getSessionNotificationById(foreign.id)?.disposition).toBe('admitting')
    // A settled completion is never dispatched later: its final seam no longer finds it admitted.
    expect(store.transitionSessionNotification(admitted.id, 'admitted', 'dispatched')).toBe(false)
  })
})
