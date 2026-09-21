import { getSessionContextMessage } from '../../repositories/session-store'
import type { BusinessEvent } from '../webhooks/business-events'

/** A completion's output can contain every interim reply, starting with the first.
 * Prefer its exact persisted terminal message; never look up unrelated history. */
export function chatCompletionText(event: BusinessEvent): string {
  if (event.type !== 'chat.run.completed') return ''
  const sessionId = event.subject.session_id
  const messageId = Number(event.subject.message_id)
  const message = sessionId && Number.isSafeInteger(messageId) && messageId > 0
    ? getSessionContextMessage(sessionId, messageId) : null
  if (message?.role === 'assistant') {
    for (const text of [message.display_content, message.content]) {
      if (typeof text === 'string' && text.trim()) return text
    }
  }
  return typeof event.payload.output === 'string' ? event.payload.output : ''
}
