import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { toAuthenticatedUser, type AuthenticatedUser } from '../../middleware/auth'

/** Resolve only locally persisted member identities, never an ID from a relay payload. */
export function groupRunUser(
  storage: {
    getMemberByUserId?: (roomId: string, senderId: string) => { authUserId?: number | null } | null
    getMessage?: (id: string) => { roomId: string; role?: string; senderId: string } | null
  } | undefined,
  roomId: string,
  profile: string,
  message: { role?: string; senderId: string; handoffChainId?: string },
): AuthenticatedUser | undefined {
  if (!storage?.getMemberByUserId) return undefined
  let senderId = message.senderId
  if (message.role === 'assistant' && message.handoffChainId) {
    // The server's handoff chain ID is the original human message ID.
    const root = storage.getMessage?.(message.handoffChainId)
    if (root?.roomId !== roomId || root.role !== 'user') return undefined
    senderId = root.senderId
  } else if (message.role && message.role !== 'user') {
    return undefined
  }
  const userId = storage.getMemberByUserId(roomId, senderId)?.authUserId
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return undefined
  const user = findUserById(userId)
  if (!user || user.status !== 'active' || (user.role !== 'super_admin' && !userCanAccessProfile(user.id, profile))) return undefined
  return toAuthenticatedUser(user)
}
