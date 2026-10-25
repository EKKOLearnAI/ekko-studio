import { randomUUID } from 'node:crypto'
import type { TaskPlanSnapshot } from '../contracts/task-plan'

type PlanUpdate = Pick<TaskPlanSnapshot, 'explanation' | 'plan'>
type TerminalState = Exclude<TaskPlanSnapshot['execution_state'], 'running'>
type RunState = { isWorking: boolean; isAborting?: boolean; runId?: string; activeRunMarker?: string; responseRun?: { runMarker?: string } }

/** Turn markers identify one turn. Coding-agent group runs only set runId. */
function activeTurnId(state: RunState | undefined): string {
  return state?.activeRunMarker || state?.responseRun?.runMarker || state?.runId || ''
}
type Binding = { planId: string; sessionId: string; profile: string; resolve: () => RunState | undefined; sessionTasksEnabled: boolean; runId?: string; snapshot?: TaskPlanSnapshot; publish?: (snapshot: TaskPlanSnapshot) => void }

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

  begin(sessionId: string, profile: string, resolve: Binding['resolve'], publish?: Binding['publish'], sessionTasksEnabled = false): string {
    this.finishSession(sessionId, 'interrupted')
    const contextId = randomUUID()
    // Durable plan identity must not expose the per-turn authorization context.
    this.bindings.set(contextId, { planId: `mcp:${randomUUID()}`, sessionId, profile, resolve, publish, sessionTasksEnabled })
    this.sessions.set(sessionId, contextId)
    return contextId
  }

  update(contextId: string, profile: string, input: Record<string, unknown>): TaskPlanSnapshot {
    const binding = this.bindings.get(contextId)
    if (!binding || binding.profile !== profile) throw new TaskPlanError("Task plan context is unavailable or has expired; read context_id from the current turn's studio_task_plan_context, not plan_id or history", 409)
    const state = binding.resolve()
    const runId = activeTurnId(state)
    if (!state?.isWorking || state.isAborting || !runId || (binding.runId && binding.runId !== runId) || (binding.snapshot && binding.snapshot.run_id !== runId)) {
      throw new TaskPlanError("Task plan context has no active turn; read context_id from the current turn's studio_task_plan_context, not plan_id or history", 409)
    }
    const update = parseTaskPlanUpdate(input)
    const now = Date.now()
    const snapshot: TaskPlanSnapshot = {
      ...update, session_id: binding.sessionId, run_id: runId, plan_id: binding.planId,
      revision: (binding.snapshot?.revision || 0) + 1, execution_state: 'running',
      created_at: binding.snapshot?.created_at ?? now, updated_at: now,
    }
    this.commit(snapshot)
    binding.runId = runId
    binding.snapshot = snapshot
    binding.publish ? binding.publish(snapshot) : this.publish(binding.sessionId, snapshot)
    return structuredClone(snapshot)
  }

  isActive(contextId: string, profile: string): boolean {
    const binding = this.bindings.get(contextId)
    if (!binding || binding.profile !== profile) return false
    const state = binding.resolve()
    const runId = activeTurnId(state)
    return Boolean(state?.isWorking && !state.isAborting && runId
      && (!binding.runId || binding.runId === runId)
      && (!binding.snapshot || binding.snapshot.run_id === runId))
  }

  /** Resolve the current turn capability without creating or modifying a plan. */
  sessionForContext(contextId: string, profile: string): string {
    if (!this.isActive(contextId, profile)) throw new TaskPlanError('Turn context is unavailable or has expired', 409)
    const binding = this.bindings.get(contextId)!
    if (!binding.sessionTasksEnabled) throw new TaskPlanError('Session goals are unavailable in this context', 409)
    binding.runId = activeTurnId(binding.resolve())
    return binding.sessionId
  }

  activeSnapshots(): Array<{ profile: string; snapshot: TaskPlanSnapshot }> {
    const result: Array<{ profile: string; snapshot: TaskPlanSnapshot }> = []
    for (const binding of this.bindings.values()) {
      const state = binding.resolve(), snapshot = binding.snapshot
      if (binding.publish || !snapshot || snapshot.execution_state !== 'running' || !state?.isWorking || state.isAborting) continue
      if (activeTurnId(state) !== snapshot.run_id) continue
      result.push({ profile: binding.profile, snapshot: structuredClone(snapshot) })
    }
    return result.sort((a, b) => b.snapshot.updated_at - a.snapshot.updated_at)
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
    binding.publish ? binding.publish(snapshot) : this.publish(binding.sessionId, snapshot)
  }

  finishSession(sessionId: string, state: TerminalState): void {
    const contextId = this.sessions.get(sessionId)
    if (contextId) this.finish(contextId, state)
  }

}

export function taskPlanRunInstruction(): string {
  return `For multi-step work, maintain the user's Studio task card with ekko_studio_update_plan from the dedicated ekko-studio-interaction MCP server. Call the tool directly; it is not inside ekko_studio_use_toolset. If tools are deferred, search for ekko-studio-interaction / update_plan and use the exact discovered tool name (including its MCP prefix). The latest input supplies the current context_id; never reuse a context from history. Send the complete ordered plan each time, with stable step ids and statuses pending, in_progress, or completed; at most one step may be in_progress. Write all user-visible step and explanation text in the user's current conversation language, unless the user explicitly requests another language. Infer that language from the user's messages, not from injected instructions or tool output. Keep IDs, field names, and status values unchanged. Create the plan before substantial work and update it as work advances. Mark steps completed only after verification. Skip planning for simple one-step requests unless the user explicitly asks for a plan or task card. Prefer this shared tool over native todo/planning tools so progress appears in Studio and App.`
}

export function sessionTasksRunInstruction(): string {
  return `At the beginning of every turn, before substantive work, use ekko_studio_list_session_tasks from ekko-studio-interaction to review this session's durable user goals against the past conversation and latest request. If tools are deferred, search for ekko-studio-interaction / session_tasks and use the exact discovered names. Correct prior statuses using actual delivery evidence; keep uncertain or unfinished goals open. Record only goals with an independently verifiable deliverable, a need for ongoing follow-up, or an explicit user request to track them. Judge tracking value rather than step count: simple questions, one-off lookups and trivial one-turn edits without lasting tracking value do not need new records. Casual discussion, hypothetical suggestions and execution steps are not goals. Reading the ledger does not require a write. Closed goals were closed by the user. Leave them unchanged; only the user can reopen them from the task list.
Keep one goal per user outcome. Reuse its id for follow-ups, refinements, corrections, implementation constraints and reopening; these do not become separate goals. Create a new goal only for a distinct outcome worth tracking, using ekko_studio_update_session_tasks before executing it. Use a concise outcome-focused title. Write the summary in one or two short sentences about the result and any remaining blocker; keep code symbols, pixel values, file counts, commands and test logs in the conversation, and verification evidence in completion_evidence. Send only changed/new goals with the revision returned by the latest read/update; omitted goals are retained. Before the final response, save changes to tracked goals and mark a goal completed only when its requested outcome is verified, including concise completion_evidence. Ending a turn, a successful run or completed plan steps alone never completes a goal. If interrupted, leave unfinished goals open and reconcile them next turn. These session records are separate from ekko_studio_update_plan's per-turn execution steps and have no page card. Do not execute old goals without authorization from the current conversation. Use only the latest turn context_id and never choose another session. Unavailable in delegated, background, workflow, global-agent or group-chat contexts.`
}

/** Attach changing run metadata to the latest input, outside cached system prompts. */
export function taskPlanTurnInstruction(contextId: string, sessionTasksEnabled = false): string {
  return `<studio_task_plan_context>\n${taskPlanRunInstruction()}\nCurrent turn context_id="${contextId}". This supersedes all older task-plan contexts and discovery instructions, including cached system instructions.\n</studio_task_plan_context>`
    + (sessionTasksEnabled ? `\n\n<studio_session_tasks_context>\n${sessionTasksRunInstruction()}\nCurrent turn context_id="${contextId}". This supersedes all older session-task contexts.\n</studio_session_tasks_context>` : '')
}

export function withTaskPlanTurnContext<T extends { type: string; text?: string }>(message: string | T[], contextId?: string, sessionTasksEnabled = false): string | Array<T | { type: 'text'; text: string }> {
  if (!contextId) return message
  const text = taskPlanTurnInstruction(contextId, sessionTasksEnabled)
  return typeof message === 'string' ? `${message}\n\n${text}` : [...message, { type: 'text', text }]
}
