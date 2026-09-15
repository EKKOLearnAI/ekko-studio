import { randomUUID } from 'node:crypto'
import type { TaskPlanSnapshot } from '../contracts/task-plan'

type PlanUpdate = Pick<TaskPlanSnapshot, 'explanation' | 'plan'>
type TerminalState = Exclude<TaskPlanSnapshot['execution_state'], 'running'>
type RunState = { isWorking: boolean; isAborting?: boolean; activeRunMarker?: string; responseRun?: { runMarker?: string } }
type Binding = { sessionId: string; profile: string; resolve: () => RunState | undefined; snapshot?: TaskPlanSnapshot }

export class TaskPlanError extends Error {
  constructor(message: string, public readonly status = 400) { super(message) }
}

export function parseTaskPlanUpdate(input: Record<string, unknown>): PlanUpdate {
  if (!Array.isArray(input.plan) || input.plan.length < 1 || input.plan.length > 30) {
    throw new TaskPlanError('plan must contain 1 to 30 steps')
  }
  if (input.explanation !== undefined && (typeof input.explanation !== 'string' || input.explanation.length > 1000)) {
    throw new TaskPlanError('explanation must be a string of at most 1000 characters')
  }
  const ids = new Set<string>()
  let inProgress = 0
  const plan = input.plan.map((value): TaskPlanSnapshot['plan'][number] => {
    if (!value || typeof value !== 'object') throw new TaskPlanError('Invalid plan step')
    const { id, step, status } = value
    if (typeof id !== 'string' || !id.trim() || id.trim().length > 100 || ids.has(id.trim())) {
      throw new TaskPlanError('Step ids must be unique non-empty strings of at most 100 characters')
    }
    if (typeof step !== 'string' || !step.trim() || step.trim().length > 200) {
      throw new TaskPlanError('Step text must contain 1 to 200 characters')
    }
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') throw new TaskPlanError('Invalid step status')
    if (status === 'in_progress' && ++inProgress > 1) throw new TaskPlanError('Only one step can be in_progress')
    ids.add(id.trim())
    return { id: id.trim(), step: step.trim(), status }
  })
  return { ...(input.explanation !== undefined ? { explanation: input.explanation as string } : {}), plan }
}

/** Per-turn capabilities: an old MCP call cannot write into a later turn or another profile. */
export class TaskPlanRuns {
  private readonly bindings = new Map<string, Binding>()
  private readonly sessions = new Map<string, string>()

  constructor(
    private readonly commit: (snapshot: TaskPlanSnapshot) => void,
    private readonly publish: (sessionId: string, snapshot: TaskPlanSnapshot) => void,
  ) {}

  begin(sessionId: string, profile: string, resolve: Binding['resolve']): string {
    this.finishSession(sessionId, 'interrupted')
    const contextId = randomUUID()
    this.bindings.set(contextId, { sessionId, profile, resolve })
    this.sessions.set(sessionId, contextId)
    return contextId
  }

  update(contextId: string, profile: string, input: Record<string, unknown>): TaskPlanSnapshot {
    const binding = this.bindings.get(contextId)
    if (!binding || binding.profile !== profile) throw new TaskPlanError('Task plan context is unavailable or has expired', 409)
    const state = binding.resolve()
    const runId = state?.activeRunMarker || state?.responseRun?.runMarker
    if (!state?.isWorking || state.isAborting || !runId || (binding.snapshot && binding.snapshot.run_id !== runId)) {
      throw new TaskPlanError('Task plan context has no active turn', 409)
    }
    const update = parseTaskPlanUpdate(input)
    const now = Date.now()
    const snapshot: TaskPlanSnapshot = {
      ...update, session_id: binding.sessionId, run_id: runId, plan_id: `mcp:${contextId}`,
      revision: (binding.snapshot?.revision || 0) + 1, execution_state: 'running',
      created_at: binding.snapshot?.created_at ?? now, updated_at: now,
    }
    this.commit(snapshot)
    binding.snapshot = snapshot
    this.publish(binding.sessionId, snapshot)
    return structuredClone(snapshot)
  }

  finish(contextId: string, executionState: TerminalState): void {
    const binding = this.bindings.get(contextId)
    if (!binding) return
    this.bindings.delete(contextId)
    if (this.sessions.get(binding.sessionId) === contextId) this.sessions.delete(binding.sessionId)
    if (!binding.snapshot) return
    const snapshot: TaskPlanSnapshot = {
      ...binding.snapshot, revision: binding.snapshot.revision + 1, execution_state: executionState,
      updated_at: Date.now(),
      plan: binding.snapshot.plan.map(step => ({ ...step, status: step.status === 'in_progress' ? 'pending' : step.status })),
    }
    this.commit(snapshot)
    this.publish(binding.sessionId, snapshot)
  }

  finishSession(sessionId: string, state: TerminalState): void {
    const contextId = this.sessions.get(sessionId)
    if (contextId) this.finish(contextId, state)
  }

}

export function taskPlanRunInstruction(contextId: string): string {
  return `For multi-step work, keep the user's Studio task plan current using the MCP tool ekko_studio_update_plan, available through ekko_studio_use_toolset (action=describe, then action=call). Use context_id="${contextId}" for this turn only; discard any context_id from previous turns. Send the complete ordered plan each time, with stable step ids and statuses pending, in_progress, or completed; at most one step may be in_progress. Create the plan before substantial work, update it as work advances, and mark steps completed only after verification. Skip a plan for simple one-step requests. Prefer this shared plan over a separate native planning tool so the user sees one task card. Do not create Studio sessions or chat runs to update a plan.`
}
