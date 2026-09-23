import { currentEkkoJevRun, type EkkoJevClient, type EkkoJevSettings } from '../jev/client'
import type { Questions, SystemOneRequest, SystemOneResult } from '../jev'

export interface MemoryJevPolicy {
  client: EkkoJevClient
  settings: EkkoJevSettings
  signal: AbortSignal
}

export function memoryJevEnabled(feature: 'memoryKindRoutingEnabled' | 'memoryRerankEnabled' | 'memoryWriteReviewEnabled'): boolean {
  const run = currentEkkoJevRun()
  return Boolean(run?.client.available && run.client.settings.memoryEnabled && run.client.settings[feature])
}

export function throwIfMemoryRunAborted(): void {
  currentEkkoJevRun()?.signal?.throwIfAborted()
}

/** A single deadline covers provider calls and local work for this recall/write operation. */
export async function optionalMemoryJev<T>(fallback: T, work: (policy: MemoryJevPolicy) => Promise<T>): Promise<T> {
  const run = currentEkkoJevRun()
  if (!run?.client.available || !run.client.settings.memoryEnabled) return fallback
  run.signal?.throwIfAborted()
  const timeout = new AbortController()
  const signal = run.signal ? AbortSignal.any([run.signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(new Error('Memory JEV deadline exceeded.')), run.client.settings.memoryTimeoutMs)
  let onAbort: () => void = () => {}
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    return await Promise.race([work({ client: run.client, settings: run.client.settings, signal }), aborted])
  } catch {
    // Cancelling a run must not turn into an empty recall or an allowed write.
    run.signal?.throwIfAborted()
    return fallback
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export async function evaluateMemory<Q extends Questions>(policy: MemoryJevPolicy, request: SystemOneRequest<Q>): Promise<SystemOneResult<Q>> {
  policy.signal.throwIfAborted()
  // Oversized evidence must fall back intact, never be judged after silent truncation.
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 64_000) throw new Error('Memory JEV input is too large.')
  const result = await policy.client.tryEvaluate(request, { signal: policy.signal })
  policy.signal.throwIfAborted()
  if (!result?.answers || typeof result.answers !== 'object') throw new Error('Invalid memory JEV result.')
  return result
}

export function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}
