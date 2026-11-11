import type { PersonFlowMessage } from '@/api/person'
import type { Message } from '@/stores/hermes/chat'
import { mergeTaskPlanMessages, parseTaskPlan, positionTaskPlansAtTurnEnd, type TaskPlanSnapshot } from './task-plan'

const runKey = (sessionId:string,runId:string) => JSON.stringify([sessionId,runId])

/** Use the chat card pipeline while keeping colliding Bot run IDs separate. */
export function personFlowConversationMessages(entries:PersonFlowMessage[],plans:TaskPlanSnapshot[]):Message[] {
  const messages:Message[] = entries.map(entry => ({ id:`flow-chat:${entry.session_id}:${entry.id}`,
    role:entry.role,content:entry.content,timestamp:entry.timestamp*1000,
    runMarker:entry.run_marker ? runKey(entry.session_id,entry.run_marker) : undefined,personTaskReturn:entry.person_task_return }))
  const snapshots = plans.flatMap(raw => {
    const plan = parseTaskPlan(raw)
    return plan ? [{...plan,run_id:runKey(plan.session_id,plan.run_id)}] : []
  })
  return positionTaskPlansAtTurnEnd(mergeTaskPlanMessages(messages,snapshots))
}
