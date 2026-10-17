import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let db: DatabaseSync
vi.mock('../../packages/server/src/modules/studio/infrastructure/database', () => ({
  getDb: () => db, getStoragePath: () => ':memory:', isSqliteAvailable: () => true,
}))
vi.mock('../../packages/server/src/modules/studio/public/config', () => ({
  config: { appHome: '/studio' }, getWebUiHome: () => '/studio',
}))
vi.mock('../../packages/server/src/modules/studio/public/profile-config', () => ({
  getProfileDir: (profile: string) => `/hermes/${profile}`,
  listProfileNamesFromDisk: () => ['default', 'research'],
}))
import { initAllHermesTables, WORKSPACE_DIRECTORIES_TABLE } from '../../packages/server/src/modules/studio/infrastructure/database/schemas'
import { saveUserWorkspaceDirectory, getUserWorkspaceDirectories } from '../../packages/server/src/modules/studio/services/workspace/directories'
import * as controller from '../../packages/server/src/modules/studio/controllers/workspace-directories'

describe('account workspace directories', () => {
  beforeEach(() => { db = new DatabaseSync(':memory:'); initAllHermesTables() })
  afterEach(() => { db.close(); vi.restoreAllMocks() })

  it('deduplicates selections per account and preserves history after unfavoriting', () => {
    vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000).mockReturnValueOnce(3000).mockReturnValueOnce(4000)
    saveUserWorkspaceDirectory(1, ' /projects/app/ ')
    saveUserWorkspaceDirectory(1, '/projects/app', true)
    saveUserWorkspaceDirectory(1, '/projects/app/../app')
    const [entry] = saveUserWorkspaceDirectory(1, '/projects/app', false).directories
    expect(entry).toMatchObject({ path: '/projects/app', isFavorite: false, lastUsed: 3000, useCount: 2, createdAt: 1000 })
    expect(getUserWorkspaceDirectories(2).directories).toEqual([])
    saveUserWorkspaceDirectory(2, '/projects/app', true)
    expect(getUserWorkspaceDirectories(1).directories[0].isFavorite).toBe(false)
    expect(getUserWorkspaceDirectories(2).directories[0]).toMatchObject({ isFavorite: true, lastUsed: 0, useCount: 0 })
    expect(db.prepare(`SELECT count(*) AS count FROM ${WORKSPACE_DIRECTORIES_TABLE}`).get()?.count).toBe(2)
    vi.restoreAllMocks()
  })

  it('persists all selected directories while clients can show a recent subset', () => {
    for (let index = 0; index < 15; index++) saveUserWorkspaceDirectory(1, `/projects/${index}`)
    initAllHermesTables()
    expect(getUserWorkspaceDirectories(1).directories).toHaveLength(15)
  })

  it('normalizes Windows directory keys without merging distinct Unix paths', () => {
    saveUserWorkspaceDirectory(1, 'C:\\Projects\\App')
    saveUserWorkspaceDirectory(1, 'c:/projects/APP/', true)
    saveUserWorkspaceDirectory(1, '/projects/App')
    saveUserWorkspaceDirectory(1, '/projects/app')
    expect(getUserWorkspaceDirectories(1).directories).toHaveLength(3)
    expect(getUserWorkspaceDirectories(1).directories.find(entry => entry.path === 'C:\\Projects\\App')?.isFavorite).toBe(true)
  })

  it.each([
    '/studio/.ekko/workspace/default/session-id',
    '/studio/coding-agent/workspace/research/provider',
    '/studio/group-chat/default/random-room',
    '/studio/workflow/research/random-workflow',
    '/hermes/default/workspace', '/hermes/research/workspace/subfolder',
  ])('excludes generated workspaces from history and favorites: %s', path => {
    saveUserWorkspaceDirectory(1, path)
    saveUserWorkspaceDirectory(1, path, true)
    expect(getUserWorkspaceDirectories(1).directories).toEqual([])
    expect(db.prepare(`SELECT count(*) AS count FROM ${WORKSPACE_DIRECTORIES_TABLE}`).get()?.count).toBe(0)
  })

  it('does not confuse neighboring user directories with managed roots', () => {
    saveUserWorkspaceDirectory(1, '/studio/workflow-project')
    expect(getUserWorkspaceDirectories(1).directories[0].path).toBe('/studio/workflow-project')
  })

  it('requires an authenticated account and never accepts a body account selector', async () => {
    const unauthorized: any = { state: {}, request: { body: { path: '/project', user_id: 1 } } }
    await controller.record(unauthorized)
    expect(unauthorized.status).toBe(401)
    const ctx: any = { state: { user: { id: 2 } }, request: { body: { path: '/project', favorite: true, user_id: 1 } } }
    await controller.setFavorite(ctx)
    expect(getUserWorkspaceDirectories(1).directories).toEqual([])
    expect(ctx.body.directories[0].isFavorite).toBe(true)
  })

  it.each([{ path: '' }, { path: 42 }, { path: '/a\0b' }, { path: '/project', favorite: 'true' }])('rejects malformed favorite writes: %j', async body => {
    const ctx: any = { state: { user: { id: 1 } }, request: { body } }
    await controller.setFavorite(ctx)
    expect(ctx.status).toBe(400)
    expect(getUserWorkspaceDirectories(1).directories).toEqual([])
  })
})
