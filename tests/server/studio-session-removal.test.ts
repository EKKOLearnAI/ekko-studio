import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginEventStore } from '../../packages/server/src/modules/studio/repositories/plugin-event-store'
import { PluginConsumerStore } from '../../packages/server/src/modules/studio/repositories/plugin-consumer-store'

const native = vi.hoisted(() => ({ inspect: vi.fn(), remove: vi.fn(), stop: vi.fn() }))
vi.mock('../../packages/server/src/modules/studio/public/session-agent-runtime', () => ({
  getExactHermesSessionDetailForProfile: native.inspect,
  deleteHermesSessionForProfile: native.remove,
  stopCodingAgentSessionRun: native.stop,
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({ listProfileNamesFromDisk: () => ['default', 'other'] }))
vi.mock('../../packages/server/src/modules/studio/public/agent-status-registry', () => ({ isHermesAgentAvailable: () => true }))

let db: DatabaseSync
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
let service: typeof import('../../packages/server/src/modules/studio/services/sessions/removal')
let createContext: typeof import('../../packages/server/src/modules/studio/services/context/execution').createExecutionContext
let StudioError: typeof import('../../packages/studio-plugin-sdk/src').StudioError
let received: unknown[], unsubscribe: () => void
let configureHook: typeof import('../../packages/server/src/modules/studio/services/sessions/removal-hook').configureSessionRemovalHook

beforeEach(async () => {
  vi.resetModules()
  native.inspect.mockReset().mockResolvedValue(null)
  native.remove.mockReset().mockResolvedValue(true)
  native.stop.mockReset()
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  service = await import('../../packages/server/src/modules/studio/services/sessions/removal')
  ;({ configureSessionRemovalHook: configureHook } = await import('../../packages/server/src/modules/studio/services/sessions/removal-hook'))
  ;({ createExecutionContext: createContext } = await import('../../packages/server/src/modules/studio/services/context/execution'))
  ;({ StudioError } = await import('../../packages/studio-plugin-sdk/src'))
  received = []
  const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
  unsubscribe = businessEvents.subscribe('removal-test', event => { received.push(event) })
})
afterEach(() => { unsubscribe(); db.close(); vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index') })

const allowed = { authorize: async () => {} }
function seed(id = 'session', source = 'coding_agent', profile = 'default') {
  sessions.createSession({ id, profile, source, user_id: '1' })
  sessions.addMessage({ session_id: id, role: 'user', content: 'preserved on failure' })
  db.prepare('INSERT INTO workspace_run_changes (change_id, session_id, created_at) VALUES (?, ?, 1)').run(id, id)
  db.prepare('INSERT INTO workspace_run_change_files (change_id, session_id, path, created_at) VALUES (?, ?, ?, 1)').run(id, id, 'test.txt')
}
function context(controller = new AbortController(), authorize = vi.fn(async () => {})) {
  return createContext({ scopeId: 'scope', principal: { kind: 'user', id: '1' }, profileId: 'default', sessionId: 'session', surface: 'api', traceId: 'trace' },
    controller.signal, { info() {}, warn() {}, error() {} }, {
      authorize, agents: { list: async () => [] }, sessions: {
        get: async () => null,
        remove: (scope, id, signal) => service.removeStudioSession({ id, profileId: scope.profileId }, {
          signal, sessionId: scope.sessionId, authorize: async () => authorize(),
        }),
      },
    })
}

describe('shared session removal use case', () => {
  it('rejects a deletion hook before native or local side effects and rechecks permission after hooks', async () => {
    seed()
    const scope = { scopeId: 'scope', traceId: 'trace', profileId: 'default', principal: { kind: 'user' as const, id: '1' }, surface: 'api' as const }
    const hook = vi.fn(async input => {
      expect(input).toMatchObject({ scope, profileId: 'default', sessionId: 'session' })
      throw new StudioError('FORBIDDEN', 'Hook rejected deletion')
    })
    const dispose = configureHook(hook)
    await expect(service.removeStudioSession({ id: 'session' }, { ...allowed, scope: () => scope })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(native.stop).not.toHaveBeenCalled(); expect(native.inspect).not.toHaveBeenCalled(); expect(sessions.getSession('session')).not.toBeNull()
    expect(received).toEqual([]); await dispose()
    let permitted = true
    const revoke = configureHook(async () => { permitted = false })
    await expect(service.removeStudioSession({ id: 'session' }, { scope: () => scope, authorize: async () => { if (!permitted) throw new StudioError('FORBIDDEN', 'Revoked') } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(native.stop).not.toHaveBeenCalled(); expect(sessions.getSession('session')).not.toBeNull(); await revoke()
  })

  it('checks cancellation and the target again after a deletion hook waits', async () => {
    seed()
    const controller = new AbortController(), dispose = configureHook(async () => { controller.abort() })
    await expect(service.removeStudioSession({ id: 'session' }, { ...allowed, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(native.stop).not.toHaveBeenCalled(); await dispose()
    const move = configureHook(async () => { db.prepare("UPDATE sessions SET profile='other' WHERE id='session'").run() })
    await expect(service.removeStudioSession({ id: 'session', profileId: 'default' }, allowed)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(sessions.getSession('session')?.profile).toBe('other'); expect(native.stop).not.toHaveBeenCalled(); await move()
  })

  it('removes local records transactionally and publishes one event across concurrent callers', async () => {
    seed()
    const [first, second] = await Promise.all([context().sessions.remove('session'), service.removeStudioSession({ id: 'session' }, allowed)])
    expect([first.deleted, second.deleted].sort()).toEqual([false, true])
    for (const result of [first, second]) expect(result.native).toEqual({ attempted: false, deleted: false, profileId: 'default' })
    expect(sessions.getSession('session')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_run_changes').get()).toMatchObject({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_run_change_files').get()).toMatchObject({ n: 0 })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: 'chat.session.removed', payload: { reason: 'deleted', owner_user_id: 1 } })
    const events = new PluginEventStore(db), committed = events.read('default')
    expect(committed).toHaveLength(1)
    expect(committed[0].event).toMatchObject({ id: (received[0] as { id: string }).id, type: 'session.deleted', data: { sessionId: 'session' } })
    expect(events.owner(committed[0].event.id)).toBe('1')
    expect(native.stop).toHaveBeenCalledOnce()
  })

  it('rolls back session, messages and workspace records when local deletion fails', async () => {
    seed()
    db.exec("CREATE TRIGGER deny_removal BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
    await expect(context().sessions.remove('session')).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(sessions.getSession('session')).not.toBeNull()
    expect(sessions.getSessionDetail('session')?.messages).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_run_changes').get()).toMatchObject({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_run_change_files').get()).toMatchObject({ n: 1 })
    expect(received).toEqual([])
    expect(new PluginEventStore(db).read('default')).toEqual([])
  })

  it('rolls back local deletion when the public event cannot commit', async () => {
    seed(); const events = new PluginEventStore(db)
    db.exec("CREATE TRIGGER deny_event BEFORE INSERT ON studio_plugin_events BEGIN SELECT RAISE(ABORT, 'event failure'); END")
    await expect(context().sessions.remove('session')).rejects.toMatchObject({ code: 'INTERNAL' })
    expect(sessions.getSessionDetail('session')?.messages).toHaveLength(1)
    expect(events.read('default')).toEqual([]); expect(received).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_plugin_event_owners').get()).toMatchObject({ n: 0 })
  })

  it('replays a committed deletion even when the process never publishes its notification', () => {
    seed()
    expect(sessions.deleteSession('session')).toBe(true)
    expect(received).toEqual([])
    const restarted = new PluginConsumerStore(db)
    const record = restarted.register({ pluginId: 'test.consumer', profileId: 'default', ownerId: '1', name: 'deletions' }, { types: ['session.deleted'], start: 'earliest', resume: 'continue' })
    restarted.fill(record.id)
    const delivery = restarted.claim(record.id, Date.now())!
    expect(delivery.event).toMatchObject({ type: 'session.deleted', subject: { sessionId: 'session' } })
    expect(restarted.events.owner(delivery.event.id)).toBe('1')
    expect(JSON.stringify(delivery.event)).not.toContain('owner')
  })

  it('does not associate imported gateway identities with a Studio event owner', () => {
    seed('session', 'cli')
    expect(sessions.deleteSession('session')).toBe(true)
    const events = new PluginEventStore(db), event = events.read('default')[0].event
    expect(events.owner(event.id)).toBeNull()
  })

  it('removes native-only history without touching a same-ID local session in another profile', async () => {
    seed('session', 'coding_agent', 'other')
    native.inspect.mockResolvedValue({ id: 'session' })
    const result = await service.removeStudioSession({ id: 'session', profileId: 'default' }, allowed)
    expect(result).toEqual({ deleted: false, native: { attempted: true, deleted: true, profileId: 'default' } })
    expect(native.remove).toHaveBeenCalledWith('session', 'default')
    expect(native.stop).not.toHaveBeenCalled()
    expect(sessions.getSession('session')?.profile).toBe('other')
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_run_changes').get()).toMatchObject({ n: 1 })
    expect(received).toEqual([])
  })

  it('reports native failure while preserving the established local deletion policy', async () => {
    seed('session', 'cli')
    native.inspect.mockResolvedValue({ id: 'session' })
    native.remove.mockRejectedValue(new Error('private native path'))
    expect(await context().sessions.remove('session')).toEqual({ deleted: true,
      native: { attempted: true, deleted: false, profileId: 'default', error: 'Failed to delete Hermes session' } })
    expect(sessions.getSession('session')).toBeNull()
    expect(received).toHaveLength(1)
  })

  it('rejects denied profiles, foreign session IDs and cancelled scopes before side effects', async () => {
    seed()
    const denied = { authorize: () => { throw new StudioError('FORBIDDEN', 'Profile denied') } }
    await expect(service.removeStudioSession({ id: 'session' }, denied)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(context().sessions.remove('other')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const controller = new AbortController(); controller.abort()
    await expect(context(controller).sessions.remove('session')).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(sessions.getSession('session')).not.toBeNull()
    expect(native.inspect).not.toHaveBeenCalled()
    expect(native.stop).not.toHaveBeenCalled()
    expect(received).toEqual([])
  })

  it.each(['cancel', 'revoke'])('rechecks %s after native inspection before beginning mutation', async action => {
    seed('session', 'cli')
    const controller = new AbortController()
    const authorize = vi.fn(async () => {})
    native.inspect.mockImplementation(async () => {
      if (action === 'cancel') controller.abort()
      else authorize.mockRejectedValue(new StudioError('FORBIDDEN', 'Revoked'))
      return { id: 'session' }
    })
    await expect(context(controller, authorize).sessions.remove('session')).rejects.toMatchObject({ code: action === 'cancel' ? 'CANCELLED' : 'FORBIDDEN' })
    expect(native.remove).not.toHaveBeenCalled()
    expect(sessions.getSession('session')).not.toBeNull()
    expect(received).toEqual([])
  })

  it('finishes cleanup and reports committed success when cancellation arrives after mutation starts', async () => {
    seed('session', 'cli')
    const controller = new AbortController()
    native.inspect.mockResolvedValue({ id: 'session' })
    native.remove.mockImplementation(async () => { controller.abort(); return true })
    await expect(context(controller).sessions.remove('session')).resolves.toMatchObject({ deleted: true, native: { deleted: true } })
    expect(sessions.getSession('session')).toBeNull()
    expect(received).toHaveLength(1)
  })

  it('rejects a session moved to another profile while inspecting native history', async () => {
    seed('session', 'cli')
    native.inspect.mockImplementation(async () => {
      db.prepare("UPDATE sessions SET profile = 'other' WHERE id = 'session'").run()
      return { id: 'session' }
    })
    await expect(service.removeStudioSession({ id: 'session', profileId: 'default' }, allowed)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(native.remove).not.toHaveBeenCalled()
    expect(sessions.getSession('session')?.profile).toBe('other')
    expect(received).toEqual([])
  })
})
