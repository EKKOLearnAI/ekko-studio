import type { PersonChatAgentOptions } from '../../public/person-runtime'
import type { PersonStageContext } from '../../contracts/person-stage'
import { personDb } from '../../repositories/person-store'
import { personDeliveryCurrent } from './delivery'
import { assertPersonStageTask, personTaskStage } from '../../repositories/person-stage-store'

/** Only durable work that can still wake this Bot is a reason to yield. */
export function personTaskWaitState(userId: number, sessionId: string, returnExecutionId?: string, stage?: PersonStageContext) {
  const rows = personDb().prepare(`SELECT d.execution_id,d.state,e.state AS execution_state,e.task_id
    FROM person_deliveries d JOIN person_executions e ON e.id=d.execution_id AND e.owner_user_id=d.owner_user_id
    JOIN session_tasks t ON t.id=e.task_id AND t.owner_user_id=e.owner_user_id
    WHERE d.owner_user_id=? AND t.session_id=? AND t.status!='closed' AND t.requirements_revision=e.requirements_revision
    AND d.state IN ('waiting','pending','queued') AND d.execution_id!=?`)
    .all(userId,sessionId,returnExecutionId || '')
  return rows.flatMap(row => {
    if (stage) {
      const linked = personTaskStage(userId,String(row.task_id))
      if (linked?.stageId !== stage.stageId || linked.generation !== stage.generation) return []
    }
    const executionId = String(row.execution_id)
    if (['finished','failed','interrupted'].includes(String(row.execution_state))) {
      return personDeliveryCurrent(userId,executionId) ? [{executionId,ready:true}] : []
    }
    if (!['pending','queued','starting','running','stopping','waiting_person','waiting_user','waiting_approval'].includes(String(row.execution_state))) return []
    try { assertPersonStageTask(userId,String(row.task_id)) } catch { return [] }
    return [{executionId,ready:false}]
  })
}

/** Per-turn evidence cursors; changing a tool-call id, task_ref or read cursor is not progress. */
export function createPersonTaskWait(readState: NonNullable<PersonChatAgentOptions['taskWaitState']>) {
  const snapshots = new Map<string,string>()
  const eventIds = new Map<string,number>()
  let unchangedBatches = 0
  let targets = new Set<string>()
  let progressed = false, otherWork = false, requested = false
  return {
    observe(name: string, args: Record<string,unknown>, value: unknown) {
      const result = value as Record<string,any> | undefined
      if (!result || result.ok === false) { otherWork = true; return }
      if (name === 'bot_tasks_wait') { requested = true; return }
      if (name === 'bot_tasks_query') {
        const tasks = result.task ? [result.task] : result.tasks || []
        for (const task of tasks) {
          if (!task.execution_id) continue
          targets.add(task.execution_id)
          const {task_ref: _ref,...snapshot} = task
          const key = `${task.id}:${task.execution_id}`
          const signature = JSON.stringify([snapshot,result.executions])
          if (snapshots.get(key) !== signature) { progressed = true; snapshots.set(key,signature) }
        }
      } else if (name === 'bot_execution_events' && Array.isArray(value)) {
        const id = String(args.execution_id || '')
        targets.add(id)
        const latest = Math.max(eventIds.get(id) || 0,...value.map(event => Number(event.id) || 0))
        if (latest > (eventIds.get(id) || 0)) progressed = true
        eventIds.set(id,latest)
      } else otherWork = true
    },
    finishBatch() {
      if (!requested && !targets.size) {
        unchangedBatches = 0; progressed = false; otherWork = false
        return false
      }
      const pending = readState()
      const observed = pending.filter(target => targets.has(target.executionId))
      unchangedBatches = !otherWork && observed.length && !progressed ? unchangedBatches + 1 : 0
      const yieldTurn = (requested && pending.length > 0)
        || (!otherWork && observed.some(target => target.ready))
        || unchangedBatches >= 3
      targets = new Set(); progressed = false; otherWork = false; requested = false
      return yieldTurn
    },
  }
}
