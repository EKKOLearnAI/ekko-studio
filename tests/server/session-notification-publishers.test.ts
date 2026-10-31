import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import Koa from 'koa'

// ekko-background-notification-auth: an unattended producer appends passive notices to exactly one
// Hermes chat with a hashed, scoped, expiring, revocable publisher grant the owner issued with a
// login token, through the production auth middleware, body parsers, routes and storage.
const ROOT = '../../packages/server/src/modules/studio'

let db: DatabaseSync
let server: Server
let origin: string
let m: any
const published: any[] = []
const users: Record<string, { id: number; token: string }> = {}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('AUTH_JWT_SECRET', 'notice-publisher-test-secret')
  db = new DatabaseSync(':memory:')
  vi.doMock(`${ROOT}/infrastructure/database/index`, () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => ':memory:' }))
  const { initAllHermesTables } = await import(`${ROOT}/infrastructure/database/schemas`)
  initAllHermesTables()
  m = {
    store: await import(`${ROOT}/repositories/session-store`),
    inbox: await import(`${ROOT}/repositories/session-notification-store`),
    presentation: await import(`${ROOT}/services/session-notifications/presentation`),
    state: await import(`${ROOT}/repositories/session-state-store`),
    usersStore: await import(`${ROOT}/repositories/users-store`),
    auth: await import(`${ROOT}/middleware/auth`),
  }
  for (const [name, role, profiles, status] of [
    ['admin', 'super_admin', [], 'active'], ['member', 'admin', ['default'], 'active'],
    ['outsider', 'admin', ['other'], 'active'], ['disabled', 'admin', ['default'], 'active'],
  ] as const) {
    const user = m.usersStore.createUser({ username: name, password: 'password-1', role, status, profiles: [...profiles] })
    users[name] = { id: user.id, token: await m.auth.issueUserJwt(user) }
  }
  m.usersStore.updateUser({ userId: users.disabled.id, status: 'disabled' })
  for (const [id, profile, source, agent, owner] of [
    ['chat-1', 'default', 'cli', '', null], ['chat-legacy', 'default', 'api_server', '', null], ['chat-other', 'other', 'cli', '', null],
    ['ekko-1', 'default', 'builtin_agent', 'ekko-agent', null], ['coding-1', 'default', 'coding_agent', 'codex', null],
    ['workflow-1', 'default', 'workflow', '', null], ['group-1', 'default', 'group_chat', '', null],
    ['global-1', 'default', 'global_agent', '', null], ['person-main-1', 'default', 'cli', '', users.member.id],
    ['person-task-1', 'default', 'cli', '', users.member.id],
  ] as const) {
    m.store.createSession({ id, profile, source, agent, studio_user_id: owner })
  }
  m.store.addMessage({ session_id: 'chat-1', role: 'user', content: 'Please keep me posted' })
  m.inbox.getSessionNotificationById(0) // creates the notification and attention tables
  published.length = 0
  const { setChatRunServer } = await import(`${ROOT}/public/chat-run`)
  // The real publisher is covered by chat-run-session-notice-recipients; any other call would fail the request.
  setChatRunServer({ publishSessionNotice: (record: any) => published.push(record) })
  const { createRequestBodyParser, createSessionNotificationRequestBodyParser } = await import(`${ROOT}/middleware/request-body-parser`)
  const { sessionRoutes } = await import(`${ROOT}/routes/sessions`)
  const { authPublicRoutes } = await import(`${ROOT}/routes/auth`)
  const app = new Koa()
  app.use(createSessionNotificationRequestBodyParser())
  app.use(createRequestBodyParser())
  app.use(authPublicRoutes.routes())
  app.use(m.auth.requireUserJwt)
  app.use(m.auth.resolveUserProfile)
  app.use(sessionRoutes.routes())
  server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  origin = `http://127.0.0.1:${(server.address() as any).port}`
}, 30_000)

afterEach(async () => {
  await new Promise(resolve => server.close(resolve))
  db.close()
  vi.unstubAllEnvs()
  vi.doUnmock(`${ROOT}/infrastructure/database/index`)
})

async function request(path: string, init: { method?: string; token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: init.method || 'GET',
    headers: {
      ...(init.body !== undefined || init.raw !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  })
  const text = await response.text()
  let body: any = text
  try { body = JSON.parse(text) } catch { /* plain text error */ }
  return { status: response.status, body }
}

async function generation(sessionId: string, token = users.admin.token, profile = 'default') {
  const result = await request(`/api/studio/sessions/${sessionId}?profile=${profile}`, { token })
  expect(result.status).toBe(200)
  return result.body.session.session_generation as string
}

function notice(expected: string, overrides: Record<string, unknown> = {}) {
  return { profile: 'default', expected_session_generation: expected, source: 'validator-review', event_id: 'review-1',
    title: 'Validation complete', content: 'All required checks passed.', ...overrides }
}

const post = (sessionId: string, body: unknown, token = users.admin.token, headers?: Record<string, string>) =>
  request(`/api/studio/sessions/${encodeURIComponent(sessionId)}/notifications`, { method: 'POST', token, body, headers })
const rows = () => db.prepare(`SELECT * FROM session_notifications WHERE kind='external' ORDER BY id`).all() as any[]
const attention = (sessionId = 'chat-1') => db.prepare(`SELECT COUNT(*) AS n FROM session_attention_events WHERE session_id=?`).get(sessionId) as any


const SOURCES = ['repo-puller', 'pr-review-cron', 'my-pr-status-watcher']
const publisherPath = (sessionId = 'chat-1') => `/api/studio/sessions/${encodeURIComponent(sessionId)}/notification-publishers`
const grants = () => db.prepare('SELECT * FROM session_notice_publishers ORDER BY created_at').all() as any[]

async function issue(overrides: Record<string, unknown> = {}, token = users.admin.token, sessionId = 'chat-1') {
  const expected = overrides.expected_session_generation ?? await generation(sessionId)
  return request(publisherPath(sessionId), { method: 'POST', token, headers: { 'x-hermes-profile': 'default' },
    body: { profile: 'default', expected_session_generation: expected, sources: SOURCES, label: 'background producers', ...overrides } })
}

async function grant(overrides: Record<string, unknown> = {}) {
  const issued = await issue(overrides)
  expect(issued.status).toBe(201)
  return { token: issued.body.token as string, publisher: issued.body.publisher, expected: issued.body.publisher.session_generation as string }
}

const publish = (token: string, expected: string, overrides: Record<string, unknown> = {}, sessionId = 'chat-1', headers: Record<string, string> = { 'x-hermes-profile': 'default' }) =>
  post(sessionId, notice(expected, { source: 'repo-puller', event_id: 'repo-puller:83803bcd619d:2026-10-31T20:00Z', ...overrides }), token, headers)

describe('notice publisher grants', () => {
  it('the owner issues a scoped grant with a login token; Studio stores only its hash and never returns it again', async () => {
    const issued = await issue()
    expect(issued.status).toBe(201)
    expect(issued.body.token).toMatch(/^esnp_[A-Za-z0-9_-]{43}$/)
    expect(issued.body.publisher).toMatchObject({ session_id: 'chat-1', profile: 'default', sources: SOURCES, revoked_at: null })
    expect(issued.body.publisher).not.toHaveProperty('token_hash')
    expect(issued.body.publisher.expires_at - issued.body.publisher.created_at).toBe(90 * 24 * 60 * 60_000)
    const [row] = grants()
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(row)).not.toContain(issued.body.token)
    expect(row.session_generation).toBe(m.store.getSessionGeneration('chat-1'))
    const listed = await request(publisherPath(), { token: users.admin.token, headers: { 'x-hermes-profile': 'default' } })
    expect(listed.status).toBe(200)
    expect(JSON.stringify(listed.body)).not.toContain(issued.body.token)
    expect(listed.body.publishers.map((p: any) => p.id)).toEqual([issued.body.publisher.id])
  })

  it('delivers a passive notice with a grant: persisted identity, published once, never a turn, idempotent retries', async () => {
    const { token, expected } = await grant()
    const messagesBefore = (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='chat-1'").get() as any).n
    const accepted = await publish(token, expected)
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ ok: true, session_id: 'chat-1', profile: 'default', session_generation: expected, duplicate: false })
    const [row] = rows()
    expect(row).toMatchObject({ kind: 'external', session_id: 'chat-1', profile: 'default', session_generation: expected })
    expect(JSON.parse(row.payload)).toMatchObject({ source: 'repo-puller', event_id: 'repo-puller:83803bcd619d:2026-10-31T20:00Z' })
    expect(published).toHaveLength(1)
    // Passive: no stored message, so nothing entered model history and no turn was queued.
    expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='chat-1'").get() as any).n).toBe(messagesBefore)
    // A retry of the same producer run is a duplicate with the original receipt and no further effects.
    const retry = await publish(token, expected)
    expect(retry.status).toBe(200)
    expect(retry.body).toEqual({ ...accepted.body, duplicate: true })
    expect(published).toHaveLength(1)
    expect(rows()).toHaveLength(1)
    // Both outcomes are notices; the failure of the next run is a separate event.
    expect((await publish(token, expected, { event_id: 'repo-puller:83803bcd619d:2026-10-31T21:00Z', title: 'repo-puller failed', content: 'exit 1' })).status).toBe(201)
    expect(published).toHaveLength(2)
    expect(grants()[0].last_used_at).toEqual(expect.any(Number))
  })

  it('refuses every request outside the grant and writes nothing', async () => {
    const { token, expected } = await grant()
    const other = await generation('chat-other', users.admin.token, 'other')
    const results = {
      otherSession: await publish(token, await generation('chat-legacy'), {}, 'chat-legacy'),
      otherProfile: await publish(token, other, { profile: 'other' }, 'chat-other', { 'x-hermes-profile': 'other' }),
      headerMismatch: await publish(token, expected, {}, 'chat-1', { 'x-hermes-profile': 'other' }),
      otherGeneration: await publish(token, 'not-the-granted-generation'),
      sourceNotAllowed: await publish(token, expected, { source: 'activation-check' }),
      malformed: await publish('esnp_not-a-real-grant', expected),
      unprefixed: await publish('not-a-token', expected),
      missing: await request('/api/studio/sessions/chat-1/notifications', { method: 'POST', body: notice(expected, { source: 'repo-puller' }) }),
      queryString: await request(`/api/studio/sessions/chat-1/notifications?token=${token}`, { method: 'POST', body: notice(expected, { source: 'repo-puller' }) }),
    }
    expect(Object.fromEntries(Object.entries(results).map(([name, r]) => [name, [r.status, r.body.error]]))).toEqual({
      otherSession: [403, 'publisher_scope_mismatch'],
      otherProfile: [403, 'publisher_scope_mismatch'],
      headerMismatch: [400, 'profile_mismatch'],
      otherGeneration: [403, 'publisher_scope_mismatch'],
      sourceNotAllowed: [403, 'publisher_source_not_allowed'],
      malformed: [401, 'publisher_token_invalid'],
      unprefixed: [401, expect.anything()],
      missing: [401, expect.anything()],
      queryString: [401, 'publisher_token_header_required'],
    })
    expect(rows()).toHaveLength(0)
    expect(published).toHaveLength(0)
  })

  it('a reset or delete-recreate of the session invalidates the grant', async () => {
    const { token, expected } = await grant()
    m.store.clearSessionMessages('chat-1')
    const afterReset = await publish(token, expected)
    expect([afterReset.status, afterReset.body.error]).toEqual([409, 'session_generation_mismatch'])
    // The grant is bound to the old generation: a caller cannot simply move it forward.
    const moved = await publish(token, await generation('chat-1'), { event_id: 'moved' })
    expect([moved.status, moved.body.error]).toEqual([403, 'publisher_scope_mismatch'])

    const second = await grant()
    m.store.deleteSession('chat-1')
    m.store.createSession({ id: 'chat-1', profile: 'default', source: 'cli', agent: '' })
    const recreated = await publish(second.token, second.expected, { event_id: 'after-recreate' })
    expect(recreated.status).toBe(409)
    expect(rows()).toHaveLength(0)
  })

  it('revoked and expired grants, and grants of a disabled or unauthorized owner, are refused', async () => {
    const first = await grant()
    const revoke = await request(`${publisherPath()}/${first.publisher.id}`, { method: 'DELETE', token: users.admin.token, headers: { 'x-hermes-profile': 'default' } })
    expect(revoke.status).toBe(200)
    expect((await publish(first.token, first.expected)).status).toBe(401)
    expect((await request(`${publisherPath()}/${first.publisher.id}`, { method: 'DELETE', token: users.admin.token, headers: { 'x-hermes-profile': 'default' } })).status).toBe(404)

    const expiring = await grant({ expires_in_days: 1 })
    db.prepare('UPDATE session_notice_publishers SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expiring.publisher.id)
    expect((await publish(expiring.token, expiring.expected)).body.error).toBe('publisher_token_invalid')

    const memberGrant = await issue({}, users.member.token)
    expect(memberGrant.status).toBe(201)
    m.usersStore.updateUser({ userId: users.member.id, status: 'disabled' })
    expect((await publish(memberGrant.body.token, memberGrant.body.publisher.session_generation)).status).toBe(401)
    m.usersStore.updateUser({ userId: users.member.id, status: 'active', profiles: ['other'] })
    expect((await publish(memberGrant.body.token, memberGrant.body.publisher.session_generation)).status).toBe(401)
    expect(rows()).toHaveLength(0)
  })

  it('a grant authenticates no other route, method or token class, and cannot issue or revoke grants', async () => {
    const { token, publisher } = await grant()
    const attempts = [
      await request('/api/studio/sessions/chat-1?profile=default', { token }),
      await request('/api/studio/sessions/conversations/chat-1/messages/paginated?profile=default', { token }),
      await request('/api/studio/sessions/chat-1/notifications', { method: 'GET', token }),
      await request(publisherPath(), { token, headers: { 'x-hermes-profile': 'default' } }),
      await issue({}, token),
      await request(`${publisherPath()}/${publisher.id}`, { method: 'DELETE', token, headers: { 'x-hermes-profile': 'default' } }),
      await request('/api/auth/users', { token }),
    ]
    expect(attempts.map(r => r.status)).toEqual([403, 403, 403, 403, 403, 403, 403])
    expect(attempts.every(r => r.body.error === 'publisher_token_route_not_allowed')).toBe(true)
    expect(grants()).toHaveLength(1)
  })

  it('issuance requires a login token with profile access, the current generation and a supported target', async () => {
    const expected = await generation('chat-1')
    const member = m.usersStore.findUserById(users.member.id)
    const results = {
      missing: await request(publisherPath(), { method: 'POST', body: { profile: 'default', expected_session_generation: expected, sources: SOURCES } }),
      modelRun: await issue({}, await m.auth.issueModelRunJwt(member)),
      outsider: await issue({}, users.outsider.token),
      staleGeneration: await issue({ expected_session_generation: 'stale' }),
      unsupported: await issue({ expected_session_generation: await generation('ekko-1') }, users.admin.token, 'ekko-1'),
      badSources: await issue({ sources: [] }),
      duplicateSources: await issue({ sources: ['a', 'a'] }),
      tooLong: await issue({ expires_in_days: 181 }),
      unknownField: await issue({ scope: 'all' }),
    }
    expect(Object.fromEntries(Object.entries(results).map(([name, r]) => [name, r.status]))).toEqual({
      missing: 401, modelRun: 403, outsider: 403, staleGeneration: 409, unsupported: 422,
      badSources: 400, duplicateSources: 400, tooLong: 400, unknownField: 400,
    })
    expect(grants()).toHaveLength(0)
  })

  it('an activation-check source is accepted only when the grant was issued with it', async () => {
    const plain = await grant()
    expect((await publish(plain.token, plain.expected, { source: 'activation-check', event_id: 'activation-1' })).status).toBe(403)
    const labeled = await grant({ sources: [...SOURCES, 'activation-check'] })
    const accepted = await publish(labeled.token, labeled.expected, { source: 'activation-check', event_id: 'activation-1', title: 'Publisher activation check' })
    expect(accepted.status).toBe(201)
    expect(JSON.parse(rows()[0].payload)).toMatchObject({ source: 'activation-check', title: 'Publisher activation check' })
  })

  it('login-token delivery is unchanged', async () => {
    const expected = await generation('chat-1')
    expect((await post('chat-1', notice(expected))).status).toBe(201)
  })
})
