import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPlanSnapshot } from '../../packages/server/src/modules/studio/contracts/task-plan'

const snapshot = (sessionId = 's1', runId = 'r1', revision = 1): TaskPlanSnapshot => ({
  session_id: sessionId, run_id: runId, plan_id: runId, revision, execution_state: 'running',
  created_at: revision, updated_at: revision,
  plan: [{ id: 'a', step: 'Inspect', status: 'completed' }, { id: 'b', step: 'Verify', status: 'in_progress' }],
})

describe('task plan persistence', () => {
  let db: import('node:sqlite').DatabaseSync
  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({
      getDb: () => db, isSqliteAvailable: () => true,
    }))
    const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
    initAllHermesTables()
  })
  afterEach(() => {
    db.close()
    vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
    vi.resetModules()
  })

  it('updates a single durable snapshot and rejects stale revisions', async () => {
    const { saveTaskPlan, listTaskPlansForPage } = await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
    saveTaskPlan(snapshot())
    saveTaskPlan({ ...snapshot('s1', 'r1', 2), explanation: 'Updated' })
    expect(() => saveTaskPlan(snapshot())).toThrow('outdated')
    expect(listTaskPlansForPage('s1', [{ run_marker: 'r1' }])).toEqual([expect.objectContaining({ revision: 2, explanation: 'Updated' })])
    expect(listTaskPlansForPage('s2', [], true)).toEqual([])
  })

  it('loads plans for history pages and the latest plan even before tool messages persist', async () => {
    const { saveTaskPlan, listTaskPlansForPage } = await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
    saveTaskPlan(snapshot())
    saveTaskPlan({ ...snapshot('s1', 'r2'), created_at: 20 })
    expect(listTaskPlansForPage('s1', [{ run_marker: 'r1' }]).map(plan => plan.run_id)).toEqual(['r1'])
    expect(listTaskPlansForPage('s1', [], true).map(plan => plan.run_id)).toEqual(['r2'])
    expect(listTaskPlansForPage('s1', [{ run_marker: 'r1' }], true)).toHaveLength(2)
  })

  it('round-trips independent ids alongside existing mcp context-based ids', async () => {
    const { saveTaskPlan, listTaskPlansForPage } = await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
    const { TaskPlanRuns } = await import('../../packages/server/src/modules/studio/services/task-plan-runs')
    const old = { ...snapshot('s1', 'old-turn'), plan_id: 'mcp:legacy-context' }
    saveTaskPlan(old)
    const runs = new TaskPlanRuns(saveTaskPlan, vi.fn())
    const context = runs.begin('s1', 'research', () => ({ isWorking: true, runId: 'new-turn' }))
    const first = runs.update(context, 'research', { plan: snapshot().plan })
    runs.update(context, 'research', { plan: snapshot().plan })
    const plans = listTaskPlansForPage('s1', [{ run_marker: 'old-turn' }, { run_marker: 'new-turn' }])
    expect(plans).toHaveLength(2)
    expect(plans.find(p => p.run_id === 'old-turn')).toEqual(old)
    expect(plans.find(p => p.run_id === 'new-turn')).toMatchObject({ plan_id: first.plan_id, revision: 2 })
    expect(first.plan_id).not.toContain(context)
    const { mergeTaskPlanMessages } = await import('../../packages/client/src/utils/task-plan')
    const cards = mergeTaskPlanMessages([], plans, 's1')
    expect(cards).toHaveLength(2)
    const initialCard = mergeTaskPlanMessages([], [first], 's1')
    const updatedCard = mergeTaskPlanMessages(initialCard, [plans.find(p => p.run_id === 'new-turn')!], 's1')
    expect(updatedCard).toHaveLength(1)
    expect(updatedCard[0].id).toBe(initialCard[0].id)
    expect(updatedCard[0].taskPlan?.revision).toBe(2)
  })

  it('recovers orphaned runs on restart while preserving completed steps', async () => {
    const { saveTaskPlan, listTaskPlansForPage, interruptOrphanedTaskPlans } = await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
    saveTaskPlan(snapshot())
    saveTaskPlan({ ...snapshot('s2'), execution_state: 'ended' })
    interruptOrphanedTaskPlans()
    interruptOrphanedTaskPlans()
    expect(listTaskPlansForPage('s1', [], true)[0]).toMatchObject({ revision: 2, execution_state: 'interrupted', plan: [{ status: 'completed' }, { status: 'pending' }] })
    expect(listTaskPlansForPage('s2', [], true)[0].revision).toBe(1)
  })

  it.each(['deleteSession', 'clearSessionMessages'] as const)('cleans up plans with %s', async method => {
    const { saveTaskPlan, listTaskPlansForPage } = await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
    const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
    sessions.createSession({ id: 's1' })
    saveTaskPlan(snapshot())
    sessions[method]('s1')
    expect(listTaskPlansForPage('s1', [], true)).toEqual([])
  })
})
