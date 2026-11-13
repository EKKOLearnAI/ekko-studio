import type { AgentTool, AgentToolContext, AgentToolProvider, AgentToolResult } from './types'

export interface AgentSessionTask {
  id: string
  title: string
  summary: string
  status: 'open' | 'completed' | 'closed'
}

export interface AgentSessionTasksSnapshot {
  session_id: string
  revision: number
  updated_at: number
  tasks: AgentSessionTask[]
}

export interface AgentSessionTaskChange {
  id?: string
  title: string
  summary: string
  status: 'open' | 'completed'
  completion_evidence?: string
}

export interface AgentSessionTasksUpdate {
  revision: number
  changes: AgentSessionTaskChange[]
}

export function parseSessionTasksUpdate(input: Record<string, unknown>): AgentSessionTasksUpdate {
  if (Object.keys(input).some(key => !['revision', 'changes'].includes(key))) throw new Error('Only revision and changes are accepted; the host supplies the session.')
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new Error('revision must be a non-negative integer from list_session_tasks.')
  if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 30) throw new Error('changes must contain 1 to 30 goals.')
  const changes: AgentSessionTaskChange[] = input.changes.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !['id', 'title', 'summary', 'status', 'completion_evidence'].includes(key))) throw new Error('Invalid session goal.')
    const { id, title, summary, status, completion_evidence } = value
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 100)) throw new Error('Invalid goal id.')
    if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Goal title must contain 1 to 200 characters.')
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 1000) throw new Error('Goal summary must contain 1 to 1000 characters.')
    if (status !== 'open' && status !== 'completed') throw new Error('Goal status must be open or completed.')
    if (completion_evidence !== undefined && (typeof completion_evidence !== 'string' || completion_evidence.length > 1000)) throw new Error('Invalid completion_evidence.')
    return { ...(id !== undefined ? { id: id.trim() } : {}), title: title.trim(), summary: summary.trim(), status,
      ...(completion_evidence !== undefined ? { completion_evidence: completion_evidence.trim() } : {}) }
  })
  return { revision: input.revision as number, changes }
}

function assertAccess(context?: AgentToolContext): asserts context is AgentToolContext & { sessionId: string } {
  if (!context?.sessionId || (context.delegationDepth || 0) > 0) throw new Error('Session goals are unavailable in this runtime.')
  if (context.signal?.aborted) throw new Error('Session goal operation was cancelled.')
}

function snapshotResult(snapshot: AgentSessionTasksSnapshot, context: AgentToolContext): AgentToolResult {
  assertAccess(context)
  if (snapshot.session_id !== context.sessionId) throw new Error('Session goal operation returned a different session.')
  const data = structuredClone(snapshot)
  return { ok: true, content: JSON.stringify(data), data }
}

/** The host binds the reader to this run's session; the model never selects a session. */
export class ListSessionTasksTool implements AgentTool {
  readonly concurrency = 'parallel' as const
  readonly definition = {
    name: 'list_session_tasks',
    description: 'Read durable user goals for the current session at the beginning of every turn. Review past delivery and outstanding work. Record only independent deliverables, ongoing follow-up or user-requested tracking; skip simple questions, one-off lookups and trivial edits without lasting tracking value. Reuse one goal per user outcome. Reading does not require a write. Closed goals were closed by the user. Leave them unchanged; only the user can reopen them from the task list. Goals span turns; update_plan manages execution steps for this run. The host binds the session. Follow the latest user request.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    try {
      if (Object.keys(input).length) throw new Error('list_session_tasks accepts no arguments; the current session is supplied by the host.')
      assertAccess(context)
      if (!context.listSessionTasks) throw new Error('Session goal queries are unavailable in this runtime.')
      const snapshot = await context.listSessionTasks()
      return snapshotResult(snapshot, context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, error: message }
    }
  }
}

export class UpdateSessionTasksTool implements AgentTool {
  readonly concurrency = 'serial' as const
  readonly definition = {
    name: 'update_session_tasks',
    description: 'Persist changed/new goals worth tracking: independent deliverables, ongoing follow-up or explicit user-requested tracking. Skip simple questions, one-off lookups and trivial edits without lasting tracking value. Keep one goal per user outcome: reuse its id for follow-ups, refinements, corrections, constraints and reopening. Create distinct goals before execution; save changed progress and verified completion before the final response. Use concise outcome titles and one or two short summary sentences about results and remaining blockers; keep implementation and test logs in the conversation, verification in completion_evidence. Omitted goals remain; unchanged ledgers need no write. Use the latest revision; reread on conflict. open includes blocked/interrupted work. Closed goals were closed by the user. Leave them unchanged; only the user can reopen them from the task list. Turn end or a finished update_plan never proves goal completion. Independent of run plans; no page card.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['revision', 'changes'],
      properties: {
        revision: { type: 'integer', minimum: 0 },
        changes: { type: 'array', minItems: 1, maxItems: 30, items: {
          type: 'object', additionalProperties: false, required: ['title', 'summary', 'status'], properties: {
            id: { type: 'string', minLength: 1, maxLength: 100 },
            title: { type: 'string', minLength: 1, maxLength: 200, description: 'Concise user outcome; reuse the existing goal for refinements and corrections.' },
            summary: { type: 'string', minLength: 1, maxLength: 1000, description: 'One or two short sentences about results and remaining blockers. Keep implementation and test logs in the conversation.' },
            status: { type: 'string', enum: ['open', 'completed'] },
            completion_evidence: { type: 'string', maxLength: 1000, description: 'Required when newly completing a goal: concise evidence that its requested outcome was delivered and verified.' },
          },
        } },
      },
    },
  }

  async execute(input: Record<string, unknown>, context?: AgentToolContext): Promise<AgentToolResult> {
    try {
      assertAccess(context)
      if (!context.updateSessionTasks) throw new Error('Session goal updates are unavailable in this runtime.')
      const update = parseSessionTasksUpdate(input)
      return snapshotResult(await context.updateSessionTasks(update), context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, content: message, error: message }
    }
  }
}

export function createSessionTasksToolProvider(): AgentToolProvider {
  return {
    id: 'ekko-session-tasks',
    async listTools(context) {
      if (!context?.sessionId || !context.listSessionTasks || (context.delegationDepth || 0) > 0) return []
      return [new ListSessionTasksTool(), ...(context.updateSessionTasks ? [new UpdateSessionTasksTool()] : [])]
    },
  }
}
