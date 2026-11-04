import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {acceptanceFixture,type AcceptanceFixture} from './fixtures/person-acceptance'

let f:AcceptanceFixture
let flows:typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let stages:typeof import('../../packages/server/src/modules/studio/repositories/person-stage-store')
let confirmations:typeof import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
let confirm:typeof import('../../packages/server/src/modules/studio/services/person/stage-confirmation')
let reports:typeof import('../../packages/server/src/modules/studio/repositories/person-flow-report-store')
let sessions:typeof import('../../packages/server/src/modules/studio/repositories/session-store')
const creator='person-main-1',peer='person-main-peer',other='person-main-other'
beforeEach(async()=>{
  f=await acceptanceFixture()
  flows=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  stages=await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  confirmations=await import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
  confirm=await import('../../packages/server/src/modules/studio/services/person/stage-confirmation')
  reports=await import('../../packages/server/src/modules/studio/repositories/person-flow-report-store')
  sessions=await import('../../packages/server/src/modules/studio/repositories/session-store')
  for(const id of [peer,other])sessions.createSession({id,studio_user_id:1,user_id:1,source:'builtin_agent',workspace:f.workspace})
  vi.mocked(f.runtime.model).mockResolvedValue(JSON.stringify({status:'complete',reason:'The original result fulfills the stage'}))
})
afterEach(async()=>{await f.close('flow-report-integration')})
function create(rounds=1){return flows.createPersonFlow(1,{session_id:creator,title:'Two roles',goal:'Retain evidence',rounds,report_to_creator:true,idempotency_key:randomUUID(),stages:[peer,other].map(session_id=>({session_id,goal:'Produce evidence',return_expectation:'Return evidence'}))})}
async function saved(flowId:string,prepare=true,settle=true){
  const flow=stages.getPersonFlow(1,flowId),stage=flow.stages[flow.current_position],runId=randomUUID()
  const context={flowId,stageId:stage.id,generation:flow.generation}
  confirmations.startPersonStageRun(1,context,runId)
  if(prepare)await flows.controlPersonFlow(1,{action:'complete',flow_id:flowId,expected_revision:flow.revision,idempotency_key:randomUUID()},{sessionId:stage.session_id,runId,stage:context,messages:[]})
  const id=sessions.addMessage({session_id:stage.session_id,run_marker:runId,role:'assistant',content:`Evidence round ${flow.round_number} role ${stage.position}`,finish_reason:'stop'})!
  if(settle)flows.finishPersonStageTurn(1,context,runId,id,true)
  return {context,runId,id}
}

it('creates exactly one all-round report when the last stage is completed by status confirmation',async()=>{
  const flow=create(2),ids:number[]=[]
  for(let index=0;index<3;index++){ids.push((await saved(flow.id)).id);expect(f.db.prepare('SELECT count(*) n FROM person_flow_reports').get()!.n).toBe(0)}
  const last=await saved(flow.id,false);ids.push(last.id)
  await confirm.confirmPersonStage(1,last.context)
  await confirm.confirmPersonStage(1,last.context)
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',round_number:2,completion_report:{state:'pending'}})
  const rows=f.db.prepare('SELECT snapshot_json FROM person_flow_reports').all()
  expect(rows).toHaveLength(1)
  expect(JSON.parse(String(rows[0].snapshot_json)).sources.map((s:any)=>s.result_message_id)).toEqual(ids)
  expect(f.runtime.model).toHaveBeenCalledTimes(1)
  expect(f.runtime.execute).not.toHaveBeenCalled()
})

it('recovers a crash between last reply persistence and completion without replaying stages or reports',async()=>{
  const flow=create();await saved(flow.id)
  const last=await saved(flow.id,true,false)
  await f.reopen()
  flows.recoverPersonStages();confirm.recoverStageConfirmations();reports.recoverPersonFlowReports()
  flows.recoverPersonStages();confirm.recoverStageConfirmations();reports.recoverPersonFlowReports()
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',completion_report:{state:'pending'}})
  expect(f.db.prepare('SELECT count(*) n FROM person_flow_reports').get()!.n).toBe(1)
  expect(f.db.prepare('SELECT count(*) n FROM person_stage_results WHERE result_message_id=?').get(last.id)!.n).toBe(1)
  expect(f.runtime.execute).not.toHaveBeenCalled();expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})

it('resumes only confirmation of the saved last reply after an outbox failure and restart',async()=>{
  const flow=create();await saved(flow.id)
  f.db.exec("CREATE TRIGGER reject_report BEFORE INSERT ON person_flow_reports BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END")
  const last=await saved(flow.id)
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'failed',stages:[{state:'completed'},{state:'failed',result_message_id:last.id}]})
  await f.reopen();f.db.exec('DROP TRIGGER reject_report')
  const failed=stages.getPersonFlow(1,flow.id)
  const resumed=await flows.controlPersonFlow(1,{action:'resume',flow_id:flow.id,expected_revision:failed.revision,idempotency_key:'resume-saved'})
  await confirm.confirmPersonStage(1,{...last.context,generation:resumed.generation})
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',completion_report:{state:'pending'}})
  expect(f.db.prepare('SELECT count(*) n FROM messages').get()!.n).toBe(2)
  expect(f.db.prepare('SELECT count(*) n FROM person_flow_reports').get()!.n).toBe(1)
  expect(f.runtime.model).toHaveBeenCalledTimes(1)
  expect(f.runtime.execute).not.toHaveBeenCalled();expect(f.runtime.deliverStage).not.toHaveBeenCalled()
})
