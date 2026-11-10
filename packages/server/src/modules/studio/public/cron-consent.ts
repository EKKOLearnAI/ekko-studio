import { studioSessionAccount } from '../contracts/runs/usage'
import { getSession, getSessionGeneration } from '../repositories/session-store'
import { findUserById, userCanAccessProfile } from '../repositories/users-store'

export interface ConsentSessionView {
  id: string
  profile: string
  title: string
  generation: string
  /** Authoritative Studio account attribution, when the session has one. */
  ownerAccount: number | null
}

/** The session as a consent destination sees it now, or null when it no longer exists. */
export function consentSessionView(sessionId: string): ConsentSessionView | null {
  const session = getSession(sessionId)
  const generation = session ? getSessionGeneration(sessionId) : null
  if (!session || !generation) return null
  const owner = studioSessionAccount(session as any)
  return {
    id: session.id,
    profile: session.profile || 'default',
    title: String(session.title || session.preview || '').slice(0, 200),
    generation,
    ownerAccount: owner ? Number(owner) : null,
  }
}

/** The account is active and may use the profile. */
export function consentAccountAllowed(accountId: number, profile: string): boolean {
  const user = findUserById(accountId)
  return !!user && user.status === 'active' && (user.role === 'super_admin' || userCanAccessProfile(user.id, profile))
}
