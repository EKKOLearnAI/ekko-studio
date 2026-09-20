import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { DatabaseSync } from 'node:sqlite'
import type { Server } from 'node:http'
import { SESSION_SHARE_LIFETIME_MS } from '../../packages/server/src/modules/studio/contracts/session-shares'

describe('App-only session share HTTP lifecycle', () => {
  let server: Server
  let origin: string
  let db: DatabaseSync
  let session: any
  const verifyIdentity = vi.fn()
  const local = { id: 7, role: 'super_admin', status: 'active', username: 'owner' }

  beforeEach(async () => {
    vi.resetModules()
    verifyIdentity.mockReset()
    session = { id: 's1', profile: 'default', workspace: null }
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, getStoragePath: () => ':memory:' }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/session-store', () => ({ getSession: (id: string) => id === 's1' ? session : null }))
    vi.doMock('../../packages/server/src/modules/studio/repositories/users-store', () => ({ findUserById: () => local, userCanAccessProfile: () => true }))
    vi.doMock('../../packages/server/src/modules/studio/public/auth', () => ({
      inspectAppUserToken: async (token: string) => token === 'device-jwt' ? { status: 'active', user: local } : null,
    }))
    vi.doMock('../../packages/server/src/modules/studio/services/session-shares/app-identity', async () => {
      const { SessionShareError } = await import('../../packages/server/src/modules/studio/contracts/session-shares')
      verifyIdentity.mockImplementation(async (token: string) => {
        const users: Record<string, any> = { alice: { id: 101, name: 'Alice from cloud' }, bob: { id: 202, name: 'Bob from cloud' }, mallory: { id: 303, name: 'Mallory' } }
        if (!users[token]) throw new SessionShareError('share_app_login_required', 401)
        return users[token]
      })
      return { shareAppIdentityVerifier: { verify: verifyIdentity } }
    })
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    const { sessionShareRoutes, sessionSharePublicRoutes } = await import('../../packages/server/src/modules/studio/routes/session-shares')
    const app = new Koa()
    app.use(bodyParser())
    app.use(sessionSharePublicRoutes.routes())
    app.use(async (ctx, next) => {
      if (!['Bearer device-jwt', 'Bearer browser-jwt'].includes(ctx.get('authorization'))) { ctx.status = 401; return }
      ctx.state.user = local as any
      await next()
    })
    app.use(sessionShareRoutes.routes())
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as any).port}`
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    for (const name of ['infrastructure/database/index', 'repositories/session-store', 'repositories/users-store', 'public/auth', 'services/session-shares/app-identity']) {
      vi.doUnmock(`../../packages/server/src/modules/studio/${name}`)
    }
    vi.resetModules()
  })

  async function request(path: string, method = 'GET', data?: any, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers }
  }
  const manager = { Authorization: 'Bearer device-jwt' }
  const guest = (token: string, actor = 'bob') => ({ 'X-App-Access-Token': actor, 'X-Session-Share-Token': token })
  const create = (permissions = {}) => request('/api/studio/sessions/s1/shares', 'POST', { permissions, sharer: { id: 101, name: 'Alice from App' } }, manager)

  it('creates, explicitly claims, authorizes only the bound session, changes permissions and revokes', async () => {
    const created = await create({ input: true, terminal: true })
    expect(created.status).toBe(201)
    const { token, share } = created.body
    expect(share.sharer_name_snapshot).toBe('Alice from App')
    expect(share.expires_at - share.created_at).toBe(SESSION_SHARE_LIFETIME_MS)
    expect(created.headers.get('cache-control')).toBe('no-store')
    expect(created.headers.get('referrer-policy')).toBe('no-referrer')
    expect((await request('/api/studio/session-shares/access', 'GET', undefined, guest(token))).status).toBe(403)
    expect((await request('/api/studio/session-shares/claim', 'POST', {}, guest(token))).status).toBe(400)
    const claimed = await request('/api/studio/session-shares/claim', 'POST', { confirm: true }, guest(token))
    expect(claimed.body.share).toMatchObject({ recipient_app_user_id: 202, recipient_name_snapshot: 'Bob from cloud' })
    expect((await request('/api/studio/session-shares/claim', 'POST', { confirm: true }, guest(token, 'mallory'))).status).toBe(409)
    expect((await request('/api/studio/session-shares/check', 'POST', { action: 'input', sessionId: 's2' }, guest(token))).status).toBe(403)
    expect((await request('/api/studio/session-shares/check', 'POST', { action: 'input', sessionId: 's1' }, guest(token))).body.allowed).toBe(true)
    const path = `/api/studio/sessions/s1/shares/${share.id}`
    expect((await request(path, 'PATCH', { permissions: { input: false } }, manager)).status).toBe(200)
    expect((await request('/api/studio/session-shares/check', 'POST', { action: 'input', sessionId: 's1' }, guest(token))).status).toBe(403)
    expect((await request(path, 'DELETE', undefined, manager)).status).toBe(200)
    expect((await request('/api/studio/session-shares/access', 'GET', undefined, guest(token))).status).toBe(410)
  })

  it('manages shares using only the existing Studio device identity, even when cloud identity is unavailable', async () => {
    verifyIdentity.mockRejectedValue(new Error('Cloud must not be called for management'))
    const created = await create()
    expect(created.status).toBe(201)
    const path = `/api/studio/sessions/s1/shares/${created.body.share.id}`
    expect((await request('/api/studio/sessions/s1/shares', 'GET', undefined, manager)).body.shares).toHaveLength(1)
    expect((await request(path, 'PATCH', { permissions: { input: true } }, manager)).status).toBe(200)
    expect((await request(path, 'DELETE', undefined, manager)).status).toBe(200)
    expect(verifyIdentity).not.toHaveBeenCalled()
    expect((await request('/api/studio/sessions/s1/shares', 'GET', undefined, { Authorization: 'Bearer browser-jwt' })).status).toBe(401)
    expect((await request('/api/studio/sessions/s1/shares', 'GET', undefined, { 'X-App-Access-Token': 'alice' })).status).toBe(401)
    session = null
    expect((await request('/api/studio/sessions/s1/shares', 'GET', undefined, manager)).status).toBe(403)
  })

  it('validates attribution and never allows it to override the Studio owner', async () => {
    for (const sharer of [null, { id: -1, name: 'A' }, { id: '101', name: 'A' }, { id: 101 }, { id: 101, name: 'x'.repeat(201) }, { id: 101, name: 'A', ownerId: 7 }]) {
      expect((await request('/api/studio/sessions/s1/shares', 'POST', { sharer }, manager)).status).toBe(400)
    }
    const first = await create()
    const second = await request('/api/studio/sessions/s1/shares', 'POST', { sharer: { id: 999, name: 'Other attribution' } }, manager)
    expect(second.status).toBe(201)
    const listed = await request('/api/studio/sessions/s1/shares', 'GET', undefined, manager)
    expect(listed.body.shares.map((row: any) => row.id)).toEqual(expect.arrayContaining([first.body.share.id, second.body.share.id]))
    expect(verifyIdentity).not.toHaveBeenCalled()
  })

  it('does not accept caller recipient identities, arbitrary expiry or query-string invitation tokens', async () => {
    for (const input of [{ sharer_app_user_id: 999 }, { expires_at: Date.now() }, { recipient_app_user_id: 202 }]) {
      expect((await request('/api/studio/sessions/s1/shares', 'POST', input, manager)).status).toBe(400)
    }
    const { token, share } = (await create()).body
    expect((await request('/api/studio/session-shares/claim', 'POST', { confirm: true, recipient_app_user_id: 999 }, guest(token))).status).toBe(400)
    expect((await request(`/api/studio/session-shares/claim?token=${token}`, 'POST', { confirm: true }, { 'X-App-Access-Token': 'bob' })).status).toBe(404)
    expect((await request(`/api/studio/sessions/s1/shares/${share.id}`, 'PATCH', { expires_at: Date.now() + 100 }, manager)).status).toBe(400)
  })

  it('does not expose raw tokens, token hashes, workspace paths or local identities in subsequent responses', async () => {
    const { token } = (await create()).body
    await request('/api/studio/session-shares/claim', 'POST', { confirm: true }, guest(token))
    for (const result of [await request('/api/studio/sessions/s1/shares', 'GET', undefined, manager),
      await request('/api/studio/session-shares/access', 'GET', undefined, guest(token))]) {
      const json = JSON.stringify(result.body)
      expect(json).not.toContain(token)
      for (const field of ['token_hash', 'created_by_user_id', 'workspace_root', 'workspace_real_root', 'profile']) expect(json).not.toContain(`"${field}"`)
    }
  })

  it('does not promote share credentials into normal Studio account routes', async () => {
    const { token } = (await create()).body
    expect((await request('/api/studio/sessions/s1/shares', 'GET', undefined, { Authorization: `Bearer ${token}` })).status).toBe(401)
    expect((await request('/api/studio/sessions/s1/shares', 'GET', undefined, guest(token))).status).toBe(401)
  })
})
