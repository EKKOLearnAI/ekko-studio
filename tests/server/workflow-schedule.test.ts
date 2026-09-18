import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'hermes-workflow-schedule-'))
process.env.HERMES_WEB_UI_TEST_DB_DIR = join(root, 'db')
process.env.HERMES_WEB_UI_HOME = join(root, 'home')
process.env.HERMES_WEBUI_STATE_DIR = join(root, 'home')

afterAll(async () => {
  const { closeDb } = await import('../../packages/server/src/modules/studio/infrastructure/database/index')
  closeDb()
  rmSync(root, { recursive: true, force: true })
})

describe('workflow schedules', () => {
  it('persists a unique trigger identity before dispatching and never dispatches it twice', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule, getWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    initAllStores()
    const workflow = createWorkflow({ id: 'schedule-workflow', name: 'Scheduled', nodes: [], edges: [] })
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '*/5 * * * *', timezone: 'UTC', enabled: true, next_run_at: Date.UTC(2026, 7, 8, 12, 0, 0) })
    const scheduledAt = Date.UTC(2026, 7, 8, 12, 0, 0)
    const runNow = vi.fn().mockResolvedValue({ run: { id: 'run-1' } })
    const service = new WorkflowScheduleService({ getWorkflow: () => workflow, runNow, validate: async () => {} })

    await service.tick(scheduledAt)
    await service.tick(scheduledAt)

    expect(runNow).toHaveBeenCalledTimes(1)
    expect(runNow).toHaveBeenCalledWith(workflow.id, expect.objectContaining({
      triggerSource: 'scheduled', scheduledAt,
    }))
    expect(getWorkflowSchedule(schedule.id)?.last_run_id).toBe('run-1')
    expect(listWorkflowScheduleEvents(schedule.id).map(event => event.kind)).toEqual(['triggered'])
  })

  it('passes the schedule owner as the run account without credential fields', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    const { createUser } = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    initAllStores()
    const owner = createUser({ username: 'schedule-notification-owner', password: 'pw', profiles: ['default'] })!
    const workflow = createWorkflow({ id: 'owned-schedule-workflow', name: 'Owned', nodes: [], edges: [] })
    const now = Date.UTC(2026, 7, 8, 12, 0, 0)
    createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', owner_user_id: owner.id, schedule: '* * * * *', timezone: 'UTC', next_run_at: now })
    const runNow = vi.fn().mockResolvedValue({ run: { id: 'owned-run' } })
    const service = new WorkflowScheduleService({ getWorkflow: () => workflow, runNow, validate: async () => {} })
    await service.tick(now)
    const input = runNow.mock.calls.find(call => call[0] === workflow.id)![1]
    expect(input.user).toEqual({ id: owner.id, username: owner.username, role: owner.role })
  })

  it('skips missed intervals and active workflows with durable audit evidence', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule, getWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    initAllStores()
    const workflow = createWorkflow({ id: 'skip-workflow', name: 'Skip', nodes: [], edges: [] })
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '* * * * *', timezone: 'UTC', enabled: true, next_run_at: Date.UTC(2026, 7, 8, 11, 0, 0) })
    const service = new WorkflowScheduleService({ getWorkflow: () => workflow, hasActiveRun: () => true, runNow: vi.fn(), validate: async () => {} })

    await service.tick(Date.UTC(2026, 7, 8, 12, 5, 0))

    expect(getWorkflowSchedule(schedule.id)?.last_error).toContain('skipped')
    expect(listWorkflowScheduleEvents(schedule.id).map(event => event.kind)).toContain('skipped')
  })

  it('persists a disabled schedule as disabled', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule, getWorkflowSchedule } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    initAllStores()
    const workflow = createWorkflow({ id: 'disabled-schedule-workflow', name: 'Disabled', nodes: [], edges: [] })
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '* * * * *', timezone: 'UTC', enabled: false })

    expect(getWorkflowSchedule(schedule.id)?.enabled).toBe(false)
  })

  it('records validation failures without dispatching a workflow', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    initAllStores()
    const workflow = createWorkflow({ id: 'unavailable-provider-workflow', name: 'Unavailable provider', nodes: [], edges: [] })
    const scheduledAt = Date.UTC(2026, 7, 8, 12, 0, 0)
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '* * * * *', timezone: 'UTC', next_run_at: scheduledAt })
    const runNow = vi.fn()
    const service = new WorkflowScheduleService({
      getWorkflow: () => workflow,
      runNow,
      validate: async () => { throw Object.assign(new Error('workflow node n1 target capability is unavailable in profile'), { status: 409 }) },
    })

    await service.tick(scheduledAt)

    expect(runNow).not.toHaveBeenCalled()
    expect(listWorkflowScheduleEvents(schedule.id)).toEqual([expect.objectContaining({ kind: 'failed', error: expect.stringContaining('capability is unavailable') })])
  })

  it('records an admission race as a concurrency skip', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    initAllStores()
    const workflow = createWorkflow({ id: 'admission-race-workflow', name: 'Admission race', nodes: [], edges: [] })
    const scheduledAt = Date.UTC(2026, 7, 8, 12, 0, 0)
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: 'default', schedule: '* * * * *', timezone: 'UTC', next_run_at: scheduledAt })
    const service = new WorkflowScheduleService({
      getWorkflow: () => workflow,
      runNow: async () => { throw Object.assign(new Error('workflow is already running'), { status: 409 }) },
      validate: async () => {},
    })

    await service.tick(scheduledAt)

    expect(listWorkflowScheduleEvents(schedule.id)).toEqual([expect.objectContaining({ kind: 'skipped', error: 'workflow is already running' })])
  })

  it('does not dispatch when the schedule owner loses profile access', async () => {
    const { initAllStores } = await import('../../packages/server/src/modules/studio/infrastructure/database/init')
    const { createWorkflow } = await import('../../packages/server/src/modules/studio/repositories/workflow-store')
    const { createWorkflowSchedule, listWorkflowScheduleEvents } = await import('../../packages/server/src/modules/studio/repositories/workflow-schedule-store')
    const { createUser } = await import('../../packages/server/src/modules/studio/repositories/users-store')
    const { WorkflowScheduleService } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    initAllStores()
    const owner = createUser({ username: 'schedule-owner-without-profile', password: 'pw', profiles: [] })!
    const workflow = createWorkflow({ id: 'owner-access-workflow', name: 'Owner access', profile: 'restricted', nodes: [], edges: [] })
    const scheduledAt = Date.UTC(2026, 7, 8, 12, 0, 0)
    const schedule = createWorkflowSchedule({ workflow_id: workflow.id, profile: workflow.profile, owner_user_id: owner.id, schedule: '* * * * *', timezone: 'UTC', next_run_at: scheduledAt })
    const runNow = vi.fn()
    const service = new WorkflowScheduleService({ getWorkflow: () => workflow, runNow })

    await service.tick(scheduledAt)

    expect(runNow).not.toHaveBeenCalled()
    expect(listWorkflowScheduleEvents(schedule.id)).toEqual([expect.objectContaining({ kind: 'failed', error: expect.stringContaining('no longer has access') })])
  })

  it('normalizes common schedule presets before scheduling', async () => {
    const { normalizeWorkflowSchedule, nextWorkflowScheduleAt } = await import('../../packages/server/src/modules/studio/services/workflow/schedule')
    const after = Date.UTC(2026, 7, 8, 12, 34, 0)

    expect(normalizeWorkflowSchedule('@daily')).toBe('0 0 * * *')
    expect(nextWorkflowScheduleAt('@hourly', 'UTC', after)).toBe(Date.UTC(2026, 7, 8, 13, 0, 0))
  })
})
