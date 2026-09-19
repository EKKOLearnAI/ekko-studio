import { getSession, updateSession } from '../../studio/public/sessions'

const CONTEXT_WINDOW_ERROR_MARKERS = [
  'context_length_exceeded',
  'input exceeds the context window',
  'maximum context length',
  'request payload is too large',
  'payload too large',
]

export function isContextWindowExceededError(error: unknown): boolean {
  const text = errorText(error).toLowerCase()
  return CONTEXT_WINDOW_ERROR_MARKERS.some(marker => text.includes(marker))
}

export function resetCodexNativeThreadAfterContextOverflow(sessionId: string): { reset: boolean; previousNativeSessionId: string } {
  const session = getSession(sessionId)
  if (!session || session.agent !== 'codex') {
    return { reset: false, previousNativeSessionId: '' }
  }
  const previousNativeSessionId = String(session.agent_native_session_id || '').trim()
  if (!previousNativeSessionId) {
    return { reset: false, previousNativeSessionId: '' }
  }
  updateSession(sessionId, { agent_native_session_id: '' })
  return { reset: true, previousNativeSessionId }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error ? error.cause : undefined
    return `${error.message} ${cause == null ? '' : errorText(cause)}`
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
