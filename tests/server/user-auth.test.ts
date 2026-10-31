import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('user auth tables and middleware', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret')
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
      isSqliteAvailable: () => true,
    }))
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      listProfileNamesFromDisk: () => ['default'],
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.doUnmock('../../packages/server/src/modules/studio/public/profile-config')
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function initUsers() {
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      users: await import('../../packages/server/src/modules/studio/repositories/users-store'),
      auth: await import('../../packages/server/src/modules/studio/middleware/auth'),
    }
  }

  function makeCtx(user: any, profile: string) {
    return {
      state: { user },
      query: { profile },
      request: { body: {} },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? '' : ''),
      status: 200,
      body: null,
    } as any
  }

  function jwtPayload(token: string): any {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'))
  }

  it('uses the default user JWT lifetime when no override is configured', async () => {
    const { auth } = await initUsers()
    vi.setSystemTime(new Date('2026-06-30T00:00:00Z'))

    const token = await auth.issueUserJwt({ id: 1, username: 'admin', role: 'super_admin' })
    const payload = jwtPayload(token)

    expect(payload.exp - payload.iat).toBe(60 * 60 * 24 * 30)
  })

  it('allows configuring the user JWT lifetime with HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN', async () => {
    vi.stubEnv('HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN', '12h')
    const { auth } = await initUsers()
    vi.setSystemTime(new Date('2026-06-30T00:00:00Z'))

    const token = await auth.issueUserJwt({ id: 1, username: 'admin', role: 'super_admin' })
    const payload = jwtPayload(token)

    expect(payload.exp - payload.iat).toBe(12 * 60 * 60)
  })

  it('falls back to the default user JWT lifetime for invalid overrides', async () => {
    vi.stubEnv('HERMES_WEB_UI_AUTH_JWT_EXPIRES_IN', 'forever')
    const { auth } = await initUsers()

    expect(auth.getUserJwtExpiresSeconds()).toBe(60 * 60 * 24 * 30)
  })

  it.each([
    ['30s', 30],
    ['90', 90],
    ['15m', 15 * 60],
    ['2 hours', 2 * 60 * 60],
    ['7d', 7 * 24 * 60 * 60],
  ])('parses user JWT lifetime override %s', async (value, seconds) => {
    const { auth } = await initUsers()

    expect(auth.parseJwtExpirySeconds(value)).toBe(seconds)
  })

  it('allows configuring the model-run JWT lifetime independently', async () => {
    vi.stubEnv('HERMES_WEB_UI_MODEL_RUN_JWT_EXPIRES_IN', '12h')
    const { auth } = await initUsers()
    vi.setSystemTime(new Date('2026-06-30T00:00:00Z'))

    const token = await auth.issueModelRunJwt({ id: 1, username: 'admin', role: 'super_admin' })
    const payload = jwtPayload(token)

    expect(payload.exp - payload.iat).toBe(12 * 60 * 60)
  })

  it('falls back to the one-hour model-run JWT lifetime for invalid overrides', async () => {
    vi.stubEnv('HERMES_WEB_UI_MODEL_RUN_JWT_EXPIRES_IN', 'forever')
    const { auth } = await initUsers()

    expect(auth.getModelRunJwtExpiresSeconds()).toBe(60 * 60)
  })

  it('creates the default super admin without profile bindings', async () => {
    const { schemas, users } = await initUsers()

    const created = users.bootstrapDefaultSuperAdmin('admin', '123456')
    expect(created?.id).toBe(1)

    const row = db.prepare(`SELECT * FROM ${schemas.USERS_TABLE} WHERE id = ?`).get(1) as any
    expect(row.username).toBe('admin')
    expect(row.role).toBe('super_admin')
    expect(row.status).toBe('active')
    expect(row.password_hash).not.toBe('123456')
    expect(users.verifyPassword('123456', row.password_hash)).toBe(true)

    const profileCount = db.prepare(`SELECT COUNT(*) as count FROM ${schemas.USER_PROFILES_TABLE} WHERE user_id = ?`).get(1) as any
    expect(profileCount.count).toBe(0)
  })

  it('allows super admin to access profiles without explicit binding', async () => {
    const { users, auth } = await initUsers()
    const created = users.bootstrapDefaultSuperAdmin('admin', '123456')
    expect(created?.role).toBe('super_admin')

    const ctx = makeCtx({ id: created?.id, username: 'admin', role: 'super_admin' }, 'research')
    const next = vi.fn(async () => {})

    await auth.resolveUserProfile(ctx, next)

    expect(ctx.state.profile).toEqual({ name: 'research' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('requires regular admins to be associated with the requested profile', async () => {
    const { schemas, users, auth } = await initUsers()
    const now = Date.now()
    db.prepare(
      `INSERT INTO ${schemas.USERS_TABLE} (username, password_hash, role, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('ops', users.hashPassword('secret'), 'admin', 'active', now, now)
    const admin = users.findUserByUsername('ops')
    expect(admin?.id).toBe(1)

    const deniedCtx = makeCtx({ id: admin!.id, username: 'ops', role: 'admin' }, 'research')
    await auth.resolveUserProfile(deniedCtx, vi.fn(async () => {}))
    expect(deniedCtx.status).toBe(403)

    db.prepare(
      `INSERT INTO ${schemas.USER_PROFILES_TABLE} (user_id, profile_name, is_default, created_at)
       VALUES (?, ?, 1, ?)`
    ).run(admin!.id, 'research', now)

    const allowedCtx = makeCtx({ id: admin!.id, username: 'ops', role: 'admin' }, 'research')
    const next = vi.fn(async () => {})
    await auth.resolveUserProfile(allowedCtx, next)

    expect(allowedCtx.state.profile).toEqual({ name: 'research' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not infer a profile when the frontend does not send one', async () => {
    const { auth } = await initUsers()
    const ctx = makeCtx({ id: 1, username: 'admin', role: 'super_admin' }, '')
    const next = vi.fn(async () => {})

    await auth.resolveUserProfile(ctx, next)

    expect(ctx.state.profile).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()

    await auth.requireUserProfile(ctx, vi.fn(async () => {}))
    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Profile is required' })
  })

  it.each([
    '/api/studio/media/apikey-image-generate',
    '/api/studio/media/grok-image-to-video',
    '/api/studio/voice/proxy/default/v1/tts',
    '/api/studio/voice/proxy/work/v1/audio/transcriptions',
  ])('allows server token for an approved loopback agent endpoint %s', async (path) => {
    vi.stubEnv('AUTH_TOKEN', 'server-token')
    const { auth } = await initUsers()
    const ctx = {
      path,
      headers: { authorization: 'Bearer server-token' },
      query: {},
      ip: '127.0.0.1',
      request: { ip: '127.0.0.1', body: {} },
      req: { socket: { remoteAddress: '127.0.0.1' } },
      state: {},
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.state.serverTokenAuth).toBe(true)
  })

  it.each([
    '/api/studio/media/apikey-image-generate',
    '/api/studio/media/grok-image-to-video',
    '/api/studio/voice/proxy/default/v1/tts',
    '/api/studio/voice/proxy/work/v1/audio/transcriptions',
  ])('rejects server token for local-only endpoint %s from non-loopback clients', async (path) => {
    vi.stubEnv('AUTH_TOKEN', 'server-token')
    const { auth } = await initUsers()
    const ctx = {
      path,
      headers: { authorization: 'Bearer server-token' },
      query: {},
      ip: '192.168.1.50',
      request: { ip: '192.168.1.50', body: {} },
      req: { socket: { remoteAddress: '192.168.1.50' } },
      state: {},
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('requires super admin privileges after a valid user token reaches MCP device routes', async () => {
    const { auth } = await initUsers()
    const next = vi.fn(async () => {})
    const adminCtx = {
      state: { user: { id: 1, username: 'ops', role: 'admin' } },
      status: 200,
      body: null,
    } as any
    const superCtx = {
      state: { user: { id: 2, username: 'root', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any

    await auth.requireSuperAdmin(adminCtx, vi.fn(async () => {}))
    await auth.requireSuperAdmin(superCtx, next)

    expect(adminCtx.status).toBe(403)
    expect(adminCtx.body).toEqual({ error: 'Super administrator privileges are required' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('allows admin and super_admin roles through provider-management authorization', async () => {
    const { auth } = await initUsers()
    const adminNext = vi.fn(async () => {})
    const superNext = vi.fn(async () => {})
    const missingNext = vi.fn(async () => {})

    const adminCtx = { state: { user: { role: 'admin' } }, status: 200, body: null } as any
    const superCtx = { state: { user: { role: 'super_admin' } }, status: 200, body: null } as any
    const missingCtx = { state: {}, status: 200, body: null } as any

    await auth.requireAdmin(adminCtx, adminNext)
    await auth.requireAdmin(superCtx, superNext)
    await auth.requireAdmin(missingCtx, missingNext)

    expect(adminNext).toHaveBeenCalledOnce()
    expect(superNext).toHaveBeenCalledOnce()
    expect(missingNext).not.toHaveBeenCalled()
    expect(missingCtx.status).toBe(403)
    expect(missingCtx.body).toEqual({ error: 'Administrator privileges are required' })
  })

  it('ignores stale profile headers for the aggregate available-models endpoint', async () => {
    const { auth } = await initUsers()
    const ctx = {
      path: '/api/hermes/available-models',
      state: { user: { id: 1, username: 'ops', role: 'admin' } },
      query: {},
      request: { body: {} },
      get: vi.fn((name: string) => name.toLowerCase() === 'x-hermes-profile' ? 'private' : ''),
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.resolveUserProfile(ctx, next)

    expect(ctx.state.profile).toBeUndefined()
    expect(next).toHaveBeenCalledOnce()
  })

  it('does not create the default super admin until first valid bootstrap login', async () => {
    const { schemas, users } = await initUsers()

    expect(users.countUsers()).toBe(0)
    expect(users.bootstrapDefaultSuperAdmin('admin', 'bad-password')).toBeNull()
    expect(users.countUsers()).toBe(0)

    const created = users.bootstrapDefaultSuperAdmin('admin', '123456')
    expect(created?.role).toBe('super_admin')
    expect(users.countUsers()).toBe(1)

    const userCount = db.prepare(`SELECT COUNT(*) as count FROM ${schemas.USERS_TABLE}`).get() as any
    expect(userCount.count).toBe(1)
  })

  it('signs and verifies user JWTs', async () => {
    const { auth } = await initUsers()
    const token = auth.signUserJwt({ id: 1, username: 'admin', role: 'super_admin' }, 'secret', 1000)

    const payload = auth.verifyUserJwt(token, 'secret', 1000)
    expect(payload?.sub).toBe('1')
    expect(payload?.username).toBe('admin')
    expect(payload?.role).toBe('super_admin')

    expect(auth.verifyUserJwt(token, 'wrong', 1000)).toBeNull()
  })

  it('rejects tokens issued for the legacy hermes-web-ui audience', async () => {
    const { auth } = await initUsers()
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify({
      sub: '1',
      username: 'admin',
      role: 'super_admin',
      type: 'access',
      aud: 'hermes-web-ui',
      iat: 1,
      exp: 3601,
    })).toString('base64url')
    const unsigned = `${header}.${body}`
    const signature = createHmac('sha256', 'secret').update(unsigned).digest('base64url')

    expect(auth.verifyUserJwt(`${unsigned}.${signature}`, 'secret', 1000)).toBeNull()
  })

  it('marks login and model-run JWTs with distinct signed purposes', async () => {
    const { auth } = await initUsers()
    const user = { id: 1, username: 'admin', role: 'super_admin' as const }
    const purpose = (token: string) => auth.verifyUserJwt(token, 'test-secret')?.purpose
    expect(purpose(await auth.issueUserJwt(user))).toBe('login')
    expect(purpose(await auth.issueModelRunJwt(user))).toBe('model_run')
    expect(purpose(auth.signUserJwt(user, 'test-secret'))).toBeUndefined()
  })

  it('signs model run JWTs with the same payload shape and a one hour expiry', async () => {
    const { auth } = await initUsers()
    const token = auth.signUserJwt(
      { id: 1, username: 'admin', role: 'super_admin' },
      'secret',
      1000,
      auth.MODEL_RUN_EXPIRES_SECONDS,
    )

    const payload = auth.verifyUserJwt(token, 'secret', 1000)
    expect(payload).toMatchObject({
      sub: '1',
      username: 'admin',
      role: 'super_admin',
      type: 'access',
      aud: 'hermes-studio',
      iat: 1,
      exp: 3601,
    })
    expect(auth.verifyUserJwt(token, 'secret', 1000 + 60 * 60 * 1000)).toBeNull()
  })

  it('protects account Person sessions in HTTP independently of shared Profile or admin role', async () => {
    const { users, auth } = await initUsers()
    const owner = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    db.prepare("INSERT INTO users(username,password_hash,role,status,created_at,updated_at) VALUES ('other','unused','super_admin','active',1,1)").run()
    const other = users.findUserByUsername('other')!
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: `person-main-${owner.id}`, user_id: owner.id, studio_user_id: owner.id, source: 'builtin_agent', profile: 'resource-profile' })
    for (const user of [owner, other]) {
      const ctx = { path: `/api/studio/sessions/person-main-${owner.id}`, query: {}, request: { body: {} },
        headers: { authorization: `Bearer ${auth.signUserJwt(user, 'test-secret')}` }, state: {}, status: 200, body: null,
        get: (name: string) => name === 'x-hermes-profile' ? 'unrelated-profile' : '' } as any
      const next = vi.fn()
      await auth.requireUserJwt(ctx, next)
      if (user.id === owner.id) {
        expect(next).toHaveBeenCalledOnce()
        await auth.resolveUserProfile(ctx, vi.fn())
        expect(ctx.state.profile.name).toBe('resource-profile')
      } else { expect(ctx.status).toBe(404); expect(next).not.toHaveBeenCalled() }
    }
  })

  it.each(['single', 'batch'])('uses Person lifecycle cleanup for owner deletion through the generic %s session endpoint', async kind => {
    const { users } = await initUsers()
    const owner = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const store = await import('../../packages/server/src/modules/studio/repositories/person-store')
    const sid = 'person-main-remove'
    sessions.createSession({ id: sid, user_id: owner.id, studio_user_id: owner.id, source: 'builtin_agent', agent: 'ekko-agent', profile: 'default' })
    sessions.createSession({ id: 'person-main-keep', user_id: owner.id, studio_user_id: owner.id, source: 'builtin_agent', agent: 'ekko-agent', profile: 'default' })
    const selection = { runtime: 'ekko', mode: 'scoped' as const, profile: 'default', provider: 'p', model: 'm' }
    const task = store.createPersonTask(owner.id, 'Remove', 'Work', selection, '/tmp', sid)
    const kept = store.createPersonTask(owner.id, 'Keep', 'Work', selection, '/tmp', 'person-main-keep')
    const controller = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx = { params: { id: sid }, state: { user: owner }, request: { body: { ids: [sid] } }, query: {} } as any
    if (kind === 'single') await controller.remove(ctx)
    else await controller.batchRemove(ctx)
    expect(ctx.body.ok).toBe(true)
    expect(sessions.getSession(sid)).toBeNull()
    expect(() => store.getPersonTask(owner.id, task.id)).toThrow('not found')
    expect(store.getPersonTask(owner.id, kept.id)).toBeTruthy()
  })

  it('only allows owner-authenticated reads of hidden task sessions, never generic mutations', async () => {
    const { users, auth } = await initUsers()
    const owner = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    db.prepare("INSERT INTO users(username,password_hash,role,status,created_at,updated_at) VALUES ('other','unused','super_admin','active',1,1)").run()
    const other = users.findUserByUsername('other')!
    const { createPersonTask, enqueuePersonExecution } = await import('../../packages/server/src/modules/studio/repositories/person-store')
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: `person-main-${owner.id}`, user_id: owner.id, studio_user_id: owner.id, source: 'builtin_agent', profile: 'default' })
    const task = createPersonTask(owner.id, 'Owned task', 'Run privately', { runtime: 'ekko', mode: 'scoped', profile: 'default', provider: 'p', model: 'm' }, '/tmp', `person-main-${owner.id}`)
    const id = enqueuePersonExecution(task).session_id
    for (const [user, method, suffix, allowed] of [[owner,'GET','',true], [owner,'GET','/context',true], [other,'GET','',false], [owner,'DELETE','',false], [owner,'POST','/messages/batch-delete',false], [owner,'GET','/share-models',false]] as const) {
      const ctx = { path: `/api/studio/sessions/${id}${suffix}`, method, query: {}, request: { body: {} },
        headers: { authorization: `Bearer ${auth.signUserJwt(user, 'test-secret')}` }, state: {}, status: 200, body: null,
        get: () => '' } as any
      const next = vi.fn()
      await auth.requireUserJwt(ctx, next)
      if (allowed) { expect(next).toHaveBeenCalledOnce(); expect(ctx.state.personTaskRead).toBe(id) }
      else { expect(ctx.status).toBe(404); expect(next).not.toHaveBeenCalled() }
    }
  })

  it('protects Person sessions in structured batch deletes at both the middleware and controller', async () => {
    const { users, auth } = await initUsers()
    const owner = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    db.prepare("INSERT INTO users(username,password_hash,role,status,created_at,updated_at) VALUES ('other','unused','admin','active',1,1)").run()
    const other = users.findUserByUsername('other')!
    users.replaceUserProfiles(other.id, ['default'], 'default')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    const sid = `person-main-${owner.id}`
    sessions.createSession({ id: sid, user_id: owner.id, studio_user_id: owner.id, source: 'builtin_agent', agent: 'ekko-agent', profile: 'default' })
    sessions.addMessage({session_id:sid,role:'user',content:'Private conversation'})
    const runtime = await import('../../packages/server/src/modules/studio/public/session-agent-runtime')
    runtime.configureSessionAgentRuntime({stopCodingAgentSessionRun:vi.fn()} as any)
    const { batchRemove } = await import('../../packages/server/src/modules/studio/controllers/sessions')
    const ctx = { path: '/api/studio/sessions/batch-delete', method:'POST', query: {}, request: { body: { sessions: [{id:sid,profile:'default'}] } },
      headers: { authorization: `Bearer ${auth.signUserJwt(other, 'test-secret')}` }, state: {}, status: 200, body: null,
      get: () => '' } as any
    await auth.requireUserJwt(ctx, async () => { await auth.resolveUserProfile(ctx, async () => { await batchRemove(ctx) }) })
    expect(ctx.status).toBe(404)
    expect(sessions.getSession(sid)).not.toBeNull()
    // The controller also enforces ownership if reached through another transport.
    ctx.state = { user: { id: other.id, role: other.role } }
    await batchRemove(ctx)
    expect(ctx.body).toMatchObject({ deleted: 0, failed: 1 })
    expect(sessions.getSessionDetail(sid)?.messages).toHaveLength(1)
    const worker = 'person-task-private'
    sessions.createSession({ id: worker, user_id: owner.id, studio_user_id: owner.id, source: 'builtin_agent', profile: 'default' })
    ctx.state.user = { id: owner.id, role: owner.role }
    ctx.request.body = { sessions: [{ id: worker, profile: 'default' }] }
    await batchRemove(ctx)
    expect(ctx.body).toMatchObject({ deleted: 0, failed: 1 })
    expect(sessions.getSession(worker)).not.toBeNull()
  })

  it.each([
    ['/api/studio/sessions/ordinary-chat/workspace-file/read', { path: 'packages/server/src/bootstrap/person-task-runtime.ts' }],
    ['/api/studio/group-chat/rooms/ordinary-room/workspace-file/read', { path: 'person-task-notes.txt' }],
    ['/api/studio/files/download', { path: '/tmp/person-task-results/report.txt' }],
    ['/api/studio/sessions/search', { q: 'person-main-architecture' }],
    ['/api/studio/person/conversations', { search: 'person-task-research' }],
    ['/api/studio/sessions/ordinary-person-main-reference', {}],
    ['/api/studio/group-chat/rooms/person-task-project', {}],
    ['/api/studio/workflows', { ids: 'person-main-workflow' }],
    ['/api/studio/logs/ekko-agent', { text: 'person-task-runtime.ts' }],
  ])('does not treat ordinary request text as a Person session: %s', async (path, query) => {
    const { users, auth } = await initUsers()
    const user = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const ctx = { path, method: 'GET', query, request: { body: {} },
      headers: { authorization: `Bearer ${auth.signUserJwt(user, 'test-secret')}` },
      state: {}, status: 200, body: null, get: () => '' } as any
    const next = vi.fn()

    await auth.requireUserJwt(ctx, next)

    expect(ctx.status).toBe(200)
    expect(next).toHaveBeenCalledOnce()
    expect(ctx.state.personSession).toBeUndefined()
    expect(ctx.state.personTaskRead).toBeUndefined()
  })

  it.each([
    ['GET', '/api/studio/sessions/person-main-private', {}, {}],
    ['GET', '/API/STUDIO/SESSIONS/person-main-private/', {}, {}],
    ['GET', '/api/studio/sessions/person%2Dmain%2Dprivate', {}, {}],
    ['GET', '/api/studio/sessions/conversations/person-main-private/messages/paginated', {}, {}],
    ['GET', '/api/studio/sessions/hermes/person-main-private', {}, {}],
    ['DELETE', '/api/studio/person/conversations/person-main-private', {}, {}],
    ['GET', '/api/studio/person', { session_id: 'person-main-private' }, {}],
    ['GET', '/api/studio/sessions/usage', { ids: 'ordinary,person-main-private' }, {}],
    ['GET', '/api/studio/logs/ekko-agent', { session: 'person-main-private' }, {}],
    ['GET', '/api/studio/logs/ekko-agent', { session: 'person-task-private' }, {}],
    ['POST', '/api/studio/chat-run/runs', {}, { session_id: 'person-main-private' }],
    ['POST', '/api/studio/chat-run/runs', {}, { parent_session_id: 'person-main-private' }],
    ['POST', '/api/coding-agents/runs/person-main-private/input', {}, { input: 'continue' }],
    ['DELETE', '/api/coding-agents/runs/person-main-private', {}, {}],
    ['POST', '/api/coding-agents/runs/person-task-private/input', {}, { input: 'continue' }],
    ['DELETE', '/api/coding-agents/runs/person-task-private', {}, {}],
    ['POST', '/api/studio/sessions/batch-delete', {}, { ids: ['ordinary', 'person-main-private'] }],
    ['POST', '/api/studio/sessions/batch-delete', {}, { sessions: [], ids: ['person-main-private'] }],
    ['POST', '/api/studio/sessions/batch-delete', {}, { sessions: [{ id: 'person-main-private', profile: 'default' }] }],
  ])('keeps private Person references protected in %s %s', async (method, path, query, body) => {
    const { users, auth } = await initUsers()
    const user = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const { createSession } = await import('../../packages/server/src/modules/studio/repositories/session-store')
    createSession({ id: 'person-main-private', studio_user_id: user.id + 1, profile: 'default' })
    const ctx = { path, method, query, request: { body },
      headers: { authorization: `Bearer ${auth.signUserJwt(user, 'test-secret')}` },
      state: {}, status: 200, body: null, get: () => '' } as any
    const next = vi.fn()

    await auth.requireUserJwt(ctx, next)

    expect(ctx.status).toBe(404)
    expect(next).not.toHaveBeenCalled()
  })

  it('authenticates JWTs passed as query tokens for download and websocket URLs', async () => {
    const { users, auth } = await initUsers()
    const user = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const token = auth.signUserJwt(user, 'test-secret')
    const ctx = {
      path: '/api/studio/files/download',
      headers: {},
      query: { token },
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(ctx.state.user).toEqual({ id: user.id, username: 'admin', role: 'super_admin' })
    expect(next).toHaveBeenCalledOnce()
  })

  it('lets SPA and static asset paths pass through without a JWT', async () => {
    const { auth } = await initUsers()
    const ctx = {
      path: '/',
      headers: {},
      query: {},
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.status).toBe(200)
    expect(ctx.body).toBeNull()
  })

  it('still requires a JWT for protected API paths', async () => {
    const { auth } = await initUsers()
    const ctx = {
      path: '/api/studio/sessions',
      headers: {},
      query: {},
      state: {},
      request: { body: {} },
      status: 200,
      body: null,
    } as any
    const next = vi.fn(async () => {})

    await auth.requireUserJwt(ctx, next)

    expect(next).not.toHaveBeenCalled()
    expect(ctx.status).toBe(401)
    expect(ctx.body).toEqual({ error: 'Unauthorized' })
  })

  it('bootstraps the default super admin through password login and returns a user JWT', async () => {
    await initUsers()
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/auth')
    const ctx = {
      request: { body: { username: 'admin', password: '123456' } },
      headers: {},
      ip: '127.0.0.1',
      status: 200,
      body: null,
    } as any

    await ctrl.login(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body.token).toMatch(/^[^.]+\.[^.]+\.[^.]+$/)
    expect(ctx.body.userId).toBeGreaterThan(0)
    expect(ctx.body.profiles).toContain('default')
    expect(ctx.body.theme).toEqual({
      fontSize: 14,
      textColor: null,
      appearance: { global: {}, regions: {} },
      accentColor: null,
      background: null,
      updatedAt: 0,
    })
  })

  it('marks only admin with password 123456 as requiring a credential change', async () => {
    vi.stubEnv('HERMES_DESKTOP', 'false')
    const { users } = await initUsers()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/auth')

    const defaultCtx = {
      state: { user: { id: admin.id, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any
    await ctrl.currentUser(defaultCtx)
    expect(defaultCtx.body.user.requiresCredentialChange).toBe(true)

    users.updateUserPassword(admin.id, 'stronger-password')
    const passwordChangedCtx = {
      state: { user: { id: admin.id, username: 'admin', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any
    await ctrl.currentUser(passwordChangedCtx)
    expect(passwordChangedCtx.body.user.requiresCredentialChange).toBe(false)

    users.updateUserPassword(admin.id, '123456')
    users.updateUsername(admin.id, 'owner')
    const usernameChangedCtx = {
      state: { user: { id: admin.id, username: 'owner', role: 'super_admin' } },
      status: 200,
      body: null,
    } as any
    await ctrl.currentUser(usernameChangedCtx)
    expect(usernameChangedCtx.body.user.requiresCredentialChange).toBe(false)
  })

  it('lets super admins create regular admins with profile bindings', async () => {
    const { users } = await initUsers()
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      listProfileNamesFromDisk: () => ['default', 'research'],
    }))
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/auth')
    const ctx = {
      state: { user: { id: 1, username: 'admin', role: 'super_admin' } },
      request: {
        body: {
          username: 'ops',
          password: 'secret1',
          role: 'admin',
          status: 'active',
          profiles: ['research'],
        },
      },
      status: 200,
      body: null,
    } as any

    await ctrl.createManagedUser(ctx)

    expect(ctx.status).toBe(201)
    const created = users.findUserByUsername('ops')
    expect(created?.role).toBe('admin')
    expect(users.listUserProfiles(created!.id).map(profile => profile.profile_name)).toEqual(['research'])
  })

  it('does not allow disabling the last active super admin', async () => {
    const { users } = await initUsers()
    const admin = users.bootstrapDefaultSuperAdmin('admin', '123456')!
    vi.doMock('../../packages/server/src/modules/studio/public/profile-config', () => ({
      listProfileNamesFromDisk: () => ['default'],
    }))
    const ctrl = await import('../../packages/server/src/modules/studio/controllers/auth')
    const ctx = {
      state: { user: { id: admin.id, username: 'admin', role: 'super_admin' } },
      params: { id: String(admin.id) },
      request: { body: { status: 'disabled' } },
      status: 200,
      body: null,
    } as any

    await ctrl.updateManagedUser(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'You cannot disable your own account' })
  })

  it('requires super admin for super-admin-only middleware', async () => {
    const { auth } = await initUsers()
    const adminCtx = makeCtx({ id: 2, username: 'ops', role: 'admin' }, 'default')
    await auth.requireSuperAdmin(adminCtx, vi.fn(async () => {}))
    expect(adminCtx.status).toBe(403)

    const superCtx = makeCtx({ id: 1, username: 'admin', role: 'super_admin' }, 'default')
    const next = vi.fn(async () => {})
    await auth.requireSuperAdmin(superCtx, next)
    expect(next).toHaveBeenCalledOnce()
  })
})
