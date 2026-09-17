import { describe, expect, it, vi } from 'vitest'
import { parseTaskPlanUpdate, TaskPlanRuns, taskPlanRunInstruction, taskPlanTurnInstruction, withTaskPlanTurnContext } from '../../packages/server/src/modules/studio/services/task-plan-runs'

const steps = () => ({ plan: [
  { id: 'inspect', step: 'Inspect', status: 'completed' },
  { id: 'verify', step: 'Verify', status: 'in_progress' },
] })
function harness() {
  const commit = vi.fn()
  const publish = vi.fn()
  const state = { isWorking: true, isAborting: false, responseRun: { runMarker: 'turn-1' } }
  const runs = new TaskPlanRuns(commit, publish)
  const contextId = runs.begin('session-1', 'research', () => state)
  return { commit, publish, state, runs, contextId }
}

describe('shared MCP task plans', () => {
  it('uses the history turn marker and publishes only after persistence, maintaining one card', () => {
    const { runs, contextId, commit, publish } = harness()
    const first = runs.update(contextId, 'research', steps())
    const next = runs.update(contextId, 'research', { ...steps(), explanation: 'Verifying changes' })
    expect(first).toMatchObject({ session_id: 'session-1', run_id: 'turn-1', revision: 1, execution_state: 'running' })
    expect(next).toMatchObject({ plan_id: first.plan_id, created_at: first.created_at, revision: 2 })
    expect(first.created_at).toBeGreaterThan(1e12)
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(publish.mock.invocationCallOrder[0])
    expect(publish).toHaveBeenLastCalledWith('session-1', next)
  })

  it('does not advance or publish a failed write', () => {
    const { runs, contextId, commit, publish } = harness()
    commit.mockImplementationOnce(() => { throw new Error('storage unavailable') })
    expect(() => runs.update(contextId, 'research', steps())).toThrow('storage unavailable')
    expect(publish).not.toHaveBeenCalled()
    expect(runs.update(contextId, 'research', steps()).revision).toBe(1)
  })

  it.each(['ended', 'interrupted', 'failed'] as const)('settles %s without falsely completing unfinished steps', terminal => {
    const { runs, contextId, publish } = harness()
    runs.update(contextId, 'research', steps())
    runs.finishSession('session-1', terminal)
    expect(publish).toHaveBeenLastCalledWith('session-1', expect.objectContaining({
      revision: 2, execution_state: terminal, plan: [
        expect.objectContaining({ status: 'completed' }), expect.objectContaining({ status: 'pending' }),
      ],
    }))
    runs.finish(contextId, 'ended')
    expect(publish).toHaveBeenCalledTimes(2)
    expect(() => runs.update(contextId, 'research', steps())).toThrow('expired')
  })

  it('rejects other profiles, unknown contexts, aborted turns and changed run markers', () => {
    const { runs, contextId, state, publish } = harness()
    expect(() => runs.update(contextId, 'other', steps())).toThrow('unavailable')
    expect(() => runs.update('unknown', 'research', steps())).toThrow('unavailable')
    state.isWorking = false
    expect(() => runs.update(contextId, 'research', steps())).toThrow('active turn')
    state.isWorking = true
    state.isAborting = true
    expect(() => runs.update(contextId, 'research', steps())).toThrow('active turn')
    state.isAborting = false
    runs.update(contextId, 'research', steps())
    state.responseRun.runMarker = 'turn-2'
    expect(() => runs.update(contextId, 'research', steps())).toThrow('active turn')
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('expires the previous turn even when a coding runtime is reused and ignores its late terminal callback', () => {
    const { runs, contextId, state } = harness()
    const first = runs.update(contextId, 'research', steps())
    const nextContext = runs.begin('session-1', 'research', () => state)
    state.responseRun.runMarker = 'turn-2'
    expect(() => runs.update(contextId, 'research', steps())).toThrow('expired')
    runs.finish(contextId, 'failed')
    expect(runs.update(nextContext, 'research', steps())).toMatchObject({ run_id: 'turn-2', revision: 1 })
    expect(runs.update(nextContext, 'research', steps()).plan_id).not.toBe(first.plan_id)
  })

  it('accepts the Hermes bridge marker and keeps concurrent sessions isolated', () => {
    const { runs, contextId } = harness()
    const other = runs.begin('hermes-session', 'research', () => ({ isWorking: true, activeRunMarker: 'cli-turn' }))
    expect(runs.update(other, 'research', steps()).run_id).toBe('cli-turn')
    runs.finish(contextId, 'interrupted')
    expect(runs.update(other, 'research', steps()).revision).toBe(2)
  })

  it.each([
    { plan: [] }, { plan: Array.from({ length: 31 }, (_, i) => ({ id: `${i}`, step: 'Step', status: 'pending' })) },
    { plan: [{ id: 'x', step: 'Step', status: 'pending' }, { id: ' x ', step: 'Other', status: 'pending' }] },
    { plan: [{ id: 'x', step: 'Step', status: 'in_progress' }, { id: 'y', step: 'Other', status: 'in_progress' }] },
    { plan: [{ id: '', step: 'Step', status: 'pending' }] },
    { plan: [{ id: 'x', step: ' ', status: 'pending' }] },
    { plan: [{ id: 'x', step: 'Step', status: 'done' }] },
    { plan: [null] }, { ...steps(), explanation: 5 }, { ...steps(), explanation: 'x'.repeat(1001) },
  ])('rejects malformed snapshots: %j', input => {
    expect(() => parseTaskPlanUpdate(input)).toThrow()
  })

  it('adds fresh turn context without mutating image blocks or the original input', () => {
    const blocks = [{ type: 'text', text: 'Show a task card' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }]
    const original = structuredClone(blocks)
    const first = withTaskPlanTurnContext(blocks, 'turn-one')
    const second = withTaskPlanTurnContext(blocks, 'turn-two')
    expect(blocks).toEqual(original)
    expect(first).toHaveLength(3)
    expect(JSON.stringify(second)).toContain('turn-two')
    expect(JSON.stringify(second)).not.toContain('turn-one')
    expect(withTaskPlanTurnContext(blocks)).toBe(blocks)
  })

  it('explains how to discover the MCP tool and supplies only the current context', () => {
    const text = taskPlanTurnInstruction('current-turn')
    expect(text).toContain('ekko-studio-interaction')
    expect(taskPlanRunInstruction()).not.toContain('context_id=')
    expect(text).toContain('ekko_studio_update_plan')
    expect(text).toContain('context_id="current-turn"')
  })
})
