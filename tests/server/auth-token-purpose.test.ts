import './fixtures/isolated-studio-state'
// Signed token purposes: migrated from the fork's case in the removed user-auth suite.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('user token purpose', () => {
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

  it('marks login and model-run JWTs with distinct signed purposes', async () => {
    const { auth } = await initUsers()
    const user = { id: 1, username: 'admin', role: 'super_admin' as const }
    const purpose = (token: string) => auth.verifyUserJwt(token, 'test-secret')?.purpose
    expect(purpose(await auth.issueUserJwt(user))).toBe('login')
    expect(purpose(await auth.issueModelRunJwt(user))).toBe('model_run')
    expect(purpose(auth.signUserJwt(user, 'test-secret'))).toBeUndefined()
  })
})
