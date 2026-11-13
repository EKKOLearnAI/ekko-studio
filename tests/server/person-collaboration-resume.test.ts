import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'
import type { PersonTaskOrigin } from '../../packages/server/src/modules/studio/contracts/person'
import type { PersonConversationFlow } from '../../packages/server/src/modules/studio/contracts/person-stage'

let f: AcceptanceFixture
let flows: typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let stages: typeof import('../../packages/server/src/modules/studio/repositories/person-stage-store')
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
const creator = 'person-main-1', b = 'person-main-b', c = 'person-main-c', d = 'person-main-d', outsider = 'person-main-outsider'
const actor = (sessionId: string): PersonTaskOrigin => ({ sessionId, runId: randomUUID(), messages: [] })

beforeEach(async () => {
  f = await acceptanceFixture()
  flows = await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  stages = await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  for (const id of [b,c,d,outsider]) sessions.createSession({ id, studio_user_id: 1, title: id, source: 'builtin_agent', workspace: f.workspace })
})
afterEach(async () => { await f.close('collaboration-resume') })

function create(parallel = false, route = [b,c]) {
  return flows.createPersonFlow(1, { title: '恢复原协作', goal: '保留阶段与原结果', session_id: creator, idempotency_key: randomUUID(),
    stages: route.map(session_id => ({ session_id, goal: '完成本阶段', return_expectation: '保存结果', ...(parallel ? { group: 0 } : {}) })) })
}
const current = (flow: PersonConversationFlow) => stages.getPersonFlow(1,flow.id)
const context = (flow: PersonConversationFlow, position = 0) => ({ flowId: flow.id, stageId: flow.stages[position].id, generation: flow.generation })
function control(flow: PersonConversationFlow, action: string, origin?: PersonTaskOrigin, key = randomUUID()) {
  return flows.controlPersonFlow(1, { action, flow_id: flow.id, expected_revision: flow.revision, idempotency_key: key }, origin)
}
async function finish(flow: PersonConversationFlow, position: number) {
  const stage = flow.stages[position], origin = { ...actor(stage.session_id), stage: context(flow,position) }
  await control(flow,'complete',origin)
  const id = sessions.addMessage({ session_id: stage.session_id, role: 'assistant', content: `原结果 ${position}`, run_marker: origin.runId, finish_reason: 'completed' })!
  flows.finishPersonStageTurn(1,origin.stage,origin.runId,id,true)
  return { id, origin, flow: current(flow) }
}

it('lets the current Bot query and resume a stopped flow without its creator, dispatching the same stage once', async () => {
  const flow = create(), stopped = await control(flow,'stop',actor(b))
  const { personFlowTools } = await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const tools = personFlowTools(1,b), origin = actor(b)
  const query = await tools.find(tool => tool.name === 'bot_flows_query')!.execute({ flow_id: flow.id },origin) as any
  const input = { action: 'resume', flow_ref: query.flows[0].flow_ref }
  const result = await tools.find(tool => tool.name === 'bot_flow_control')!.execute(input,origin) as any
  expect(result).toMatchObject({ ok: true, flow: { id: flow.id, state: 'active', position: 0 } })
  expect(current(flow)).toMatchObject({ generation: stopped.generation + 1, creator_session_id: creator, stages: [{ session_id: b },{ state: 'pending' }] })
  expect(await tools.find(tool => tool.name === 'bot_flow_control')!.execute(input,origin)).toEqual(result)
  await flows.deliverPersonStages()
  expect(vi.mocked(f.runtime.deliverStage!).mock.calls.map(([input]) => input.sessionId)).toEqual([b])
})

it('resumes only the failed parallel branch, preserves its completed peer and fences old results and revisions', async () => {
  const flow = create(true), peer = await finish(flow,1)
  flows.failPersonStage(1,context(flow),'当前分支失败')
  const failed = current(flow)
  await expect(control(failed,'resume',actor(c))).rejects.toMatchObject({ status: 403 })
  const resumed = await control(failed,'resume',actor(b))
  expect(resumed.stages[1]).toMatchObject({ state: 'completed', result_message_id: peer.id })
  expect(f.db.prepare('SELECT COUNT(*) n FROM person_stage_deliveries WHERE flow_id=? AND generation=?').get(flow.id,resumed.generation)!.n).toBe(1)
  flows.finishPersonStageTurn(1,peer.origin.stage,peer.origin.runId,peer.id,true)
  await expect(control(failed,'resume',actor(b))).rejects.toMatchObject({ status: 409 })
  expect(current(flow)).toEqual(resumed)
  expect((await finish(resumed,0)).flow.state).toBe('completed')
  await expect(control(current(flow),'resume',actor(creator))).rejects.toMatchObject({ status: 409 })
})

it('rejects past, future, unrelated, foreign-account and stale stage callers while allowing the current role', async () => {
  const flow = create(false,[b,c,d]), next = (await finish(flow,0)).flow
  const stopped = await control(next,'stop',actor(c))
  for (const sessionId of [b,d,outsider,'person-main-2']) {
    await expect(control(stopped,'resume',actor(sessionId))).rejects.toMatchObject({ status: sessionId === 'person-main-2' ? 404 : 403 })
    expect(current(flow)).toEqual(stopped)
  }
  await expect(control(stopped,'resume',{ ...actor(c), stage: context(next,1) })).rejects.toMatchObject({ status: 409 })
  const resumed = await control(stopped,'resume',actor(c))
  expect(resumed.current_position).toBe(1)
  expect(resumed.stages[0].result_message_id).toBe(next.stages[0].result_message_id)
})

it.each([creator,undefined])('preserves creator/account resume for %s', async sessionId => {
  const stopped = await control(create(),'stop')
  expect((await control(stopped,'resume',sessionId ? actor(sessionId) : undefined)).state).toBe('active')
})

it('waits for a live parallel peer before permitting a failed participant to resume', async () => {
  const flow = create(true)
  flows.failPersonStage(1,context(flow),'B failed')
  const failed = current(flow)
  await expect(control(failed,'resume',actor(b))).rejects.toThrow('Wait for the other roles')
  expect(current(flow)).toEqual(failed)
  await finish(failed,1)
  expect((await control(current(flow),'resume',actor(b))).stages[1].state).toBe('completed')
})

it('shows the failed Bot its own branch and exposes no controls to unrelated Bots', async () => {
  const flow = create(true,[c,b])
  flows.failPersonStage(1,context(flow,1),'B failed')
  const { personFlowTools } = await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const own: any = await personFlowTools(1,b)[0].execute({ flow_id: flow.id },actor(b))
  expect(own.flows[0]).toMatchObject({ current_stage: flow.stages[1].id, session_id: b, allowed_actions: ['stop','resume'] })
  const other: any = await personFlowTools(1,outsider)[0].execute({ flow_id: flow.id },actor(outsider))
  expect(other.flows[0].allowed_actions).toEqual([])
})

it('waits for a stopped failed branch worker to acknowledge stopping before resuming', async () => {
  const flow = create(), origin = { ...actor(b), stage: context(flow) }
  const child = await f.tasks.applyPersonTask(1,{ action: 'create', session_id: b, title: '已有 worker', goal: '保留执行记录', idempotency_key: randomUUID() },undefined,origin)
  f.db.prepare("UPDATE person_executions SET state='running' WHERE id=?").run(child.execution!.id)
  let release!: () => void
  vi.mocked(f.runtime.stop).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  flows.failPersonStage(1,context(flow),'Worker failed')
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  try {
    await control(current(flow),'stop',actor(b))
    await expect(control(current(flow),'resume',actor(b))).rejects.toThrow('finish stopping')
    expect(current(flow).state).toBe('stopped')
  } finally { release() }
  await vi.waitFor(() => expect(f.get(child.task.id).execution_state).toBe('interrupted'))
  const resumed = await control(current(flow),'resume',actor(b))
  expect(resumed.stages[0].tasks.map(task => task.id)).toEqual([child.task.id])
})

it('lets the participating Bot recover and continue its existing child through the real main-chat tools', async () => {
  const flow = create(), assigned = { ...actor(b), stage: context(flow) }
  const child = await f.tasks.applyPersonTask(1,{ action: 'create', title: '协作子任务', goal: '修复原交付', idempotency_key: randomUUID() },undefined,assigned)
  const oldExecution = f.store.getPersonExecution(1,child.execution!.id)
  await control(flow,'stop',actor(b))
  const { personTools } = await import('../../packages/server/src/modules/studio/services/person/tools')
  const tools = personTools(1,'main',undefined,b), origin = actor(b)
  const call = async (name: string, args: Record<string,unknown>, from = origin) => tools.find(tool => tool.name === name)!.execute(args,from) as Promise<any>
  const blocked = await call('bot_tasks_query',{ task_id: child.task.id })
  expect(blocked.task.allowed_actions).not.toContain('continue')
  expect(blocked.task.collaboration).toMatchObject({ flow_id: flow.id, state: 'stopped', resume_required: true })
  const lookup = await call('bot_flows_query',{ flow_id: blocked.task.collaboration.flow_id })
  expect(lookup.flows[0].allowed_actions).toEqual(['resume'])
  expect(await call('bot_flow_control',{ action: 'resume', flow_ref: lookup.flows[0].flow_ref })).toMatchObject({ ok: true })
  const queried = await call('bot_tasks_query',{ task_id: child.task.id })
  expect(queried.task.allowed_actions).toContain('continue')
  expect(await call('bot_task_control',{ action: 'continue', task_ref: queried.task.task_ref, message: '继续修复这个任务' },assigned)).toMatchObject({ ok: false, error: { code: 'STALE_TASK' } })
  const continued = await call('bot_task_control',{ action: 'continue', task_ref: queried.task.task_ref, message: '继续修复这个任务' })
  expect(continued).toMatchObject({ ok: true, task: { id: child.task.id, session_id: b } })
  const execution = f.store.getPersonExecution(1,continued.execution.id)
  expect(execution.session_id).toBe(oldExecution.session_id)
  expect(execution.selection_json).toBe(oldExecution.selection_json)
  await f.run(child.task.id)
  const callback = JSON.parse(String(f.db.prepare('SELECT origin_json FROM person_deliveries WHERE execution_id=?').get(execution.id)!.origin_json))
  expect(callback).toMatchObject({ sessionId: b, stage: { flowId: flow.id, generation: current(flow).generation } })
  expect(f.store.listPersonTasks(1)).toHaveLength(1)
  expect(current(flow)).toMatchObject({ current_position: 0, stages: [{ state: 'active' },{ state: 'pending' }] })
})

it('keeps ordinary task reopening and continuation available in the owning Bot conversation', async () => {
  const child = await f.tasks.applyPersonTask(1,{ action: 'create', title: '普通任务', goal: '原目标', start: false, idempotency_key: randomUUID() },undefined,actor(b))
  await f.tasks.applyPersonTask(1,{ action: 'close', task_id: child.task.id, expected_revision: child.task.revision, idempotency_key: randomUUID() },undefined,actor(b))
  const tools = f.personTaskTools(1,b), origin = actor(b)
  const query = () => tools[0].execute({ task_id: child.task.id },origin) as Promise<any>
  const closed = await query()
  expect(closed.task.allowed_actions).toEqual(['reopen'])
  expect(await tools[2].execute({ action: 'reopen', task_ref: closed.task.task_ref },origin)).toMatchObject({ ok: true })
  const opened = await query()
  expect(await tools[2].execute({ action: 'continue', task_ref: opened.task.task_ref, message: '继续原任务' },origin)).toMatchObject({ ok: true, task: { id: child.task.id, session_id: b } })
})

it('does not abort a resumed stage when a transport retries the same resume receipt', async () => {
  const stopped = await control(create(),'stop'), key = randomUUID(), origin = actor(b)
  const resumed = await control(stopped,'resume',origin,key)
  const turn = flows.registerPersonStageTurn(context(resumed))
  try {
    expect(await control(stopped,'resume',origin,key)).toEqual(resumed)
    expect(turn.signal.aborted).toBe(false)
    expect(f.db.prepare('SELECT COUNT(*) n FROM person_stage_deliveries WHERE flow_id=? AND generation=?').get(resumed.id,resumed.generation)!.n).toBe(1)
  } finally { turn.release() }
})

it('admits only one concurrent resume from two authorized participants', async () => {
  const stopped = await control(create(true),'stop')
  const results = await Promise.allSettled([control(stopped,'resume',actor(b)),control(stopped,'resume',actor(c))])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
  expect(current(stopped)).toMatchObject({ generation: stopped.generation + 1, revision: stopped.revision + 1 })
  expect(f.db.prepare('SELECT COUNT(*) n FROM person_stage_deliveries WHERE flow_id=? AND generation=?').get(stopped.id,current(stopped).generation)!.n).toBe(2)
})

async function legacy() {
  const created = await f.create({ next_steps: [{ session_id: b, goal: '继续原任务', return_expectation: '保存交付' }], return_expectation: '原目标' })
  await f.run(created.task.id)
  const task = f.get(created.task.id)
  const moved = await f.tasks.applyPersonTask(1,{ action: 'advance', task_id: task.id, expected_revision: task.revision, message: '前一阶段已核实', idempotency_key: randomUUID() },undefined,actor(creator))
  const stopped = await f.tasks.applyPersonTask(1,{ action: 'stop', task_id: task.id, expected_revision: moved.task.revision, idempotency_key: randomUUID() },undefined,actor(b))
  return stopped.task
}

it('advertises reopen to the current legacy role and continues its original task, Agent and worker conversation', async () => {
  const task = await legacy(), execution = f.store.getPersonExecution(1,task.execution_id!)
  const tools = f.personTaskTools(1,b), origin = actor(b)
  const query = () => tools.find(tool => tool.name === 'bot_tasks_query')!.execute({ task_id: task.id },origin) as Promise<any>
  const first = await query()
  expect(first.task.allowed_actions).toEqual(['reopen'])
  expect(await tools.find(tool => tool.name === 'bot_task_control')!.execute({ action: 'reopen', task_ref: first.task.task_ref },origin)).toMatchObject({ ok: true })
  const opened = await query()
  const continued: any = await tools.find(tool => tool.name === 'bot_task_control')!.execute({ action: 'continue', task_ref: opened.task.task_ref, message: '修复本阶段问题' },origin)
  expect(continued).toMatchObject({ ok: true, task: { id: task.id, session_id: b } })
  const next = f.store.getPersonExecution(1,continued.execution.id)
  expect(next.session_id).toBe(execution.session_id)
  expect(next.selection_json).toBe(execution.selection_json)
  expect(JSON.parse(f.get(task.id).requirements_json).flow).toMatchObject({ index: 1, stopped: false })
})

it('keeps legacy reopen scoped to the current role, creator or account and rejects stale execution snapshots', async () => {
  const task = await legacy()
  await expect(f.tasks.applyPersonTask(1,{ action: 'reopen', task_id: task.id, expected_revision: task.revision, idempotency_key: randomUUID() },undefined,actor(c))).rejects.toMatchObject({ status: 403 })
  await expect(f.tasks.applyPersonTask(1,{ action: 'reopen', task_id: task.id, expected_revision: task.revision, expected_execution_id: 'stale', idempotency_key: randomUUID() },undefined,actor(b))).rejects.toMatchObject({ status: 409 })
  await expect(f.chat.continuePersonTask(1,task.id,{ expected_revision: task.revision, idempotency_key: randomUUID(), input: [{ type: 'text', text: '直接继续' }] },actor(b))).rejects.toMatchObject({ status: 409 })
  const reopened = await f.tasks.applyPersonTask(1,{ action: 'reopen', task_id: task.id, expected_revision: task.revision, idempotency_key: randomUUID() },undefined,actor(creator))
  expect(JSON.parse(reopened.task.requirements_json).flow.stopped).toBe(false)
})
