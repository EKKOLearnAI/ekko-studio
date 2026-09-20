import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publicSessionShare, SESSION_SHARE_LIFETIME_MS } from '../../packages/server/src/modules/studio/contracts/session-shares'

describe('session share grants', () => {
  let db: DatabaseSync
  let service: any
  let store: any
  let now: number
  let root: string
  let session: any
  let owner: any
  let permitted: boolean
  const sender = { id: 101, name: 'Alice' }
  const recipient = { id: 202, name: 'Bob' }
  const other = { id: 303, name: 'Mallory' }
  const disposers: (() => void)[] = []

  beforeEach(async () => {
    vi.resetModules()
    now = Date.now()
    root = await mkdtemp(join(tmpdir(), 'session-share-'))
    session = { id: 'session-1', profile: 'default', workspace: root }
    owner = { id: 7, role: 'super_admin', status: 'active' }
    permitted = true
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, getStoragePath: () => ':memory:' }))
    const schemas = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    schemas.initAllHermesTables()
    store = (await import('../../packages/server/src/modules/studio/repositories/session-shares-store')).sessionSharesStore
    const { SessionShareService } = await import('../../packages/server/src/modules/studio/services/session-shares/service')
    service = new SessionShareService({ store, now: () => now,
      session: (id: string) => id === session?.id ? session : null,
      owner: (id: number) => id === owner?.id ? owner : null, canAccessProfile: () => permitted })
  })

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose()
    vi.useRealTimers()
    db.close()
    await rm(root, { recursive: true, force: true })
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function issued(permissions: Record<string, boolean> = {}) {
    return service.create(7, sender, 'session-1', { permissions })
  }

  it('upgrades an existing share table before creating new invitations and keeps legacy paths closed', async () => {
    const legacy = await issued({ workspaceRead: true })
    service.claim(legacy.token, recipient)
    db.exec('ALTER TABLE session_shares DROP COLUMN workspace_real_root')
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    initAllHermesTables()
    expect((db.prepare('PRAGMA table_info(session_shares)').all() as any[])
      .find(column => column.name === 'workspace_real_root')).toMatchObject({ notnull: 1, dflt_value: "''" })
    expect(store.find(legacy.record.id).workspace_real_root).toBe('')
    await expect(service.authorizePath(legacy.token, recipient, 'workspaceRead', root)).rejects.toThrow('share_workspace_required')
    const created = await issued({ workspaceRead: true })
    expect(store.find(created.record.id).workspace_real_root).toBeTruthy()
    expect(service.list(7, 'session-1')).toHaveLength(2)
  })

  it('creates independent records with hashed tokens, fixed thirty-day expiry and deny-by-default permissions', async () => {
    const first = await issued()
    const second = await issued()
    expect(first.token).toMatch(/^sst1_[A-Za-z0-9_-]{43}$/)
    expect(second.token).not.toBe(first.token)
    expect(second.record.id).not.toBe(first.record.id)
    expect(first.record.expires_at).toBe(now + SESSION_SHARE_LIFETIME_MS)
    expect(Object.values(first.record.permissions)).toEqual(Array(10).fill(false))
    expect(first.record).toMatchObject({ sharer_app_user_id: sender.id, sharer_name_snapshot: 'Alice', recipient_app_user_id: null })
    const rows = db.prepare('SELECT * FROM session_shares').all()
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain(first.token)
    expect(first.record.token_hash).toHaveLength(64)
    expect(publicSessionShare(first.record)).not.toHaveProperty('token_hash')
    expect(publicSessionShare(first.record)).not.toHaveProperty('workspace_root')
  })

  it('requires explicit outside-directory grants for workspace changes without rebasing other shares', async () => {
    const initial = join(root, 'initial'), extra = join(root, 'extra'), child = join(extra, 'child')
    await mkdir(initial); await mkdir(child, { recursive: true })
    session.workspace = initial
    const { token, record } = await service.create(7, sender, session.id, { permissions: { switchWorkspace: true, input: true }, extraPaths: [{ path: extra, writable: false }] })
    service.claim(token, recipient)
    expect(() => service.authorizeWorkspaceSwitch(token, recipient, child)).toThrow('share_path_forbidden')
    await service.change(7, session.id, record.id, { permissions: { outsideWorkspace: true } })
    expect(service.authorizeWorkspaceSwitch(token, recipient, child)).toBe(child)
    session.workspace = child
    expect(service.authorize(token, recipient, 'input').share.workspace_root).toBe(initial)
    expect(service.authorizeWorkspaceSwitch(token, recipient, initial)).toBe(initial)
    expect(() => service.authorizeWorkspaceSwitch(token, recipient, root)).toThrow('share_path_forbidden')
    await service.change(7, session.id, record.id, { permissions: { outsideWorkspace: false } })
    expect(() => service.authorize(token, recipient, 'input')).toThrow('share_workspace_changed')
    expect(() => service.authorizeWorkspaceSwitch(token, recipient, child)).toThrow('share_path_forbidden')
  })

  it('rejects group and workflow sessions and invalidates a session whose source changes', async () => {
    const { token } = await issued({ input: true })
    service.claim(token, recipient)
    for (const source of ['group_chat', 'workflow']) {
      session.source = source
      await expect(issued()).rejects.toThrow('share_session_unavailable')
      expect(() => service.authorize(token, recipient, 'read')).toThrow('share_session_unavailable')
    }
  })

  it('initializes its schema and indexes idempotently', async () => {
    const original = await issued()
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
    expect(store.find(original.record.id)).toEqual(original.record)
    expect(db.prepare('PRAGMA index_list(session_shares)').all().map((r: any) => r.name)).toContain('uniq_session_shares_token')
  })

  it('only one recipient wins a claim, and retrying as that account preserves binding and expiry', async () => {
    const { record, token } = await issued()
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_recipient_required')
    now += 1000
    const claim = service.claim(token, recipient)
    now += 5000
    const retry = service.claim(token, { ...recipient, name: 'Renamed Bob' })
    expect(retry).toEqual(claim)
    expect(claim.recipient_name_snapshot).toBe('Bob')
    expect(claim.claimed_at).toBe(record.created_at + 1000)
    expect(claim.expires_at).toBe(record.expires_at)
    expect(() => service.claim(token, other)).toThrow('share_already_claimed')
    expect(() => service.authorize(token, other, 'read')).toThrow('share_recipient_required')
  })

  it('enforces the compare-and-set across different service instances sharing the database', async () => {
    const { record } = await issued()
    const first = store.claim(record.id, recipient, now)
    const second = store.claim(record.id, other, now)
    expect(first.recipient_app_user_id).toBe(recipient.id)
    expect(second.recipient_app_user_id).toBe(recipient.id)
  })

  it('rejects wrong sessions, wrong resource ownership, invalid tokens and unknown actions', async () => {
    const { token } = await issued({ input: true })
    service.claim(token, recipient)
    expect(() => service.authorize(token, recipient, 'read', 'another-session')).toThrow('share_session_mismatch')
    expect(() => service.authorizeResource(token, recipient, 'input', { sessionId: 'another-session' })).toThrow('share_session_mismatch')
    expect(() => service.authorize('guess', recipient, 'read')).toThrow('share_not_found')
    expect(() => service.authorize(token, recipient, 'admin')).toThrow('share_unknown_action')
    expect(() => service.authorize(token, recipient, 'upload')).toThrow('share_permission_denied')
    expect(service.authorize(token, recipient, 'input').share.session_id).toBe('session-1')
  })

  it('rejects unknown, non-boolean and overbroad external path permissions', async () => {
    await expect(issued({ admin: true })).rejects.toThrow('share_invalid_permissions')
    await expect(issued({ input: 'yes' } as any)).rejects.toThrow('share_invalid_permissions')
    await expect(issued({ outsideWorkspace: true })).rejects.toThrow('share_extra_paths_required')
    owner.role = 'admin'
    await expect(service.create(7, sender, 'session-1', { extraPaths: [{ path: root, writable: false }] })).rejects.toThrow('share_extra_paths_forbidden')
  })

  it('caches only immutable permission snapshots and reloads after ten seconds', async () => {
    const { token } = await issued()
    service.claim(token, recipient)
    const lookup = vi.spyOn(store, 'findByHash')
    const first = service.authorize(token, recipient, 'read')
    first.share.permissions.input = true
    expect(() => service.authorize(token, recipient, 'input')).toThrow('share_permission_denied')
    service.authorize(token, recipient, 'read')
    expect(lookup).toHaveBeenCalledTimes(1)
    now += 10_001
    service.authorize(token, recipient, 'read')
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it('invalidates cached permissions immediately and retains expiry on updates', async () => {
    const { token, record } = await issued({ terminal: true })
    service.claim(token, recipient)
    const invalid = vi.fn()
    disposers.push(service.watch(token, recipient, 'terminal', invalid))
    service.authorize(token, recipient, 'terminal')
    const changed = await service.change(7, 'session-1', record.id, { permissions: { terminal: false, input: true } })
    expect(invalid).toHaveBeenCalledTimes(1)
    expect(() => service.authorize(token, recipient, 'terminal')).toThrow('share_permission_denied')
    expect(service.authorize(token, recipient, 'input').share.policy_version).toBe(3)
    expect(changed.expires_at).toBe(record.expires_at)
  })

  it('revokes active watchers immediately and retains the record; repeated revoke is idempotent', async () => {
    const { token, record } = await issued()
    service.claim(token, recipient)
    const invalid = vi.fn()
    disposers.push(service.watch(token, recipient, 'read', invalid))
    const revoked = await service.change(7, 'session-1', record.id, { revoke: true })
    expect(invalid).toHaveBeenCalledTimes(1)
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_revoked')
    expect(() => service.claim(token, recipient)).toThrow('share_revoked')
    expect(await service.change(7, 'session-1', record.id, { revoke: true })).toEqual(revoked)
    expect(store.find(record.id)).not.toBeNull()
  })

  it('expires claimed and unclaimed records at the exact boundary and notifies idle watchers', async () => {
    const { token, record } = await issued()
    const unclaimed = await issued()
    service.claim(token, recipient)
    vi.useFakeTimers()
    const invalid = vi.fn()
    disposers.push(service.watch(token, recipient, 'read', invalid))
    now = record.expires_at
    vi.advanceTimersByTime(1000)
    expect(invalid).toHaveBeenCalledTimes(1)
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_expired')
    expect(() => service.claim(unclaimed.token, recipient)).toThrow('share_expired')
  })

  it('uses local ownership rather than App attribution to manage records', async () => {
    const { record } = await issued()
    const second = await service.create(7, other, 'session-1')
    expect(service.list(7, 'session-1').map((row: any) => row.id)).toEqual(expect.arrayContaining([record.id, second.record.id]))
    await expect(service.change(7, 'session-1', second.record.id, { revoke: true })).resolves.toMatchObject({ revoked_at: now })
    expect(service.list(7, 'session-1').map((row: any) => row.id)).toEqual([record.id])
    expect(store.find(second.record.id)).toMatchObject({ revoked_at: now })
    await expect(service.change(8, 'session-1', record.id, { revoke: true })).rejects.toThrow('share_session_unavailable')
    // Even a different active Studio user with access to the same session
    // cannot manage a record created by this owner.
    owner.id = 8
    expect(service.list(8, 'session-1')).toEqual([])
    await expect(service.change(8, 'session-1', record.id, { revoke: true })).rejects.toThrow('share_not_found')
  })

  it('fails closed when session disappears or owner loses account/profile access, even with a warm cache', async () => {
    const { token } = await issued()
    service.claim(token, recipient)
    service.authorize(token, recipient, 'read')
    owner.status = 'disabled'
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_session_unavailable')
    owner.status = 'active'; owner.role = 'admin'; permitted = false
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_session_unavailable')
    permitted = true; session = null
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_session_unavailable')
  })

  it('pins the session profile and workspace instead of silently expanding authority', async () => {
    const { token } = await issued({ input: true, workspaceRead: true })
    service.claim(token, recipient)
    session.workspace = join(root, 'other')
    expect(() => service.authorize(token, recipient, 'input')).toThrow('share_workspace_changed')
    expect(service.authorize(token, recipient, 'read')).toBeTruthy()
    session.profile = 'other'
    expect(() => service.authorize(token, recipient, 'read')).toThrow('share_session_changed')
  })

  it('contains paths and symlinks, and never treats upload or terminal permission as workspace read access', async () => {
    await mkdir(join(root, 'workspace'))
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret'), 'test fixture')
    await symlink(join(root, 'outside'), join(root, 'workspace', 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    session.workspace = join(root, 'workspace')
    const { token } = await issued({ workspaceRead: true, workspaceWrite: true })
    service.claim(token, recipient)
    expect((await service.authorizePath(token, recipient, 'workspaceWrite', 'new-file')).fullPath).toBe(join(root, 'workspace', 'new-file'))
    await expect(service.authorizePath(token, recipient, 'workspaceRead', '../outside/secret')).rejects.toThrow('share_path_forbidden')
    await expect(service.authorizePath(token, recipient, 'workspaceRead', 'escape/secret')).rejects.toThrow('share_path_forbidden')
    await expect(service.authorizePath(token, recipient, 'download', 'new-file')).rejects.toThrow('share_permission_denied')
    const onlyUpload = await issued({ upload: true, terminal: true })
    service.claim(onlyUpload.token, recipient)
    await expect(service.authorizePath(onlyUpload.token, recipient, 'workspaceRead', 'new-file')).rejects.toThrow('share_permission_denied')
  })

  it('allows only explicitly granted extra roots and respects read-only extra paths', async () => {
    await mkdir(join(root, 'workspace')); await mkdir(join(root, 'extra')); await mkdir(join(root, 'other'))
    session.workspace = join(root, 'workspace')
    const { token } = await service.create(7, sender, 'session-1', {
      permissions: { outsideWorkspace: true, workspaceRead: true, workspaceWrite: true },
      extraPaths: [{ path: join(root, 'extra'), writable: false }],
    })
    service.claim(token, recipient)
    await expect(service.authorizePath(token, recipient, 'workspaceRead', join(root, 'extra', 'file'))).resolves.toBeTruthy()
    await expect(service.authorizePath(token, recipient, 'workspaceWrite', join(root, 'extra', 'file'))).rejects.toThrow('share_path_forbidden')
    await expect(service.authorizePath(token, recipient, 'workspaceRead', join(root, 'other', 'file'))).rejects.toThrow('share_path_forbidden')
  })

  it('denies known runtime credential paths even when workspace access is granted', async () => {
    const { token } = await issued({ workspaceRead: true, download: true })
    service.claim(token, recipient)
    for (const path of ['.env', '.env.production', '.token', '.model-run-token', 'folder/auth.json', '.ssh/id_rsa']) {
      await expect(service.authorizePath(token, recipient, 'workspaceRead', path)).rejects.toThrow('share_path_forbidden')
    }
  })

  it('rejects a workspace root retargeted after the invitation was created', async () => {
    await mkdir(join(root, 'first')); await mkdir(join(root, 'second'))
    const link = join(root, 'workspace-link')
    await symlink(join(root, 'first'), link, process.platform === 'win32' ? 'junction' : 'dir')
    session.workspace = link
    const { token } = await issued({ workspaceRead: true })
    service.claim(token, recipient)
    await expect(service.authorizePath(token, recipient, 'workspaceRead', 'file')).resolves.toBeTruthy()
    await rm(link)
    await symlink(join(root, 'second'), link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.authorizePath(token, recipient, 'workspaceRead', 'file')).rejects.toThrow('share_workspace_changed')
  })

  it('does not overwrite a claim committed while a manager update was preparing', async () => {
    const { record, token } = await issued()
    const original = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementation((next: any, version: number) => {
      service.claim(token, recipient)
      return original(next, version)
    })
    await expect(service.change(7, 'session-1', record.id, { permissions: { input: true } })).rejects.toThrow('share_policy_conflict')
    expect(store.find(record.id)).toMatchObject({ recipient_app_user_id: recipient.id, permissions: { input: false } })
  })
})
