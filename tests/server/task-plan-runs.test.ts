import { expect, it } from 'vitest'
import { TaskPlanRuns } from '../../packages/server/src/modules/studio/services/task-plan-runs'

type RunState = { isWorking: boolean; isAborting?: boolean; runId?: string; activeRunMarker?: string; responseRun?: { runMarker?: string } }

const plan = [{ id: 'step', step: 'Do the work', status: 'in_progress' as const }]

function setup() {
  const committed: string[] = []
  const state: RunState = { isWorking: true }
  const runs = new TaskPlanRuns(() => {}, (_sessionId, snapshot) => committed.push(snapshot.execution_state))
  return { state, runs, committed }
}

it('keeps the newer turn binding when a resumed run reports its terminal event late', () => {
  const { state, runs } = setup()
  state.isWorking = true
  state.runId = 'run_old'
  state.activeRunMarker = 'cli_run_old'
  const oldContext = runs.begin('session', 'default', () => state, undefined, true)
  runs.update(oldContext, 'default', { plan })
  state.isWorking = false

  state.isWorking = true
  state.runId = 'run_new'
  state.activeRunMarker = 'cli_run_new'
  const newContext = runs.begin('session', 'default', () => state, undefined, true)

  // The poll attached to the old run finally delivers run.completed.
  runs.finishRun('session', 'run_old', 'ended')

  expect(runs.isActive(newContext, 'default')).toBe(true)
  expect(runs.update(newContext, 'default', { plan }).revision).toBe(1)
})

it('finishes the binding while the terminal event belongs to the run that owns it', () => {
  const { state, runs, committed } = setup()
  state.runId = 'run_live'
  state.activeRunMarker = 'cli_run_live'
  const context = runs.begin('session', 'default', () => state, undefined, true)
  runs.update(context, 'default', { plan })

  // A resumed consumer reports the active run using the bridge run id.
  runs.finishRun('session', 'run_live', 'ended')

  expect(runs.isActive(context, 'default')).toBe(false)
  expect(committed.at(-1)).toBe('ended')
})

it('finishes the current binding for session-level stops and closes', () => {
  const { state, runs, committed } = setup()
  state.runId = 'run_live'
  state.activeRunMarker = 'cli_run_live'
  const context = runs.begin('session', 'default', () => state, undefined, true)
  runs.update(context, 'default', { plan })

  runs.finishSession('session', 'interrupted')

  expect(runs.isActive(context, 'default')).toBe(false)
  expect(committed.at(-1)).toBe('interrupted')
})
