type NativeAck = { session_id?: string; queue_id?: string; run_id?: string; settled?: boolean; reason?: string }
export type McuTurnOutcome = 'completed' | 'cancelled' | 'failed'

/** Old StackChan firmware recognizes only completed as the backend fence terminal. */
export function emitMcuSettledTurn(
  interactionId: string,
  outcome: McuTurnOutcome,
  emit: (payload: Record<string, unknown>) => boolean,
): boolean {
  // Preserve the existing firmware UI meaning. The subsequent completed only
  // clears its fence: aborted/failed makes the app stop and fence its generation.
  if (outcome !== 'completed' && !emit({ type: 'interaction.status', interactionId,
    status: outcome === 'cancelled' ? 'aborted' : 'failed', outcome, stop_reason: outcome })) return false
  return emit({ type: 'interaction.status', interactionId, status: 'completed', outcome, stop_reason: outcome })
}

/** A cancel request is not settlement; only a correlated native ACK proves it. */
export function createMcuNativeCancellation(options: {
  sessionId: string
  queueId: string
  state: () => { sent: boolean; queuePending: boolean; runId: string; terminalWithoutRun: boolean }
  emit: (event: string, payload: Record<string, unknown>, ack: (result: NativeAck) => void) => void
  settled: () => void
  unconfirmed: (reason: string) => void
  timeoutMs?: number
}) {
  let pending = false
  let pendingKey = ''
  let attempt = 0
  let done = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => { if (timer) clearTimeout(timer); timer = undefined; pending = false }
  const request = () => {
    if (done || closed) return
    const state = options.state()
    if (!state.sent || state.terminalWithoutRun) { clear(); done = true; options.settled(); return }
    const queued = state.queuePending && !state.runId
    if (!queued && !state.runId) return
    const id = queued ? options.queueId : state.runId
    const key = `${queued ? 'queue' : 'run'}:${id}`
    if (pending && pendingKey === key) return
    // Admission may win while the queue-removal ACK is still in flight. Only
    // this queue's run.started can upgrade cancellation to that exact run ID.
    clear(); pending = true; pendingKey = key
    const currentAttempt = ++attempt
    timer = setTimeout(() => { clear(); options.unconfirmed('ack_timeout') }, options.timeoutMs ?? 30_000)
    timer.unref?.()
    options.emit(queued ? 'cancel_queued_run' : 'abort', { session_id: options.sessionId,
      ...(queued ? { queue_id: id } : { run_id: id }) }, result => {
      if (done || closed || currentAttempt !== attempt) return
      if (result?.session_id !== options.sessionId || (queued ? result.queue_id : result.run_id) !== id) {
        clear(); attempt++; options.unconfirmed('ack_mismatch'); return
      }
      clear()
      if (result.settled === true) { done = true; options.settled(); return }
      attempt++
      options.unconfirmed(result.reason || 'stop_unconfirmed')
      // A not-found queue may have started before cancellation reached admission.
      // Wait for its own run.started, then cancel that exact native run only.
      if (queued && options.state().runId) request()
    })
  }
  return { request,
    disconnect: () => { if (done || closed) return; clear(); closed = true; options.unconfirmed('transport_disconnected') },
    dispose: () => { clear(); done = true; closed = true },
  }
}
