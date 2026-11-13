import { getCompressionSnapshot } from '../../repositories/compression-snapshot'
import { getSessionContextUsageEstimate, saveSessionContextUsageEstimate } from '../../repositories/session-context-usage'
import { logger } from '../../public/logging'
import { SUMMARY_PREFIX } from '../context-compressor'
import { assembleCursorSnapshotHistory, buildDbHistory, readCursorSnapshotParts } from './context-history'
import { estimateUsageTokensFromMessages } from './usage'
import type { SessionState } from './types'

/** Read only: estimating usage must never invalidate or rewrite a compression snapshot. */
export function estimateSessionContextTokens(sessionId: string, fixedTokens = 0): number | undefined {
  try {
    const snapshot = getCompressionSnapshot(sessionId)
    let messages
    if (snapshot) {
      const read = readCursorSnapshotParts(sessionId, snapshot, { truncateToolResults: true })
      // Do not count the expanded transcript when a summary cannot be resolved.
      if (read.status !== 'usable') return undefined
      messages = assembleCursorSnapshotHistory(snapshot, read.parts, SUMMARY_PREFIX)
    } else {
      messages = buildDbHistory(sessionId, { truncateToolResults: true })
    }
    const usage = estimateUsageTokensFromMessages(messages)
    const tokens = usage.inputTokens + usage.outputTokens
    return tokens + fixedTokens
  } catch (error) {
    logger.warn(error, '[chat-run] unable to estimate current context for session %s', sessionId)
    return undefined
  }
}

/** Read before deleting: an earlier edit's checkpoint can retain known overhead. */
export function getSessionContextOverhead(sessionId: string, state?: SessionState): number {
  const fixedTokens = state?.ekkoContext?.fixedContextTokens ?? state?.bridgeContext?.fixedContextTokens
  if (typeof fixedTokens === 'number' && Number.isFinite(fixedTokens) && fixedTokens >= 0) return Math.floor(fixedTokens)
  return getSessionContextUsageEstimate(sessionId)?.fixedTokens ?? 0
}

export function refreshContextUsageAfterDeletion(sessionId: string, fixedTokens: number): number | undefined {
  const tokens = estimateSessionContextTokens(sessionId, fixedTokens)
  if (tokens != null) {
    try {
      // Preserve known fixed system/tool overhead across refreshes and restarts.
      // This checkpoint never changes billing counters or compression metadata.
      saveSessionContextUsageEstimate(sessionId, tokens, fixedTokens)
    } catch (error) {
      logger.warn(error, '[chat-run] unable to save context estimate for session %s', sessionId)
    }
  }
  return tokens
}
