import { isSessionUploadAttachment } from '../files/session-uploads'
import { createHash } from 'node:crypto'
import { lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { SessionShareError, type SessionShareAction, type SessionShareAppUser, type SessionShareRecord } from '../../contracts/session-shares'
import type { AuthenticatedUser } from '../../middleware/auth'
import { findUserById, listUserProfiles } from '../../repositories/users-store'
import { getSession } from '../../repositories/session-store'
import { getProfileUploadDir } from '../files/upload-paths'
import { isPathWithin, isNearestExistingRealPathWithin } from '../files/path'
import { shareAppIdentityVerifier } from './app-identity'
import { sessionShareService } from './service'

/** Internal request context. Never serialize credentials into responses or run events. */
export interface SessionShareAccess {
  token: string
  appAccessToken: string
  actor: SessionShareAppUser
  share: SessionShareRecord
}

export function socketShareToken(auth: Record<string, unknown> = {}): string {
  if (auth.shareToken !== undefined) return String(auth.shareToken || 'invalid-share-token')
  return typeof auth.token === 'string' && auth.token.startsWith('sst1_') ? auth.token : ''
}

export async function authenticateSessionShare(token: string, appAccessToken: string): Promise<SessionShareAccess> {
  const actor = await shareAppIdentityVerifier.verify(appAccessToken, token)
  const { share } = sessionShareService.authorize(token, actor, 'read')
  return { token, appAccessToken, actor, share }
}

export function authorizeSessionShare(access: SessionShareAccess, action: SessionShareAction, sessionId = access.share.session_id) {
  const { share } = sessionShareService.authorize(access.token, access.actor, action, sessionId)
  access.share = share
  return share
}

export async function refreshSessionShare(access: SessionShareAccess, action: SessionShareAction, sessionId = access.share.session_id) {
  const actor = await shareAppIdentityVerifier.verify(access.appAccessToken, access.token)
  if (actor.id !== access.actor.id) throw new SessionShareError('share_recipient_required')
  return authorizeSessionShare(access, action, sessionId)
}

/** Execution still uses the existing host account; this is not an App login. */
export function sessionShareExecutionUser(access: SessionShareAccess): AuthenticatedUser {
  authorizeSessionShare(access, 'read')
  const owner = findUserById(access.share.created_by_user_id)!
  return { id: owner.id, username: owner.username, role: owner.role,
    profiles: owner.role === 'super_admin' ? undefined : listUserProfiles(owner.id).map(row => row.profile_name) }
}

export function assertShareProfile(access: SessionShareAccess, ...profiles: unknown[]) {
  if (profiles.some(profile => profile !== undefined && profile !== null && profile !== '' && profile !== access.share.profile)) {
    throw new SessionShareError('share_profile_mismatch')
  }
}

export function watchSessionShare(access: SessionShareAccess, action: SessionShareAction, onInvalid: () => void): () => void {
  let disposed = false
  let checking = false
  let stopPolicy: () => void = () => undefined
  const dispose = () => { disposed = true; clearInterval(timer); stopPolicy() }
  const invalid = () => { if (!disposed) { dispose(); onInvalid() } }
  const timer = setInterval(() => {
    if (checking || disposed) return
    checking = true
    void refreshSessionShare(access, action).catch(invalid).finally(() => { checking = false })
  }, 1000)
  timer.unref()
  try { stopPolicy = sessionShareService.watch(access.token, access.actor, action, invalid) } catch { invalid() }
  return dispose
}

export function sessionShareUploadDir(access: SessionShareAccess): string {
  return join(getProfileUploadDir(access.share.profile), 'session-shares', createHash('sha256').update(access.share.session_id).digest('hex'))
}

async function shareUploadRootIsSafe(access: SessionShareAccess): Promise<boolean> {
  const root = sessionShareUploadDir(access)
  // These server-owned directory components must not alias another session.
  for (const path of [dirname(root), root]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (info && (!info.isDirectory() || info.isSymbolicLink())) return false
  }
  return true
}

export async function authorizeShareUpload(access: SessionShareAccess): Promise<string> {
  authorizeSessionShare(access, 'upload')
  await mkdir(getProfileUploadDir(access.share.profile), { recursive: true })
  const directory = sessionShareUploadDir(access)
  if (!await shareUploadRootIsSafe(access) || !await isNearestExistingRealPathWithin(directory, getProfileUploadDir(access.share.profile))) {
    throw new SessionShareError('share_path_forbidden')
  }
  authorizeSessionShare(access, 'upload')
  return directory
}

export async function authorizeShareFile(access: SessionShareAccess, action: 'workspaceRead' | 'workspaceWrite' | 'download', path: string): Promise<string> {
  authorizeSessionShare(access, action)
  if (action === 'workspaceWrite') return (await sessionShareService.authorizePath(access.token, access.actor, action, path)).fullPath
  const fullPath = resolve(access.share.workspace_root || '.', path)
  const root = sessionShareUploadDir(access)
  if (dirname(fullPath) === root && isPathWithin(fullPath, root) && await shareUploadRootIsSafe(access)
    && await isNearestExistingRealPathWithin(fullPath, root)
    && await isNearestExistingRealPathWithin(root, getProfileUploadDir(access.share.profile))
    && !fullPath.split(/[\\/]/).pop()?.startsWith('.')
    && await lstat(fullPath).then(info => info.isFile() && !info.isSymbolicLink()).catch(() => false)) {
    authorizeSessionShare(access, action)
    return fullPath
  }
  if (await isSessionUploadAttachment(access.share.session_id, access.share.profile, fullPath)) {
    authorizeSessionShare(access, action)
    return fullPath
  }
  return (await sessionShareService.authorizePath(access.token, access.actor, action, path)).fullPath
}

export async function authorizeShareDownload(access: SessionShareAccess, path: string): Promise<string> {
  return authorizeShareFile(access, 'download', path)
}

/** Retain the existing run API, but derive execution configuration from the bound session. */
export function prepareSessionShareRun(access: SessionShareAccess, data: Record<string, any>): void {
  if (typeof data.session_id !== 'string') throw new SessionShareError('share_session_required', 400)
  authorizeSessionShare(access, 'input', data.session_id)
  assertShareProfile(access, data.profile)
  const session = getSession(access.share.session_id)!
  if (data.workspace !== undefined && data.workspace !== session.workspace) throw new SessionShareError('share_workspace_changed')
  const source = ['coding_agent', 'global_agent', 'cli'].includes(session.source) ? session.source : 'cli'
  if (data.source !== undefined && data.source !== session.source && data.source !== source) throw new SessionShareError('share_session_mismatch')
  // Session-management slash commands can branch, clear or switch sessions.
  if (typeof data.input === 'string' && /^\s*\//.test(data.input)) throw new SessionShareError('share_session_command_forbidden')
  const input = data.input
  const queueId = typeof data.queue_id === 'string' ? data.queue_id : undefined
  for (const key of Object.keys(data)) delete data[key]
  Object.assign(data, { input, session_id: session.id, queue_id: queueId, profile: access.share.profile,
    source, workspace: session.workspace, model: session.model || undefined,
    provider: session.provider || undefined })
  if (session.agent && session.agent !== 'hermes') data.coding_agent_id = session.agent.replace('ekko_agent', 'ekko-agent')
  if (session.agent_mode) data.mode = session.agent_mode
  if (session.api_mode) data.apiMode = session.api_mode
  if (session.reasoning_effort) data.reasoning_effort = session.reasoning_effort
}
