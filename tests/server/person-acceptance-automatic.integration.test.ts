import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptance, acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture
beforeEach(async () => { f=await acceptanceFixture({automatic:true}) })
afterEach(async context => { await f?.close(context.task.name) })
async function reviewer() {
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({id:'person-main-reviewer',studio_user_id:1,user_id:1,title:'暖暖',workspace:f.workspace,source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',profile:'default'})
  return 'person-main-reviewer'
}
async function decideReports() {
  const {finishPersonDelivery}=await import('../../packages/server/src/modules/studio/services/person/delivery')
  vi.mocked(f.runtime.deliver).mockImplementation(async result => {
    if(result.acceptance?.next_action==='review') {
      const tools=f.personTaskTools(1,result.origin.sessionId)
      const queried:any=await tools.find(tool=>tool.name==='bot_tasks_query')!.execute({task_id:String(result.acceptance.development_task_id)})
      const session=f.store.getPersonExecution(1,result.executionId).session_id
      const recorded=await tools.find(tool=>tool.name==='bot_task_control')!.execute({action:'record_acceptance',task_ref:queried.task.task_ref,verification_execution_id:result.executionId,report:f.decisions.get(session)},
        {...result.origin,runId:randomUUID(),returnExecutionId:result.executionId})
      expect(recorded).toMatchObject({ok:true,instruction:expect.stringContaining('host automatically')})
    }
    finishPersonDelivery(1,result.executionId,true,'',result.origin.acceptanceReturnId)
  })
}
async function pump(check:()=>void) {
  await vi.waitFor(async()=>{await f.runner.tickPersonWork();check()},{timeout:6000,interval:15})
}
const rootReceipt=(taskId:string)=>f.receipt(f.get(taskId).execution_id!)

it.each([false,true])('automatically repairs and re-verifies without Bot routing tool calls; external reviewer=%s',async external=>{
  await decideReports();f.worker('41','42')
  const reviewer_session_id=external?await reviewer():undefined
  const {task,execution}=await f.create({acceptance:{...acceptance,reviewer_session_id}})
  expect(JSON.parse(task.requirements_json).acceptance.progression).toBe('automatic')
  await pump(()=>expect(f.get(task.id).status).toBe('completed'))
  const tasks=f.store.listPersonTasks(1),runs=f.store.taskPersonExecutions(1,task.id)
  expect(tasks).toHaveLength(2);expect(runs).toHaveLength(2)
  expect(runs.every(run=>run.session_id===execution.session_id)).toBe(true)
  const detail=f.detail.personAcceptanceDetail(1,task.id)!
  expect(detail.attempts.map(round=>round.ordinal)).toEqual([1,2])
  expect(detail.attempts.map(round=>round.decision_attempts)).toEqual([1,1])
  expect(new Set(detail.attempts.map(round=>round.verification_execution_id)).size).toBe(2)
  const calls=f.execute.mock.calls.map(([input])=>input)
  expect(calls.map(input=>input.purpose)).toEqual(['development','verification','development','verification'])
  expect(JSON.stringify(calls[2].prompt)).toContain('Expected 42; observed 41')
  expect(rootReceipt(task.id).deadline).toBe(f.receipt(execution.id).deadline)
  expect(rootReceipt(task.id).cycle_id).toBe(execution.id)
  expect(vi.mocked(f.runtime.deliver).mock.calls.some(([result])=>result.acceptance?.next_action==='verify'||result.acceptance?.next_action==='repair')).toBe(false)
  const reviewTask=tasks.find(row=>row.id!==task.id)!
  expect(reviewTask.session_id).toBe(reviewer_session_id || task.session_id)
  expect(reviewTask.status).toBe('completed')
  if(external) await pump(()=>expect(vi.mocked(f.runtime.deliver).mock.calls.some(([result])=>result.taskId===task.id&&result.acceptance?.next_action==='report')).toBe(true))
})

it('automatically verifies a first-pass result and finishes with no developer retry',async()=>{
  await decideReports()
  const {task}=await f.create({acceptance})
  await pump(()=>expect(f.get(task.id).status).toBe('completed'))
  expect(f.execute.mock.calls.map(([input])=>input.purpose)).toEqual(['development','verification'])
  expect(rootReceipt(task.id)).toMatchObject({state:'passed',attempt:1})
})

it('retains original result-memory authority for developer repair without granting it to the reviewer',async()=>{
  await decideReports();f.worker('41','42')
  const memoryRequest={sessionId:'person-main-1',messageId:1,historyRevision:0,content:'Remember the verified result'}
  const {task}=await f.tasks.applyPersonTask(1,{action:'create',title:'Result',goal:'Write 42',acceptance,idempotency_key:randomUUID()},undefined,
    {sessionId:'person-main-1',runId:'user-turn',messages:[],memoryRequest})
  await pump(()=>expect(f.get(task.id).status).toBe('completed'))
  const rows=f.db.prepare('SELECT e.task_id,d.origin_json FROM person_deliveries d JOIN person_executions e ON e.id=d.execution_id').all()
  for(const row of rows) expect(JSON.parse(String(row.origin_json)).memoryRequest).toEqual(row.task_id===task.id?memoryRequest:undefined)
})

it('retains the schedule occurrence through automatic repair and finishes it only after re-verification',async()=>{
  await decideReports();f.worker('41','42')
  const {task}=await f.create({start:false,acceptance})
  const schedule=f.schedules.applyPersonSchedule(1,{action:'create',mode:'worker',task_id:task.id,kind:'once',expression:new Date(Date.now()+60_000).toISOString(),timezone:'UTC',idempotency_key:randomUUID()})
  f.db.prepare('UPDATE person_schedules SET next_at=? WHERE id=?').run(Date.now()-10,schedule.id)
  await pump(()=>expect(f.db.prepare('SELECT state FROM person_occurrences WHERE schedule_id=?').get(schedule.id)?.state).toBe('finished'))
  const occurrence=f.db.prepare('SELECT id FROM person_occurrences WHERE schedule_id=?').get(schedule.id)!
  expect(f.store.taskPersonExecutions(1,task.id).map(run=>run.occurrence_id)).toEqual([occurrence.id,occurrence.id])
  expect(f.execute).toHaveBeenCalledTimes(4)
})

it('keeps an automatic stage child bound to its stage through repair and permits stage completion after acceptance',async()=>{
  await decideReports();f.worker('41','42')
  const {createPersonFlow,controlPersonFlow}=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  const {getPersonFlow}=await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  const receiver=await reviewer()
  const flow=createPersonFlow(1,{title:'Build',goal:'Deliver a verified result',stages:[{session_id:receiver,goal:'Write the result',return_expectation:'Validated artifact'}],idempotency_key:randomUUID()}, {sessionId:'person-main-1',runId:'creator',messages:[]})
  const origin={sessionId:receiver,runId:'role-turn',messages:[],stage:{flowId:flow.id,stageId:flow.stages[0].id,generation:flow.generation}}
  const child=await f.tasks.applyPersonTask(1,{action:'create',title:'Child result',goal:'Write 42',acceptance,idempotency_key:randomUUID()},undefined,origin)
  await pump(()=>expect(f.get(child.task.id).status).toBe('completed'))
  expect(f.store.taskPersonExecutions(1,child.task.id)).toHaveLength(2)
  await expect(controlPersonFlow(1,{action:'complete',flow_id:flow.id,expected_revision:getPersonFlow(1,flow.id).revision,idempotency_key:randomUUID()},origin)).resolves.toBeDefined()
})

it('stops after the shared round budget instead of creating replacement work',async()=>{
  await decideReports();f.worker('41','41')
  const {task}=await f.create({acceptance:{...acceptance,max_attempts:2}})
  await pump(()=>expect(rootReceipt(task.id).state).toBe('failed'))
  expect(rootReceipt(task.id).attempt).toBe(2);expect(f.get(task.id).status).toBe('open')
  for(let i=0;i<4;i++)await f.runner.tickPersonWork()
  expect(f.execute).toHaveBeenCalledTimes(4);expect(f.store.listPersonTasks(1)).toHaveLength(2)
})

it('blocks on an environment verdict without starting repair',async()=>{
  await decideReports()
  f.worker('42','42',input=>{
    const report=f.assessment(input);report.verdict='blocked';report.summary='Browser environment unavailable'
    report.checks[0]={...report.checks[0],status:'blocked',findings:'Restore the browser environment before continuing',evidence:[]}
    return {ok:true,output:'无法打开浏览器，缺少验收环境。请恢复环境后继续。'}
  })
  const {task}=await f.create({acceptance})
  await pump(()=>expect(rootReceipt(task.id).state).toBe('blocked'))
  for(let i=0;i<3;i++)await f.runner.tickPersonWork()
  expect(f.execute).toHaveBeenCalledTimes(2);expect(f.get(task.id).status).toBe('open')
})

it('returns a failed native verifier to the original developer Bot without repair retries',async()=>{
  await decideReports()
  const reviewer_session_id=await reviewer()
  f.worker('42','42',()=>({ok:false,output:'',error:'Verification provider unavailable'}))
  const {task}=await f.create({acceptance:{...acceptance,reviewer_session_id}})
  await pump(()=>expect(rootReceipt(task.id).state).toBe('blocked'))
  await pump(()=>expect(vi.mocked(f.runtime.deliver).mock.calls.some(([result])=>result.taskId===task.id&&result.origin.sessionId===task.session_id&&result.acceptance?.next_action==='blocked')).toBe(true))
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it('continues a saved dispatch after restart and repeated scheduler calls dispatch only once',async()=>{
  await decideReports()
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  expect(f.receipt(execution.id).state).toBe('awaiting_dispatch')
  await f.reopen()
  const {advanceAutomaticAcceptances}=await import('../../packages/server/src/modules/studio/services/person/automatic-acceptance')
  await Promise.all(Array.from({length:5},()=>advanceAutomaticAcceptances()))
  expect(f.store.listPersonTasks(1)).toHaveLength(2)
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM person_acceptance_attempts').get()!.n).toBe(1)
  await pump(()=>expect(f.get(task.id).status).toBe('completed'))
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it('does not dispatch verification after an explicit stop between development and acceptance',async()=>{
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const current=f.get(task.id)
  await f.tasks.applyPersonTask(1,{action:'stop',task_id:task.id,execution_id:execution.id,expected_revision:current.revision,expected_execution_id:execution.id,idempotency_key:randomUUID()})
  for(let i=0;i<3;i++)await f.runner.tickPersonWork()
  expect(rootReceipt(task.id).state).toBe('interrupted')
  expect(f.execute).toHaveBeenCalledTimes(1);expect(f.store.listPersonTasks(1)).toHaveLength(1)
})

it('does not let an automatic background callback cancel the workflow instead of waiting for its host transition',async()=>{
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  const tools=f.personTaskTools(1,task.session_id)
  const query:any=await tools.find(tool=>tool.name==='bot_tasks_query')!.execute({task_id:task.id})
  expect(query.task.allowed_actions).not.toContain('verify')
  const result=await tools.find(tool=>tool.name==='bot_task_control')!.execute({action:'stop',task_ref:query.task.task_ref},
    {sessionId:task.session_id,runId:'unexpected-background-turn',messages:[],returnExecutionId:execution.id})
  expect(result).toMatchObject({ok:false})
  expect(rootReceipt(task.id).state).toBe('awaiting_dispatch')
})

it('keeps cross-Bot acceptance visible and prevents clearing its owner while the linked verifier is pending or stopping',async()=>{
  const {advanceAutomaticAcceptances}=await import('../../packages/server/src/modules/studio/services/person/automatic-acceptance')
  const {personHasPendingWork,clearPersonHistory}=await import('../../packages/server/src/modules/studio/repositories/person-history-store')
  const {personBackgroundTaskCount}=await import('../../packages/server/src/modules/studio/repositories/person-presence-store')
  const reviewer_session_id=await reviewer()
  const {task,execution}=await f.create({acceptance:{...acceptance,reviewer_session_id}});await f.run(task.id)
  await advanceAutomaticAcceptances()
  expect(personBackgroundTaskCount(1,task.session_id)).toBe(1)
  expect(personHasPendingWork(1,task.session_id)).toBe(true)
  expect(()=>clearPersonHistory(1,task.session_id,0)).toThrow(/Wait for Person tasks/)
  await f.tasks.applyPersonTask(1,{action:'stop',task_id:task.id,execution_id:execution.id,expected_revision:f.get(task.id).revision,idempotency_key:randomUUID()})
  expect(personHasPendingWork(1,task.session_id)).toBe(true)
  await pump(()=>expect(personHasPendingWork(1,task.session_id)).toBe(false))
})

it.each([false,true])('retries a missing decision boundedly and exposes a blocker; callback error=%s',async failed=>{
  const {finishPersonDelivery}=await import('../../packages/server/src/modules/studio/services/person/delivery')
  vi.mocked(f.runtime.deliver).mockImplementation(async result=>finishPersonDelivery(1,result.executionId,!failed,failed?'Bot provider failed':'',result.origin.acceptanceReturnId))
  const {task}=await f.create({acceptance})
  let reopened=false
  await vi.waitFor(async()=>{
    // Advance only the fixture cooldown; the shared acceptance deadline is unchanged.
    f.db.prepare("UPDATE person_deliveries SET updated_at=0 WHERE state='pending' AND error!=''").run()
    await f.runner.tickPersonWork()
    const attempt=f.detail.personAcceptanceDetail(1,task.id)?.attempts[0]
    if(failed && attempt?.decision_attempts===1 && !reopened) {await f.reopen();reopened=true}
    expect(rootReceipt(task.id).state).toBe('blocked')
  },{timeout:6000,interval:15})
  expect(rootReceipt(task.id).reason).toContain('3 Bot turns')
  expect(f.detail.personAcceptanceDetail(1,task.id)!.attempts[0].decision_attempts).toBe(3)
  expect(f.execute).toHaveBeenCalledTimes(2);expect(f.get(task.id).status).toBe('open')
})

it('respects a stop while independent verification is running and never launches repair',async()=>{
  f.worker('42','42',input=>new Promise(resolve=>{
    input.signal.addEventListener('abort',()=>resolve({ok:false,output:'',error:'Stopped'}),{once:true})
  }))
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  await f.runner.tickPersonWork()
  const verification=f.store.listPersonTasks(1).find(row=>row.id!==task.id)!
  await vi.waitFor(()=>expect(f.get(verification.id).execution_state).toBe('running'))
  await f.tasks.applyPersonTask(1,{action:'stop',task_id:task.id,execution_id:execution.id,expected_revision:f.get(task.id).revision,idempotency_key:randomUUID()})
  await pump(()=>expect(f.get(verification.id).execution_state).toBe('interrupted'))
  expect(rootReceipt(task.id).state).toBe('interrupted')
  expect(f.execute).toHaveBeenCalledTimes(2)
})

it('blocks an unavailable reviewer and notifies the developer instead of forgetting the dispatch',async()=>{
  await decideReports()
  const reviewer_session_id=await reviewer()
  const {task}=await f.create({acceptance:{...acceptance,reviewer_session_id}});await f.run(task.id)
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(reviewer_session_id)
  await f.runner.tickPersonWork()
  expect(rootReceipt(task.id)).toMatchObject({state:'blocked',reason:expect.stringContaining('Automatic acceptance could not advance')})
  expect(f.store.listPersonTasks(1)).toHaveLength(1);expect(f.execute).toHaveBeenCalledTimes(1)
  expect(vi.mocked(f.runtime.deliver).mock.calls.at(-1)![0].acceptance?.next_action).toBe('blocked')
})

it('expires a saved transition without resetting the deadline or starting more work',async()=>{
  await decideReports()
  const {task,execution}=await f.create({acceptance});await f.run(task.id)
  f.db.prepare('UPDATE person_acceptance SET deadline=? WHERE execution_id=?').run(Date.now()-1,execution.id)
  await f.runner.tickPersonWork()
  expect(rootReceipt(task.id).state).toBe('blocked')
  expect(f.execute).toHaveBeenCalledTimes(1);expect(f.get(task.id).status).toBe('open')
  expect(vi.mocked(f.runtime.deliver).mock.calls.at(-1)![0].acceptance?.next_action).toBe('blocked')
})
