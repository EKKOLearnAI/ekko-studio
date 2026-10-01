import { completeRunUsage } from '../../repositories/run-usage-store'
import { getSessionContextMessage } from '../../repositories/session-store'
import { logger } from '../../public/logging'
import { flushBridgePendingToDb } from './bridge-message'
import { flushResponseRunToDb } from './response-stream'
import { persistRunMessages } from './message-persistence'
import type { SessionState } from './types'

/** Persist an interrupted run before its listener and runtime state are released. */
export function finalizeAbortedRunUsage(sessionId: string, runId: string, state: SessionState) {
  try {
    if (state.finalizeRunUsage) return state.finalizeRunUsage()
    if (!runId) return undefined
    const marker = state.activeRunMarker || state.responseRun?.runMarker || runId
    const bridgeMessageId = state.bridgeAssistantMessageId || state.bridgePendingAssistantContent || state.bridgePendingReasoningContent
      ? flushBridgePendingToDb(state, sessionId, marker) : undefined
    let messageId = bridgeMessageId || flushResponseRunToDb(state, sessionId)
    if (!messageId) {
      const assistant = [...state.messages].reverse().find(message => message.role === 'assistant' && message.runMarker === marker)
      const persisted = assistant && getSessionContextMessage(sessionId, Number(assistant.id))
      if (persisted?.role === 'assistant' && persisted.run_marker === marker) {
        messageId = String(persisted.id)
      } else {
        const { ids } = persistRunMessages(state, { sessionId, runMarker: marker,
          messages: [assistant || { role: 'assistant', content: '' }], appendToState: !assistant })
        if (ids[0] != null) messageId = String(ids[0])
      }
    }
    return completeRunUsage(sessionId, runId, messageId)
  } catch (err) {
    logger.warn({ err, sessionId, runId }, '[run-usage] interrupted usage snapshot failed')
    return undefined
  }
}
