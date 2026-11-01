import { createHash, randomUUID } from 'node:crypto'
import type { PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personError } from '../../contracts/person'
import { getPersonExecution, getPersonTask, listAssignablePersonGoals, listPersonTasks, taskPersonExecutions } from '../../repositories/person-store'
import { applyPersonTask } from './tasks'
import { continuePersonTask } from './task-chat'
import { requirePersonSession } from '../../repositories/person-session-store'
import type { PersonTool } from './model'
import { personFlowSummary, personRequirements } from '../../contracts/person-flow'
import { personDeliveryCurrent } from './delivery'
import { assertPersonStage, personTaskStage } from '../../repositories/person-stage-store'

type Field = { type: 'string' | 'boolean' | 'integer' | 'array' | ['string', 'null']; maxLength?: number; minLength?: number; minimum?: number; enum?: string[]; description?: string; maxItems?: number; items?: Field | { type: 'object'; properties: Record<string, Field>; required: string[]; additionalProperties: false } }
type Action = 'adopt' | 'update' | 'start' | 'continue' | 'stop' | 'close' | 'reopen' | 'advance' | 'accept'
type Snapshot = Pick<PersonTask, 'id' | 'session_id' | 'session_title' | 'title' | 'summary' | 'status' | 'revision' | 'execution_id' | 'execution_state' | 'running' | 'pending_count'> & { requirements_json?: string }
type Reference = { task: Snapshot; assignable: boolean; expiresAt: number }
const text = (maxLength: number): Field => ({ type: 'string', minLength: 1, maxLength })
const actionFields: Record<Action, string[]> = {
  adopt: ['goal', 'agent_id', 'start', 'session_id', 'remember_result'], update: ['goal'], continue: ['message', 'remember_result'], start: ['remember_result'], stop: [], close: [], reopen: [], advance: ['message'], accept: ['candidate', 'evidence'],
}
const actionRequired: Partial<Record<Action, string[]>> = { adopt: ['goal'], update: ['goal'], continue: ['message'], advance: ['message'], accept: ['candidate', 'evidence'] }
const queryAgain = 'Call bot_tasks_query again and reconsider the action using its current task_ref and allowed_actions.'
const listAgain = 'List tasks with bot_tasks_query {"search":"","offset":0}, or put keywords in search. Omit task_id; never guess all/recent/0. For details, copy an exact id from the list.'

/** These flat tool contracts drive both the advertised schema and runtime validation. */
function validate(input: Record<string, unknown>, fields: Record<string, Field>, required: string[]) {
  if (required.some(key => input[key] === undefined)) throw personError(`Required fields: ${required.join(', ')}`)
  for (const [key, value] of Object.entries(input)) {
    const field = fields[key]
    if (!Object.hasOwn(fields, key)) throw personError(`Unknown field: ${key}`)
    const types: string[] = Array.isArray(field.type) ? field.type : [field.type]
    if (value === null && types.includes('null')) continue
    if (types.includes('string') && (typeof value !== 'string' || value.trim().length < (field.minLength ?? 1) || value.length > field.maxLength!)) throw personError(`Invalid ${key}`)
    if (types.includes('boolean') && typeof value !== 'boolean') throw personError(`Invalid ${key}`)
    if (types.includes('integer') && (!Number.isSafeInteger(value) || Number(value) < (field.minimum || 0))) throw personError(`Invalid ${key}`)
    if (field.enum && !field.enum.includes(String(value))) throw personError(`Unsupported ${key}`)
    if (types.includes('array')) {
      if (!Array.isArray(value) || value.length > field.maxItems!) throw personError(`Invalid ${key}`)
      for (const item of value) {
        if (field.items?.type !== 'object') { validate({ value: item }, { value: field.items as Field }, ['value']); continue }
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw personError(`Invalid ${key} item`)
        validate(item, field.items!.properties, field.items!.required)
      }
    }
  }
}
function failure(code: string, message: string, recovery: string, taskId?: string) {
  return { ok: false as const, error: { code, message, recovery, ...(taskId ? { query: { task_id: taskId } } : {}) } }
}
function actions(task: Snapshot, assignable = false, sessionId = '', staged = false): Action[] {
  if (assignable) return ['adopt']
  const requirements = task.requirements_json ? personRequirements({ requirements_json: task.requirements_json }) : undefined
  if (requirements?.verification?.state === 'pending' && task.execution_id === requirements.verification.execution_id
    && task.execution_state === 'finished' && !task.pending_count && task.status === 'open' && task.session_id === sessionId)
    return ['accept', 'continue', 'close']
  if (requirements?.flow) {
    const own = sessionId === task.session_id, creator = sessionId === requirements.creator_session_id
    if (!own && !creator) return []
    if (requirements.flow.stopped) return creator ? ['reopen'] : []
    if (!own) return requirements.flow.completed || task.status === 'closed' ? [] : ['stop']
    if (!requirements.flow.completed && task.status !== 'closed' && task.execution_state === 'finished' && !task.pending_count) return ['advance', 'continue', 'stop', 'close']
    if (!requirements.flow.completed && task.status !== 'closed' && task.execution_state === 'failed' && !task.pending_count) return ['continue', 'stop', 'close']
    if (!requirements.flow.completed && !task.running && task.status === 'open') return ['update', 'start', 'continue', 'stop', 'close']
  }
  if (task.execution_state === 'stopping') return ['stop']
  if (staged && task.status !== 'closed' && !task.pending_count && ['finished','failed','interrupted'].includes(task.execution_state || '')) return ['continue','close']
  if (task.running) return task.execution_id && ['pending','queued','starting','running','waiting_person','waiting_user','waiting_approval'].includes(task.execution_state || '') ? ['continue', 'stop'] : ['continue']
  return task.status === 'open' ? ['update', 'start', 'continue', 'close'] : task.status === 'closed' ? ['reopen'] : ['continue', 'reopen', 'close']
}

/** One instance per Person main turn. References never grant ownership or outlive this toolset. */
export function personTaskTools(userId: number, currentSessionId: string, projectId = ''): PersonTool[] {
  const namespace = randomUUID()
  const references = new Map<string, Reference>()
  const requests = new Map<string, Promise<unknown>>()
  const ttl = 10 * 60_000
  const expose = (task: Snapshot, assignable = false) => {
    const snapshot: Snapshot = { id: task.id, session_id: task.session_id, session_title: task.session_title, title: task.title, summary: task.summary.slice(0, 500), status: task.status,
      revision: task.revision, execution_id: task.execution_id || null, execution_state: task.execution_state || 'idle', running: Boolean(task.running), pending_count: task.pending_count || 0, requirements_json: task.requirements_json }
    for (const [ref, value] of references) if (value.expiresAt <= Date.now()) references.delete(ref)
    let ref = [...references].find(([, value]) => value.assignable === assignable && JSON.stringify(value.task) === JSON.stringify(snapshot))?.[0]
    if (!ref) {
      ref = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      if (references.size >= 128) references.delete(references.keys().next().value!)
      references.set(ref, { task: snapshot, assignable, expiresAt: Date.now() + ttl })
    }
    const { revision: _revision, running: _running, requirements_json: _requirements, ...visible } = snapshot
    const context = _requirements ? personFlowSummary({ requirements_json: _requirements }) : undefined
    const stage = assignable ? undefined : personTaskStage(userId,task.id)
    return { ...visible, ...context, ...(stage ? { stage } : {}), ...(context ? { return_expectation: context.return_expectation.slice(0,400) } : {}), task_ref: ref, allowed_actions: actions(snapshot, assignable, currentSessionId,!!stage) }
  }
  const execute = async (input: Record<string, unknown>, origin?: PersonTaskOrigin) => {
    origin ||= { sessionId: currentSessionId, runId: '', messages: [] }
    if (projectId && input.project_id && input.project_id !== projectId) throw personError('Task must use the bound project',403)
    if (input.task_id && projectId && personRequirements(getPersonTask(userId,String(input.task_id))).contract?.project?.id !== projectId) throw personError('Task is outside the project',403)
    if (input.action === 'create' && projectId) input = { ...input, project_id: projectId }
    if (input.remember_result === true && (!origin.memoryRequest || origin.returnExecutionId || origin.memoryRequest.sessionId !== currentSessionId)) {
      throw personError('remember_result requires the current user request; background results cannot grant memory writes', 403)
    }
    origin = { ...origin, memoryRequest: input.remember_result === true ? origin.memoryRequest : undefined }
    if (origin.stage) {
      assertPersonStage(userId,origin.stage,currentSessionId)
      if (input.action !== 'create') {
        const linked = personTaskStage(userId,String(input.task_id))
        if (linked?.stageId !== origin.stage.stageId) throw personError('This stage may only control its own subtasks',403)
      }
    }
    // Stable ordering gives exact retries the same durable idempotency key, even
    // when a model reorders fields or the service committed before a transport error.
    const normalized = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))
    const key = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const previous = requests.get(key)
    if (previous) return { ...await previous as object, replayed: true }
    if (origin.returnExecutionId) {
      if (!personDeliveryCurrent(userId, origin.returnExecutionId)) throw personError('Result callback is no longer current', 409)
      const returned = getPersonTask(userId, getPersonExecution(userId, origin.returnExecutionId).task_id)
      if (personRequirements(returned).flow && input.task_id !== returned.id) throw personError('A flow callback must operate its existing task', 403)
    }
    if (requests.size >= 128) return failure('TURN_LIMIT', 'Too many task operations in this turn', 'Continue in a new user turn.')
    const pending = (async () => {
      const result = normalized.action === 'continue'
        ? await continuePersonTask(userId, String(normalized.task_id), { input: [{ type: 'text', text: normalized.message }], expected_revision: normalized.expected_revision, expected_execution_id: normalized.expected_execution_id, idempotency_key: `${namespace}:${key}` }, origin)
        : await applyPersonTask(userId, { ...normalized, idempotency_key: `${namespace}:${key}` }, undefined, origin)
      return { ok: true, task: expose(result.task), ...(result.execution ? { execution: { id: result.execution.id, state: result.execution.state },
        ...(['create','adopt','start','continue'].includes(String(normalized.action)) ? { instruction:'Worker accepted. End this turn and wait for its automatic result callback, which resumes the remaining user-requested handoffs. Queued is normal: do not poll, stop, replace or duplicate this work.' } : {}) } : {}) }
    })()
    requests.set(key, pending)
    try { return await pending } catch (error) { requests.delete(key); throw error }
  }
  const define = (name: string, description: string, fields: Record<string, Field>, required: string[], run: PersonTool['execute']): PersonTool => ({
    name, description, parameters: { type: 'object', properties: fields, required, additionalProperties: false },
    async execute(args, origin) {
      try { validate(args, fields, required); return await run(args, origin) }
      catch (error) {
        const status = (error as { status?: number }).status
        const message = error instanceof Error ? error.message : 'Task operation failed'
        const taskId = references.get(String(args.task_ref))?.task.id
        if ((error as { code?: string }).code === 'ROLE_HANDOFF_REQUIRED') return failure('ROLE_HANDOFF_REQUIRED', message, 'Use bot_flow_create with one stage for the target session_id. The recipient replies directly or chooses its own Agent; do not create a worker to relay a message.')
        if (status === 409 || status === 404) return failure(status === 404 ? 'TASK_UNAVAILABLE' : 'STALE_TASK', message, name === 'bot_tasks_query' ? listAgain : queryAgain, taskId)
        if (status === 400) return failure('INVALID_ARGUMENT', message, 'Correct the arguments using this tool schema; do not supply host-managed fields.')
        if (status === 403) return failure('ACCESS_DENIED', message, 'This operation is not authorized; do not retry with another task reference.')
        throw error
      }
    },
  })
  const query = define('bot_tasks_query', 'List/search tasks, including completed ones; exact task_id for details. Query existing work before routing follow-ups. Use fresh task_ref/allowed_actions. assignable=true lists adoptable goals.', {
    session_id: { ...text(100), description: 'Conversation filter.' },
    task_id: { ...text(100), type: ['string', 'null'], minLength: 0 }, search: { ...text(200), minLength: 0 }, offset: { type: 'integer', minimum: 0 }, assignable: { type: 'boolean' },
  }, [], async args => {
    if (args.assignable) return { tasks: projectId ? [] : (listAssignablePersonGoals(userId, String(args.search || '')) as Snapshot[]).map(task => expose(task, true)) }
    const taskId = String(args.task_id || '').trim()
    if (taskId) {
      const task = getPersonTask(userId, taskId)
      const requirements = personRequirements(task)
      if (projectId && requirements.contract?.project?.id !== projectId) throw personError('Task is outside the project',403)
      return { task: { ...expose(task), goal: requirements.goal, contract: requirements.contract, verification: requirements.verification, return_expectation: requirements.return_expectation || '' }, executions: taskPersonExecutions(userId, task.id).slice(0, 5).map(run => ({ id: run.id, state: run.state, output_preview: run.output.slice(0, 500) })) }
    }
    const offset = Number(args.offset) || 0
    const tasks = listPersonTasks(userId, String(args.search || ''), offset, { limit: 11, sessionId: args.session_id ? requirePersonSession(userId, String(args.session_id)).id : undefined })
    return { tasks: tasks.slice(0, 10).filter(task => !projectId || personRequirements(task).contract?.project?.id === projectId).map(task => expose(task)), next_offset: tasks.length > 10 ? offset + 10 : null }
  })
  const create = define('bot_task_create', 'New background task for THIS role only, never message forwarding. For additions, changes, fixes or feedback on existing work, query and continue the original task, even if completed. Create only for an independent goal, an explicit separate-task request, or verified inability to continue (explain why). agent_id from bot_agents_list. Starts unless start=false. Other roles: bot_flow_create.', {
    session_id: { ...text(100), description: 'Omit; only the current conversation is allowed.' }, title: text(200), goal: text(8000), agent_id: text(100), start: { type: 'boolean' },
    remember_result: { type: 'boolean', description: 'Remember at current user request.' },
    project_id: text(100), workspace: text(4000), branch: text(200),
    access_mode: { ...text(10), enum: ['read','write'], description: 'Read tasks share resource claims; write tasks claim an exclusive workspace.' },
    acceptance: text(4000), authorization: text(4000),
    resources: { type: 'array', maxItems: 20, items: text(200), description: 'Shared deployment or device resource IDs. Conflicting writes queue.' },
    dependencies: { type: 'array', maxItems: 20, items: text(200), description: 'Existing task IDs in this project that must complete first.' },
  }, ['title', 'goal'], (args, origin) => execute({ action: 'create', session_id: currentSessionId, ...args }, origin))
  const control = define('bot_task_control', 'Use fresh task_ref/allowed_actions. Default to continue for follow-ups on existing work, including completed tasks; it preserves the original Agent, owner and conversation. advance follows legacy route. Only creator reopens stopped legacy flows.', {
    candidate: { ...text(64), description: 'accept only: exact candidate hash from task details.' },
    evidence: { ...text(4000), description: 'accept only: observed checks against acceptance criteria, with artifact or commit evidence. Inspect results first; model success alone is insufficient.' },
    task_ref: text(100), action: { ...text(30), enum: Object.keys(actionFields) }, session_id: { ...text(100), description: 'Adopt only, current conversation only.' }, goal: { ...text(8000), description: 'Adopt/update only.' }, message: { ...text(32000), description: 'continue: new requirements, changes, fixes or feedback for the original Agent in its existing conversation; advance: outcome and artifacts (max 4000).' }, agent_id: text(100), start: { type: 'boolean' },
    remember_result: { type: 'boolean', description: 'adopt/start/continue only.' },
  }, ['task_ref', 'action'], async (args, origin) => {
    const action = args.action as Action
    if (Object.keys(args).some(key => !['task_ref', 'action', ...actionFields[action]].includes(key))) throw personError(`Unsupported fields for ${action}`)
    if (actionRequired[action]?.some(key => args[key] === undefined)) throw personError(`${action} requires ${actionRequired[action]!.join(', ')}`)
    const reference = references.get(String(args.task_ref))
    if (!reference || reference.expiresAt <= Date.now()) return failure('INVALID_TASK_REF', 'Task reference is unknown or expired', queryAgain)
    const { task, assignable } = reference
    if (!actions(task, assignable, currentSessionId,!!personTaskStage(userId,task.id)).includes(action)) return failure('ACTION_NOT_ALLOWED', 'Action is unavailable for the queried task state', queryAgain, task.id)
    const { task_ref: _ref, ...intent } = args
    return execute({ ...(action === 'adopt' ? { session_id: currentSessionId } : {}), ...intent, task_id: task.id, expected_revision: task.revision,
      ...(!assignable ? { expected_execution_id: task.execution_id || null } : {}),
      ...(action === 'stop' ? { execution_id: task.execution_id } : {}),
    }, origin)
  })
  return [query, create, control]
}
