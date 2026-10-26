import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateTaskPlan } from '../../packages/server/src/modules/studio/controllers/task-plans'
import { setChatRunServer } from '../../packages/server/src/modules/studio/services/chat-run/server-registry'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'

afterEach(() => setChatRunServer(null))
describe('task plan HTTP controller', () => {
  it('binds updates to the authenticated profile, ignoring caller-supplied session and run ids', () => {
    const runs = new TaskPlanRuns(vi.fn(), vi.fn())
    const contextId = runs.begin('owned-session', 'research', () => ({ isWorking: true, activeRunMarker: 'owned-turn' }))
    setChatRunServer({ updateTaskPlan: runs.update.bind(runs) })
    const ctx = {
      state: { profile: { name: 'research' } }, status: 200, body: undefined as any,
      request: { body: { context_id: contextId, session_id: 'other-session', run_id: 'other-turn',
        plan: [{ id: 'check', step: 'Check changes', status: 'in_progress' }] } },
    }
    updateTaskPlan(ctx as any)
    expect(ctx.body).toMatchObject({ ok: true, session_id: 'owned-session', run_id: 'owned-turn', revision: 1 })
    ctx.state.profile.name = 'other'
    updateTaskPlan(ctx as any)
    expect(ctx.status).toBe(409)
    ctx.state.profile.name = 'research'
    ctx.request.body.context_id = ''
    updateTaskPlan(ctx as any)
    expect(ctx.status).toBe(400)
  })

  it.each(['unknown', 'inactive'])('points a %s context back to current turn instructions', kind => {
    const runs = new TaskPlanRuns(vi.fn(), vi.fn())
    const context = kind === 'unknown' ? 'fixture-expired-context' : runs.begin('fixture-session', 'research', () => ({ isWorking: false, runId: 'old-turn' }))
    setChatRunServer({ updateTaskPlan: runs.update.bind(runs) })
    const ctx: any = { state: { profile: { name: 'research' } }, status: 200,
      request: { body: { context_id: context, plan: [{ id: 'work', step: 'Work', status: 'pending' }] } } }
    updateTaskPlan(ctx)
    expect(ctx.status).toBe(409)
    expect(ctx.body.error).toContain('studio_task_plan_context')
    expect(ctx.body.error).toContain('not plan_id or history')
    setChatRunServer(null)
    updateTaskPlan(ctx)
    expect(ctx.status).toBe(503)
    expect(ctx.body.error).toBe('Chat run service is unavailable')
  })

  it('reports unavailable runtime without accepting a plan', () => {
    const ctx = { state: {}, request: { body: {} }, status: 200, body: undefined as any }
    updateTaskPlan(ctx as any)
    expect(ctx.status).toBe(503)
  })
})
