import { describe, expect, it } from 'vitest'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'

const plan = { plan: [{ id: 'work', step: 'Implement', status: 'in_progress' }] }

describe('TaskPlanRuns coding-agent turn id', () => {
  it('keeps a working coding-agent run active when only runId is set', () => {
    const state: { isWorking: boolean; runId?: string } = { isWorking: true, runId: 'coding-agent-run' }
    const plans = new TaskPlanRuns(() => {}, () => {})
    const contextId = plans.begin('session-1', 'research', () => state)

    expect(plans.isActive(contextId, 'research')).toBe(true)
    expect(plans.update(contextId, 'research', plan).run_id).toBe('coding-agent-run')
    expect(plans.activeSnapshots()[0]?.snapshot.run_id).toBe('coding-agent-run')

    state.isWorking = false
    expect(plans.isActive(contextId, 'research')).toBe(false)
  })

  it('prefers the turn marker over a longer-lived runId', () => {
    const state = { isWorking: true, runId: 'coding-agent-run', activeRunMarker: 'turn-2' }
    const plans = new TaskPlanRuns(() => {}, () => {})
    const contextId = plans.begin('session-1', 'research', () => state)

    expect(plans.update(contextId, 'research', plan).run_id).toBe('turn-2')
  })
})
