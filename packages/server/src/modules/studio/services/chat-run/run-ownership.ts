import type { SessionState } from './types'

/**
 * Accepting a new run owner (a claimed preparation, a dequeued item, a reattached native run) or a
 * Stop advances the session's owner revision synchronously, so an identity captured earlier (for
 * example by an outstanding /destroy) can never match the new owner, even before it has a run marker.
 * Queueing behind a busy owner is not acceptance and must not call this.
 */
export function advanceRunOwnership(state: SessionState): number {
  state.ownerRevision = (state.ownerRevision ?? 0) + 1
  return state.ownerRevision
}
