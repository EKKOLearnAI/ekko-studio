import { personError, personRevision } from '../../contracts/person'
import { getChatRunServer } from '../../public/chat-run'
import { clearPersonHistory, personHistorySessions } from '../../repositories/person-history-store'
import { personUpdated } from '../../repositories/person-updates'
import { personUser } from './catalog'
import { personChatBusy } from './chat-agent'
import { requirePersonSession } from '../../repositories/person-session-store'

export async function clearPerson(userId: number, input: Record<string, unknown>) {
  personUser(userId)
  const sessionId = String(input.session_id || '')
  requirePersonSession(userId, sessionId)
  const server = getChatRunServer()
  for (const { id } of personHistorySessions(userId, sessionId)) await server?.assertSessionMessagesEditable?.(id)
  personUser(userId)
  requirePersonSession(userId, sessionId)
  if (personChatBusy(userId, sessionId)) throw personError('Wait for the current Person reply to finish', 409)
  const result = clearPersonHistory(userId, sessionId, personRevision(input.expected_history_revision))
  for (const id of result.sessionIds) server?.clearSessionHistory?.(id, { historyAlreadyCleared: true })
  for (const id of result.sessionIds) if (id !== input.session_id) await server?.disposeSession?.(id)
  personUpdated(userId)
  return { cleared: true, session_id: String(input.session_id), deleted_tasks: result.deletedTasks }
}
