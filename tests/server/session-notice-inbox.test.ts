import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

// Passive session notice inbox on real SQLite storage: generation fencing, idempotency, silence,
// History paging and re-authorized live publication.
const ROOT = '../../packages/server/src/modules/studio'

let db: DatabaseSync
let m: any

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('AUTH_JWT_SECRET', 'inbox-test-secret')
  db = new DatabaseSync(':memory:')
  vi.doMock(`${ROOT}/infrastructure/database/index`, () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
  const { initAllHermesTables } = await import(`${ROOT}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    store: await import(`${ROOT}/repositories/session-store`),
    inbox: await import(`${ROOT}/repositories/session-notification-store`),
    presentation: await import(`${ROOT}/services/session-notifications/presentation`),
    users: await import(`${ROOT}/repositories/users-store`),
  }
  m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
})

afterEach(() => {
  db.close()
  vi.unstubAllEnvs()
  vi.doUnmock(`${ROOT}/infrastructure/database/index`)
})

function accept(overrides: Record<string, unknown> = {}) {
  return m.inbox.acceptFencedSessionNotification({
    namespace: 'inst-1', profile: 'default', producerKey: 'script-report:k1', sessionId: 'chat-1',
    expectedGeneration: m.store.getSessionGeneration('chat-1'), kind: 'script_report', disposition: 'notified',
    payload: { job_id: 'job1', job_name: 'Digest', invocation_id: 'i1', outcome: 'output', content: 'hello' }, ...overrides,
  })
}
const attention = () => db.prepare("SELECT COUNT(*) AS n FROM session_attention_events WHERE event_key LIKE 'session-notice:%'").get() as any

describe('session generation', () => {
  it('is stable across reads, rotated by a history reset and new for a recreated session', () => {
    const first = m.store.getSessionGeneration('chat-1')
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(m.store.getSessionGeneration('chat-1')).toBe(first)
    m.store.clearSessionMessages('chat-1')
    const reset = m.store.getSessionGeneration('chat-1')
    expect(reset).not.toBe(first)
    m.store.deleteSession('chat-1')
    expect(m.store.getSessionGeneration('chat-1')).toBeNull()
    m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
    expect([first, reset]).not.toContain(m.store.getSessionGeneration('chat-1'))
  })
})

describe('passive notice inbox', () => {
  it('accepts once with attention; an identical replay is a duplicate with no new attention', () => {
    const first = accept()
    expect(first.status).toBe('accepted')
    expect(first.record).toMatchObject({ disposition: 'notified', attention_pending: 1 })
    expect(accept().status).toBe('duplicate')
    expect(attention().n).toBe(1)
    expect(m.inbox.listVisibleSessionNotifications('chat-1')).toHaveLength(1)
  })

  it('rejects different content under the same key without overwriting', () => {
    accept()
    expect(accept({ payload: { content: 'tampered' } }).status).toBe('conflict')
    expect(accept({ disposition: 'unknown' }).status).toBe('conflict')
    expect(m.inbox.listVisibleSessionNotifications('chat-1')[0].payload.content).toBe('hello')
  })

  it('records silence without attention and never shows it', () => {
    expect(accept({ producerKey: 'script-report:s', disposition: 'silent' }).record.attention_pending).toBe(0)
    expect(attention().n).toBe(0)
    expect(m.inbox.listVisibleSessionNotifications('chat-1')).toEqual([])
  })

  it('fences the frozen generation across reset, delete and same-id recreation, and never reroutes', () => {
    const frozen = m.store.getSessionGeneration('chat-1')
    accept()
    m.store.clearSessionMessages('chat-1')
    expect(attention().n).toBe(0)
    expect(m.inbox.listVisibleSessionNotifications('chat-1')).toEqual([])
    expect(accept({ producerKey: 'script-report:k2', expectedGeneration: frozen }).status).toBe('generation_mismatch')
    // An old receipt never reports delivery after a reset: the generation is checked first.
    expect(accept({ expectedGeneration: frozen }).status).toBe('generation_mismatch')
    m.store.deleteSession('chat-1')
    m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli' })
    expect(accept({ producerKey: 'script-report:k3', expectedGeneration: frozen }).status).toBe('generation_mismatch')
    expect(accept({ producerKey: 'script-report:k4', profile: 'other' }).status).toBe('generation_mismatch')
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_notifications').get()).toEqual({ n: 1 })
  })

  it('places every notice on exactly one History page and keeps stored-row offsets', () => {
    for (let i = 1; i <= 10; i++) m.store.addMessage({ session_id: 'chat-1', role: 'user', content: `m${i}`, timestamp: i * 10 })
    const at = (ts: number, key: string) => accept({ producerKey: key, now: ts * 1000 })
    at(55, 'a'); at(50, 'b'); at(5, 'c'); at(200, 'd')
    const page = (offset: number, limit: number) => {
      const stored = db.prepare('SELECT * FROM messages WHERE session_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all('chat-1', limit, offset) as any[]
      return m.presentation.withSessionNotices('chat-1', stored.reverse(), { offset, storedCount: stored.length })
    }
    const pages = [page(0, 5), page(5, 5)]
    const notices = pages.flat().filter((row: any) => row.studio_notice).map((row: any) => row.timestamp).sort((a: number, b: number) => a - b)
    expect(notices).toEqual([5, 50, 55, 200])
    expect(pages.map(rows => rows.filter((row: any) => !row.studio_notice).length)).toEqual([5, 5])
    expect(pages[1].some((row: any) => row.timestamp === 50 && row.studio_notice)).toBe(true) // equal timestamp: older page
  })
})

describe('live notice publication', () => {
  async function publisher() {
    const { ChatRunSocket } = await import(`${ROOT}/sockets/chat-run`)
    const member = m.users.createUser({ username: 'member', password: 'password-1', role: 'admin', status: 'active', profiles: ['default'] })
    const outsider = m.users.createUser({ username: 'outsider', password: 'password-1', role: 'admin', status: 'active', profiles: ['other'] })
    const sent: string[] = []
    const socket = (id: string, data: any) => ({ id, data, emit: (event: string) => sent.push(`${id}:${event}`) })
    const sockets = new Map<string, any>([
      ['member', socket('member', { user: { id: member.id } })],
      ['outsider', socket('outsider', { user: { id: outsider.id } })],
      ['anonymous', socket('anonymous', {})],
    ])
    const stateSync = { publish: vi.fn() }
    const fake = Object.create(ChatRunSocket.prototype)
    Object.assign(fake, { nsp: { sockets, adapter: { rooms: new Map([['session:chat-1', new Set(['outsider', 'anonymous'])], ['studio-account', new Set(['member', 'outsider'])]]) } }, sessionStateSync: stateSync })
    return { fake, sent, stateSync, member }
  }

  it('reaches only accounts that may read the session now, and nobody once the generation is stale', async () => {
    const { fake, sent, stateSync, member } = await publisher()
    const { record } = accept()
    fake.publishSessionNotice(record)
    expect(sent).toEqual(['member:session.notice'])
    expect(stateSync.publish).toHaveBeenCalledWith('chat-1')
    m.users.updateUser({ userId: member.id, status: 'disabled' })
    sent.length = 0
    fake.publishSessionNotice(record)
    expect(sent).toEqual([])
    m.users.updateUser({ userId: member.id, status: 'active' })
    m.store.clearSessionMessages('chat-1')
    fake.publishSessionNotice(record)
    expect(sent).toEqual([])
  })
})
