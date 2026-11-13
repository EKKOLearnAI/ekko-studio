export const PENDING_INTERACTION_EXPIRED_EVENT = 'hermes:pending-interaction-expired'

export type PendingInteractionSubmitResult = 'submitted' | 'expired' | 'missing'

export function pendingInteractionMonotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0
}

export function pendingInteractionDeadline(
  remainingTimeoutMs: unknown,
  timeoutMs: unknown,
  fallbackTimeoutMs = 300_000,
): number {
  const remaining = Number(remainingTimeoutMs)
  const timeout = Number(timeoutMs)
  const duration = Number.isFinite(remaining) && remaining >= 0
    ? remaining
    : Number.isFinite(timeout) && timeout > 0
      ? timeout
      : fallbackTimeoutMs
  return pendingInteractionMonotonicNow() + Math.max(0, duration)
}

export function pendingInteractionRemainingMs(deadline: number, now = pendingInteractionMonotonicNow()): number {
  if (deadline === Infinity) return Infinity
  if (!Number.isFinite(deadline)) return 0
  return Math.max(0, deadline - now)
}

export function formatPendingInteractionTime(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function isPendingInteractionExpiredError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error || '').toLowerCase()
  const interaction = message.includes('approval') || message.includes('clarification')
  return interaction && (message.includes('timed out')
    || message.includes('expired')
    || message.includes('unknown approval request')
    || message.includes('unknown clarification request')
    || message.includes('approval is no longer pending')
    || message.includes('approval is not pending')
    || message.includes('clarification is no longer pending')
    || message.includes('clarification is not pending'))
}

export function notifyPendingInteractionExpired(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PENDING_INTERACTION_EXPIRED_EVENT))
}
