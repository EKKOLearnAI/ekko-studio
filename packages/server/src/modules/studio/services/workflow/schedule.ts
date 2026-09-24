import type { WorkflowRecord, WorkflowRunNowInput } from './manager'
import { getWorkflowManager, preflightWorkflowExecutionDefinition } from './manager'
import { createWorkflowScheduleEvent, claimWorkflowScheduleTrigger, listWorkflowSchedules, updateWorkflowSchedule, type WorkflowScheduleRecord } from '../../repositories/workflow-schedule-store'
import { listActiveWorkflowRuns } from '../../repositories/workflow-run-store'
import { findUserById, userCanAccessProfile } from '../../repositories/users-store'
import { assertWorkflowImportCapabilities } from './import-capabilities'
import { logger } from '../../public/logging'
import { getWorkflowAvailableModelGroups } from '../../public/workflow-runtime'

type Dependencies = {
  getWorkflow?: (id: string) => WorkflowRecord | null
  hasActiveRun?: (id: string) => boolean
  runNow?: (id: string, input: WorkflowRunNowInput) => Promise<{ run: { id: string } }>
  validate?: (workflow: WorkflowRecord, schedule: WorkflowScheduleRecord) => Promise<void>
}

const MINUTE = 60_000

const CRON_PRESETS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

export function normalizeWorkflowSchedule(schedule: string): string {
  const normalized = schedule.trim()
  return CRON_PRESETS[normalized.toLowerCase()] || normalized
}

function values(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step < 1) throw new Error('invalid cron step')
    const [fromRaw, toRaw] = range === '*' ? [String(min), String(max)] : range.split('-')
    const from = Number(fromRaw)
    const to = toRaw === undefined ? from : Number(toRaw)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) throw new Error('invalid cron field')
    for (let value = from; value <= to; value += step) out.add(value)
  }
  return out
}

export function assertWorkflowScheduleCron(schedule: string): void {
  const fields = normalizeWorkflowSchedule(schedule).split(/\s+/)
  if (fields.length !== 5) throw new Error('schedule must be a five-field cron expression')
  values(fields[0], 0, 59)
  values(fields[1], 0, 23)
  values(fields[2], 1, 31)
  values(fields[3], 1, 12)
  values(fields[4], 0, 6)
}

function zoned(date: number, timezone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date(date))
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find(part => part.type === 'weekday')?.value || '')
  return [value('minute'), value('hour'), value('day'), value('month'), weekday]
}

export function nextWorkflowScheduleAt(schedule: string, timezone: string, after: number): number {
  assertWorkflowScheduleCron(schedule)
  new Intl.DateTimeFormat('en-US', { timeZone: timezone })
  const fields = normalizeWorkflowSchedule(schedule).split(/\s+/).map((field, index) => values(field, [0, 0, 1, 1, 0][index], [59, 23, 31, 12, 6][index]))
  let candidate = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const limit = candidate + 366 * 24 * 60 * MINUTE
  while (candidate <= limit) {
    const parts = zoned(candidate, timezone)
    if (parts.every((value, index) => fields[index].has(value))) return candidate
    candidate += MINUTE
  }
  throw new Error('schedule has no occurrence in the next year')
}

async function validateScheduledExecution(workflow: WorkflowRecord, schedule: WorkflowScheduleRecord): Promise<void> {
  if (schedule.owner_user_id != null) {
    const owner = findUserById(schedule.owner_user_id)
    if (!owner || owner.status !== 'active' || (owner.role !== 'super_admin' && !userCanAccessProfile(owner.id, schedule.profile))) {
      throw Object.assign(new Error('scheduled workflow owner no longer has access to its profile'), { status: 403 })
    }
  }

  const preflight = await preflightWorkflowExecutionDefinition(workflow.nodes, workflow.edges, schedule.profile, schedule.start_node_ids)
  assertWorkflowImportCapabilities(preflight.activeNodes, await getWorkflowAvailableModelGroups(schedule.profile))
}

export class WorkflowScheduleService {
  private readonly getWorkflow: NonNullable<Dependencies['getWorkflow']>
  private readonly hasActiveRun: NonNullable<Dependencies['hasActiveRun']>
  private readonly runNow: NonNullable<Dependencies['runNow']>
  private readonly validate: NonNullable<Dependencies['validate']>
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(deps: Dependencies = {}) {
    this.getWorkflow = deps.getWorkflow || (id => getWorkflowManager().get(id))
    this.hasActiveRun = deps.hasActiveRun || (id => listActiveWorkflowRuns().some(run => run.workflow_id === id))
    this.runNow = deps.runNow || ((id, input) => getWorkflowManager().runNow(id, input))
    this.validate = deps.validate || validateScheduledExecution
  }

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), 15_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(now = Date.now()): Promise<void> {
    for (const schedule of listWorkflowSchedules()) {
      try {
        await this.process(schedule, now)
      } catch (error) {
        logger.error(error, '[workflow-schedule] tick failed for %s', schedule.id)
      }
    }
  }

  private async process(schedule: WorkflowScheduleRecord, now: number): Promise<void> {
    if (!schedule.enabled) return
    const next = schedule.next_run_at
    if (next == null) {
      updateWorkflowSchedule(schedule.id, { next_run_at: nextWorkflowScheduleAt(schedule.schedule, schedule.timezone, now) })
      return
    }
    if (next > now) return

    const identity = claimWorkflowScheduleTrigger(schedule, next)
    const following = nextWorkflowScheduleAt(schedule.schedule, schedule.timezone, now)
    if (!identity) {
      updateWorkflowSchedule(schedule.id, { next_run_at: following })
      return
    }

    const workflow = this.getWorkflow(schedule.workflow_id)
    if (!workflow || workflow.profile !== schedule.profile) {
      const error = 'scheduled workflow is unavailable or its profile changed'
      createWorkflowScheduleEvent({ schedule_id: schedule.id, workflow_id: schedule.workflow_id, trigger_identity: identity, scheduled_at: next, kind: 'failed', run_id: null, error })
      updateWorkflowSchedule(schedule.id, { last_scheduled_at: next, next_run_at: following, last_error: error })
      return
    }
    if (next < now - MINUTE || this.hasActiveRun(schedule.workflow_id)) {
      const error = next < now - MINUTE
        ? 'scheduled occurrence skipped while service was offline'
        : 'scheduled occurrence skipped because workflow is already running'
      createWorkflowScheduleEvent({ schedule_id: schedule.id, workflow_id: schedule.workflow_id, trigger_identity: identity, scheduled_at: next, kind: 'skipped', run_id: null, error })
      updateWorkflowSchedule(schedule.id, { last_scheduled_at: next, next_run_at: following, last_error: error })
      return
    }

    try {
      await this.validate(workflow, schedule)
      let accept!: (run: { id: string }) => void
      const accepted = new Promise<{ id: string }>(resolve => { accept = resolve })
      const owner = schedule.owner_user_id == null ? null : findUserById(schedule.owner_user_id)
      const execution = this.runNow(schedule.workflow_id, {
        profile: schedule.profile,
        user: owner ? { id: owner.id, username: owner.username, role: owner.role } : undefined,
        startNodeIds: schedule.start_node_ids,
        input: schedule.input,
        timeoutMs: schedule.timeout_ms ?? undefined,
        triggerSource: 'scheduled',
        scheduledAt: next,
        onAccepted: accept,
      })
      const result = await Promise.race([
        accepted,
        execution.then(value => value.run),
      ])
      void execution.catch(error => logger.error(error, '[workflow-schedule] async run failed for %s', schedule.workflow_id))
      createWorkflowScheduleEvent({ schedule_id: schedule.id, workflow_id: schedule.workflow_id, trigger_identity: identity, scheduled_at: next, kind: 'triggered', run_id: result.id, error: null })
      updateWorkflowSchedule(schedule.id, { last_scheduled_at: next, next_run_at: following, last_run_id: result.id, last_error: null })
    } catch (err: any) {
      const error = err?.message || 'scheduled workflow failed preflight'
      const concurrent = Number(err?.status) === 409 && error === 'workflow is already running'
      createWorkflowScheduleEvent({ schedule_id: schedule.id, workflow_id: schedule.workflow_id, trigger_identity: identity, scheduled_at: next, kind: concurrent ? 'skipped' : 'failed', run_id: null, error })
      updateWorkflowSchedule(schedule.id, { last_scheduled_at: next, next_run_at: following, last_error: error })
    }
  }
}

let singleton: WorkflowScheduleService | undefined
export function getWorkflowScheduleService(): WorkflowScheduleService {
  return singleton ||= new WorkflowScheduleService()
}
