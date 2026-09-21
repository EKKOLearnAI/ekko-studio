import { getSession, updateSession } from '../../studio/public/sessions'

export type RecoverableNativeAgentId = 'claude-code' | 'codex' | 'grok' | 'pi'

const RECOVERABLE_STORED_AGENTS: Record<RecoverableNativeAgentId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
  pi: 'pi',
}

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

export function resetNativeSessionAfterContextOverflow(
  sessionId: string,
  agentId: string,
): { reset: boolean; previousNativeSessionId: string } {
  const storedAgent = RECOVERABLE_STORED_AGENTS[agentId as RecoverableNativeAgentId]
  if (!storedAgent) return { reset: false, previousNativeSessionId: '' }
  const session = getSession(sessionId)
  if (!session || session.agent !== storedAgent) {
    return { reset: false, previousNativeSessionId: '' }
  }
  const previousNativeSessionId = String(session.agent_native_session_id || '').trim()
  if (!previousNativeSessionId) {
    return { reset: false, previousNativeSessionId: '' }
  }
  updateSession(sessionId, { agent_native_session_id: '' })
  return { reset: true, previousNativeSessionId }
}

export function nativeContextRecoveryMessage(agentName: string): string {
  return `${agentName} compaction could not fit inside the model context window. Studio kept the visible conversation and workspace, then detached the oversized native session. Send the next message to continue in a fresh ${agentName} context.`
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
