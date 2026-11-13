import { afterEach,beforeEach,expect,it,vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptanceFixture,type AcceptanceFixture } from './fixtures/person-acceptance'
let f:AcceptanceFixture
let flows:typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let runs:typeof import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
let conversation:typeof import('../../packages/server/src/modules/studio/services/person/flow-conversation')
let sessions:typeof import('../../packages/server/src/modules/studio/repositories/session-store')
const creator='person-main-1',peer='person-main-peer'
beforeEach(async () => {
  f=await acceptanceFixture()
  flows=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  runs=await import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
  conversation=await import('../../packages/server/src/modules/studio/services/person/flow-conversation')
  sessions=await import('../../packages/server/src/modules/studio/repositories/session-store')
  sessions.createSession({id:peer,studio_user_id:1,title:'协作 Bot',bot_type:'shuishui',source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',workspace:f.workspace})
})
afterEach(async () => {await f.close('flow-conversation')})
function create(runId='creator-run') {
  return flows.createPersonFlow(1,{session_id:creator,title:'共同完成',goal:'完成这次协作',idempotency_key:randomUUID(),stages:[{session_id:peer,goal:'协作任务',return_expectation:'报告结果'}]},
    {sessionId:creator,runId,messages:[]})
}
function reply(runId:string,content:string,sessionId=peer) {
  return Number(sessions.addMessage({session_id:sessionId,role:'assistant',run_marker:runId,content,finish_reason:'completed'}))
}
const read=(id:string,query:Parameters<typeof conversation.personFlowConversation>[2]={}) => conversation.personFlowConversation(1,id,query)

it('merges exact creator and stage turns across waits/restarts without unrelated Bot history or duplicate messages',async () => {
  const flow=create()
  reply('creator-run','已发起协作',creator)
  const context={flowId:flow.id,stageId:flow.stages[0].id,generation:0}
  runs.startPersonStageRun(1,context,'first-turn')
  const first=reply('first-turn','已检查接口，等待任务结果')
  runs.startPersonStageRun(1,context,'callback-turn')
  const second=reply('callback-turn','已完成接口联调')
  reply('unrelated-turn','其他用户话题')
  const other=create('other-creator-run')
  runs.startPersonStageRun(1,{flowId:other.id,stageId:other.stages[0].id,generation:0},'other-flow')
  reply('other-flow','另一个协作的结果')
  await f.reopen()
  expect(read(flow.id).messages.map(message=>message.content)).toEqual(['已发起协作','已检查接口，等待任务结果','已完成接口联调'])
  expect(read(flow.id).messages.slice(1)).toMatchObject([{id:first,session_title:'协作 Bot',stage_id:context.stageId},{id:second,round_number:1}])
  expect(f.runtime.execute).not.toHaveBeenCalled()
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})

it('retains the creator and participant replies after stopping and reopening a collaboration',async () => {
  const flow=create()
  reply('creator-run','开始成语接龙',creator)
  runs.startPersonStageRun(1,{flowId:flow.id,stageId:flow.stages[0].id,generation:0},'idiom-turn')
  reply('idiom-turn','一心一意')
  await flows.controlPersonFlow(1,{action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:randomUUID()})
  await f.reopen()
  const stopped=read(flow.id)
  expect(stopped.flow.state).toBe('stopped')
  expect(stopped.messages.map(message=>message.content)).toEqual(['开始成语接龙','一心一意'])
  expect(f.runtime.execute).not.toHaveBeenCalled()
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})

it('restores owned collaboration history, activity and clear-history boundaries with a conversation',async () => {
  const flow=create()
  const active=conversation.personConversationFlows(1,creator)!
  expect(active).toMatchObject({flows:[{id:flow.id}],active_flows:[{id:flow.id}],active_flow_count:1,history_cleared_at:0})
  expect(conversation.personConversationFlows(1,peer)).toMatchObject({flows:[{id:flow.id}],active_flows:[],active_flow_count:0})
  expect(()=>conversation.personConversationFlows(2,creator)).toThrow('Person conversation not found')
  expect(conversation.personConversationFlows(1,'ordinary-chat')).toBeUndefined()
  await flows.controlPersonFlow(1,{action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:randomUUID()})
  f.db.prepare('UPDATE sessions SET history_cleared_at=? WHERE id=?').run(flow.created_at+1,creator)
  expect(conversation.personConversationFlows(1,creator)).toMatchObject({flows:[{id:flow.id,state:'stopped'}],active_flows:[],active_flow_count:0,history_cleared_at:flow.created_at+1})
})

it('keeps collaboration fields in the default App snapshot and lets Studio omit their duplicate load',async () => {
  const flow=create()
  const {personSnapshot}=await import('../../packages/server/src/modules/studio/services/person/service')
  expect(await personSnapshot(1,creator)).toMatchObject({flows:[{id:flow.id}],active_flows:[{id:flow.id}],active_flow_count:1})
  const settings=await personSnapshot(1,creator,{includeFlows:false})
  expect(settings).toMatchObject({session:{id:creator},tasks:[]})
  for(const key of ['flows','active_flows','active_flow_count']) expect(settings).not.toHaveProperty(key)
})

it('uses the normal Bot display projection for native blocks and private reasoning',() => {
  const flow=create()
  runs.startPersonStageRun(1,{flowId:flow.id,stageId:flow.stages[0].id,generation:0},'visible-run')
  reply('visible-run','<think>PRIVATE REASONING</think>公开结论')
  reply('visible-run',JSON.stringify([{type:'thinking',thinking:'PRIVATE NATIVE'},{type:'text',text:'公开进度'},{type:'tool_use',name:'secret',input:{token:'PRIVATE ARG'}}]))
  sessions.addMessage({session_id:peer,role:'tool',run_marker:'visible-run',content:'PRIVATE TOOL'})
  reply('visible-run','<think>unfinished private reasoning')
  expect(read(flow.id).messages.map(message=>message.content)).toEqual(['公开结论','公开进度'])
  expect(JSON.stringify(read(flow.id))).not.toContain('PRIVATE')
})

it('paginates original IDs without gaps or duplicates while new replies arrive',() => {
  const flow=create()
  runs.startPersonStageRun(1,{flowId:flow.id,stageId:flow.stages[0].id,generation:0},'paged-run')
  const ids=Array.from({length:5},(_,index)=>reply('paged-run',`回复 ${index}`))
  const latest=read(flow.id,{limit:2})
  expect(latest).toMatchObject({has_more:true,next_before_id:ids[3]})
  expect(latest.messages.map(message=>message.id)).toEqual(ids.slice(3))
  reply('paged-run','新回复')
  const earlier=read(flow.id,{before_id:latest.next_before_id,limit:2})
  expect(earlier.messages.map(message=>message.id)).toEqual(ids.slice(1,3))
  expect(read(flow.id,{before_id:earlier.next_before_id,limit:2})).toMatchObject({has_more:false,messages:[{id:ids[0]}]})
})

it('restores older flows from exact results even when the original run marker is missing',() => {
  const flow=create()
  f.db.prepare('DELETE FROM person_flow_runs WHERE flow_id=?').run(flow.id)
  const id=Number(sessions.addMessage({session_id:peer,role:'assistant',content:'旧流程的已保存成果',finish_reason:'completed'}))
  f.db.prepare('INSERT INTO person_stage_results(stage_id,round_number,result_message_id) VALUES(?,?,?)').run(flow.stages[0].id,1,id)
  f.db.prepare("UPDATE person_stages SET result_message_id=?,state='completed' WHERE id=?").run(id,flow.stages[0].id)
  expect(read(flow.id).messages).toMatchObject([{id,content:'旧流程的已保存成果'}])
})

it('enforces ownership and clear-history boundaries, and changes the history identity after message removal',async () => {
  const flow=create()
  runs.startPersonStageRun(1,{flowId:flow.id,stageId:flow.stages[0].id,generation:0},'owned-run')
  const id=reply('owned-run','可见回复')
  const before=read(flow.id)
  expect(()=>conversation.personFlowConversation(2,flow.id,{})).toThrow('Flow not found')
  f.db.prepare('DELETE FROM messages WHERE id=?').run(id)
  f.db.prepare('UPDATE sessions SET history_revision=history_revision+1 WHERE id=?').run(peer)
  expect(read(flow.id).history_key).not.toBe(before.history_key)
  expect(read(flow.id).messages).toEqual([])
  await flows.controlPersonFlow(1,{action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:randomUUID()})
  f.db.prepare('UPDATE sessions SET history_cleared_at=? WHERE id=?').run(flow.created_at+1,creator)
  expect(()=>read(flow.id)).toThrow('Flow history was cleared')
})

it.each([{limit:0},{limit:201},{before_id:-1},{before_id:1.5},{limit:'invalid'}])('rejects invalid paging input %j',query => {
  const flow=create()
  expect(()=>read(flow.id,query)).toThrow('Invalid conversation cursor or limit')
})

it.each(['completed','stopped','failed'] as const)('restores only linked plans and receipts for a %s collaboration',async state => {
  const flow=create()
  const context={flowId:flow.id,stageId:flow.stages[0].id,generation:0}
  runs.startPersonStageRun(1,context,'linked-worker-run')
  const {task,execution}=await f.create({session_id:peer,title:'阶段任务',goal:'验证关联'})
  const {linkPersonStageTask}=await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  linkPersonStageTask(1,task.id,context,peer)
  f.db.prepare("UPDATE person_executions SET state='finished' WHERE id=?").run(execution.id)
  const receiptId=reply('linked-worker-run','')
  const {savePersonTaskReturn}=await import('../../packages/server/src/modules/studio/repositories/person-return-store')
  expect(savePersonTaskReturn(1,execution.id,peer,receiptId)).toBeTruthy()
  reply('unrelated-run','不属于这次协作')
  const {saveTaskPlan}=await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
  const plan={session_id:peer,run_id:'linked-worker-run',plan_id:'linked-plan',revision:1,execution_state:'ended' as const,
    created_at:1000,updated_at:2000,plan:[{id:'work',step:'执行阶段任务',status:'completed' as const}]}
  saveTaskPlan(plan)
  saveTaskPlan({...plan,plan_id:'unrelated-plan',run_id:'unrelated-run'})
  // A run ID alone must never join a plan from another Bot or account.
  saveTaskPlan({...plan,session_id:'person-main-2',plan_id:'other-owner'})
  f.db.prepare('UPDATE person_flows SET state=? WHERE id=?').run(state,flow.id)
  await f.reopen()
  const result=read(flow.id)
  expect(result.flow.state).toBe(state)
  expect(result.flow.stages[0].tasks).toMatchObject([{id:task.id}])
  expect(result.messages).toMatchObject([{id:receiptId,content:'',run_marker:'linked-worker-run',person_task_return:{taskId:task.id,executionId:execution.id}}])
  expect(result.taskPlans).toEqual([plan])
  expect(()=>conversation.personFlowConversation(2,flow.id,{})).toThrow('Flow not found')
  f.db.prepare('UPDATE sessions SET history_cleared_at=? WHERE id=?').run(flow.created_at+1,creator)
  expect(()=>read(flow.id)).toThrow('Flow history was cleared')
  expect(f.runtime.execute).not.toHaveBeenCalled()
  expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})

it('keeps plans without public replies and restores legacy result run identities without latest-Bot fallbacks',async () => {
  const flow=create()
  const {saveTaskPlan}=await import('../../packages/server/src/modules/studio/repositories/task-plan-store')
  const plan={session_id:creator,run_id:'creator-run',plan_id:'creator-plan',revision:1,execution_state:'running' as const,
    created_at:1000,updated_at:1000,plan:[{id:'check',step:'核对协作',status:'in_progress' as const}]}
  saveTaskPlan(plan)
  expect(read(flow.id)).toMatchObject({messages:[],taskPlans:[plan]})
  const id=reply('legacy-run','历史阶段成果')
  f.db.prepare('INSERT INTO person_stage_results(stage_id,round_number,result_message_id) VALUES(?,?,?)').run(flow.stages[0].id,1,id)
  const legacy={...plan,session_id:peer,run_id:'legacy-run',plan_id:'legacy-plan'}
  saveTaskPlan(legacy)
  saveTaskPlan({...legacy,plan_id:'latest-other-topic',run_id:'other-topic',created_at:9000})
  expect(read(flow.id).taskPlans).toEqual([plan,legacy])
  f.db.prepare('DELETE FROM task_plans WHERE session_id=? AND plan_id=?').run(peer,'legacy-plan')
  expect(read(flow.id).taskPlans).toEqual([plan])
})

it('returns no cards without associated data and retains raw pagination bounds for hidden replies',async () => {
  const flow=create()
  expect(read(flow.id)).toMatchObject({messages:[],taskPlans:[],flow:{stages:[{tasks:[]}]}})
  runs.startPersonStageRun(1,{flowId:flow.id,stageId:flow.stages[0].id,generation:0},'paging')
  const hidden=reply('paging','<think>private only</think>')
  expect(read(flow.id)).toMatchObject({messages:[],oldest_message_id:hidden})
  const first=reply('paging','第一条'),second=reply('paging','第二条')
  expect(read(flow.id,{limit:1})).toMatchObject({messages:[{id:second}],next_before_id:second,has_more:true})
  expect(read(flow.id,{limit:1,before_id:second})).toMatchObject({messages:[{id:first}],next_before_id:first,has_more:true})
})
