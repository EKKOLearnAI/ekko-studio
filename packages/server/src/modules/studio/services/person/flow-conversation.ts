import { personError } from '../../contracts/person'
import { readPersonFlowMessages } from '../../repositories/person-flow-messages'
import { personDisplayMessages } from '../chat-run/person-display'
import { isPersonSession, ownsPersonSession } from '../../contracts/person-session'
import { getSessionMetadata } from '../../repositories/session-store'
import { listPersonFlows, personFlowActivity } from '../../repositories/person-stage-store'
import { readPersonTimeline, personTimelineFlowItem, PERSON_TIMELINE_PAGE_LIMIT } from '../../repositories/person-timeline'
import type { SessionMessage } from '../../contracts/runs/session'
import { withPersonTaskReturns } from '../../repositories/person-return-store'

/** Restore collaboration display state in the same packet as its conversation. */
export function personConversationFlows(userId: number, sessionId: string) {
  if (!isPersonSession(sessionId)) return undefined
  const session = getSessionMetadata(sessionId)
  if (!ownsPersonSession(userId, session)) throw personError('Person conversation not found', 404)
  const flows = listPersonFlows(userId, sessionId)
  return {
    flows,
    card_updates:flows.filter(flow => flow.creator_session_id === sessionId && flow.state !== 'active'
      && flow.created_at >= (session!.history_cleared_at || 0) && flow.stages.some(stage => stage.session_id !== sessionId))
      .map(flow => personTimelineFlowItem(flow,session!.history_revision || 0)),
    ...personFlowActivity(userId, sessionId),
    history_cleared_at: session!.history_cleared_at || 0,
  }
}

export function personConversationTimeline(userId: number, sessionId: string, query: { before?: unknown; limit?: unknown } = {}) {
  const session = getSessionMetadata(sessionId)
  if (!ownsPersonSession(userId,session)) throw personError('Person conversation not found',404)
  if (query.before !== undefined && typeof query.before !== 'string') throw personError('Invalid timeline cursor')
  const page = readPersonTimeline(userId,session!,query.before as string | undefined,query.limit === undefined ? PERSON_TIMELINE_PAGE_LIMIT : Number(query.limit))
  return { messages:page.messages as SessionMessage[],personFlows:{ ...personConversationFlows(userId,sessionId),cards:page.cards,timeline:page.timeline },
    messageTotal:session!.message_count || 0,messageLoadedCount:page.messages.length,messagePageLimit:PERSON_TIMELINE_PAGE_LIMIT,hasMoreBefore:page.timeline.has_more }
}

export function personFlowConversation(userId: number, flowId: string, query: { before_id?: unknown; limit?: unknown }) {
  const beforeId = query.before_id === undefined ? 0 : Number(query.before_id)
  const limit = query.limit === undefined ? 100 : Number(query.limit)
  if (!Number.isSafeInteger(beforeId) || beforeId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw personError('Invalid conversation cursor or limit')
  const result = readPersonFlowMessages(userId,flowId,beforeId,limit)
  const bySession = new Map<string, typeof result.rows>()
  for (const row of result.rows) {
    const rows = bySession.get(row.session_id) || []
    rows.push(row);bySession.set(row.session_id,rows)
  }
  const receipts = new Map([...bySession].flatMap(([sessionId,rows]) => withPersonTaskReturns(sessionId,rows))
    .map(row => [row.id,row.person_task_return]))
  const messages = result.rows.flatMap(row => {
    const display = personDisplayMessages(row.session_id,[{...row,person_task_return:receipts.get(row.id)}])[0]
    return display.content.trim() || display.person_task_return ? [{ id:row.id,session_id:row.session_id,session_title:row.session_title,bot_type:row.bot_type,
      stage_id:row.stage_id,round_number:row.round_number,role:display.role,content:display.content,timestamp:row.timestamp,
      run_marker:row.run_marker,person_task_return:display.person_task_return }] : []
  })
  return { flow:result.flow,messages,taskPlans:result.taskPlans,oldest_message_id:result.rows[0]?.id ?? null,has_more:result.hasMore,
    next_before_id:result.hasMore ? result.rows[0]?.id ?? null : null,history_key:result.historyKey }
}
