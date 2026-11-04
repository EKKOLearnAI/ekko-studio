import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'
import type { PersonConversationFlow, PersonStageContext } from '../../packages/server/src/modules/studio/contracts/person-stage'

let f: AcceptanceFixture
let flows: typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let stages: typeof import('../../packages/server/src/modules/studio/repositories/person-stage-store')
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
const creator = 'person-main-1', b = 'person-main-b', c = 'person-main-c'
beforeEach(async () => {
  f = await acceptanceFixture()
  flows = await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  stages = await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  for (const id of [b,c]) sessions.createSession({ id, studio_user_id: 1, title: id, source: 'builtin_agent', workspace: f.workspace })
})
afterEach(async () => { await f.close('flow-rounds') })
function create(rounds?: unknown, route = [b,c]) {
  return flows.createPersonFlow(1, { title:'接龙',goal:'依次接龙',session_id:creator,idempotency_key:randomUUID(),
    ...(rounds === undefined ? {} : {rounds}),stages:route.map(session_id=>({session_id,goal:'接上游的最后一个成语',return_expectation:'给出下一个成语'})) })
}
function context(flow: PersonConversationFlow, position = flow.current_position): PersonStageContext {
  return {flowId:flow.id,stageId:flow.stages.find(s=>s.position===position)!.id,generation:flow.generation}
}
async function prepare(flow: PersonConversationFlow, position = flow.current_position) {
  const stage = flow.stages.find(s=>s.position===position)!, runId = randomUUID(), ctx = context(flow,position)
  await flows.controlPersonFlow(1,{action:'complete',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:randomUUID()},
    {sessionId:stage.session_id,runId,messages:[],stage:ctx})
  return {stage,runId,ctx}
}
async function finish(flow: PersonConversationFlow, output: string, position = flow.current_position) {
  const turn = await prepare(flow,position)
  const id = sessions.addMessage({session_id:turn.stage.session_id,role:'assistant',content:output,run_marker:turn.runId,finish_reason:'completed'})!
  flows.finishPersonStageTurn(1,turn.ctx,turn.runId,id,true)
  return {flow:stages.getPersonFlow(1,flow.id),id,...turn}
}

it('defaults to one round; completion creates no unread notice, while real replies remain unread', async () => {
  const { listSessionStateRecords,recordSessionAttention,markSessionRead } = await import('../../packages/server/src/modules/studio/repositories/session-state-store')
  const {SessionStateSync} = await import('../../packages/server/src/modules/studio/services/session-state')
  const sync = new SessionStateSync(()=>({working:false,backgroundPending:0}),()=>true)
  const events: any[] = []
  const socket: any = {data:{user:{id:1,role:'super_admin'}},handshake:{query:{session_state:'1'}},on:vi.fn(),emit:(event:string,payload:any)=>events.push({event,payload})}
  sync.attach(socket)
  const read = () => {sync.publish();return events.at(-1).payload.sessions.find((s:any)=>s.sessionId===creator)}
  const flow = create(undefined,[b]); await finish(flow,'一心一意')
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',round_limit:1,round_number:1})
  expect(f.db.prepare('SELECT count(*) n FROM session_attention_events WHERE session_id=?').get(creator)!.n).toBe(0)
  // Existing installations may still have completion-only attention rows. Ignore
  // them without deleting data or swallowing any actual assistant response.
  recordSessionAttention(creator,`person-flow-completed:${flow.id}:0`)
  expect(listSessionStateRecords(1,creator)[0].lastAttentionId).toBe(0)
  expect(read().unread).toBe(false)
  const messageId = sessions.addMessage({session_id:creator,role:'assistant',content:'接到结果，已汇总',finish_reason:'completed'})!
  expect(read().unread).toBe(true)
  markSessionRead(1,creator,messageId,999)
  expect(read().unread).toBe(false)
  recordSessionAttention(creator,'other-business-notice')
  expect(read().unread).toBe(true)
  sync.close()
})

it('repeats a serial route for the requested rounds, carries the final result across the boundary and fences old completions', async () => {
  const first = await finish(create(2),'一心一意')
  expect(stages.personStageSources(1,context(first.flow))).toMatchObject([{id:first.id,content:'一心一意'}])
  const last = await finish(first.flow,'意气风发')
  expect(last.flow).toMatchObject({state:'active',round_number:2,round_limit:2,generation:1,current_position:0})
  expect(stages.personStageSources(1,context(last.flow))).toMatchObject([{id:last.id,content:'意气风发'}])
  const pending = f.db.prepare("SELECT count(*) n FROM person_stage_deliveries WHERE generation=1 AND state='pending'").get()!.n
  expect(pending).toBe(1)
  flows.finishPersonStageTurn(1,last.ctx,last.runId,last.id,true)
  expect(stages.getPersonFlow(1,last.flow.id).round_number).toBe(2)
  const second = await finish(last.flow,'发扬光大')
  const ended = await finish(second.flow,'大展宏图')
  expect(ended.flow).toMatchObject({state:'completed',round_number:2,generation:1})
  expect(f.db.prepare('SELECT count(*) n FROM person_stage_results').get()!.n).toBe(4)
  expect(f.db.prepare('SELECT count(*) n FROM messages WHERE id IN (SELECT result_message_id FROM person_stage_results)').get()!.n).toBe(4)
})

it('delivers an explicitly planned return stage to its creator, with the upstream original result', async () => {
  const one = await finish(create(undefined,[b,creator]),'一心一意')
  await flows.deliverPersonStages()
  const calls = vi.mocked(f.runtime.deliverStage!).mock.calls
  expect(calls.at(-1)![0]).toMatchObject({sessionId:creator,context:{flowId:one.flow.id,stageId:one.flow.stages[1].id}})
  expect(stages.personStageSources(1,context(one.flow))).toMatchObject([{id:one.id,session_id:b}])
  const two = await finish(one.flow,'已收到并汇总')
  expect(two.flow.state).toBe('completed')
  flows.finishPersonStageTurn(1,two.ctx,two.runId,two.id,true)
  flows.recoverPersonStages()
  await flows.deliverPersonStages()
  expect(f.runtime.deliverStage).toHaveBeenCalledTimes(1)
  expect(f.db.prepare('SELECT count(*) n FROM messages WHERE session_id=?').get(creator)!.n).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM session_attention_events WHERE session_id=?').get(creator)!.n).toBe(0)
})

it('finishes every requested parallel round without an extra creator turn or replaying a legacy report queue', async () => {
  const flow = flows.createPersonFlow(1,{title:'按原路由协作',goal:'两位 Bot 独立完成两轮',session_id:creator,rounds:2,idempotency_key:randomUUID(),
    stages:[b,c].map(session_id=>({session_id,group:0,goal:'完成本轮工作',return_expectation:'给出结果，按需汇报'}))})
  const ids:number[]=[]
  for(let round=1;round<=2;round++) {
    await flows.deliverPersonStages()
    const current=stages.getPersonFlow(1,flow.id)
    ids.push((await finish(current,`B 第 ${round} 轮`,0)).id)
    ids.push((await finish(current,`C 第 ${round} 轮`,1)).id)
  }
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',round_number:2,error:''})
  expect(vi.mocked(f.runtime.deliverStage!).mock.calls.map(([input])=>input.sessionId)).toEqual([b,c,b,c])
  expect(f.db.prepare('SELECT result_message_id FROM person_stage_results ORDER BY result_message_id').all().map(row=>row.result_message_id)).toEqual(ids)
  // Retain old integration data as inert history; it must not become a new wake on restart.
  f.db.exec('CREATE TABLE person_flow_reports(id TEXT PRIMARY KEY,flow_id TEXT NOT NULL,state TEXT NOT NULL)')
  f.db.prepare("INSERT INTO person_flow_reports VALUES('legacy-report',?,'pending')").run(flow.id)
  await f.reopen()
  flows.recoverPersonStages();flows.recoverPersonStages()
  await f.runner.tickPersonWork();await f.runner.tickPersonWork()
  expect(f.runtime.deliverStage).toHaveBeenCalledTimes(4)
  expect(f.runtime.deliver).not.toHaveBeenCalled()
  expect(f.runtime.execute).not.toHaveBeenCalled()
  expect(f.runtime.model).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT count(*) n FROM messages WHERE session_id=?').get(creator)!.n).toBe(0)
  expect(f.db.prepare('SELECT count(*) n FROM session_attention_events WHERE session_id=?').get(creator)!.n).toBe(0)
  expect(f.db.prepare('SELECT state FROM person_flow_reports').get()!.state).toBe('pending')
  expect(stages.getPersonFlow(1,flow.id).state).toBe('completed')
})

it('keeps flow lookups read-only and rejects the removed pagination and reporting arguments', async () => {
  const ended=await finish(create(undefined,[b]),'已保存的结果')
  const before=stages.getPersonFlow(1,ended.flow.id)
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const tools=personFlowTools(1,creator),query=tools.find(tool=>tool.name==='bot_flows_query')!
  const origin={sessionId:creator,runId:'status-only',messages:[]}
  const response:any=await query.execute({flow_id:before.id},origin)
  expect(response.flows[0]).toMatchObject({state:'completed',results:[{message_id:ended.id}]})
  expect(response.flows[0]).not.toHaveProperty('report_instruction')
  expect(await query.execute({flow_id:before.id,result_offset:0},origin)).toMatchObject({ok:false})
  expect(await query.execute({flow_id:before.id,claim_report:true},origin)).toMatchObject({ok:false})
  expect(await tools.find(tool=>tool.name==='bot_flow_create')!.execute({title:'额外汇报',goal:'不创建额外汇报',report_to_creator:true,
    stages:[{session_id:c,goal:'工作',return_expectation:'结果'}]},origin)).toMatchObject({ok:false})
  // Existing flow-list offsets are part of the user's original API and remain supported.
  expect(await query.execute({offset:0},origin)).toMatchObject({flows:[{id:before.id}]})
  expect(stages.getPersonFlow(1,before.id)).toEqual(before)
  expect(f.db.prepare('SELECT count(*) n FROM person_flows').get()!.n).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM messages WHERE session_id=?').get(creator)!.n).toBe(0)
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})

it('finishes worker-backed rounds without reusing or exposing prior-round workers as current work', async () => {
  const flow = create(2)
  const origin = {sessionId:b,runId:randomUUID(),messages:[],stage:context(flow)}
  const result = await f.tasks.applyPersonTask(1,{action:'create',session_id:b,title:'This round',goal:'Write a result',idempotency_key:randomUUID()},undefined,origin) as {task:{id:string}}
  await f.run(result.task.id)
  expect(stages.getPersonFlow(1,flow.id).stages[0].tasks).toHaveLength(1)
  const one = await finish(stages.getPersonFlow(1,flow.id),'第一位已完成')
  const two = await finish(one.flow,'本轮最后结果')
  expect(two.flow.round_number).toBe(2)
  expect(two.flow.stages[0].tasks).toEqual([])
  // The next round's completion gate must ignore an old child even if its
  // historical task status changes later. Its generation is fenced separately.
  f.db.prepare("UPDATE session_tasks SET status='open' WHERE id=?").run(result.task.id)
  const three = await finish(two.flow,'下一轮新结果')
  expect(three.flow.current_position).toBe(1)
})

it('joins all parallel results before a new round, and carries every terminal branch into its first group', async () => {
  const flow = flows.createPersonFlow(1,{title:'Parallel',goal:'Repeat peers',session_id:creator,rounds:2,idempotency_key:randomUUID(),
    stages:[b,c].map(session_id=>({session_id,group:0,goal:'Answer',return_expectation:'Result'}))})
  const one = await finish(flow,'B result',0)
  expect(one.flow.round_number).toBe(1)
  const two = await finish(flow,'C result',1) // peer may use its originally observed revision
  expect(two.flow.round_number).toBe(2)
  expect(stages.personStageSources(1,context(two.flow,0)).map(s=>s.id)).toEqual([one.id,two.id])
  expect(f.db.prepare('SELECT count(*) n FROM person_stage_deliveries WHERE generation=1').get()!.n).toBe(2)
})

it('runs until stopped only when rounds=0, and resumes the same unfinished round after restart', async () => {
  const one = await finish(create(0),'一心一意'), two = await finish(one.flow,'意气风发')
  await flows.controlPersonFlow(1,{action:'stop',flow_id:two.flow.id,expected_revision:two.flow.revision,idempotency_key:randomUUID()})
  let stopped = stages.getPersonFlow(1,two.flow.id)
  expect(stopped).toMatchObject({state:'stopped',round_number:2,round_limit:0})
  expect(f.db.prepare("SELECT count(*) n FROM person_stage_deliveries WHERE flow_id=? AND state IN ('pending','queued')").get(stopped.id)!.n).toBe(0)
  await f.reopen()
  flows.recoverPersonStages()
  await flows.controlPersonFlow(1,{action:'resume',flow_id:stopped.id,expected_revision:stopped.revision,idempotency_key:randomUUID()})
  stopped = stages.getPersonFlow(1,stopped.id)
  expect(stopped).toMatchObject({state:'active',round_number:2})
  expect(stages.personStageSources(1,context(stopped))).toMatchObject([{id:two.id}])
  const third = await finish(stopped,'发扬光大'), fourth = await finish(third.flow,'大展宏图')
  expect(fourth.flow).toMatchObject({state:'active',round_number:3})
})

it('recovers a crash after the last final reply was saved, advancing the round once', async () => {
  const one = await finish(create(2),'一心一意')
  const turn = await prepare(one.flow)
  const id = sessions.addMessage({session_id:turn.stage.session_id,role:'assistant',content:'意气风发',run_marker:turn.runId,finish_reason:'completed'})!
  await f.reopen(); flows.recoverPersonStages(); flows.recoverPersonStages()
  const current = stages.getPersonFlow(1,one.flow.id)
  expect(current).toMatchObject({round_number:2,generation:1})
  expect(stages.personStageSources(1,context(current))).toMatchObject([{id}])
  expect(f.db.prepare('SELECT count(*) n FROM person_stage_deliveries WHERE generation=1').get()!.n).toBe(1)
})

it('keeps a failed first stage of the next round blocked if its original upstream result is missing', async () => {
  const one = await finish(create(2),'一心一意'), two = await finish(one.flow,'意气风发')
  f.db.prepare('DELETE FROM messages WHERE id=?').run(two.id)
  await flows.deliverPersonStages()
  expect(stages.getPersonFlow(1,two.flow.id)).toMatchObject({state:'failed',round_number:2})
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})

it.each([-1,1.5,1001,'2',null])('rejects invalid rounds %j without creating a flow', rounds => {
  expect(()=>create(rounds)).toThrow('rounds')
  expect(f.db.prepare('SELECT count(*) n FROM person_flows').get()!.n).toBe(0)
})

it('rejects a repeating self-handoff boundary and preserves legacy single-round defaults on schema reinitialization', () => {
  expect(()=>create(2,[b])).toThrow('round boundary')
  const flow = create()
  for (const column of ['round_limit','round_number','round_generation']) f.db.exec(`ALTER TABLE person_flows DROP COLUMN ${column}`)
  f.schema.initAllHermesTables()
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({round_number:1,round_limit:1})
})
