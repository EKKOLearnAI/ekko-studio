import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { toAuthenticatedUser, type AuthenticatedUser } from '../../middleware/auth'

/** Resolve only locally persisted member identities, never an ID from a relay payload. */
export function groupRunUser(
  storage: { getMemberByUserId?: (roomId: string, senderId: string) => { authUserId?: number | null } | null } | undefined,
  roomId: string,
  profile: string,
  message: { role?: string; senderId: string },
): AuthenticatedUser | undefined {
  if ((message.role && message.role !== 'user') || typeof storage?.getMemberByUserId !== 'function') return undefined
  const userId = storage.getMemberByUserId(roomId, message.senderId)?.authUserId
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return undefined
  const user = findUserById(userId)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile))) return undefined
  return toAuthenticatedUser(user)
}
