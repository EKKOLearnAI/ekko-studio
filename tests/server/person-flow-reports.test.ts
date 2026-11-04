import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PersonRuntimePort } from '../../packages/server/src/modules/studio/public/person-runtime'

let root: string, db: DatabaseSync, runtime: PersonRuntimePort
let flows: typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let stages: typeof import('../../packages/server/src/modules/studio/repositories/person-stage-store')
let reports: typeof import('../../packages/server/src/modules/studio/repositories/person-flow-report-store')
let delivery: typeof import('../../packages/server/src/modules/studio/services/person/flow-reports')
let sessions: typeof import('../../packages/server/src/modules/studio/repositories/session-store')
const creator = 'person-main-creator', peer = 'person-main-peer', other = 'person-main-other'

beforeEach(async () => {
  vi.resetModules()
  root = realpathSync(mkdtempSync(join(tmpdir(),'flow-report-')))
  db = new DatabaseSync(join(root,'state.db'))
  db.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF')
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({ getDb:()=>db,isSqliteAvailable:()=>true }))
  vi.doMock('../../packages/server/src/modules/studio/public/config',()=>({ config:{ appHome:root },getWebUiHome:()=>root }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store',()=>({ findUserById:(id:number)=>({ id,status:'active',role:'super_admin',username:'fixture' }),listUserProfiles:()=>[{profile_name:'default'}],userCanAccessProfile:()=>true }))
  vi.doMock('../../packages/server/src/modules/studio/public/profile-config',()=>({ listProfileNamesFromDisk:()=>['default'],getActiveProfileName:()=> 'default',readConfigYamlForProfile:async()=>({}) }))
  const schema = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  schema.initAllHermesTables()
  sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  for (const id of [creator,peer,other]) sessions.createSession({ id,studio_user_id:1,user_id:1,title:id,workspace:root,source:'builtin_agent',agent:'ekko-agent',profile:'default' })
  runtime = { deliverFlowReport:vi.fn(async()=>{}),deliverStage:vi.fn(async()=>{}),deliver:vi.fn(),model:vi.fn(),modelConfig:vi.fn(),nativeModels:vi.fn(),execute:vi.fn(),answer:vi.fn(),stop:vi.fn() }
  const { configurePersonRuntime } = await import('../../packages/server/src/modules/studio/public/person-runtime')
  configurePersonRuntime(runtime)
  flows = await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  stages = await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  reports = await import('../../packages/server/src/modules/studio/repositories/person-flow-report-store')
  delivery = await import('../../packages/server/src/modules/studio/services/person/flow-reports')
})
afterEach(()=>{ db.close();rmSync(root,{recursive:true,force:true});vi.restoreAllMocks() })

function create(route = [{session_id:peer,group:0}], rounds=1, reporting:Record<string,unknown>={report_to_creator:true}) {
  return flows.createPersonFlow(1,{ session_id:creator,title:'Original collaboration',goal:'Answer the original request',rounds,...reporting,idempotency_key:crypto.randomUUID(),stages:route.map(s=>({...s,goal:'Do assigned work',return_expectation:'Report evidence'})) })
}
async function complete(flowId:string, index=0) {
  const flow = stages.getPersonFlow(1,flowId), stage=flow.stages[index]
  const context = { flowId,stageId:stage.id,generation:flow.generation },runId=`stage-run-${stage.id}-${flow.generation}`
  await flows.controlPersonFlow(1,{ action:'complete',flow_id:flowId,expected_revision:flow.revision,idempotency_key:`complete-${stage.id}-${flow.generation}` },{sessionId:stage.session_id,runId,stage:context,messages:[]})
  const message = sessions.addMessage({ session_id:stage.session_id,run_marker:runId,role:'assistant',content:`Result ${index}`,finish_reason:'completed' })!
  flows.finishPersonStageTurn(1,context,runId,message,true)
  return { context,runId,message }
}
function receipt() { return db.prepare('SELECT * FROM person_flow_reports').get() as unknown as import('../../packages/server/src/modules/studio/contracts/person-stage').PersonFlowReport }
function due() { db.prepare('UPDATE person_flow_reports SET next_attempt_at=0').run() }
function begin(runId='summary-run') {
  const row=receipt(), identity={id:row.id,attempt:row.attempts}
  db.prepare("UPDATE person_flow_reports SET state='starting' WHERE id=? AND state='queued'").run(row.id)
  reports.startPersonFlowReport(1,identity,creator,runId)
  return identity
}
function summary(runId='summary-run', overrides:Record<string,unknown>={}) {
  return sessions.addMessage({ session_id:creator,run_marker:runId,role:'assistant',content:'Verified summary',finish_reason:'completed',...overrides })!
}

it.each([{}, {report_to_creator:false}])('completes all rounds without a creator report when not requested: %j',async reporting=>{
  const flow=create([{session_id:peer,group:0},{session_id:other,group:1}],2,reporting)
  expect(flow.report_to_creator).toBe(false)
  // An unavailable reporting subsystem must not block work that does not request reporting.
  db.exec("CREATE TRIGGER reject_unrequested_report BEFORE INSERT ON person_flow_reports BEGIN SELECT RAISE(ABORT,'no report requested'); END")
  const messages:number[]=[]
  for(let round=0;round<2;round++) {
    messages.push((await complete(flow.id,0)).message,(await complete(flow.id,1)).message)
  }
  flows.recoverPersonStages();reports.recoverPersonFlowReports()
  await delivery.deliverPersonFlowReports()
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',round_number:2,error:'',report_to_creator:false,completion_report:null})
  expect(db.prepare('SELECT result_message_id FROM person_stage_results ORDER BY round_number,stage_id').all().map(row=>row.result_message_id).sort()).toEqual(messages.sort())
  expect(receipt()).toBeUndefined()
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
  expect(runtime.deliverStage).not.toHaveBeenCalled()
})

it('keeps a requested recipient stage without adding a compulsory creator summary',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:creator,group:1}],1,{})
  await complete(flow.id,0)
  expect(stages.getPersonFlow(1,flow.id).stages[1].state).toBe('active')
  const result=await complete(flow.id,1)
  await delivery.deliverPersonFlowReports()
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',completion_report:null})
  expect(db.prepare('SELECT content FROM messages WHERE id=? AND session_id=?').get(result.message,creator)).toBeTruthy()
  expect(receipt()).toBeUndefined()
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
})

it('keeps ordinary creator status queries read-only and allows a later explicit summary request',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:other,group:1}],2,{})
  const ids:number[]=[]
  for(let round=0;round<2;round++)ids.push((await complete(flow.id,0)).message,(await complete(flow.id,1)).message)
  const before=stages.getPersonFlow(1,flow.id)
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const query=personFlowTools(1,creator).find(tool=>tool.name==='bot_flows_query')!
  const origin={sessionId:creator,runId:'requested-summary',messages:[]}
  const status:any=await query.execute({flow_id:flow.id},origin)
  expect(status.flows[0]).not.toHaveProperty('report_instruction')
  expect(stages.getPersonFlow(1,flow.id)).toEqual(before)
  expect(receipt()).toBeUndefined()
  await query.execute({flow_id:flow.id,claim_report:true},{sessionId:peer,runId:'peer-query',messages:[]})
  expect(receipt()).toBeUndefined()
  const requested:any=await query.execute({flow_id:flow.id,claim_report:true},origin)
  expect(requested.flows[0]).toMatchObject({report_to_creator:true,completion_report:{state:'running',run_id:'requested-summary'},report_instruction:expect.any(String)})
  expect(JSON.parse(receipt().snapshot_json).sources.map((source:any)=>source.result_message_id)).toEqual(ids)
  const attempts=receipt().attempts
  await query.execute({flow_id:flow.id,claim_report:true},origin)
  expect(receipt().attempts).toBe(attempts)
  const message=summary('requested-summary')
  expect(reports.finishPersonFlowReport(1,{id:receipt().id,attempt:attempts},message,true)).toBe(true)
  reports.recoverPersonFlowReports();await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'delivered',result_message_id:message})
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
  expect(db.prepare('SELECT count(*) n FROM person_stage_results').get()!.n).toBe(4)
})

it('does not let a normal status lookup claim an already requested pending summary',async()=>{
  const flow=create();await complete(flow.id)
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const result:any=await personFlowTools(1,creator).find(tool=>tool.name==='bot_flows_query')!.execute({flow_id:flow.id},{sessionId:creator,runId:'status-only',messages:[]})
  expect(result.flows[0]).not.toHaveProperty('report_instruction')
  expect(receipt()).toMatchObject({state:'pending',attempts:0,run_id:''})
})

it.each(['pending','paused','running'])('migrates old flows with reporting off and keeps legacy %s reports dormant until requested',async state=>{
  const flow=create();const saved=await complete(flow.id)
  db.prepare('UPDATE person_flow_reports SET state=?').run(state)
  db.exec('ALTER TABLE person_flows DROP COLUMN report_to_creator')
  const {initPersonStageTables}=await import('../../packages/server/src/modules/studio/infrastructure/database/person-stage-schema')
  initPersonStageTables(db);initPersonStageTables(db)
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'completed',report_to_creator:false,completion_report:null})
  reports.recoverPersonFlowReports();reports.resumePersonFlowReports(1,creator)
  await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
  expect(receipt().state).toBe(state==='running'?'pending':state)
  expect(db.prepare('SELECT id FROM messages WHERE id=?').get(saved.message)).toBeTruthy()
  expect(()=>reports.retryCompletedPersonFlowReport(1,stages.getPersonFlow(1,flow.id),receipt().id,receipt().attempts)).toThrow()
  expect(reports.claimPersonFlowReportForRun(1,flow.id,creator,'requested-after-upgrade')).toBe(true)
  expect(receipt()).toMatchObject({state:'running',run_id:'requested-after-upgrade'})
  const id=summary('requested-after-upgrade')
  expect(reports.finishPersonFlowReport(1,{id:receipt().id,attempt:receipt().attempts},id,true)).toBe(true)
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
})

it.each(['false',1,null])('rejects a non-boolean reporting request: %j',value=>{
  expect(()=>create(undefined,1,{report_to_creator:value})).toThrow('boolean')
  expect(db.prepare('SELECT count(*) n FROM person_flows').get()!.n).toBe(0)
})

it('atomically creates one outbox item and acknowledges only the creator saved final reply',async()=>{
  const flow=create(), finished=await complete(flow.id)
  expect(stages.getPersonFlow(1,flow.id).state).toBe('completed')
  expect(receipt().state).toBe('pending')
  flows.finishPersonStageTurn(1,finished.context,finished.runId,finished.message,true)
  expect(db.prepare('SELECT COUNT(*) n FROM person_flow_reports').get()!.n).toBe(1)
  await delivery.deliverPersonFlowReports();await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
  expect(receipt().state).toBe('queued')
  const identity=begin(), id=summary()
  reports.startPersonFlowReport(1,identity,creator,'summary-run')
  expect(reports.finishPersonFlowReport(1,identity,id,true)).toBe(true)
  reports.finishPersonFlowReport(1,identity,id,true)
  due();await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'delivered',result_message_id:id,run_id:'summary-run',attempts:1})
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
  expect(db.prepare("SELECT COUNT(*) n FROM person_flow_report_events WHERE event='creator_report_completed'").get()!.n).toBe(1)
})

it('rolls back an outbox failure, visibly blocks and retains the saved reply for resume without redispatch',async()=>{
  const flow=create(), stage=flow.stages[0],context={flowId:flow.id,stageId:stage.id,generation:0}
  await flows.controlPersonFlow(1,{action:'complete',flow_id:flow.id,expected_revision:0,idempotency_key:'prepare'}, {sessionId:peer,runId:'r',stage:context,messages:[]})
  const id=sessions.addMessage({session_id:peer,run_marker:'r',role:'assistant',content:'saved',finish_reason:'stop'})!
  db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON person_flow_reports BEGIN SELECT RAISE(ABORT,'outbox failure'); END")
  flows.finishPersonStageTurn(1,context,'r',id,true)
  let current=stages.getPersonFlow(1,flow.id)
  expect(current).toMatchObject({state:'failed',stages:[{state:'failed',result_message_id:id,confirmation:{state:'blocked',message_id:id}}]})
  expect(receipt()).toBeUndefined()
  db.exec('DROP TRIGGER reject_outbox')
  current=await flows.controlPersonFlow(1,{action:'resume',flow_id:flow.id,expected_revision:current.revision,idempotency_key:'resume'})
  expect(db.prepare('SELECT count(*) n FROM person_stage_deliveries WHERE generation=?').get(current.generation)!.n).toBe(0)
  const resumed={...context,generation:current.generation}
  await flows.controlPersonFlow(1,{action:'complete',flow_id:flow.id,expected_revision:current.revision,idempotency_key:'saved-complete'},{sessionId:peer,runId:'r',stage:resumed,messages:[]})
  flows.finishPersonStageTurn(1,resumed,'r',id,true)
  expect(receipt().state).toBe('pending')
  expect(db.prepare('SELECT count(*) n FROM messages').get()!.n).toBe(1)
  expect(runtime.deliverStage).not.toHaveBeenCalled()
})

it('reports every round in order, joins terminal peers once, and paginates original references',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:other,group:0}],6)
  db.prepare('UPDATE person_stages SET return_expectation=? WHERE flow_id=?').run('e'.repeat(4000),flow.id)
  const ids:number[]=[]
  for(let round=1;round<=6;round++) {
    ids.push((await complete(flow.id,0)).message)
    expect(receipt()).toBeUndefined()
    ids.push((await complete(flow.id,1)).message)
    if(round<6) expect(receipt()).toBeUndefined()
  }
  await delivery.deliverPersonFlowReports()
  const row=receipt(),context=delivery.personFlowReportContext(1,{id:row.id,attempt:1},creator)
  expect(context).toMatchObject({round_number:6,round_limit:6,total_sources:12,next_source_offset:10})
  expect(context.sources.map(s=>s.result_message_id)).toEqual(ids.slice(0,10))
  expect(context.sources.map(s=>s.round_number)).toEqual([1,1,2,2,3,3,4,4,5,5])
  expect(context.sources[0]).toMatchObject({return_expectation:'e'.repeat(300),return_expectation_truncated:true})
  expect(JSON.parse(row.snapshot_json).stage_expectations[flow.stages[0].id]).toHaveLength(4000)
  expect(row.snapshot_json.length).toBeLessThan(18000)
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const page:any=await personFlowTools(1,creator).find(t=>t.name==='bot_flows_query')!.execute({flow_id:flow.id,result_offset:10},{sessionId:creator,runId:'lookup',messages:[]})
  expect(page.source_page).toMatchObject({total_sources:12,next_source_offset:null})
  expect(page.source_page.sources.map((s:any)=>s.result_message_id)).toEqual(ids.slice(10))
  expect(JSON.stringify(page).length).toBeLessThan(18000)
  expect(receipt().state).toBe('queued') // Reading evidence alone does not claim the queued summary.
  // Even an unavailable early page must block later-page summaries rather than silently omit it.
  db.prepare('DELETE FROM messages WHERE id=?').run(ids[0])
  expect(()=>delivery.personFlowReportSources(1,flow.id,10)).toThrow('unavailable')
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
})

it('does not report an unfinished continuous flow or revive it when stopped',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:other,group:1}],0)
  await complete(flow.id,0);await complete(flow.id,1)
  const current=stages.getPersonFlow(1,flow.id)
  expect(current).toMatchObject({state:'active',round_number:2})
  await flows.controlPersonFlow(1,{action:'stop',flow_id:flow.id,expected_revision:current.revision,idempotency_key:'stop-continuous'})
  reports.recoverPersonFlowReports();await delivery.deliverPersonFlowReports()
  expect(receipt()).toBeUndefined();expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
})

it('retries only the failed report with a fresh bounded budget and monotonically fenced attempts',async()=>{
  const flow=create();await complete(flow.id);await delivery.deliverPersonFlowReports()
  const old=begin('old-summary')
  db.prepare('UPDATE person_flow_reports SET attempts=5').run()
  reports.finishPersonFlowReport(1,{id:old.id,attempt:5},undefined,false,'exhausted')
  const resume=vi.fn();runtime.resumeFlowReports=resume
  const current=stages.getPersonFlow(1,flow.id)
  const input={action:'retry_report',flow_id:flow.id,expected_revision:current.revision,report_id:old.id,expected_attempt:5,idempotency_key:'retry'}
  await expect(flows.controlPersonFlow(2,input)).rejects.toMatchObject({status:404})
  await flows.controlPersonFlow(1,input)
  await flows.controlPersonFlow(1,input)
  expect(receipt()).toMatchObject({state:'pending',attempts:5,attempt_limit:10})
  await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'queued',attempts:6})
  const identity=begin('new-summary'),id=summary('new-summary')
  expect(reports.finishPersonFlowReport(1,old,undefined,false,'late')).toBe(false)
  expect(reports.finishPersonFlowReport(1,identity,id,true)).toBe(true)
  expect(resume).toHaveBeenCalledWith(1,creator)
  expect(runtime.deliverStage).not.toHaveBeenCalled()
  const latest=stages.getPersonFlow(1,flow.id)
  await expect(flows.controlPersonFlow(1,{...input,expected_revision:latest.revision,idempotency_key:'stale'})).rejects.toMatchObject({status:409})
})

it('migrates existing report retry budgets without replacing persisted receipts',async()=>{
  await complete(create().id)
  const original=receipt()
  const current=JSON.parse(original.snapshot_json)
  const legacy=JSON.stringify({title:current.title,goal:current.goal,workspace:current.workspace,
    sources:current.sources.map((source:any)=>({session_id:source.session_id,result_message_id:source.result_message_id,return_expectation:'Legacy return expectation'}))})
  db.prepare("UPDATE person_flow_reports SET state='paused',attempts=3,snapshot_json=? WHERE id=?").run(legacy,original.id)
  db.exec('ALTER TABLE person_flow_reports DROP COLUMN attempt_limit')
  const init=await import('../../packages/server/src/modules/studio/infrastructure/database/person-stage-schema')
  init.initPersonStageTables(db)
  expect(receipt()).toMatchObject({id:original.id,snapshot_json:legacy,state:'paused',attempts:3,attempt_limit:5})
  db.prepare("UPDATE person_flow_reports SET state='queued'").run()
  expect(delivery.personFlowReportContext(1,{id:original.id,attempt:3},creator).sources[0]).toMatchObject({round_number:1,return_expectation:'Legacy return expectation'})
})

it('waits for every parallel branch and carries all source references and the original workspace',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:other,group:0}])
  // These represent final Bot replies after their optional worker callbacks; workers must settle first.
  await complete(flow.id,1)
  expect(receipt()).toBeUndefined()
  await complete(flow.id,0)
  await delivery.deliverPersonFlowReports()
  const row=receipt(), context=delivery.personFlowReportContext(1,{id:row.id,attempt:row.attempts},creator)
  expect(context).toMatchObject({goal:flow.goal,workspace:root,sources:[{session_id:peer,content:'Result 0'},{session_id:other,content:'Result 1'}]})
})

it.each([
  { content:'   ' },{ finish_reason:'streaming' },{ tool_calls:[{id:'tool'}] },
  { session_id:peer },{ run_marker:'unrelated' },{ role:'user' },
])('rejects a runtime success with an invalid saved final message %j',async overrides=>{
  await complete(create().id);await delivery.deliverPersonFlowReports()
  const identity=begin(),id=summary('summary-run',overrides)
  expect(reports.finishPersonFlowReport(1,identity,id,true)).toBe(false)
  expect(receipt()).toMatchObject({state:'pending',result_message_id:null,attempts:1})
})

it('retries transient dispatch and run failures with backoff, fences old callbacks, and caps attempts',async()=>{
  await complete(create().id)
  vi.mocked(runtime.deliverFlowReport!).mockRejectedValueOnce(new Error('offline'))
  await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'pending',attempts:1,error:'Error: offline'})
  await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
  due();await delivery.deliverPersonFlowReports()
  const old=begin('old-run')
  reports.finishPersonFlowReport(1,old,undefined,false,'model failure')
  due();await delivery.deliverPersonFlowReports()
  const current=begin('current-run')
  expect(reports.finishPersonFlowReport(1,old,summary('old-run'),true)).toBe(false)
  expect(receipt()).toMatchObject({state:'running',attempts:3})
  reports.finishPersonFlowReport(1,current,undefined,false,'failed again')
  for(let n=0;n<2;n++) { due();await delivery.deliverPersonFlowReports();reports.finishPersonFlowReport(1,begin(`retry-${n}`),undefined,false,'still failing') }
  expect(receipt()).toMatchObject({state:'failed',attempts:5})
  due();await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(5)
})

it('recovers a crash after message persistence without generating a second summary',async()=>{
  await complete(create().id);await delivery.deliverPersonFlowReports();begin()
  const id=summary()
  db.close();db=new DatabaseSync(join(root,'state.db'))
  reports.recoverPersonFlowReports();reports.recoverPersonFlowReports()
  due();await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'delivered',result_message_id:id})
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
})

it.each(['queued','starting','running'])('recovers lost %s work for retry after restart',async state=>{
  await complete(create().id);await delivery.deliverPersonFlowReports()
  db.prepare('UPDATE person_flow_reports SET state=?').run(state)
  reports.recoverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'pending',attempts:1})
  due();await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'queued',attempts:2})
})

it('retains an observable pause without exhausting attempts and resumes after admission succeeds',async()=>{
  await complete(create().id)
  vi.mocked(runtime.deliverFlowReport!).mockRejectedValue(Object.assign(new Error('user stopped reporting'),{code:'FLOW_REPORT_PAUSED'}))
  for(let n=0;n<7;n++) { due();await delivery.deliverPersonFlowReports() }
  expect(receipt()).toMatchObject({state:'paused',attempts:0})
  vi.mocked(runtime.deliverFlowReport!).mockResolvedValue()
  reports.recoverPersonFlowReports()
  due();await delivery.deliverPersonFlowReports()
  expect(receipt().state).toBe('paused')
  reports.resumePersonFlowReports(1,creator)
  due();await delivery.deliverPersonFlowReports()
  const identity=begin(),id=summary()
  reports.finishPersonFlowReport(1,identity,id,true)
  expect(receipt()).toMatchObject({state:'delivered',attempts:1})
})

it.each(['generation','deleted','ownership','source'])('does not run a report with invalid %s',async kind=>{
  const flow=create();await complete(flow.id)
  if(kind==='generation') db.prepare('UPDATE person_flows SET generation=generation+1').run()
  if(kind==='deleted') db.prepare('DELETE FROM sessions WHERE id=?').run(creator)
  if(kind==='ownership') db.prepare('UPDATE sessions SET studio_user_id=2 WHERE id=?').run(creator)
  if(kind==='source') db.prepare('UPDATE sessions SET studio_user_id=2 WHERE id=?').run(peer)
  await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
  expect(receipt().state).not.toBe('delivered')
  expect(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id=?').get(creator)!.n).toBe(kind==='deleted'?0:1)
})

it('uses the creator final-stage reply as delivery confirmation without a self-wake loop',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:creator,group:1}])
  await complete(flow.id,0)
  const final=await complete(flow.id,1)
  await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'delivered',session_id:creator,result_message_id:final.message,attempts:0})
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
})

it('still summarizes peer results when the creator finishes last in a parallel group',async()=>{
  const flow=create([{session_id:peer,group:0},{session_id:creator,group:0}])
  await complete(flow.id,0);await complete(flow.id,1)
  expect(receipt().state).toBe('pending')
  await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
})

it.each([false,true])('wakes the offline creator through the real session queue, busy=%s, and ignores duplicate dispatch',async busy=>{
  const { ChatRunSocket } = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const server = Object.create(ChatRunSocket.prototype) as any
  const emit=vi.fn(),state={queue:[],isWorking:busy}
  server.sessionMap=new Map([[creator,state]])
  server.nsp={to:()=>({emit})}
  server.sessionStateForBackground=vi.fn(async()=>state)
  server.socketForBackgroundRun=vi.fn(()=>({connected:false,data:{user:{id:999}}}))
  let finish:()=>void=()=>{}
  server.executeRun=vi.fn((socket:any,data:any)=>new Promise<void>(resolve=>{
    expect(socket.connected).toBe(false)
    expect(socket.data.user.id).toBe(1)
    expect(data.session_id).toBe(creator)
    expect(data.autonomous).toBe(true)
    expect(data.display_input).toBeNull()
    data.onEvent('run.started',{run_id:'queue-summary'})
    finish=()=>{
      const message=summary('queue-summary')
      data.onEvent('run.completed',{run_id:'queue-summary',message_id:message})
      state.isWorking=false;resolve()
    }
  }))
  runtime.deliverFlowReport=vi.fn(input=>server.deliverPersonFlowReport(input))
  await complete(create().id)
  await Promise.all([delivery.deliverPersonFlowReports(),delivery.deliverPersonFlowReports()])
  const row=receipt(),input={user:{id:1},identity:{id:row.id,attempt:row.attempts},sessionId:creator}
  await server.deliverPersonFlowReport(input)
  if(busy) {
    expect(server.executeRun).not.toHaveBeenCalled()
    expect(state.queue).toHaveLength(1)
    state.isWorking=false
    server.dequeueNextQueuedRun({data:{user:{id:999}}},creator)
  }
  expect(server.executeRun).toHaveBeenCalledTimes(1)
  expect(receipt().state).toBe('running')
  await server.deliverPersonFlowReport(input)
  expect(state.queue).toHaveLength(0)
  finish()
  await Promise.resolve()
  expect(receipt()).toMatchObject({state:'delivered',run_id:'queue-summary',attempts:1})
  expect(server.executeRun).toHaveBeenCalledTimes(1)
})

it('returns both worker results to their Bots before creating one parallel-flow creator report',async()=>{
  const store=await import('../../packages/server/src/modules/studio/repositories/person-store')
  const callbacks=await import('../../packages/server/src/modules/studio/services/person/delivery')
  const flow=create([{session_id:peer,group:0},{session_id:other,group:0}])
  const workers=flow.stages.map(stage=>{
    const context={flowId:flow.id,stageId:stage.id,generation:0}
    const task=store.createPersonTask(1,stage.session_id,'Produce verified result',{runtime:'ekko',mode:'scoped',profile:'default',provider:'fixture',model:'test'},root,stage.session_id)
    stages.linkPersonStageTask(1,task.id,context,stage.session_id)
    callbacks.savePersonTaskOrigin(1,task.id,{sessionId:stage.session_id,runId:`initial-${stage.id}`,stage:context,messages:[]})
    const execution=store.enqueuePersonExecution(task)
    return {task,execution,context,stage}
  })
  for(const {context,stage} of workers) await expect(flows.controlPersonFlow(1,{action:'complete',flow_id:flow.id,expected_revision:0,idempotency_key:`premature-${stage.id}`},{sessionId:stage.session_id,runId:'premature',stage:context,messages:[]})).rejects.toMatchObject({status:409})
  for(const {task,execution} of workers) {
    db.prepare("UPDATE person_executions SET state='finished',output='verified worker output' WHERE id=?").run(execution.id)
    db.prepare("UPDATE session_tasks SET status='completed' WHERE id=?").run(task.id)
    callbacks.readyPersonDelivery(store.getPersonExecution(1,execution.id))
  }
  await callbacks.deliverPersonResults()
  expect(vi.mocked(runtime.deliver).mock.calls.map(([input])=>input.origin.sessionId).sort()).toEqual([other,peer].sort())
  expect(receipt()).toBeUndefined()
  for(let i=0;i<workers.length;i++) {
    const {execution}=workers[i]
    await complete(flow.id,i)
    callbacks.finishPersonDelivery(1,execution.id,true)
  }
  await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
  const identity=begin(),id=summary()
  reports.finishPersonFlowReport(1,identity,id,true)
  expect(receipt()).toMatchObject({state:'delivered',result_message_id:id})
})

it.each([creator,peer])('cancels reports when target or source history is cleared: %s',async sessionId=>{
  await complete(create().id)
  const history=await import('../../packages/server/src/modules/studio/repositories/person-history-store')
  history.clearPersonHistory(1,sessionId,sessions.getSession(sessionId)!.history_revision)
  await delivery.deliverPersonFlowReports()
  expect(receipt().state).toBe('cancelled')
  expect(runtime.deliverFlowReport).not.toHaveBeenCalled()
})

it.each(['queued','running'])('persists Stop on a %s report before a terminal callback and waits for a user turn across restart',async mode=>{
  await complete(create().id);await delivery.deliverPersonFlowReports()
  const row=receipt(),identity=mode==='running'?begin():{id:row.id,attempt:row.attempts}
  const {handleAbort}=await import('../../packages/server/src/modules/studio/services/chat-run/abort')
  const agentRuntime=await import('../../packages/server/src/modules/studio/public/chat-agent-runtime')
  vi.spyOn(agentRuntime.chatCodingAgentRunManager,'hasSession').mockReturnValue(false)
  vi.spyOn(agentRuntime,'hasChatEkkoBackgroundTasks').mockReturnValue(false)
  const state:any={queue:mode==='queued'?[{autonomous:true,personFlowReport:{userId:1,identity}}]:[],messages:[],events:[],isWorking:false,source:'builtin_agent'}
  const emit=vi.fn(),nsp:any={to:()=>({emit}),adapter:{rooms:new Map()}},socket:any={connected:false,emit}
  await handleAbort(nsp,socket,creator,new Map([[creator,state]]),{},vi.fn())
  expect(state.queue).toHaveLength(0)
  expect(receipt().state).toBe('paused')
  reports.recoverPersonFlowReports();due();await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(1)
  reports.resumePersonFlowReports(1,creator)
  await delivery.deliverPersonFlowReports()
  expect(receipt()).toMatchObject({state:'queued',attempts:2})
})

it.each(['reject','no-event','empty-success'])('retries an actual queued report after %s without acknowledging delivery',async failure=>{
  const {ChatRunSocket}=await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const server=Object.create(ChatRunSocket.prototype) as any,state={queue:[],isWorking:false}
  server.sessionMap=new Map([[creator,state]])
  server.nsp={to:()=>({emit:vi.fn()})}
  server.sessionStateForBackground=vi.fn(async()=>state)
  server.socketForBackgroundRun=vi.fn(()=>({connected:false}))
  server.executeRun=vi.fn(async(_socket:any,data:any)=>{
    if(failure==='reject') throw new Error('model unavailable')
    data.onEvent('run.started',{run_id:'failed-summary'})
    if(failure==='empty-success') data.onEvent('run.completed',{run_id:'failed-summary'})
  })
  runtime.deliverFlowReport=vi.fn(input=>server.deliverPersonFlowReport(input))
  await complete(create().id);await delivery.deliverPersonFlowReports()
  await vi.waitFor(()=>expect(receipt().state).toBe('pending'))
  expect(receipt().result_message_id).toBeNull()
  expect(receipt().error).not.toBe('')
  expect(server.executeRun).toHaveBeenCalledTimes(1)
})

it.each([false,true])('lets a creator follow-up claim and fulfill the same report, alreadyQueued=%s',async queued=>{
  const flow=create();await complete(flow.id)
  if(queued) await delivery.deliverPersonFlowReports()
  const old={id:receipt().id,attempt:receipt().attempts}
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const query=personFlowTools(1,creator).find(tool=>tool.name==='bot_flows_query')!
  const origin={sessionId:creator,runId:'follow-up-run',messages:[]}
  const response:any=await query.execute({flow_id:flow.id,claim_report:true},origin)
  expect(response.flows[0]).toMatchObject({completion_report:{state:'running',run_id:'follow-up-run'},report_instruction:expect.any(String)})
  const attempts=receipt().attempts
  await query.execute({flow_id:flow.id,claim_report:true},origin)
  expect(receipt().attempts).toBe(attempts)
  const message=summary('follow-up-run')
  for(const row of reports.personFlowReportsForRun(1,creator,'follow-up-run'))
    reports.finishPersonFlowReport(1,{id:row.id,attempt:row.attempts},message,true)
  expect(receipt()).toMatchObject({state:'delivered',result_message_id:message})
  expect(reports.finishPersonFlowReport(1,old,undefined,false,'old queued callback')).toBe(false)
  due();await delivery.deliverPersonFlowReports()
  expect(runtime.deliverFlowReport).toHaveBeenCalledTimes(queued?1:0)
})

it('does not let a participant query claim the creator report',async()=>{
  const flow=create();await complete(flow.id)
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  const query=personFlowTools(1,peer).find(tool=>tool.name==='bot_flows_query')!
  await query.execute({flow_id:flow.id,claim_report:true},{sessionId:peer,runId:'participant-run',messages:[]})
  expect(receipt()).toMatchObject({state:'pending',attempts:0})
})

it('lists completed flows without claiming unrelated reports',async()=>{
  await complete(create().id)
  const {personFlowTools}=await import('../../packages/server/src/modules/studio/services/person/stage-tools')
  await personFlowTools(1,creator).find(tool=>tool.name==='bot_flows_query')!.execute({}, {sessionId:creator,runId:'list-run',messages:[]})
  expect(receipt()).toMatchObject({state:'pending',attempts:0})
})

it('drops the old real queue entry after the creator follow-up reply is saved',async()=>{
  const {ChatRunSocket}=await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const server=Object.create(ChatRunSocket.prototype) as any,state={queue:[],isWorking:true}
  server.sessionMap=new Map([[creator,state]])
  server.nsp={to:()=>({emit:vi.fn()})}
  server.sessionStateForBackground=vi.fn(async()=>state)
  server.socketForBackgroundRun=vi.fn(()=>({connected:false}))
  server.executeRun=vi.fn()
  runtime.deliverFlowReport=vi.fn(input=>server.deliverPersonFlowReport(input))
  const flow=create();await complete(flow.id);await delivery.deliverPersonFlowReports()
  expect(state.queue).toHaveLength(1)
  reports.claimPersonFlowReportForRun(1,flow.id,creator,'follow-up')
  const row=receipt(),message=summary('follow-up')
  reports.finishPersonFlowReport(1,{id:row.id,attempt:row.attempts},message,true)
  state.isWorking=false
  server.dequeueNextQueuedRun({},creator)
  expect(state.queue).toHaveLength(0)
  expect(state.isWorking).toBe(false)
  expect(server.executeRun).not.toHaveBeenCalled()
  expect(receipt()).toMatchObject({state:'delivered',result_message_id:message})
})
