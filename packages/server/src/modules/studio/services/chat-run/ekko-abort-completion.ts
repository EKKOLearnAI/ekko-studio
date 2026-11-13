import type { SessionState } from './types'

/** Flow cancellation uses a separate signal, bypassing the socket Abort handler. */
export function emitEkkoAbortCompletion(
  state: Pick<SessionState,'abortController'|'queue'>,
  owner: AbortController,
  emit: (event: string, payload: Record<string,unknown>) => void,
  payload: Record<string,unknown>,
) {
  // The explicit Abort handler already emits its own terminal event. An old
  // consumer must also never settle a replacement run in the same conversation.
  if (owner.signal.aborted || state.abortController !== owner) return false
  emit('abort.completed',{...payload,event:'abort.completed',stop_reason:'cancelled',
    queue_length:state.queue.length,queue_remaining:state.queue.length})
  return true
}
