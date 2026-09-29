/**
 * Live stream-speed metrics for the chat composer.
 *
 * Purely additive: tracks time-to-first-token and a rolling tokens/second
 * rate for the most recent streaming run. Sessions without a recorded start
 * are ignored, so existing behavior is never affected.
 *
 * The tokens/second figure is recomputed over a 2-second sliding window by a
 * sampler interval that only runs while a stream is active.
 */
import { reactive } from 'vue'

export const streamMetrics = reactive({
  /** Time to first content token (ms), null until measured. */
  ttftMs: null as number | null,
  /** Content deltas per second over the last 2s window, null when unknown. */
  tokensPerSec: null as number | null,
  /** True while at least one content delta has been seen for the active run. */
  active: false,
})

/** Session the current metrics belong to (for multi-session UI gating). */
let metricsSession: string | null = null
export function activeStreamSession(): string | null {
  return streamMetrics.active ? metricsSession : null
}

const WINDOW_MS = 2000

let currentSession: string | null = null
let startedAt: number | null = null
let firstDeltaAt: number | null = null
interface DeltaSample { t: number; tokens: number }
let deltaSamples: DeltaSample[] = []
let samplerId: ReturnType<typeof setInterval> | null = null

/**
 * Estimate token count for a delta text chunk.
 *
 * The stream carries raw text, not token ids, and exact client-side encoding
 * is too heavy for every delta. ASCII text averages ~4 chars/token for most
 * BPE vocabularies; CJK characters tokenize at roughly one per character.
 */
function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk++
    else other++
  }
  return Math.max(1, Math.ceil(other / 4) + cjk)
}

function ensureSampler(): void {
  if (samplerId !== null) return
  samplerId = setInterval(() => {
    if (!streamMetrics.active) return
    const now = performance.now()
    const windowStart = now - WINDOW_MS
    // Drop stale samples beyond a few windows to bound memory.
    deltaSamples = deltaSamples.filter(s => s.t >= now - WINDOW_MS * 5)
    const recent = deltaSamples.filter(s => s.t >= windowStart)
    if (recent.length === 0 || startedAt === null) {
      streamMetrics.tokensPerSec = null
      return
    }
    // Sum estimated tokens inside the SAME window used for filtering,
    // starting no earlier than the run itself so short streams ramp up correctly.
    const spanMs = Math.max(500, now - Math.max(windowStart, startedAt))
    const tokens = recent.reduce((sum, s) => sum + s.tokens, 0)
    streamMetrics.tokensPerSec = Math.round((tokens / spanMs) * 1000)
  }, WINDOW_MS)
}

/**
 * Record the moment a run is issued for a session.
 *
 * Known limitation: resumed streams (page reload mid-run) are not timed —
 * they have no local run-start moment. Metrics simply stay absent there.
 */
export function noteStreamStart(sessionId: string): void {
  if (!sessionId) return
  currentSession = sessionId
  metricsSession = sessionId
  startedAt = performance.now()
  firstDeltaAt = null
  deltaSamples = []
  streamMetrics.ttftMs = null
  streamMetrics.tokensPerSec = null
  streamMetrics.active = false
  ensureSampler()
}

/**
 * Record one content delta; the first one also captures TTFT.
 *
 * `deltaText` is the raw chunk from the server: it carries no token counts,
 * so the rate is based on a per-chunk token estimate.
 */
export function noteStreamDelta(sessionId: string, deltaText?: string): void {
  if (!sessionId || sessionId !== currentSession || startedAt === null) return
  const now = performance.now()
  if (firstDeltaAt === null) {
    firstDeltaAt = now
    streamMetrics.ttftMs = Math.max(0, Math.round(now - startedAt))
    streamMetrics.active = true
  }
  const tokens = estimateTokens(deltaText ?? '')
  if (tokens > 0) deltaSamples.push({ t: now, tokens })
}

/** Stop tracking (run completed / failed / aborted). Chip hides immediately. */
export function endStreamMetrics(): void {
  streamMetrics.active = false
  if (samplerId !== null) {
    clearInterval(samplerId)
    samplerId = null
  }
}
