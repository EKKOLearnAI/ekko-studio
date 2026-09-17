import { importSessionPins, writeSessionPin } from '../../repositories/session-pin-store'
export { listSessionPins } from '../../repositories/session-pin-store'

export class SessionPinValidationError extends Error {}

function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && id.trim().length > 0 && id.length <= 512
}

export function setSessionPin(userId: number, profile: string, sessionId: unknown, pinned: unknown) {
  if (!validSessionId(sessionId) || typeof pinned !== 'boolean') {
    throw new SessionPinValidationError('A session ID and boolean pinned value are required')
  }
  return writeSessionPin(userId, profile, sessionId, pinned)
}

export function migrateSessionPins(userId: number, profile: string, pinnedIds: unknown) {
  if (!Array.isArray(pinnedIds) || pinnedIds.length > 10000 || !pinnedIds.every(validSessionId)) {
    throw new SessionPinValidationError('pinnedIds must be an array of at most 10000 session IDs')
  }
  return importSessionPins(userId, profile, [...new Set(pinnedIds)])
}
