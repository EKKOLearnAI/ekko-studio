import { randomUUID } from 'node:crypto'
import { personError, personText, personRevision } from '../../contracts/person'
import type { PersonSchedule } from '../../contracts/person'
import { personDb, personTransaction, getPersonTask, enqueuePersonExecution, listPersonSchedules, personOperation } from '../../repositories/person-store'
import { requirePersonSession } from '../../repositories/person-session-store'
import { nextWorkflowScheduleAt } from '../workflow/schedule'
import { enqueuePersonScheduledStage, personTaskStage, PERSON_STAGE_PENDING_WORK_SQL } from '../../repositories/person-stage-store'
import { personRequirements } from '../../contracts/person-flow'

export function applyPersonSchedule(userId: number, input: Record<string, unknown>) {
  const key = personText(input.idempotency_key, 'idempotency_key', 200)
  return personOperation(userId, `schedule:${key}`, input, () => {
    const db = personDb(); const now = Date.now()
    if (input.action === 'create') {
      if (!['assistant','worker'].includes(String(input.mode))) throw personError('Choose assistant or worker scheduling mode')
      const task = input.mode === 'worker' ? getPersonTask(userId, personText(input.task_id, 'task_id', 100)) : undefined
      if (task && (personRequirements(task).flow || personTaskStage(userId,task.id))) throw personError('Flow stages are advanced explicitly; schedules are not supported')
      if (task && task.status !== 'open') throw personError('Task must be open')
      if (input.mode === 'assistant' && input.task_id) throw personError('Assistant schedules use a goal, not a worker task')
      const sessionId = requirePersonSession(userId, task?.session_id || personText(input.session_id,'session_id',100)).id
      const title = task?.title || personText(input.title,'title',200)
      const goal = task ? '' : personText(input.goal,'goal',8000)
      const timezone = personText(input.timezone, 'timezone', 100)
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      if (!['once','cron'].includes(String(input.kind))) throw personError('Schedule kind must be once or cron')
      const expression = personText(input.expression, 'expression', 100)
      const next = input.kind === 'once' ? Date.parse(expression) : nextWorkflowScheduleAt(expression, timezone, now)
      if (!Number.isFinite(next) || next <= now) throw personError('Next occurrence must be in the future')
      if (input.kind === 'once' && !/(Z|[+-]\d{2}:\d{2})$/.test(expression)) throw personError('One-time schedule must include a timezone offset')
      const id = randomUUID()
      db.prepare('INSERT INTO person_schedules(id,owner_user_id,mode,task_id,session_id,title,goal,kind,expression,timezone,next_at,misfire,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, userId, String(input.mode), task?.id || null, sessionId, title, goal, String(input.kind), expression, timezone, next, input.misfire === 'run_latest' ? 'run_latest' : 'skip', now)
      return listPersonSchedules(userId).find(s => s.id === id)!
    }
    const id = personText(input.schedule_id, 'schedule_id', 100)
    const schedule = db.prepare('SELECT * FROM person_schedules WHERE id=? AND owner_user_id=?').get(id, userId) as unknown as PersonSchedule | undefined
    if (!schedule) throw personError('Schedule not found', 404)
    requirePersonSession(userId, schedule.session_id)
    if (input.action === 'delete') {
      if (!db.prepare('DELETE FROM person_schedules WHERE id=? AND owner_user_id=? AND revision=?')
        .run(id, userId, personRevision(input.expected_revision)).changes) throw personError('Schedule changed', 409)
      // Occurrences are schedule metadata; their workers, results and flows remain.
      db.prepare('DELETE FROM person_occurrences WHERE schedule_id=?').run(id)
      return { deleted: true, schedule_id: id }
    }
    if (input.action === 'update') {
      if (schedule.task_id && getPersonTask(userId, schedule.task_id).status !== 'open') throw personError('Task must be open',409)
      if (input.mode && input.mode !== schedule.mode || input.task_id && input.task_id !== schedule.task_id || input.session_id && input.session_id !== schedule.session_id) throw personError('Schedule target is fixed; create a new schedule')
      const title = schedule.mode === 'assistant' ? personText(input.title ?? schedule.title,'title',200) : schedule.title
      const goal = schedule.mode === 'assistant' ? personText(input.goal ?? schedule.goal,'goal',8000) : ''
      if (schedule.state === 'cancelled') throw personError('Schedule is cancelled', 409)
      const timezone = personText(input.timezone, 'timezone', 100)
      new Intl.DateTimeFormat('en-US', { timeZone: timezone })
      if (!['once','cron'].includes(String(input.kind))) throw personError('Invalid schedule kind')
      const expression = personText(input.expression, 'expression', 100)
      const next = input.kind === 'once' ? Date.parse(expression) : nextWorkflowScheduleAt(expression, timezone, now)
      if (!Number.isFinite(next) || next <= now || (input.kind === 'once' && !/(Z|[+-]\d{2}:\d{2})$/.test(expression))) throw personError('Future schedule with explicit timezone required')
      if (!db.prepare("UPDATE person_schedules SET title=?,goal=?,kind=?,expression=?,timezone=?,next_at=?,state=?,revision=revision+1 WHERE id=? AND owner_user_id=? AND revision=?")
        .run(title, goal, String(input.kind), expression, timezone, next, schedule.state === 'paused' ? 'paused' : 'active', id, userId, personRevision(input.expected_revision)).changes) throw personError('Schedule changed', 409)
      return listPersonSchedules(userId).find(s => s.id === id)!
    }
    const state = { pause: 'paused', resume: 'active', cancel: 'cancelled' }[String(input.action)]
    if (!state || schedule.state === 'cancelled') throw personError('Invalid schedule action')
    if (schedule.task_id) getPersonTask(userId, schedule.task_id)
    const next = state === 'active' && schedule.kind === 'cron' ? nextWorkflowScheduleAt(schedule.expression, schedule.timezone, now) : schedule.next_at
    if (state === 'active' && next <= now && schedule.kind === 'once') throw personError('One-time date has passed; create a new schedule')
    if (!db.prepare('UPDATE person_schedules SET state=?,next_at=?,revision=revision+1 WHERE id=? AND owner_user_id=? AND revision=?')
      .run(state, next, id, userId, personRevision(input.expected_revision)).changes) throw personError('Schedule changed', 409)
    return listPersonSchedules(userId).find(s => s.id === id)!
  })
}

/** Occurrence claim, queue insertion and advancement share one SQLite commit. */
export function tickPersonSchedules(now = Date.now()) {
  const due = personDb().prepare("SELECT * FROM person_schedules WHERE state='active' AND next_at<=? ORDER BY next_at LIMIT 20").all(now) as unknown as PersonSchedule[]
  for (const schedule of due) {
    const next = schedule.kind === 'once' ? schedule.next_at : nextWorkflowScheduleAt(schedule.expression, schedule.timezone, now)
    personTransaction(() => {
      const db = personDb()
      const claimed = db.prepare("UPDATE person_schedules SET next_at=?,state=? WHERE id=? AND revision=? AND next_at=? AND state='active'")
        .run(next, schedule.kind === 'once' ? 'exhausted' : 'active', schedule.id, schedule.revision, schedule.next_at)
      if (!claimed.changes) return
      const id = randomUUID()
      let state = 'skipped'; let execution: string | null = null; let flow: string | null = null
      requirePersonSession(schedule.owner_user_id, schedule.session_id)
      const active = db.prepare("SELECT id FROM person_executions WHERE task_id=? AND state IN ('pending','queued','starting','stopping','running','waiting_person','waiting_user','waiting_approval')").get(schedule.task_id)
      const task = schedule.task_id ? getPersonTask(schedule.owner_user_id, schedule.task_id) : undefined
      const activeFlow = db.prepare(`SELECT 1 FROM person_occurrences o JOIN person_flows f ON f.id=o.flow_id WHERE o.schedule_id=?
        AND (f.state='active' OR (f.state='failed' AND EXISTS(SELECT 1 FROM person_stages s
          WHERE s.flow_id=f.id AND s.group_position=f.current_position AND ${PERSON_STAGE_PENDING_WORK_SQL}))) LIMIT 1`).get(schedule.id)
      const recent = now - schedule.next_at <= (schedule.misfire === 'run_latest' ? 86400_000 : 60_000)
      if (recent && !active && !activeFlow && (!task || task.status === 'open')) {
        if (schedule.mode === 'assistant') flow = enqueuePersonScheduledStage(schedule.owner_user_id, schedule.session_id, schedule.title, schedule.goal)
        else if (task) execution = enqueuePersonExecution(task, id).id
        state = 'queued'
      }
      db.prepare('INSERT INTO person_occurrences(id,schedule_id,revision,scheduled_at,state,execution_id,flow_id) VALUES (?,?,?,?,?,?,?)')
        .run(id, schedule.id, schedule.revision, schedule.next_at, state, execution, flow)
    })
  }
}
