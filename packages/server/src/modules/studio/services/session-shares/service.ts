import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  SESSION_SHARE_CACHE_MS, SESSION_SHARE_LIFETIME_MS, SESSION_SHARE_PERMISSION_KEYS,
  SessionShareError, sharePermissions,
  type SessionShareRecord, type SessionShareAppUser, type SessionShareAction, type SessionShareExtraPath,
} from '../../contracts/session-shares'
import { sessionSharesStore } from '../../repositories/session-shares-store'
import { getSession } from '../../repositories/session-store'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { isPathWithin, isNearestExistingRealPathWithin } from '../files/path'

interface ShareOwner { id: number; role: string; status: string }
interface ShareSession { id: string; profile: string; workspace: string | null; source?: string }
export interface ShareDependencies {
  store: typeof sessionSharesStore
  session: (id: string) => ShareSession | null
  owner: (id: number) => ShareOwner | null
  canAccessProfile: (id: number, profile: string) => boolean
  now: () => number
}

export interface ShareAuthorization {
  share: SessionShareRecord
  action: SessionShareAction
}

function tokenHash(token: string): string {
  if (!/^sst1_[A-Za-z0-9_-]{43}$/.test(token)) throw new SessionShareError('share_not_found', 404)
  return createHash('sha256').update(token).digest('hex')
}

function assertActor(actor: SessionShareAppUser) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || typeof actor.name !== 'string') {
    throw new SessionShareError('share_app_login_required', 401)
  }
}

export class SessionShareService {
  private readonly cache = new Map<string, { record: SessionShareRecord; until: number }>()
  private readonly observers = new Map<string, Set<() => void>>()
  constructor(private readonly deps: ShareDependencies = {
    store: sessionSharesStore, session: id => getSession(id), owner: id => findUserById(id),
    canAccessProfile: (id, profile) => userCanAccessProfile(id, profile), now: Date.now,
  }) {}

  private assertOwnerSession(ownerId: number, sessionId: string) {
    const session = this.deps.session(sessionId)
    const owner = this.deps.owner(ownerId)
    if (!session || ['workflow', 'group_chat'].includes(session.source || '') || !owner || owner.status !== 'active'
      || (owner.role !== 'super_admin' && !this.deps.canAccessProfile(ownerId, session.profile || 'default'))) {
      throw new SessionShareError('share_session_unavailable', 403)
    }
    return { session, owner }
  }

  private assertActive(record: SessionShareRecord) {
    if (record.revoked_at !== null) throw new SessionShareError('share_revoked', 410)
    if (record.expires_at <= this.deps.now()) throw new SessionShareError('share_expired', 410)
    const { session } = this.assertOwnerSession(record.created_by_user_id, record.session_id)
    if ((session.profile || 'default') !== record.profile) throw new SessionShareError('share_session_changed', 403)
    return session
  }

  private byToken(token: string, fresh = false): SessionShareRecord {
    const hash = tokenHash(token)
    const cached = this.cache.get(hash)
    if (!fresh && cached && cached.until > this.deps.now()) return structuredClone(cached.record)
    this.cache.delete(hash)
    const record = this.deps.store.findByHash(hash)
    if (!record) throw new SessionShareError('share_not_found', 404)
    // Loading is synchronous; a committed update cannot race an in-flight
    // asynchronous read and repopulate this cache with an older policy.
    if (this.cache.size >= 1024) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(hash, { record: structuredClone(record), until: Math.min(this.deps.now() + SESSION_SHARE_CACHE_MS, record.expires_at) })
    return record
  }

  private invalidate(record: SessionShareRecord) {
    this.cache.delete(record.token_hash)
    for (const callback of [...this.observers.get(record.id) || []]) {
      try { callback() } catch { /* A consumer must not block policy invalidation. */ }
    }
  }

  private async extraPaths(value: unknown, superAdmin: boolean): Promise<SessionShareExtraPath[]> {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 16) throw new SessionShareError('share_invalid_paths', 400)
    if (value.length && !superAdmin) throw new SessionShareError('share_extra_paths_forbidden', 403)
    const paths: SessionShareExtraPath[] = []
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['path', 'writable'].includes(key))
        || typeof entry.path !== 'string' || !isAbsolute(entry.path) || entry.path.length > 4096 || typeof entry.writable !== 'boolean') {
        throw new SessionShareError('share_invalid_paths', 400)
      }
      const path = await realpath(entry.path).catch(() => '')
      if (!path || !await stat(path).then(info => info.isDirectory()).catch(() => false)) throw new SessionShareError('share_invalid_paths', 400)
      paths.push({ path: resolve(entry.path), realPath: path, writable: entry.writable })
    }
    return paths
  }

  async create(ownerId: number, actor: SessionShareAppUser, sessionId: string, input: { permissions?: unknown; extraPaths?: unknown } = {}) {
    assertActor(actor)
    let context = this.assertOwnerSession(ownerId, sessionId)
    const permissions = sharePermissions(input.permissions)
    const extraPaths = await this.extraPaths(input.extraPaths, context.owner.role === 'super_admin')
    if (permissions.outsideWorkspace && !extraPaths.length) throw new SessionShareError('share_extra_paths_required', 400)
    const workspaceRoot = context.session.workspace ? resolve(context.session.workspace) : ''
    const workspaceRealRoot = workspaceRoot ? await realpath(workspaceRoot).catch(() => '') : ''
    // Recheck after filesystem IO: the session or owner may have changed.
    context = this.assertOwnerSession(ownerId, sessionId)
    if ((context.session.workspace ? resolve(context.session.workspace) : '') !== workspaceRoot) throw new SessionShareError('share_workspace_changed', 409)
    if (extraPaths.length && context.owner.role !== 'super_admin') throw new SessionShareError('share_extra_paths_forbidden', 403)
    const now = this.deps.now()
    const token = `sst1_${randomBytes(32).toString('base64url')}`
    const record: SessionShareRecord = {
      id: randomUUID(), session_id: sessionId, profile: context.session.profile || 'default',
      created_by_user_id: ownerId, sharer_app_user_id: actor.id, sharer_name_snapshot: actor.name.slice(0, 200),
      recipient_app_user_id: null, recipient_name_snapshot: null, token_hash: tokenHash(token),
      permissions, workspace_root: workspaceRoot, workspace_real_root: workspaceRealRoot, extra_paths: extraPaths,
      policy_version: 1, created_at: now, updated_at: now, expires_at: now + SESSION_SHARE_LIFETIME_MS,
      claimed_at: null, revoked_at: null,
    }
    this.deps.store.insert(record)
    return { record, token }
  }

  list(ownerId: number, sessionId: string) {
    this.assertOwnerSession(ownerId, sessionId)
    return this.deps.store.list(sessionId, ownerId)
  }

  claim(token: string, actor: SessionShareAppUser): SessionShareRecord {
    assertActor(actor)
    const record = this.byToken(token, true)
    this.assertActive(record)
    const claimed = this.deps.store.claim(record.id, actor, this.deps.now())
    this.invalidate(record)
    if (!claimed) throw new SessionShareError('share_not_found', 404)
    this.assertActive(claimed)
    if (claimed.recipient_app_user_id !== actor.id) throw new SessionShareError('share_already_claimed', 409)
    return claimed
  }

  async change(ownerId: number, sessionId: string, shareId: string,
    input: { permissions?: unknown; extraPaths?: unknown; revoke?: boolean }): Promise<SessionShareRecord> {
    this.assertOwnerSession(ownerId, sessionId)
    const record = this.deps.store.find(shareId)
    if (!record || record.session_id !== sessionId || record.created_by_user_id !== ownerId) {
      throw new SessionShareError('share_not_found', 404)
    }
    if (input.revoke && record.revoked_at !== null) return record
    if (!input.revoke) this.assertActive(record)
    const permissions = sharePermissions(input.permissions, record.permissions)
    const extraPaths = input.extraPaths === undefined ? record.extra_paths
      : await this.extraPaths(input.extraPaths, this.deps.owner(ownerId)?.role === 'super_admin')
    const { owner } = this.assertOwnerSession(ownerId, sessionId)
    if (!input.revoke && extraPaths.length && owner.role !== 'super_admin') throw new SessionShareError('share_extra_paths_forbidden', 403)
    if (permissions.outsideWorkspace && !extraPaths.length) throw new SessionShareError('share_extra_paths_required', 400)
    const next = { ...record, permissions, extra_paths: extraPaths, updated_at: this.deps.now(), revoked_at: input.revoke ? this.deps.now() : record.revoked_at }
    if (!this.deps.store.update(next, record.policy_version)) throw new SessionShareError('share_policy_conflict', 409)
    this.invalidate(record)
    return this.deps.store.find(shareId)!
  }

  authorize(token: string, actor: SessionShareAppUser, action: SessionShareAction, sessionId?: string): ShareAuthorization {
    assertActor(actor)
    if (action !== 'read' && !SESSION_SHARE_PERMISSION_KEYS.includes(action)) throw new SessionShareError('share_unknown_action', 400)
    const record = this.byToken(token)
    const session = this.assertActive(record)
    if (record.recipient_app_user_id !== actor.id) throw new SessionShareError('share_recipient_required', 403)
    if (sessionId !== undefined && sessionId !== record.session_id) throw new SessionShareError('share_session_mismatch', 403)
    if (action === 'terminal' && this.deps.owner(record.created_by_user_id)?.role !== 'super_admin') throw new SessionShareError('share_terminal_forbidden')
    if (action !== 'read' && !record.permissions[action]) throw new SessionShareError('share_permission_denied', 403)
    if (action !== 'read' && action !== 'switchWorkspace' && (session.workspace ? resolve(session.workspace) : '') !== record.workspace_root) {
      if (!record.permissions.switchWorkspace || !this.workspaceWithinGrant(record, session.workspace || '')) {
        throw new SessionShareError('share_workspace_changed', 403)
      }
    }
    if (record.permissions.outsideWorkspace && this.deps.owner(record.created_by_user_id)?.role !== 'super_admin'
      && action !== 'read') throw new SessionShareError('share_extra_paths_forbidden', 403)
    return { share: record, action }
  }

  private workspaceWithinGrant(share: SessionShareRecord, path: string): boolean {
    const sensitive = (value: string) => value.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part)
      || ['.token', '.model-run-token', 'auth.json', '.ssh', '.aws', '.gnupg'].includes(part.toLowerCase()))
    if (!path || path.length > 4096 || !isAbsolute(path) || sensitive(path)) return false
    const roots = [{ path: share.workspace_root, real: share.workspace_real_root },
      ...(share.permissions.outsideWorkspace ? share.extra_paths.map(root => ({ path: root.path, real: root.realPath })) : [])]
    try {
      const actual = realpathSync(path)
      return !sensitive(actual) && statSync(path).isDirectory() && roots.some(root => {
        try {
          return root.path && root.real && realpathSync(root.path) === root.real
            && isPathWithin(resolve(path), root.path) && isPathWithin(actual, root.real)
        } catch { return false }
      })
    } catch { return false }
  }

  authorizeWorkspaceSwitch(token: string, actor: SessionShareAppUser, path: unknown): string {
    const { share } = this.authorize(token, actor, 'switchWorkspace')
    if (typeof path !== 'string' || !this.workspaceWithinGrant(share, path)) throw new SessionShareError('share_path_forbidden')
    return resolve(path)
  }

  /** Called with a server-resolved resource owner, never an unverified request ID. */
  authorizeResource(token: string, actor: SessionShareAppUser, action: SessionShareAction, resource: { sessionId: string }) {
    return this.authorize(token, actor, action, resource.sessionId)
  }

  async authorizePath(token: string, actor: SessionShareAppUser, action: 'workspaceRead' | 'workspaceWrite' | 'download', path: string) {
    const { share } = this.authorize(token, actor, action)
    if (!path || path.length > 4096 || path.includes('\0')) throw new SessionShareError('share_invalid_path', 400)
    if (!share.workspace_root || !share.workspace_real_root) throw new SessionShareError('share_workspace_required', 403)
    if (await realpath(share.workspace_root).catch(() => '') !== share.workspace_real_root) {
      throw new SessionShareError('share_workspace_changed', 403)
    }
    const fullPath = resolve(this.deps.session(share.session_id)?.workspace || share.workspace_root, path)
    // A directory grant never turns runtime credentials into shareable files.
    if (fullPath.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part)
      || ['.token', '.model-run-token', 'auth.json', '.ssh', '.aws', '.gnupg'].includes(part.toLowerCase()))) {
      throw new SessionShareError('share_path_forbidden', 403)
    }
    const roots = [{ path: share.workspace_root, writable: true, real: share.workspace_real_root },
      ...(share.permissions.outsideWorkspace ? share.extra_paths.map(root => ({ ...root, real: root.realPath })) : [])]
    let allowed = false
    for (const root of roots) {
      if (action === 'workspaceWrite' && !root.writable) continue
      if (await realpath(root.path).catch(() => '') !== root.real) continue
      if (isPathWithin(fullPath, root.path) && await isNearestExistingRealPathWithin(fullPath, root.path)) { allowed = true; break }
    }
    if (!allowed) throw new SessionShareError('share_path_forbidden', 403)
    const current = this.authorize(token, actor, action, share.session_id).share
    if (current.policy_version !== share.policy_version) throw new SessionShareError('share_policy_changed', 409)
    return { fullPath, share: current }
  }

  /** Rechecks on policy changes and time expiry. Consumers close their own
   * Socket/PTY/stream when invalidated; a lease is never a substitute for checking
   * each command. Returns a disposer for normal disconnect/finish. */
  watch(token: string, actor: SessionShareAppUser, action: SessionShareAction, onInvalid: (reason: unknown) => void): () => void {
    const initial = this.authorize(token, actor, action).share
    let closed = false
    const callbacks = this.observers.get(initial.id) || new Set<() => void>()
    this.observers.set(initial.id, callbacks)
    const dispose = () => {
      if (closed) return
      closed = true
      clearInterval(timer)
      callbacks.delete(check)
      if (!callbacks.size) this.observers.delete(initial.id)
    }
    const check = () => {
      if (closed) return
      try {
        const current = this.authorize(token, actor, action).share
        if (current.policy_version !== initial.policy_version) throw new SessionShareError('share_policy_changed', 409)
      } catch (error) { dispose(); onInvalid(error) }
    }
    const timer = setInterval(check, 1000)
    timer.unref()
    callbacks.add(check)
    return dispose
  }
}

export const sessionShareService = new SessionShareService()
