import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { io as connect, type Socket } from 'socket.io-client'

const state = vi.hoisted(() => ({ db: null as DatabaseSync | null, busy: new Set<string>(), revoked: new Set<string>() }))
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({ getDb: () => state.db }))
vi.mock('../../packages/server/src/modules/studio/public/chat-run', () => ({ getChatRunServer: () => ({ isSessionRunning: (id: string) => state.busy.has(id) }) }))
vi.mock('../../packages/server/src/modules/studio/public/auth', () => ({ authenticateUserToken: async (token: string) =>
  /^user[12]$/.test(token) && !state.revoked.has(token) ? { id: Number(token.slice(-1)), status: 'active' } : null }))
import { initPersonTables } from '../../packages/server/src/modules/studio/infrastructure/database/person-schema'
import { personLastActivity, touchPersonActivity, recordPersonOutcome } from '../../packages/server/src/modules/studio/repositories/person-presence-store'
import { getPersonExecution, setPersonExecution } from '../../packages/server/src/modules/studio/repositories/person-store'
import { clearPersonPresenceRuntime, observePersonPresenceEvent, personPresenceSnapshot, PERSON_SLEEP_AFTER_MS } from '../../packages/server/src/modules/studio/services/person/presence'
import { PersonPresenceSocketServer } from '../../packages/server/src/modules/studio/sockets/person-presence'

beforeEach(() => {
  state.db = new DatabaseSync(':memory:'); state.busy.clear(); state.revoked.clear(); clearPersonPresenceRuntime()
  state.db.exec('CREATE TABLE session_tasks(id TEXT PRIMARY KEY,owner_user_id INTEGER,bot_id TEXT,updated_at INTEGER)')
  initPersonTables(state.db)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); clearPersonPresenceRuntime(); state.db?.close(); state.db = null })

function execution(id: string, owner: number, status: string) {
  state.db!.prepare('INSERT INTO session_tasks VALUES (?,?,?,0)').run(id, owner, `person:${owner}`)
  state.db!.prepare(`INSERT INTO person_executions(id,task_id,owner_user_id,requirements_revision,state,session_id,selection_json,created_at,updated_at)
    VALUES (?,?,?,0,?,?,'{}',0,0)`).run(id, id, owner, status, `person-task-${id}`)
}

describe('Person account presence', () => {
  it('counts all account background tasks once, including queued/waiting work and pending reports', () => {
    for (let i = 0; i < 30; i++) execution(`finished${i}`, 1, 'finished')
    for (const status of ['queued', 'starting', 'running', 'stopping', 'waiting_person', 'waiting_user', 'waiting_approval']) execution(status, 1, status)
    execution('other-account', 2, 'running')
    execution('pending-report', 1, 'finished')
    execution('reported', 1, 'finished')
    for (const [id, status] of [['pending-report', 'pending'], ['reported', 'delivered']]) {
      state.db!.prepare('INSERT INTO person_deliveries(execution_id,owner_user_id,origin_json,state,updated_at) VALUES (?,1,?,?,0)').run(id, '{}', status)
    }
    state.db!.prepare("INSERT INTO person_executions(id,task_id,owner_user_id,requirements_revision,state,session_id,selection_json,created_at,updated_at) VALUES ('previous-running','running',1,0,'finished','previous','{}',0,0)").run()
    state.db!.prepare("INSERT INTO person_deliveries(execution_id,owner_user_id,origin_json,state,updated_at) VALUES ('previous-running',1,'{}','pending',0)").run()
    recordPersonOutcome(1, 'feedback', 'done')
    expect(personPresenceSnapshot(1)).toMatchObject({ state: 'done', backgroundTaskCount: 8 })
    expect(personPresenceSnapshot(2).backgroundTaskCount).toBe(1)
    state.db!.prepare("UPDATE person_executions SET state='finished' WHERE owner_user_id=1").run()
    state.db!.prepare("UPDATE person_deliveries SET state='delivered' WHERE execution_id='previous-running'").run()
    state.db!.prepare("UPDATE person_deliveries SET state='queued' WHERE execution_id='pending-report'").run()
    expect(personPresenceSnapshot(1).backgroundTaskCount).toBe(1)
    state.db!.prepare("UPDATE person_deliveries SET state='delivered' WHERE owner_user_id=1").run()
    expect(personPresenceSnapshot(1).backgroundTaskCount).toBe(0)
  })

  it('sleeps exactly ten minutes after server-recorded interaction; reads and restart do not wake it', () => {
    const now = 1_000_000
    expect(personPresenceSnapshot(1, now).state).toBe('idle')
    expect(personPresenceSnapshot(1, now + PERSON_SLEEP_AFTER_MS - 1).state).toBe('idle')
    clearPersonPresenceRuntime()
    expect(personPresenceSnapshot(1, now + PERSON_SLEEP_AFTER_MS).state).toBe('sleeping')
    expect(personLastActivity(1, now + PERSON_SLEEP_AFTER_MS)).toBe(now)
    touchPersonActivity(1, now + PERSON_SLEEP_AFTER_MS + 1)
    touchPersonActivity(1, now) // Never let an older write move the deadline backwards.
    expect(personPresenceSnapshot(1, now + PERSON_SLEEP_AFTER_MS + 1).state).toBe('idle')
  })

  it.each(['queued', 'waiting_person', 'waiting_user', 'waiting_approval', 'finished', 'failed', 'interrupted'])('does not animate %s tasks as executing work', status => {
    execution('task', 1, status)
    expect(personPresenceSnapshot(1, 1000).state).toBe('idle')
    expect(personPresenceSnapshot(1, 1000 + PERSON_SLEEP_AFTER_MS).state).toBe('sleeping')
  })

  it.each(['starting', 'running', 'stopping'])('keeps %s work awake and finds it beyond any task-list pagination', status => {
    for (let i = 0; i < 30; i++) execution(`old${i}`, 1, 'finished')
    execution('active', 1, status)
    personPresenceSnapshot(1, 1000)
    expect(personPresenceSnapshot(1, 1000 + PERSON_SLEEP_AFTER_MS).state).toBe('searching')
    expect(personPresenceSnapshot(2, 1000).state).toBe('idle')
    state.db!.prepare("UPDATE person_executions SET state='finished' WHERE id='active'").run()
    expect(personPresenceSnapshot(1, 1000 + PERSON_SLEEP_AFTER_MS).state).toBe('sleeping')
  })

  it('tracks concurrent tools and waiting questions without confusing stale runs or other accounts', () => {
    state.busy.add('person-main-1')
    const emit = (event: string, payload = {}) => observePersonPresenceEvent('person-main-1', event, { run_id: 'new', ...payload })
    emit('run.started')
    expect(personPresenceSnapshot(1).state).toBe('thinking')
    emit('tool.started', { tool_call_id: 'a' }); emit('tool.started', { tool_call_id: 'b' })
    emit('tool.completed', { tool_call_id: 'a' })
    emit('run.completed', { run_id: 'old' })
    expect(personPresenceSnapshot(1).state).toBe('searching')
    emit('clarify.requested', { clarify_id: 'q' })
    expect(personPresenceSnapshot(1).state).toBe('idle')
    emit('clarify.resolved', { clarify_id: 'q', stale: true })
    expect(personPresenceSnapshot(1).state).toBe('idle')
    emit('clarify.resolved', { clarify_id: 'q', resolved: true })
    expect(personPresenceSnapshot(1).state).toBe('searching')
    emit('tool.failed', { tool_call_id: 'b' })
    expect(personPresenceSnapshot(1).state).toBe('thinking')
    emit('clarify.requested', { clarify_id: 'timeout' })
    emit('clarify.resolved', { clarify_id: 'timeout', resolved: false, reason: 'timeout' })
    expect(personPresenceSnapshot(1).state).toBe('thinking')
    expect(personPresenceSnapshot(2).state).toBe('idle')
    emit('run.failed'); state.busy.clear()
    expect(personPresenceSnapshot(1).state).toBe('error')
    expect(personPresenceSnapshot(1, Date.now() + 3000).state).toBe('idle')
  })

  it('plays main completion once, preserves its deadline across runtime restart and resumes current work', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    touchPersonActivity(1)
    observePersonPresenceEvent('person-main-1', 'run.started', { run_id: 'one' })
    observePersonPresenceEvent('person-main-1', 'run.completed', { run_id: 'one' })
    expect(personPresenceSnapshot(1)).toMatchObject({ state: 'done', feedbackId: 'main:one', feedbackUntil: 3000, lastActivityAt: 1000 })
    clock.mockReturnValue(2000)
    observePersonPresenceEvent('person-main-1', 'run.completed', { run_id: 'one' })
    clearPersonPresenceRuntime()
    expect(personPresenceSnapshot(1).feedbackUntil).toBe(3000)
    state.busy.add('person-main-1')
    observePersonPresenceEvent('person-main-1', 'run.started', { run_id: 'two' })
    observePersonPresenceEvent('person-main-1', 'run.failed', { run_id: 'one' })
    expect(personPresenceSnapshot(1).state).toBe('done')
    clock.mockReturnValue(3000)
    expect(personPresenceSnapshot(1).state).toBe('thinking')
    observePersonPresenceEvent('person-main-1', 'abort.completed', { run_id: 'two' })
    state.busy.clear()
    expect(personPresenceSnapshot(1).state).toBe('idle')
  })

  it('only records committed terminal task transitions; newest feedback wins without waking an idle account', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    touchPersonActivity(1)
    execution('one', 1, 'running'); execution('two', 1, 'running'); execution('stopped', 1, 'stopping')
    clock.mockReturnValue(700000)
    const first = getPersonExecution(1, 'one')
    expect(setPersonExecution(first, 'finished')).toBe(true)
    expect(personPresenceSnapshot(1)).toMatchObject({ state: 'done', feedbackUntil: 702000, lastActivityAt: 1000 })
    expect(setPersonExecution(first, 'finished')).toBe(false)
    expect(setPersonExecution(getPersonExecution(1, 'stopped'), 'finished')).toBe(false)
    clock.mockReturnValue(700500)
    expect(setPersonExecution(getPersonExecution(1, 'two'), 'failed')).toBe(true)
    expect(personPresenceSnapshot(1)).toMatchObject({ state: 'error', feedbackId: 'task:two', feedbackUntil: 703500 })
    expect(personPresenceSnapshot(2).state).toBe('idle')
    clock.mockReturnValue(703499)
    expect(personPresenceSnapshot(1).state).toBe('error')
    clock.mockReturnValue(703500)
    expect(personPresenceSnapshot(1).state).toBe('searching') // Stopping work is still executing.
    state.db!.prepare("UPDATE person_executions SET state='interrupted' WHERE id='stopped'").run()
    expect(personPresenceSnapshot(1).state).toBe('sleeping')
  })

  it('does not extend the same outcome when it is delivered again after expiry', () => {
    touchPersonActivity(1, 1000)
    recordPersonOutcome(1, 'task:once', 'done', 1000)
    recordPersonOutcome(1, 'task:once', 'done', 4000)
    expect(personPresenceSnapshot(1, 4000).state).toBe('idle')
  })
})

it('synchronizes two real Socket.IO devices across Profiles, isolates accounts, and restores sleep on reconnect', async () => {
  const http = createServer()
  const io = new Server(http)
  const presence = new PersonPresenceSocketServer(io)
  presence.init()
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const port = (http.address() as { port: number }).port
  const clients: Socket[] = []
  const snapshots = new Map<Socket, any>()
  async function device(token: string, profile: string) {
    const socket = connect(`http://127.0.0.1:${port}/person-presence`, { auth: { token }, query: { profile }, transports: ['websocket'], forceNew: true, reconnection: false })
    clients.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.on('person.presence', snapshot => { snapshots.set(socket, snapshot); resolve() })
      socket.on('connect_error', reject)
    })
    return socket
  }
  try {
    const a = await device('user1', 'default')
    const b = await device('user1', 'research')
    const other = await device('user2', 'default')
    expect(snapshots.get(a)).toEqual(snapshots.get(b))
    const asleepAt = Date.now() - PERSON_SLEEP_AFTER_MS - 100
    state.db!.prepare('UPDATE person_presence SET last_activity_at=? WHERE user_id=1').run(asleepAt)
    await (presence as any).refresh()
    await vi.waitFor(() => expect(snapshots.get(b).state).toBe('sleeping'))
    expect(snapshots.get(other).state).toBe('idle')
    b.disconnect()
    const reconnect = await device('user1', 'different-profile')
    expect(snapshots.get(reconnect).state).toBe('sleeping')
    expect(snapshots.get(reconnect).lastActivityAt).toBe(asleepAt)
    a.emit('person.activity', { userId: 2, timestamp: Number.MAX_SAFE_INTEGER, state: 'searching' })
    await vi.waitFor(() => expect(snapshots.get(reconnect).state).toBe('idle'))
    expect(snapshots.get(a)).toEqual(snapshots.get(reconnect))
    expect(snapshots.get(a).lastActivityAt).toBeLessThanOrEqual(Date.now())
    expect(snapshots.get(other).lastActivityAt).not.toBe(snapshots.get(a).lastActivityAt)
    execution('running', 1, 'running')
    await (presence as any).refresh()
    await vi.waitFor(() => expect(snapshots.get(reconnect).state).toBe('searching'))
    expect(snapshots.get(reconnect).backgroundTaskCount).toBe(1)
    expect(snapshots.get(other).backgroundTaskCount).toBe(0)
    expect(snapshots.get(other).state).toBe('idle')
    setPersonExecution(getPersonExecution(1, 'running'), 'finished')
    await vi.waitFor(() => expect(snapshots.get(reconnect).state).toBe('done'))
    expect(snapshots.get(reconnect).backgroundTaskCount).toBe(0)
    expect(snapshots.get(a)).toEqual(snapshots.get(reconnect))
    const outcomeReconnect = await device('user1', 'yet-another-profile')
    expect(snapshots.get(outcomeReconnect).feedbackUntil).toBe(snapshots.get(a).feedbackUntil)
    expect(snapshots.get(other).state).toBe('idle')
    await vi.waitFor(() => expect(snapshots.get(outcomeReconnect).state).toBe('idle'), { timeout: 3500 })
    expect(snapshots.get(a).state).toBe('idle')
    state.revoked.add('user1')
    await (presence as any).refresh()
    await vi.waitFor(() => expect(a.connected).toBe(false))
    await expect(device('invalid', 'default')).rejects.toThrow('Studio login is required')
  } finally {
    clients.forEach(socket => socket.disconnect())
    presence.close()
    await new Promise<void>(resolve => io.close(() => resolve()))
  }
})
