import { deleteCompressionSnapshot } from '../../repositories/compression-snapshot'
import {
  addMessages,
  getSessionDetail,
  updateSessionStats,
  type HermesMessageRow,
} from '../../repositories/session-store'
import { logger } from '../../public/logging'
import { getHermesSessionDetailForProfile } from '../../public/session-agent-runtime'

const HERMES_LOCAL_SOURCES = new Set(['cli', 'api_server'])
const IMPORTABLE_ROLES = new Set(['user', 'assistant', 'tool'])
const NATIVE_LINEAGE_MARKER_PREFIX = 'hermes_lineage:'

export interface HermesHistoryReconciliationOptions {
  profile?: string
  isSessionActive?: () => boolean
  invalidateCachedHistory?: () => void
}

export interface HermesHistoryReconciliationResult {
  changed: boolean
  added: number
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function nullableText(value: unknown): string | null {
  const normalized = text(value)
  return normalized ? normalized : null
}

function normalizeToolCalls(value: unknown): any[] | null {
  if (!Array.isArray(value)) return null
  const calls = value
    .map((call: any) => {
      const id = String(call?.id || '').trim()
      const fn = call?.function && typeof call.function === 'object' ? call.function : {}
      const name = String(fn.name || call?.name || '').trim()
      if (!id || !name) return null
      const rawArguments = fn.arguments ?? call?.arguments ?? {}
      return {
        id,
        type: String(call?.type || 'function'),
        function: {
          name,
          arguments: typeof rawArguments === 'string' ? rawArguments : text(rawArguments || {}) || '{}',
        },
      }
    })
    .filter(Boolean)
  return calls.length ? calls : null
}

function nativeMarker(message: any): string {
  return `${NATIVE_LINEAGE_MARKER_PREFIX}${String(message.session_id)}:${String(message.id)}`
}

function comparableMessage(message: any): string {
  return JSON.stringify({
    role: String(message?.role || ''),
    content: text(message?.content),
    tool_call_id: nullableText(message?.tool_call_id),
    tool_calls: normalizeToolCalls(message?.tool_calls),
    tool_name: nullableText(message?.tool_name),
    finish_reason: nullableText(message?.finish_reason),
    reasoning: nullableText(message?.reasoning),
    reasoning_details: nullableText(message?.reasoning_details),
    reasoning_content: nullableText(message?.reasoning_content),
    timestamp: Number(message?.timestamp || 0),
  })
}

function buildContinuationMessages(sessionId: string, nativeMessages: any[]): Array<Omit<HermesMessageRow, 'id'>> {
  const knownToolCallIds = new Set<string>()
  for (const message of nativeMessages) {
    if (String(message?.role || '') !== 'assistant') continue
    for (const call of normalizeToolCalls(message?.tool_calls) || []) knownToolCallIds.add(call.id)
  }

  const result: Array<Omit<HermesMessageRow, 'id'>> = []
  for (const message of nativeMessages) {
    const nativeSessionId = String(message?.session_id || '')
    if (!nativeSessionId || nativeSessionId === sessionId) continue
    const role = String(message?.role || '').trim()
    if (!IMPORTABLE_ROLES.has(role)) continue

    const toolCalls = role === 'assistant' ? normalizeToolCalls(message?.tool_calls) : null
    if (role === 'tool') {
      const callId = String(message?.tool_call_id || '').trim()
      if (!callId || !knownToolCallIds.has(callId)) continue
    } else if (role === 'assistant' && !text(message?.content).trim() && !toolCalls) {
      continue
    }

    result.push({
      session_id: sessionId,
      role,
      content: text(message?.content),
      display_role: nullableText(message?.display_role),
      display_content: nullableText(message?.display_content),
      tool_call_id: role === 'tool' ? nullableText(message?.tool_call_id) : null,
      tool_calls: toolCalls,
      tool_name: role === 'tool' ? nullableText(message?.tool_name) : null,
      run_marker: nativeMarker(message),
      timestamp: Number(message?.timestamp || 0),
      token_count: message?.token_count == null ? null : Number(message.token_count),
      finish_reason: nullableText(message?.finish_reason),
      reasoning: role === 'assistant' ? nullableText(message?.reasoning) : null,
      reasoning_details: role === 'assistant' ? nullableText(message?.reasoning_details) : null,
      reasoning_content: role === 'assistant' ? nullableText(message?.reasoning_content) : null,
    })
  }
  return result
}

/**
 * Copy only messages from the native compression continuation selected by the
 * Hermes lineage reader into Studio's stable public session id. Studio-only
 * messages remain untouched.
 */
export async function reconcileHermesSessionHistory(
  sessionId: string,
  options: HermesHistoryReconciliationOptions = {},
): Promise<HermesHistoryReconciliationResult> {
  const local = getSessionDetail(sessionId)
  if (!local || !HERMES_LOCAL_SOURCES.has(local.source)) return { changed: false, added: 0 }

  const localProfile = String(local.profile || 'default')
  const requestedProfile = String(options.profile || localProfile)
  if (requestedProfile !== localProfile || options.isSessionActive?.()) return { changed: false, added: 0 }

  try {
    const native = await getHermesSessionDetailForProfile(sessionId, localProfile)
    if (!native || Number(native.thread_session_count || 1) <= 1 || options.isSessionActive?.()) {
      return { changed: false, added: 0 }
    }

    const candidates = buildContinuationMessages(sessionId, Array.isArray(native.messages) ? native.messages : [])
    if (!candidates.length) return { changed: false, added: 0 }

    // Re-read after the asynchronous native query so simultaneous callers and
    // bridge writes participate in de-duplication before the synchronous insert.
    const current = getSessionDetail(sessionId)
    if (!current || String(current.profile || 'default') !== localProfile || options.isSessionActive?.()) {
      return { changed: false, added: 0 }
    }

    const markers = new Set((current.messages || []).map(message => String(message.run_marker || '')).filter(Boolean))
    const availableFingerprints = new Map<string, number>()
    for (const message of current.messages || []) {
      // Provenance-marked rows already match by native identity; never let them
      // consume a different native turn with repeated text.
      if (String(message.run_marker || '').startsWith(NATIVE_LINEAGE_MARKER_PREFIX)) continue
      const fingerprint = comparableMessage(message)
      availableFingerprints.set(fingerprint, (availableFingerprints.get(fingerprint) || 0) + 1)
    }

    const missing = candidates.filter((message) => {
      if (markers.has(String(message.run_marker || ''))) return false
      const fingerprint = comparableMessage(message)
      const available = availableFingerprints.get(fingerprint) || 0
      if (available > 0) {
        availableFingerprints.set(fingerprint, available - 1)
        return false
      }
      return true
    })
    if (!missing.length || options.isSessionActive?.()) return { changed: false, added: 0 }

    addMessages(missing)
    updateSessionStats(sessionId)
    deleteCompressionSnapshot(sessionId)
    options.invalidateCachedHistory?.()
    return { changed: true, added: missing.length }
  } catch (err) {
    logger.warn({ err, sessionId, profile: localProfile }, 'Hermes history reconciliation failed')
    return { changed: false, added: 0 }
  }
}
