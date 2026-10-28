import { createHash, randomUUID } from 'node:crypto'
import type { PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personError } from '../../contracts/person'
import { getPersonTask, listAssignablePersonGoals, listPersonTasks, taskPersonExecutions } from '../../repositories/person-store'
import { applyPersonTask } from './tasks'
import type { PersonTool } from './model'

type Field = { type: 'string' | 'boolean' | 'integer' | ['string', 'null']; maxLength?: number; minLength?: number; minimum?: number; enum?: string[]; description?: string }
type Action = 'adopt' | 'update' | 'start' | 'stop' | 'close' | 'reopen'
type Snapshot = Pick<PersonTask, 'id' | 'title' | 'summary' | 'status' | 'revision' | 'execution_id' | 'execution_state' | 'running'>
type Reference = { task: Snapshot; assignable: boolean; expiresAt: number }
const text = (maxLength: number): Field => ({ type: 'string', minLength: 1, maxLength })
const actionFields: Record<Action, string[]> = {
  adopt: ['goal', 'agent_id', 'start'], update: ['goal'], start: [], stop: [], close: [], reopen: [],
}
const actionRequired: Partial<Record<Action, string[]>> = { adopt: ['goal'], update: ['goal'] }
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
  }
}
function failure(code: string, message: string, recovery: string, taskId?: string) {
  return { ok: false as const, error: { code, message, recovery, ...(taskId ? { query: { task_id: taskId } } : {}) } }
}
function actions(task: Snapshot, assignable = false): Action[] {
  if (assignable) return ['adopt']
  if (task.running) return task.execution_id && ['queued','starting','running','waiting_person','waiting_user','waiting_approval','stopping'].includes(task.execution_state || '') ? ['stop'] : []
  return task.status === 'open' ? ['update', 'start', 'close'] : task.status === 'closed' ? ['reopen'] : ['reopen', 'close']
}

/** One instance per Person main turn. References never grant ownership or outlive this toolset. */
export function personTaskTools(userId: number): PersonTool[] {
  const namespace = randomUUID()
  const references = new Map<string, Reference>()
  const requests = new Map<string, Promise<unknown>>()
  const ttl = 10 * 60_000
  const expose = (task: Snapshot, assignable = false) => {
    const snapshot: Snapshot = { id: task.id, title: task.title, summary: task.summary.slice(0, 500), status: task.status,
      revision: task.revision, execution_id: task.execution_id || null, execution_state: task.execution_state || 'idle', running: Boolean(task.running) }
    for (const [ref, value] of references) if (value.expiresAt <= Date.now()) references.delete(ref)
    let ref = [...references].find(([, value]) => value.assignable === assignable && JSON.stringify(value.task) === JSON.stringify(snapshot))?.[0]
    if (!ref) {
      ref = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      if (references.size >= 128) references.delete(references.keys().next().value!)
      references.set(ref, { task: snapshot, assignable, expiresAt: Date.now() + ttl })
    }
    const { revision: _revision, running: _running, ...visible } = snapshot
    return { ...visible, task_ref: ref, allowed_actions: actions(snapshot, assignable) }
  }
  const execute = async (input: Record<string, unknown>, origin?: PersonTaskOrigin) => {
    // Stable ordering gives exact retries the same durable idempotency key, even
    // when a model reorders fields or the service committed before a transport error.
    const normalized = Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)))
    const key = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    const previous = requests.get(key)
    if (previous) return { ...await previous as object, replayed: true }
    if (requests.size >= 128) return failure('TURN_LIMIT', 'Too many task operations in this turn', 'Continue in a new user turn.')
    const pending = (async () => {
      const result = await applyPersonTask(userId, { ...normalized, idempotency_key: `${namespace}:${key}` }, undefined, origin)
      return { ok: true, task: expose(result.task), ...(result.execution ? { execution: { id: result.execution.id, state: result.execution.state } } : {}) }
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
        if (status === 409 || status === 404) return failure(status === 404 ? 'TASK_UNAVAILABLE' : 'STALE_TASK', message, name === 'bot_tasks_query' ? listAgain : queryAgain, taskId)
        if (status === 400) return failure('INVALID_ARGUMENT', message, 'Correct the arguments using this tool schema; do not supply host-managed fields.')
        if (status === 403) return failure('ACCESS_DENIED', message, 'This operation is not authorized; do not retry with another task reference.')
        throw error
      }
    },
  })
  const query = define('bot_tasks_query', 'List/search current tasks; omit task_id or use null/empty unless reading an exact id returned here. Never invent IDs such as all/recent/0. Use current task_ref and allowed_actions for control. assignable=true discovers account-owned goals for explicit adoption.', {
    task_id: { ...text(100), type: ['string', 'null'], minLength: 0 }, search: { ...text(200), minLength: 0 }, offset: { type: 'integer', minimum: 0 }, assignable: { type: 'boolean' },
  }, [], async args => {
    if (args.assignable) return { tasks: (listAssignablePersonGoals(userId, String(args.search || '')) as Snapshot[]).map(task => expose(task, true)) }
    const taskId = String(args.task_id || '').trim()
    if (taskId) {
      const task = getPersonTask(userId, taskId)
      return { task: { ...expose(task), goal: JSON.parse(task.requirements_json).goal }, executions: taskPersonExecutions(userId, task.id).slice(0, 5).map(run => ({ id: run.id, state: run.state, output_preview: run.output.slice(0, 500) })) }
    }
    const offset = Number(args.offset) || 0
    const tasks = listPersonTasks(userId, String(args.search || ''), offset, { limit: 11 })
    return { tasks: tasks.slice(0, 10).map(task => expose(task)), next_offset: tasks.length > 10 ? offset + 10 : null }
  })
  const create = define('bot_task_create', 'Create new background work. Supply all requirements in goal; choose agent_id from bot_agents_list. Starts immediately unless start=false. Identical requests within this turn are deduplicated by the host. Use bot_task_control to operate existing work.', {
    title: text(200), goal: text(8000), agent_id: text(100), start: { type: 'boolean' },
  }, ['title', 'goal'], (args, origin) => execute({ action: 'create', ...args }, origin))
  const control = define('bot_task_control', 'Control an existing task using a task_ref from bot_tasks_query in this turn and one of its allowed_actions. The host binds the queried version, execution and retry identity. adopt/update require goal; adopt may also select agent_id and start. All tasks use the selected Person workspace. Adopt only on an explicit user request. Stop leaves future schedules unchanged; stopping means requested, so query before claiming stopped. Reopen completed/closed work before starting it. After a stale-reference error, query and reconsider; never guess internal IDs or versions.', {
    task_ref: text(100), action: { ...text(30), enum: Object.keys(actionFields), description: 'start resumes the saved requirements unchanged; update changes requirements only when the user requests a change. reopen changes status without starting work.' }, goal: { ...text(8000), description: 'Required for adopt/update only. Do not rewrite the saved goal merely to resume work.' }, agent_id: text(100), start: { type: 'boolean' },
  }, ['task_ref', 'action'], async (args, origin) => {
    const action = args.action as Action
    if (Object.keys(args).some(key => !['task_ref', 'action', ...actionFields[action]].includes(key))) throw personError(`Unsupported fields for ${action}`)
    if (actionRequired[action]?.some(key => args[key] === undefined)) throw personError(`${action} requires goal`)
    const reference = references.get(String(args.task_ref))
    if (!reference || reference.expiresAt <= Date.now()) return failure('INVALID_TASK_REF', 'Task reference is unknown or expired', queryAgain)
    const { task, assignable } = reference
    if (!actions(task, assignable).includes(action)) return failure('ACTION_NOT_ALLOWED', 'Action is unavailable for the queried task state', queryAgain, task.id)
    const { task_ref: _ref, ...intent } = args
    return execute({ ...intent, task_id: task.id, expected_revision: task.revision,
      ...(!assignable ? { expected_execution_id: task.execution_id || null } : {}),
      ...(action === 'stop' ? { execution_id: task.execution_id } : {}),
    }, origin)
  })
  control.parameters!.anyOf = Object.entries(actionFields).map(([action, fields]) => ({
    properties: Object.fromEntries(['task_ref', 'action', ...fields].map(key => [key, key === 'action' ? { enum: [action] } : {}])),
    required: actionRequired[action as Action] || [], additionalProperties: false,
  }))
  return [query, create, control]
}
