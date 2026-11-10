import { personError } from '../../contracts/person'
import { readPersonFlowMessages } from '../../repositories/person-flow-messages'
import { personDisplayMessages } from '../chat-run/person-display'

export function personFlowConversation(userId: number, flowId: string, query: { before_id?: unknown; limit?: unknown }) {
  const beforeId = query.before_id === undefined ? 0 : Number(query.before_id)
  const limit = query.limit === undefined ? 100 : Number(query.limit)
  if (!Number.isSafeInteger(beforeId) || beforeId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw personError('Invalid conversation cursor or limit')
  const result = readPersonFlowMessages(userId,flowId,beforeId,limit)
  const messages = result.rows.flatMap(row => {
    const display = personDisplayMessages(row.session_id,[row])[0]
    return display.content.trim() ? [{ id:row.id,session_id:row.session_id,session_title:row.session_title,bot_type:row.bot_type,
      stage_id:row.stage_id,round_number:row.round_number,role:display.role,content:display.content,timestamp:row.timestamp }] : []
  })
  return { flow:result.flow,messages,has_more:result.hasMore,
    next_before_id:result.hasMore ? result.rows[0]?.id ?? null : null,history_key:result.historyKey }
}
