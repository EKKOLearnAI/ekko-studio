import type { PersonTask } from './person'

export interface PersonFlowStep { session_id: string; goal: string; return_expectation: string }
export interface PersonFlow { steps: PersonFlowStep[]; index: number; stopped: boolean; completed: boolean }
export interface PersonRequirements {
  goal: string
  acceptance?: import('./person-acceptance').PersonAcceptanceConfig
  verification_for?: { task_id: string }
  creator_session_id?: string
  return_expectation?: string
  flow?: PersonFlow
  handoff?: { execution_id: string; output: string; message: string }
}
export function personRequirements(task: Pick<PersonTask, 'requirements_json'>): PersonRequirements {
  return JSON.parse(task.requirements_json)
}
export function personFlowSummary(task: Pick<PersonTask, 'requirements_json'>) {
  const requirements = personRequirements(task)
  const flow = requirements.flow
  return { creator_session_id: requirements.creator_session_id || null,
    return_expectation: requirements.return_expectation || '',
    ...(flow ? { flow: { index: flow.index, total: flow.steps.length + 1, stopped: flow.stopped, completed: flow.completed,
      next_session_id: flow.steps[flow.index]?.session_id || null } } : {}) }
}
