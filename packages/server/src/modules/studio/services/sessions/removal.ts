import { StudioError, type SessionRemovalResult, type ExecutionScope } from '../../contracts/plugins'
import { isNativeCodingAgent } from '../../contracts/agents/native-coding-agents'
import { isBuiltinEkkoAgent } from '../../contracts/history-source'
import { getSession, deleteSession } from '../../public/sessions'
import { deleteHermesSessionForProfile, getExactHermesSessionDetailForProfile, stopCodingAgentSessionRun } from '../../public/session-agent-runtime'
import { listProfileNamesFromDisk } from '../../public/profile-config'
import { isHermesAgentAvailable } from '../../public/agent-status-registry'
import { logger } from '../../public/logging'
import { publishSessionRemoval } from '../notifications/session-removal'
import { randomUUID } from 'node:crypto'
import { beforeSessionRemoval } from './removal-hook'

/** Supplied by a trusted HTTP entrypoint or execution-context factory, never by a plugin. */
export interface SessionRemovalAccess {
  authorize(profileId: string): void | Promise<void>
  signal?: AbortSignal
  sessionId?: string
  fallbackProfile?: string
  scope?(profileId: string): ExecutionScope
}

export class SessionRemovalError extends StudioError {
  constructor(message: string, readonly native: SessionRemovalResult['native']) {
    super('INTERNAL', message)
  }
}

export function isProviderAgentSession(session?: { source?: string | null; agent?: string | null; agent_session_id?: string | null } | null): boolean {
  return session?.source === 'builtin_agent' || isBuiltinEkkoAgent(session?.agent) || session?.source === 'coding_agent' ||
    ['claude', 'codex', 'pi', 'grok', 'opencode', 'cursor', 'antigravity'].includes(session?.agent || '') ||
    isNativeCodingAgent(session?.agent) || Boolean(session?.agent_session_id)
}

const removals = new Map<string, Promise<void>>()

/** Serialize removal of the same local ID, including calls from different transports. */
export async function removeStudioSession(
  input: { id: string; profileId?: string }, access: SessionRemovalAccess,
): Promise<SessionRemovalResult> {
  if (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 256) throw new StudioError('INVALID_ARGUMENT', 'Invalid session id')
  if (input.profileId !== undefined && (typeof input.profileId !== 'string' || !input.profileId.trim())) throw new StudioError('INVALID_ARGUMENT', 'Invalid profile')
  if (access.sessionId && access.sessionId !== input.id) throw new StudioError('FORBIDDEN', 'Session is outside the execution scope')
  const previous = removals.get(input.id)
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  removals.set(input.id, current)
  try {
    await previous
    return await remove(input, access)
  } finally {
    release()
    if (removals.get(input.id) === current) removals.delete(input.id)
  }
}

async function remove(input: { id: string; profileId?: string }, access: SessionRemovalAccess): Promise<SessionRemovalResult> {
  const existing = getSession(input.id)
  const profileId = input.profileId || existing?.profile || access.fallbackProfile || 'default'
  // A native history ID may also exist in a different local profile. Never touch that record or runtime.
  const local = existing && (existing.profile || 'default') === profileId ? existing : null
  const checkLocal = () => {
    if (!local) return
    const latest = getSession(input.id)
    if (!latest || (latest.profile || 'default') !== profileId || latest.started_at !== local.started_at) {
      throw new StudioError('REVISION_CONFLICT', 'Session changed during removal')
    }
  }
  const check = async () => {
    if (access.signal?.aborted) throw new StudioError('CANCELLED', 'Session removal was cancelled')
    await access.authorize(profileId)
    if (access.signal?.aborted) throw new StudioError('CANCELLED', 'Session removal was cancelled')
  }
  await check()
  checkLocal()
  const lease = await beforeSessionRemoval({ scope: access.scope?.(profileId), profileId, sessionId: input.id, signal: access.signal || new AbortController().signal })
  try {
    await check()
    checkLocal()
    const native: SessionRemovalResult['native'] = { attempted: false, deleted: false, profileId }
    const providerSession = lease?.ownsNative || isProviderAgentSession(local)
    let nativePresent = false
    if (!providerSession && isHermesAgentAvailable() && listProfileNamesFromDisk().includes(profileId)) {
      try { nativePresent = Boolean(await getExactHermesSessionDetailForProfile(input.id, profileId)) }
      catch (err) {
        logger.warn({ err, sessionId: input.id, profile: profileId }, 'Hermes Session: profile delete skipped')
        native.attempted = true
        native.error = 'Failed to inspect Hermes session'
      }
    }
    // Inspection can await native I/O. Recheck access and cancellation before the first side effect.
    await check()
    checkLocal()
    if (providerSession && !lease?.ownsNative) stopCodingAgentSessionRun(input.id, { reportClosed: false })
    if (nativePresent) {
      native.attempted = true
      try {
        native.deleted = await deleteHermesSessionForProfile(input.id, profileId)
        if (!native.deleted) native.error = 'Failed to delete Hermes session'
      } catch (err) {
        logger.warn({ err, sessionId: input.id, profile: profileId }, 'Hermes Session: profile delete failed')
        native.error = 'Failed to delete Hermes session'
      }
    }
    // Once mutation starts, finish local cleanup and report its outcome even if the caller cancels.
    // Native state and Studio SQLite cannot share a transaction; native failures remain explicit.
    if (local) {
      checkLocal()
      const notification = { id: randomUUID(), occurredAt: Date.now() }
      try {
        const deleted = lease ? deleteSession(input.id, notification, () => lease.removed()) : deleteSession(input.id, notification)
        if (!deleted) throw new Error('Session was not removed')
      } catch (err) {
        logger.warn({ err, sessionId: input.id, profile: profileId }, 'Studio Session: deletion failed')
        throw new SessionRemovalError('Failed to delete session', native)
      }
      publishSessionRemoval(local, 'deleted', notification)
    }
    return { deleted: Boolean(local), native }
  } finally { lease?.release() }
}
