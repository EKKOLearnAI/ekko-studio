import { personAcceptanceInputSchema, personAcceptanceReportSchema } from '../../contracts/person-acceptance'
import { personAcceptanceDetail } from '../../repositories/person-acceptance-store'
import { botAcceptanceContext } from './bot-acceptance'
import { createHash, randomUUID } from 'node:crypto'
import type { PersonTask, PersonTaskOrigin } from '../../contracts/person'
import { personError } from '../../contracts/person'
import { getPersonExecution, getPersonTask, listAssignablePersonGoals, listPersonTasks, taskPersonExecutions } from '../../repositories/person-store'
import { applyPersonTask } from './tasks'
import { continuePersonTask } from './task-chat'
import { redirectPersonTask } from './task-redirection'
import { requirePersonSession } from '../../repositories/person-session-store'
import type { PersonTool } from './model'
import { personFlowSummary, personRequirements } from '../../contracts/person-flow'
import { personDeliveryCurrent } from './delivery'
import { assertPersonStage, assertPersonStageTask, getPersonFlow, personTaskStage } from '../../repositories/person-stage-store'
import { resolve } from 'node:path'

type Field = { type: string | readonly string[]; maxLength?: number; minLength?: number; minimum?: number; maximum?: number; enum?: string[]; description?: string; minItems?: number; maxItems?: number; items?: Field; properties?: Record<string, Field>; required?: readonly string[]; additionalProperties?: boolean }
type Action = 'adopt' | 'update' | 'start' | 'continue' | 'redirect' | 'stop' | 'close' | 'reopen' | 'advance' | 'configure_acceptance' | 'verify' | 'record_acceptance'
type Snapshot = Pick<PersonTask, 'redirect_state' | 'redirect_error' | 'acceptance_state' | 'acceptance_reason' | 'id' | 'session_id' | 'session_title' | 'title' | 'summary' | 'status' | 'revision' | 'execution_id' | 'execution_state' | 'running' | 'pending_count'> & { requirements_json?: string }
type Reference = { task: Snapshot; assignable: boolean; expiresAt: number }
const text = (maxLength: number): Field => ({ type: 'string', minLength: 1, maxLength })
const actionFields: Record<Action, string[]> = {
  adopt: ['goal', 'agent_id', 'start', 'session_id', 'remember_result', 'acceptance'], update: ['goal'], continue: ['message', 'remember_result'], redirect: ['goal', 'title', 'message', 'remember_result'], start: ['remember_result'], stop: [], close: [], reopen: [], advance: ['message'], configure_acceptance: ['acceptance'], verify: [], record_acceptance: ['verification_execution_id','report'],
}
const actionRequired: Partial<Record<Action, string[]>> = { adopt: ['goal'], update: ['goal'], continue: ['message'], redirect: ['goal'], advance: ['message'], configure_acceptance: ['acceptance'], record_acceptance: ['verification_execution_id','report'] }
const queryAgain = 'Call bot_tasks_query again and reconsider the action using its current task_ref and allowed_actions.'
const listAgain = 'List tasks with bot_tasks_query {"search":"","offset":0}, or put keywords in search. Omit task_id; never guess all/recent/0. For details, copy an exact id from the list.'

/** These flat tool contracts drive both the advertised schema and runtime validation. */
function validate(input: Record<string, unknown>, fields: Record<string, Field>, required: string[]) {
  if (required.some(key => input[key] === undefined)) throw personError(`Required fields: ${required.join(', ')}`)
  for (const [key, value] of Object.entries(input)) {
    const field = fields[key]
    if (!Object.hasOwn(fields, key)) throw personError(`Unknown field: ${key}`)
    const types: readonly string[] = typeof field.type === 'string' ? [field.type] : field.type
    if (value === null && types.includes('null')) continue
    if (types.includes('string') && (typeof value !== 'string' || value.trim().length < (field.minLength ?? 1) || value.length > field.maxLength!)) throw personError(`Invalid ${key}`)
    if (types.includes('boolean') && typeof value !== 'boolean') throw personError(`Invalid ${key}`)
    if (types.includes('integer') && (!Number.isSafeInteger(value) || Number(value) < (field.minimum || 0) || Number(value) > (field.maximum ?? Infinity))) throw personError(`Invalid ${key}`)
    if (field.enum && !field.enum.includes(String(value))) throw personError(`Unsupported ${key}`)
    if (types.includes('object')) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw personError(`Invalid ${key}`)
      validate(value as Record<string, unknown>,field.properties!,[...(field.required || [])])
    }
    if (types.includes('array')) {
      if (!Array.isArray(value) || value.length > (field.maxItems ?? Infinity) || value.length < (field.minItems || 0)) throw personError(`Invalid ${key}`)
      for (const item of value) validate({ item },{ item: field.items! },['item'])
    }
  }
}
function failure(code: string, message: string, recovery: string, taskId?: string) {
  return { ok: false as const, error: { code, message, recovery, ...(taskId ? { query: { task_id: taskId } } : {}) } }
}
function baseActions(task: Snapshot, assignable = false, sessionId = '', staged = false): Action[] {
  if (assignable) return ['adopt']
  const requirements = task.requirements_json ? personRequirements({ requirements_json: task.requirements_json }) : undefined
  const developer=task.session_id===sessionId, reviewer=(requirements?.acceptance?.reviewer_session_id || task.session_id)===sessionId
  if (requirements?.verification_for) return developer?(task.status==='closed'?['reopen']:task.running?['stop']:['continue','close']):[]
  if (requirements?.acceptance?.progression==='automatic' && ['awaiting_dispatch','repair_required'].includes(task.acceptance_state || '')) return developer?['stop','close']:[]
  if (task.acceptance_state==='awaiting_dispatch') return developer?['verify','stop','close']:[]
  if (task.acceptance_state==='verification_pending') return developer?['stop','close']:[]
  if (task.acceptance_state==='awaiting_review') return reviewer?['record_acceptance','verify',...(developer?['stop','close'] as Action[]:[])]:developer?['verify','stop','close']:[]
  if (task.acceptance_state==='repair_required') return developer?['continue','stop','close']:[]
  if (requirements?.acceptance?.orchestration==='bot_tasks' && ['pending','developing'].includes(task.acceptance_state || '')) return ['stop']
  if (requirements?.flow) {
    const own = sessionId === task.session_id, creator = sessionId === requirements.creator_session_id
    if (!own && !creator) return []
    if (requirements.flow.stopped) return ['reopen']
    if (!own) return requirements.flow.completed || task.status === 'closed' ? [] : ['stop']
    if (!requirements.flow.completed && task.status !== 'closed' && task.execution_state === 'finished' && !task.pending_count) return ['advance', 'continue', 'stop', 'close']
    if (!requirements.flow.completed && task.status !== 'closed' && task.execution_state === 'failed' && !task.pending_count) return ['continue', 'stop', 'close']
    if (!requirements.flow.completed && !task.running && task.status === 'open') return ['update', 'start', 'continue', 'stop', 'close']
  }
  if (task.execution_state === 'stopping') return ['stop']
  if (task.redirect_state === 'cancelling') return ['stop']
  if (staged && task.status !== 'closed' && !task.pending_count && ['finished','failed','interrupted'].includes(task.execution_state || '')) return ['continue','close']
  if (task.running) return task.execution_id && ['pending','queued','starting','running','waiting_person','waiting_user','waiting_approval'].includes(task.execution_state || '') ? ['continue', 'stop'] : ['continue']
  return task.status === 'open' ? ['update', 'start', 'continue', 'close', ...(!task.execution_id ? ['configure_acceptance' as const] : [])] : task.status === 'closed' ? ['reopen'] : ['continue', 'reopen', 'close']
}
function actions(task: Snapshot, assignable = false, sessionId = '', staged = false): Action[] {
  const available = baseActions(task,assignable,sessionId,staged)
  const requirements = task.requirements_json ? personRequirements({ requirements_json:task.requirements_json }) : undefined
  if (!assignable && task.session_id === sessionId && task.status !== 'closed' && !requirements?.verification_for && !requirements?.flow) available.push('redirect')
  return available
}

/** One instance per Person main turn. References never grant ownership or outlive this toolset. */
export function personTaskTools(userId: number, currentSessionId: string): PersonTool[] {
  const namespace = randomUUID()
  const references = new Map<string, Reference>()
  const requests = new Map<string, Promise<unknown>>()
  const ttl = 10 * 60_000
  const expose = (task: Snapshot, assignable = false) => {
    const snapshot: Snapshot = { id: task.id, session_id: task.session_id, session_title: task.session_title, title: task.title, summary: task.summary.slice(0, 500), status: task.status,
      acceptance_state: task.acceptance_state, acceptance_reason: task.acceptance_reason, revision: task.revision, execution_id: task.execution_id || null, execution_state: task.execution_state || 'idle', running: Boolean(task.running), pending_count: task.pending_count || 0, requirements_json: task.requirements_json }
    snapshot.redirect_state = task.redirect_state; snapshot.redirect_error = task.redirect_error
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
    const flow = stage ? getPersonFlow(userId,stage.flowId) : undefined
    let allowedActions = actions(snapshot,assignable,currentSessionId,!!stage)
    if (stage) {
      try { assertPersonStageTask(userId,task.id) }
      catch { allowedActions = allowedActions.filter(action => action === 'stop') }
    }
    return { ...visible, ...context, verification_task_for: _requirements ? personRequirements({requirements_json:_requirements}).verification_for?.task_id : undefined,
      ...(stage && flow ? { stage, collaboration: { flow_id:flow.id,state:flow.state,current_position:flow.current_position,
        stage_state:flow.stages.find(item => item.id === stage.stageId)?.state, resume_required:['stopped','failed'].includes(flow.state) } } : {}),
      ...(context ? { return_expectation: context.return_expectation.slice(0,400) } : {}), acceptance_enabled: Boolean(_requirements && personRequirements({ requirements_json: _requirements }).acceptance?.enabled), task_ref: ref, allowed_actions: allowedActions }
  }
  const execute = async (input: Record<string, unknown>, origin?: PersonTaskOrigin) => {
    origin ||= { sessionId: currentSessionId, runId: '', messages: [] }
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
      if (!personDeliveryCurrent(userId, origin.returnExecutionId, origin.acceptanceReturnId || '')) throw personError('Result callback is no longer current', 409)
      const returned = getPersonTask(userId, getPersonExecution(userId, origin.returnExecutionId).task_id)
      const acceptance = botAcceptanceContext(getPersonExecution(userId,origin.returnExecutionId))
      if (acceptance && acceptance.next_action!=='report' && (acceptance.automatic || !['stop','close'].includes(String(input.action)))) {
        const expected=acceptance.next_action==='verify'?['verify']:acceptance.next_action==='review'?['record_acceptance','verify']:acceptance.next_action==='repair'?['continue']:[]
        if (!expected.includes(String(input.action)) || input.task_id!==acceptance.development_task_id) throw personError('Follow the host acceptance next_action on the original development task; do not create replacement tasks',403)
      }
      if (personRequirements(returned).flow && input.task_id !== returned.id) throw personError('A flow callback must operate its existing task', 403)
    }
    if (requests.size >= 128) return failure('TURN_LIMIT', 'Too many task operations in this turn', 'Continue in a new user turn.')
    const pending = (async () => {
      const result = normalized.action === 'redirect'
        ? await redirectPersonTask(userId,String(normalized.task_id),{ goal:normalized.goal,...(normalized.title ? {title:normalized.title} : {}),expected_revision:normalized.expected_revision,expected_execution_id:normalized.expected_execution_id,idempotency_key:`${namespace}:${key}` },[{type:'text',text:String(normalized.message || normalized.goal)}],origin)
        : normalized.action === 'continue'
        ? await continuePersonTask(userId, String(normalized.task_id), { input: [{ type: 'text', text: normalized.message }], expected_revision: normalized.expected_revision, expected_execution_id: normalized.expected_execution_id, idempotency_key: `${namespace}:${key}` }, origin)
        : await applyPersonTask(userId, { ...normalized, idempotency_key: `${namespace}:${key}` }, undefined, origin)
      return { ok: true, task: expose(result.task), ...(result.execution ? { execution: { id: result.execution.id, state: result.execution.state },
        ...(['create','adopt','start','continue','redirect','verify'].includes(String(normalized.action)) ? { instruction:'Input accepted. End this turn and wait for its automatic result callback. If redirect_state=waiting, previous work is still stopping; do not claim termination is confirmed, cancel this request or dispatch it again. Explain only the requested result in natural language; keep scheduling categories internal.' } : {}) } : {}),
        ...(normalized.action==='record_acceptance' && personRequirements(result.task).acceptance?.progression==='automatic' ? {instruction:'Decision recorded. The host automatically continues the original developer for failed product checks and reuses the linked verification task after repair. End this turn with the recorded findings; do not dispatch repair or re-verification yourself.'}
          : normalized.action==='record_acceptance' && result.task.session_id!==currentSessionId ? {instruction:'Review decision returned to the original developer Bot. End this turn with your findings; that Bot owns repairs and subsequent verification. Do not create or continue developer work from this review callback.'} : {}) }
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
  const query = define('bot_tasks_query', 'List/search tasks, including completed ones; exact task_id for details. Query existing work before routing follow-ups. Use fresh task_ref/allowed_actions. For blocked collaboration tasks, query collaboration.flow_id with bot_flows_query and resume if permitted, then requery and continue this SAME task. A blocked state is not an ownership denial. assignable=true lists adoptable goals.', {
    session_id: { ...text(100), description: 'Conversation filter.' },
    task_id: { ...text(100), type: ['string', 'null'], minLength: 0 }, search: { ...text(200), minLength: 0 }, offset: { type: 'integer', minimum: 0 }, assignable: { type: 'boolean' },
    report_offset: { type: 'integer', minimum: 0, maximum: 2_000_000, description: 'Task details only: read the next page of the current verification report using next_offset. Do not decide from a truncated callback.' },
  }, [], async args => {
    if (args.assignable) return { tasks: (listAssignablePersonGoals(userId, String(args.search || '')) as Snapshot[]).map(task => expose(task, true)) }
    const taskId = String(args.task_id || '').trim()
    if (taskId) {
      const task = getPersonTask(userId, taskId)
      const requirements = personRequirements(task)
      const detail=personAcceptanceDetail(userId,task.id), latest=detail?.attempts.at(-1)
      const report=String(latest?.raw_output || ''), start=Number(args.report_offset) || 0
      const acceptanceResult=detail ? { state:detail.state, reason:detail.reason, verification_task_id:detail.verification_task_id,
        verification_execution_id:latest?.verification_execution_id || null,
        evidence_directory:latest ? resolve(getPersonExecution(userId,String(detail.execution_id)).workspace,'.studio-acceptance',String(latest.execution_id),String(latest.ordinal)) : null,
        report:{text:report.slice(start,start+8000),offset:start,total:report.length,next_offset:start+8000<report.length?start+8000:null},
        attempts:detail.attempts.map(attempt=>({ordinal:attempt.ordinal,state:attempt.state,summary:attempt.report?.summary || '',error:attempt.error})),
      } : null
      const config=requirements.acceptance
      return { task: { ...expose(task), goal: requirements.goal, return_expectation: requirements.return_expectation || '', acceptance:config ? {enabled:config.enabled,criteria:config.criteria,reviewer_session_id:config.reviewer_session_id || task.session_id,max_attempts:config.max_attempts,timeout_minutes:config.timeout_minutes} : undefined, acceptance_result: acceptanceResult }, executions: taskPersonExecutions(userId, task.id).slice(0, 5).map(run => ({ id: run.id, state: run.state, output_preview: run.output.slice(0, 500) })) }
    }
    const offset = Number(args.offset) || 0
    const tasks = listPersonTasks(userId, String(args.search || ''), offset, { limit: 11, sessionId: args.session_id ? requirePersonSession(userId, String(args.session_id)).id : undefined })
    return { tasks: tasks.slice(0, 10).map(task => expose(task)), next_offset: tasks.length > 10 ? offset + 10 : null }
  })
  const create = define('bot_task_create', 'New background task for THIS role only, never message forwarding. Query existing work first: continue for same-direction additions/fixes; redirect for user corrections replacing a mistaken goal or approach, even if completed. Create only for an independent goal, an explicit separate-task request, or verified inability to continue (explain why). agent_id from bot_agents_list. Starts unless start=false. Other roles: bot_flow_create. Explicit user requests to accept/review the deliverable (验收/复验, including visual quality) require acceptance.enabled=true, observable criteria and verifier_agent_id; writing self-check in goal alone does not enable it. The host independently verifies, repairs and blocks completion until passed. Omit for ordinary tasks or user opt-out. Check acceptance_enabled in receipt.', {
    acceptance: personAcceptanceInputSchema,
    session_id: { ...text(100), description: 'Omit; only the current conversation is allowed.' }, title: text(200), goal: { ...text(8000), description: 'Development deliverables only when acceptance is enabled. Keep functional/UI requirements here; put independent review procedures and evidence requirements exclusively in acceptance.criteria.' }, agent_id: text(100), start: { type: 'boolean' },
    remember_result: { type: 'boolean', description: 'Remember at current user request.' },
  }, ['title', 'goal'], (args, origin) => execute({ action: 'create', session_id: currentSessionId, ...args }, origin))
  const control = define('bot_task_control', 'Use fresh task_ref/allowed_actions. continue appends same-direction input. redirect replaces the mistaken direction using the complete latest goal, preserving applicable user constraints; the host invalidates old queued inputs/results, waits for the worker and linked verifier to stop, then runs the latest correction on the SAME task/Agent in the SAME existing conversation, preserving native session and chat history. Never implement redirect as stop then continue. A background callback cannot authorize redirect. verify dispatches independent review, reusing the SAME linked acceptance task/Agent for rechecks. On report return, read evidence, then record_acceptance with the current verification_execution_id and decision in report. Automatic acceptance progression belongs to the host. Persisted earlier cycles follow next_action. Insufficient review evidence: verify again without rerunning development. Never create replacement tasks.', {
    acceptance: personAcceptanceInputSchema,
    report: personAcceptanceReportSchema,
    verification_execution_id: { ...text(100), description: 'record_acceptance only: exact current verification_execution_id from task details.' },
    task_ref: text(100), action: { ...text(30), enum: Object.keys(actionFields) }, session_id: { ...text(100), description: 'Adopt only, current conversation only.' }, title: { ...text(200), description: 'redirect only: short title matching the latest goal.' }, goal: { ...text(8000), description: 'Adopt/update/redirect: complete current goal, preserving applicable user constraints. Independent review procedures belong in acceptance.criteria.' }, message: { ...text(32000), description: 'continue: same-direction requirements or defect feedback. redirect: optional details for the latest goal. advance: outcome and artifacts (max 4000).' }, agent_id: text(100), start: { type: 'boolean' },
    remember_result: { type: 'boolean', description: 'adopt/start/continue/redirect only.' },
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
