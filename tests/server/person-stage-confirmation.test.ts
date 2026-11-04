import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {acceptanceFixture,type AcceptanceFixture} from './fixtures/person-acceptance'
import type {PersonConversationFlow,PersonStageContext} from '../../packages/server/src/modules/studio/contracts/person-stage'

let f:AcceptanceFixture
let flows:typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let stages:typeof import('../../packages/server/src/modules/studio/repositories/person-stage-store')
let store:typeof import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
let repair:typeof import('../../packages/server/src/modules/studio/services/person/stage-confirmation')
let sessions:typeof import('../../packages/server/src/modules/studio/repositories/session-store')
const creator='person-main-1',b='person-main-b',c='person-main-c'
const complete=JSON.stringify({status:'complete',reason:'原回复已经完成本阶段要求'})
beforeEach(async()=>{
  f=await acceptanceFixture()
  flows=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  stages=await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  store=await import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
  repair=await import('../../packages/server/src/modules/studio/services/person/stage-confirmation')
  sessions=await import('../../packages/server/src/modules/studio/repositories/session-store')
  for(const id of [b,c]) sessions.createSession({id,studio_user_id:1,title:id,source:'builtin_agent',workspace:f.workspace})
  vi.mocked(f.runtime.model).mockResolvedValue(complete)
})
afterEach(async()=>{await f.close('stage-confirmation')})
function create(rounds=1,parallel=false){return flows.createPersonFlow(1,{title:'接龙',goal:'接龙',session_id:creator,rounds,idempotency_key:randomUUID(),
  stages:[b,c].map(session_id=>({session_id,goal:'接上一个成语',return_expectation:'一个成语',...(parallel?{group:0}:{})}))})}
function ctx(flow:PersonConversationFlow,position=flow.current_position):PersonStageContext{return {flowId:flow.id,stageId:flow.stages.find(s=>s.position===position)!.id,generation:flow.generation}}
function reply(flow:PersonConversationFlow,position=flow.current_position,finish=true){
  const context=ctx(flow,position),stage=flow.stages.find(s=>s.id===context.stageId)!,run=randomUUID()
  store.startPersonStageRun(1,context,run)
  const delivery=f.db.prepare('SELECT id FROM person_stage_deliveries WHERE stage_id=? AND generation=?').get(stage.id,flow.generation)!
  f.db.prepare("UPDATE person_stage_deliveries SET state='queued' WHERE id=?").run(delivery.id)
  const id=sessions.addMessage({session_id:stage.session_id,run_marker:run,role:'assistant',content:'开门见山',finish_reason:'completed'})!
  if(finish){flows.finishPersonStageTurn(1,{...context,deliveryId:String(delivery.id)},run,id,true);flows.finishPersonStageDelivery(1,String(delivery.id),true)}
  return {context,stage,run,id}
}
function now(flow:PersonConversationFlow){return stages.getPersonFlow(1,flow.id)}
async function action(flow:PersonConversationFlow,action:'stop'|'resume'){
  const current=now(flow)
  return flows.controlPersonFlow(1,{action,flow_id:flow.id,expected_revision:current.revision,idempotency_key:randomUUID()})
}

it('confirms an omitted completion using only the original reply and advances exactly once',async()=>{
  const flow=create(),turn=reply(flow)
  expect(now(flow).stages[0]).toMatchObject({state:'active',result_message_id:turn.id,confirmation:{state:'pending',attempts:0}})
  const before=f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n
  await Promise.all([repair.confirmPersonStage(1,turn.context),repair.confirmPersonStage(1,turn.context)])
  expect(now(flow)).toMatchObject({state:'active',current_position:1,stages:[{state:'completed',result_message_id:turn.id},{state:'active'}]})
  const [request]=vi.mocked(f.runtime.model).mock.calls[0]
  expect(request).toMatchObject({maxSteps:1,tools:[],selection:{model:'test-model'},compression:{enabled:false}})
  expect(JSON.parse(String(request.messages[0].content))).toMatchObject({bot_session_id:b,saved_reply:{message_id:turn.id,content:'开门见山'}})
  expect(f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n).toBe(before)
  expect(f.db.prepare('SELECT COUNT(*) n FROM person_stage_results').get()!.n).toBe(1)
  expect(f.runtime.execute).not.toHaveBeenCalled()
  await repair.confirmPersonStage(1,turn.context)
  expect(f.runtime.model).toHaveBeenCalledTimes(1)
})

it('persists attempts across restart, exhausts malformed confirmation responses, and resumes without rerunning work',async()=>{
  const flow=create(),turn=reply(flow)
  vi.mocked(f.runtime.model).mockResolvedValue('another idiom instead of a decision')
  await repair.confirmPersonStage(1,turn.context)
  expect(store.stageConfirmation(turn.context)).toMatchObject({state:'pending',attempts:1})
  await f.reopen();flows.recoverPersonStages();repair.recoverStageConfirmations()
  expect(store.stageConfirmation(turn.context)?.attempts).toBe(1)
  await repair.confirmPersonStage(1,turn.context)
  expect(now(flow)).toMatchObject({state:'failed',stages:[{state:'failed',result_message_id:turn.id,confirmation:{state:'blocked',attempts:2}},{state:'pending'}]})
  repair.tickStageConfirmations()
  expect(f.runtime.model).toHaveBeenCalledTimes(2)
  const resumed=await action(flow,'resume')
  expect(resumed.stages[0].confirmation).toMatchObject({state:'pending',attempts:0,message_id:turn.id})
  expect(f.db.prepare("SELECT COUNT(*) n FROM person_stage_deliveries WHERE generation=?").get(resumed.generation)!.n).toBe(0)
  vi.mocked(f.runtime.model).mockResolvedValue(complete)
  await repair.confirmPersonStage(1,ctx(resumed))
  expect(now(flow).current_position).toBe(1)
  expect(f.runtime.execute).not.toHaveBeenCalled()
})

it('recovers a crash after saving the reply but before its completion event without re-delivery',async()=>{
  const flow=create(),turn=reply(flow,0,false)
  await f.reopen();flows.recoverPersonStages();repair.recoverStageConfirmations();repair.recoverStageConfirmations()
  expect(store.stageConfirmation(turn.context)).toMatchObject({message_id:turn.id,state:'pending',attempts:0})
  await flows.deliverPersonStages()
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
  await repair.confirmPersonStage(1,turn.context)
  expect(now(flow).current_position).toBe(1)
})

it('retains consumed attempts and rejects an expired claim after restart',async()=>{
  const flow=create(),turn=reply(flow)
  f.db.prepare("UPDATE person_stage_confirmations SET state='confirming',attempts=1,claim='old-process',lease_until=1,updated_at=1").run()
  await f.reopen();repair.recoverStageConfirmations();repair.tickStageConfirmations()
  flows.finishPersonStageTurn(1,turn.context,turn.run,turn.id,true,'','old-process')
  expect(now(flow).current_position).toBe(0)
  f.db.prepare('UPDATE person_stage_confirmations SET updated_at=1').run()
  repair.tickStageConfirmations()
  await vi.waitFor(()=>expect(now(flow).current_position).toBe(1))
  expect(store.stageConfirmation(turn.context)).toMatchObject({state:'completed',attempts:2})
})

it('does not redeliver saved work after a crash between candidate persistence and delivery settlement',async()=>{
  const flow=create(),turn=reply(flow)
  f.db.prepare("UPDATE person_stage_deliveries SET state='queued' WHERE stage_id=?").run(turn.stage.id)
  await f.reopen();flows.recoverPersonStages();repair.recoverStageConfirmations()
  await flows.deliverPersonStages()
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
  await repair.confirmPersonStage(1,turn.context)
  expect(now(flow).current_position).toBe(1)
})

it('settles shutdown promptly even if a provider ignores abort, preserving the consumed attempt',async()=>{
  const flow=create(),turn=reply(flow)
  let resolve!:(value:string)=>void
  vi.mocked(f.runtime.model).mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
  const pending=repair.confirmPersonStage(1,turn.context)
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'))
  await repair.stopStageConfirmations();await pending
  expect(store.stageConfirmation(turn.context)).toMatchObject({state:'pending',attempts:1})
  resolve(complete)
  expect(now(flow).current_position).toBe(0)
})

it('fences a late confirmation after stop and resume and preserves its original result',async()=>{
  const flow=create(),turn=reply(flow)
  let resolve!:(value:string)=>void
  vi.mocked(f.runtime.model).mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
  const pending=repair.confirmPersonStage(1,turn.context)
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'))
  await action(flow,'stop')
  const resumed=await action(flow,'resume')
  resolve(complete);await pending
  expect(now(flow).current_position).toBe(0)
  expect(now(flow).stages[0].result_message_id).toBe(turn.id)
  await repair.confirmPersonStage(1,ctx(resumed))
  expect(now(flow).current_position).toBe(1)
})

it('does not settle a newer admitted turn with an older confirmation or failure',async()=>{
  const flow=create(),old=reply(flow)
  let resolve!:(value:string)=>void
  vi.mocked(f.runtime.model).mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
  const pending=repair.confirmPersonStage(1,old.context)
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'))
  const latest=reply(now(flow))
  flows.finishPersonStageTurn(1,old.context,old.run,null,false,'late failure')
  resolve(complete);await pending
  expect(now(flow).state).toBe('active')
  expect(now(flow).current_position).toBe(0)
  await repair.confirmPersonStage(1,latest.context)
  expect(now(flow).stages[0].result_message_id).toBe(latest.id)
})

it('waits for real child work and its callback without spending confirmation attempts',async()=>{
  const flow=create(),context=ctx(flow)
  const task=await f.tasks.applyPersonTask(1,{action:'create',session_id:b,title:'current work',goal:'produce result',idempotency_key:randomUUID()},undefined,{sessionId:b,runId:randomUUID(),messages:[],stage:context}) as any
  const turn=reply(flow)
  await repair.confirmPersonStage(1,context)
  expect(store.stageConfirmation(context)).toMatchObject({state:'waiting',attempts:0})
  await f.run(task.task.id)
  await repair.confirmPersonStage(1,context)
  expect(f.runtime.model).not.toHaveBeenCalled()
  // A real result callback gets its own admitted turn and replaces the waiting candidate.
  const returned=reply(now(flow))
  f.db.prepare("UPDATE person_deliveries SET state='handled'").run()
  await repair.confirmPersonStage(1,context)
  expect(now(flow).stages[0].result_message_id).toBe(returned.id)
  expect(now(flow).stages[0].result_message_id).not.toBe(turn.id)
})

it('does not infer a user decision, including across a restart',async()=>{
  const flow=create(),turn=reply(flow,0,false)
  store.stageDecisionEvent(turn.context,turn.run,true)
  flows.finishPersonStageTurn(1,turn.context,turn.run,turn.id,true)
  await repair.confirmPersonStage(1,turn.context)
  expect(store.stageConfirmation(turn.context)).toMatchObject({state:'waiting',attempts:0})
  expect(f.runtime.model).not.toHaveBeenCalled()
  await f.reopen();repair.recoverStageConfirmations()
  expect(now(flow).state).toBe('failed')
  expect(now(flow).error).toContain('user decision')
})

it('rejects a changed saved reply while confirmation is in flight',async()=>{
  const flow=create(),turn=reply(flow)
  let resolve!:(value:string)=>void
  vi.mocked(f.runtime.model).mockImplementationOnce(()=>new Promise(r=>{resolve=r}))
  const pending=repair.confirmPersonStage(1,turn.context)
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'))
  f.db.prepare('UPDATE messages SET content=? WHERE id=?').run('changed result',turn.id)
  resolve(complete);await pending
  expect(now(flow).state).toBe('failed')
  expect(now(flow).current_position).toBe(0)
  expect(now(flow).error).toContain('changed during confirmation')
})

it('does not expose provider exception contents in a flow blocker',async()=>{
  const flow=create(),turn=reply(flow)
  vi.mocked(f.runtime.model).mockRejectedValue(new Error('private-provider-diagnostic'))
  await repair.confirmPersonStage(1,turn.context);await repair.confirmPersonStage(1,turn.context)
  expect(now(flow).state).toBe('failed')
  expect(now(flow).error).toContain('Status confirmation failed')
  expect(now(flow).error).not.toContain('private-provider-diagnostic')
})

it.each(['waiting','blocked'])('shows an explicit %s reason and retains the result instead of silently waiting',async status=>{
  const flow=create(),turn=reply(flow)
  vi.mocked(f.runtime.model).mockResolvedValue(JSON.stringify({status,reason:'缺少必要输入'}))
  await repair.confirmPersonStage(1,turn.context)
  expect(now(flow)).toMatchObject({state:'failed',stages:[{state:'failed',result_message_id:turn.id},{state:'pending'}]})
  expect(now(flow).error).toContain('缺少必要输入')
})

it('blocks a real execution failure and preserves completed peer results without automatic retries',async()=>{
  const flow=create(1,true),first=reply(flow,0),second=reply(flow,1)
  await repair.confirmPersonStage(1,first.context)
  flows.finishPersonStageTurn(1,second.context,second.run,null,false,'provider execution failed')
  expect(now(flow)).toMatchObject({state:'failed',stages:[{state:'completed',result_message_id:first.id},{state:'failed'}]})
  await repair.confirmPersonStage(1,second.context)
  expect(f.runtime.model).toHaveBeenCalledTimes(1)
  expect(now(flow).state).not.toBe('completed')
})

it('joins repaired parallel branches and wraps a round exactly once',async()=>{
  const flow=create(2,true),one=reply(flow,0),two=reply(flow,1)
  await Promise.all([repair.confirmPersonStage(1,one.context),repair.confirmPersonStage(1,two.context)])
  expect(now(flow)).toMatchObject({round_number:2,generation:1,current_position:0})
  flows.finishPersonStageTurn(1,one.context,one.run,one.id,true)
  expect(f.db.prepare('SELECT COUNT(*) n FROM person_stage_results').get()!.n).toBe(2)
  expect(f.db.prepare('SELECT COUNT(*) n FROM person_stage_deliveries WHERE generation=1').get()!.n).toBe(2)
})

it('blocks absent or deleted final replies without producing a replacement result',async()=>{
  const flow=create(),turn=reply(flow)
  f.db.prepare('DELETE FROM messages WHERE id=?').run(turn.id)
  await repair.confirmPersonStage(1,turn.context);await repair.confirmPersonStage(1,turn.context)
  expect(now(flow).state).toBe('failed')
  const resumed=await action(flow,'resume')
  await flows.deliverPersonStages()
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
  expect(resumed.stages[0].confirmation?.message_id).toBe(turn.id)
  expect(f.runtime.model).not.toHaveBeenCalled()
})
