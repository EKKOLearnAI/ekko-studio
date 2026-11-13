import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { acceptanceFixture, acceptance, type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture
beforeEach(async () => { f = await acceptanceFixture() })
afterEach(async context => { await f.close(context.task.name) })
const origin = { sessionId:'person-main-1',runId:'user-turn',messages:[] }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve=r }); return { promise,resolve } }
function active(id: string) {
  f.db.prepare("UPDATE person_executions SET state='running',lease_until=? WHERE id=?").run(Date.now()+90000,id)
  return f.store.getPersonExecution(1,id)
}
async function redirect(taskId: string,goal = 'Investigate only. Do not modify the product.',extra = {}) {
  const { redirectPersonTask } = await import('../../packages/server/src/modules/studio/services/person/task-redirection')
  const task = f.get(taskId)
  return redirectPersonTask(1,taskId,{ goal,expected_revision:task.revision,expected_execution_id:task.execution_id,idempotency_key:randomUUID(),...extra },[{type:'text',text:goal}],origin)
}
async function append(taskId: string,text = 'Keep this direction and add evidence') {
  const task = f.get(taskId)
  return f.chat.continuePersonTask(1,taskId,{expected_revision:task.revision,expected_execution_id:task.execution_id,idempotency_key:randomUUID(),input:[{type:'text',text}]},origin)
}
async function advance() { (await import('../../packages/server/src/modules/studio/services/person/task-redirection')).advancePersonRedirects() }
async function stopOld(id: string) { await f.tasks.acknowledgePersonStop(f.store.getPersonExecution(1,id)); await advance() }

it('keeps same-direction Bot additions queued in the same conversation without stopping work',async () => {
  const { task,execution } = await f.create(); active(execution.id)
  const tools = f.personTaskTools(1,task.session_id)
  const query:any = await tools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:task.id})
  expect(query.task.allowed_actions).toEqual(['continue','stop','redirect'])
  const result:any = await tools.find(t=>t.name==='bot_task_control')!.execute({task_ref:query.task.task_ref,action:'continue',message:'Add a footer to the same result'},origin)
  expect(result).toMatchObject({ok:true,execution:{state:'pending'}})
  expect(f.store.getPersonExecution(1,result.execution.id).session_id).toBe(execution.session_id)
  expect(f.runtime.stop).not.toHaveBeenCalled()
})

it('routes a Bot correction through the new action and deduplicates identical tool retries',async () => {
  const {task}=await f.create()
  const tools=f.personTaskTools(1,task.session_id)
  const query:any=await tools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:task.id})
  const control=tools.find(t=>t.name==='bot_task_control')!
  const args={task_ref:query.task.task_ref,action:'redirect',goal:'Investigate only, preserving original evidence requirements'}
  const [a,b]:any[]=await Promise.all([control.execute(args,origin),control.execute(args,origin)])
  expect(a).toMatchObject({ok:true,execution:{state:'queued'}})
  expect(b).toMatchObject({ok:true,replayed:true,execution:{id:a.execution.id}})
  expect(f.store.taskPersonExecutions(1,task.id)).toHaveLength(2)
  expect(JSON.parse(f.get(task.id).requirements_json).goal).toBe(args.goal)
})

it('invalidates the old queue, preserves the correction and waits for confirmed native stop',async () => {
  const { task,execution } = await f.create(); const old = active(execution.id)
  const obsolete = await append(task.id,'Old direction addition')
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  try {
    const result=await redirect(task.id)
    expect(result.execution.state).toBe('pending')
    expect(result.execution.session_id).toBe(old.session_id)
    expect(result.execution.selection_json).toBe(old.selection_json)
    expect(result.execution.workspace).toBe(old.workspace)
    expect(f.store.getPersonExecution(1,old.id).state).toBe('stopping')
    expect(f.store.getPersonExecution(1,obsolete.execution.id).state).toBe('interrupted')
    await f.runner.tickPersonWork()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.getPersonExecution(1,result.execution.id).state).toBe('pending')
    expect(f.store.setPersonExecution(old,'finished',{output:'late old success'})).toBe(false)
    barrier.resolve(); await stopOld(old.id)
    await f.run(task.id)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0][0].sessionId).toBe(old.session_id)
    expect(f.execute.mock.calls[0][0].prompt).toEqual(expect.arrayContaining([expect.objectContaining({text:expect.stringContaining('Do not modify the product')})]))
    expect(f.store.getPersonExecution(1,obsolete.execution.id).state).toBe('interrupted')
  } finally { barrier.resolve() }
})

it('coalesces sequential corrections while a stop is in flight and only starts the latest',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  try {
    const a=await redirect(task.id,'Direction A')
    const b=await redirect(task.id,'Direction B')
    expect(a.execution.session_id).toBe(execution.session_id)
    expect(b.execution.session_id).toBe(execution.session_id)
    expect(f.store.getPersonExecution(1,a.execution.id).state).toBe('interrupted')
    expect(f.store.getPersonExecution(1,b.execution.id).state).toBe('pending')
    expect(JSON.parse(f.get(task.id).requirements_json).goal).toBe('Direction B')
    expect(f.get(task.id).redirect_state).toBe('waiting')
    barrier.resolve(); await stopOld(execution.id); await f.run(task.id)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0][0].sessionId).toBe(b.execution.session_id)
  } finally { barrier.resolve() }
})

it('preserves the original chat rows and native identity and sends the authoritative latest brief there',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const sessions=await import('../../packages/server/src/modules/studio/repositories/session-store')
  sessions.updateSession(execution.session_id,{agent_native_session_id:'original-native-conversation'})
  sessions.addMessage({session_id:execution.session_id,role:'user',content:'查厦门天气'})
  sessions.addMessage({session_id:execution.session_id,role:'assistant',content:'正在查厦门，还没有完成'})
  const history=sessions.getSessionContextMessages(execution.session_id)
  const question=f.store.addPersonInteraction(1,execution,'question-old','Should we keep the mistaken old target?',[],'question')
  f.store.answerPersonInteraction(1,question.id,question.revision,'Obsolete answered requirement','user')
  const before=Number(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'person-task-%'").get()!.n)
  const {redirectPersonTask}=await import('../../packages/server/src/modules/studio/services/person/task-redirection')
  const observed=f.get(task.id),input=[{type:'text' as const,text:'哦不，查贵阳的吧'}]
  const next=await redirectPersonTask(1,task.id,{goal:'查询贵阳天气并注明来源，不编造数据',expected_revision:observed.revision,expected_execution_id:observed.execution_id,idempotency_key:randomUUID()},input,origin)
  await stopOld(execution.id);await f.run(task.id)
  const call=f.execute.mock.calls[0][0]
  expect(call.sessionId).toBe(execution.session_id)
  expect(call.displayInput).toEqual(input)
  expect(call.prompt).toEqual(expect.arrayContaining([expect.objectContaining({text:expect.stringContaining('查询贵阳天气并注明来源，不编造数据')})]))
  expect(JSON.stringify(call.prompt)).not.toContain('Obsolete answered requirement')
  expect(sessions.getSessionContextMessages(execution.session_id)).toEqual(history)
  expect(sessions.getSession(execution.session_id)?.agent_native_session_id).toBe('original-native-conversation')
  expect(Number(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'person-task-%'").get()!.n)).toBe(before)
  const currentChat=await f.chat.personTaskChat(1,task.id,execution.id)
  expect(currentChat.session?.id).toBe(execution.session_id)
  expect(currentChat.execution?.id).toBe(execution.id)
  expect(currentChat.task.execution_id).toBe(next.execution.id)
  expect(currentChat.executions).toHaveLength(1)
})

it('waits for the old runner to unwind before reusing its session and ignores a late old stop',async () => {
  const {task,execution}=await f.create()
  const entered=deferred(),worker=deferred(),stop=deferred()
  f.execute.mockImplementationOnce(async input=>{input.onEvent('run.started',{run_id:'old-native-run'});entered.resolve();await worker.promise;return {ok:false,interrupted:true}})
  vi.mocked(f.runtime.stop).mockImplementation(()=>stop.promise)
  try {
    await f.runner.tickPersonWork();await entered.promise
    const next=await redirect(task.id,'Latest request on original conversation')
    stop.resolve();await stopOld(execution.id)
    await f.runner.tickPersonWork()
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('queued')
    worker.resolve()
    await vi.waitFor(async()=>{await f.runner.tickPersonWork();expect(f.execute).toHaveBeenCalledTimes(2)})
    expect(f.execute.mock.calls.map(([call])=>call.sessionId)).toEqual([execution.session_id,execution.session_id])
    const calls=vi.mocked(f.runtime.stop).mock.calls.length
    await f.tasks.acknowledgePersonStop(f.store.getPersonExecution(1,execution.id))
    expect(f.runtime.stop).toHaveBeenCalledTimes(calls)
    await f.settle(task.id)
  } finally {worker.resolve();stop.resolve()}
})

it('creates only the first conversation when correcting a task that has never started',async () => {
  const created=await f.tasks.applyPersonTask(1,{action:'create',session_id:'person-main-1',title:'Not started',goal:'Original goal',start:false,idempotency_key:randomUUID()})
  const next=await redirect(created.task.id)
  expect(next.execution.state).toBe('queued')
  expect(f.runtime.stop).not.toHaveBeenCalled()
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'person-task-%'").get()!.n).toBe(1)
  const second=await redirect(created.task.id,'Latest correction before first execution')
  expect(second.execution.session_id).toBe(next.execution.session_id)
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'person-task-%'").get()!.n).toBe(1)
})

it.each(['waiting','completed'])('does not launch an empty split conversation persisted by the old implementation (%s)',async phase => {
  const {task}=await f.create()
  const next=await redirect(task.id,'Keep the saved latest request')
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({id:'person-task-legacy-empty',user_id:1,studio_user_id:1,title:'Legacy empty branch',workspace:f.workspace,profile:'default',source:'builtin_agent',agent:'ekko-agent',agent_mode:'scoped'})
  f.db.prepare('UPDATE person_executions SET session_id=?,state=? WHERE id=?').run('person-task-legacy-empty',phase==='waiting'?'pending':'queued',next.execution.id)
  f.db.prepare('UPDATE person_task_redirects SET state=? WHERE task_id=?').run(phase,task.id)
  await f.runner.tickPersonWork()
  if(phase==='waiting') {
    expect(f.get(task.id).redirect_error).toContain('separate empty conversation')
    expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('pending')
  } else {
    await vi.waitFor(()=>expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('failed'))
    expect(f.store.getPersonExecution(1,next.execution.id).error).toContain('separate empty conversation')
  }
  expect(f.execute).not.toHaveBeenCalled()
  expect(JSON.parse(f.get(task.id).requirements_json).goal).toBe('Keep the saved latest request')
})

it('rejects a racing stale correction and replays an accepted request without replacing the newer direction',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  const observed=f.get(task.id), key=randomUUID()
  const args={goal:'A',expected_revision:observed.revision,expected_execution_id:observed.execution_id,idempotency_key:key}
  const {redirectPersonTask}=await import('../../packages/server/src/modules/studio/services/person/task-redirection')
  const input=[{type:'text' as const,text:'A'}]
  try {
    const results=await Promise.allSettled([redirectPersonTask(1,task.id,args,input,origin),redirectPersonTask(1,task.id,{...args,goal:'stale B',idempotency_key:randomUUID()},input,origin)])
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(r=>r.status==='rejected')).toHaveLength(1)
    const newest=await redirect(task.id,'C')
    const replay=await redirectPersonTask(1,task.id,args,input,origin)
    expect(replay.execution.state).toBe('interrupted')
    expect(f.get(task.id).execution_id).toBe(newest.execution.id)
    expect(JSON.parse(f.get(task.id).requirements_json).goal).toBe('C')
  } finally {barrier.resolve(); await stopOld(execution.id)}
})

it('keeps same-direction additions after a pending correction and releases them in order',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  try {
    const replacement=await redirect(task.id)
    const addition=await append(task.id)
    expect(addition.execution.session_id).toBe(replacement.execution.session_id)
    f.store.promotePersonFollowups()
    expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('pending')
    barrier.resolve(); await stopOld(execution.id); await f.runner.tickPersonWork()
    await vi.waitFor(()=>expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('finished'))
    await f.runner.tickPersonWork()
    await vi.waitFor(()=>expect(f.store.getPersonExecution(1,addition.execution.id).state).toBe('finished'))
    expect(f.execute.mock.calls.map(([i])=>i.sessionId)).toEqual([replacement.execution.session_id,addition.execution.session_id])
    expect(f.store.getPersonExecution(1,addition.execution.id).state).toBe('finished')
  } finally {barrier.resolve()}
})

it('invalidates finished but undelivered results from every prior direction without invalidating same-direction results',async () => {
  const {task,execution}=await f.create()
  f.store.setPersonExecution(execution,'finished',{output:'old result'})
  const delivery=await import('../../packages/server/src/modules/studio/services/person/delivery')
  delivery.readyPersonDelivery(f.store.getPersonExecution(1,execution.id))
  const addition=await append(task.id)
  expect(delivery.personDeliveryCurrent(1,execution.id)).toBe(true)
  await redirect(task.id)
  expect(delivery.personDeliveryCurrent(1,execution.id)).toBe(false)
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(addition.execution.id)!.state).toBe('cancelled')
  await expect(f.chat.continuePersonTask(1,task.id,{expected_revision:f.get(task.id).revision,idempotency_key:randomUUID(),input:[{type:'text',text:'late callback'}]}, {...origin,returnExecutionId:execution.id})).rejects.toThrow(/callback/)
})

it('waits for a linked verifier to acknowledge stop even when the developer already finished',async () => {
  const {task,execution}=await f.create({acceptance})
  f.db.prepare("UPDATE person_executions SET state='finished' WHERE id=?").run(execution.id)
  f.db.prepare("UPDATE person_acceptance SET state='awaiting_dispatch',deadline=? WHERE execution_id=?").run(Date.now()+120000,execution.id)
  const review=await f.verify(task.id); active(review.execution.id)
  await expect(redirect(review.task.id)).rejects.toThrow(/development task/)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  try {
    const next=await redirect(task.id,'Write an improved result and retain independent acceptance')
    await f.runner.tickPersonWork()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.store.getPersonExecution(1,review.execution.id).state).toBe('stopping')
    expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(review.execution.id)!.state).toBe('cancelled')
    expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('pending')
    barrier.resolve(); await stopOld(review.execution.id)
    expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('queued')
    expect(f.detail.getPersonAcceptance(next.execution.id)).toMatchObject({state:'pending',attempt:0})
  } finally {barrier.resolve()}
})

it('retains a failed stop and retries without launching the correction',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  vi.mocked(f.runtime.stop).mockRejectedValueOnce(new Error('Native exit not confirmed'))
  const next=await redirect(task.id)
  await vi.waitFor(()=>expect(f.get(task.id).redirect_error).toContain('Native exit not confirmed'))
  expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('pending')
  expect(f.execute).not.toHaveBeenCalled()
  await stopOld(execution.id)
  expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('queued')
})

it('cancels an explicitly stopped correction without resurrecting it when the old stop finishes',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  try {
    const replacement=await redirect(task.id)
    const current=f.get(task.id)
    await f.tasks.applyPersonTask(1,{action:'stop',task_id:task.id,execution_id:current.execution_id,expected_execution_id:current.execution_id,expected_revision:current.revision,idempotency_key:randomUUID()})
    expect(f.get(task.id).redirect_state).toBe('cancelling')
    await expect(append(task.id)).rejects.toThrow(/stopping/)
    barrier.resolve(); await stopOld(execution.id)
    expect(f.get(task.id).redirect_state).toBe('cancelled')
    expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('interrupted')
    await f.runner.tickPersonWork(); expect(f.execute).not.toHaveBeenCalled()
  } finally {barrier.resolve()}
})

it('rejects correction removal and insertion while native stopping is unconfirmed',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  try {
    const next=await redirect(task.id)
    const queue=await import('../../packages/server/src/modules/studio/services/person/task-queue')
    const current=f.get(task.id),body={queue_id:next.execution.id,expected_revision:current.revision,expected_execution_id:current.execution_id,idempotency_key:randomUUID()}
    expect(queue.personTaskQueue(1,task.id,next.execution.session_id).canInsert).toBe(false)
    expect(()=>queue.removePersonTaskMessage(1,task.id,body)).toThrow(/Stop task/)
  } finally {barrier.resolve();await stopOld(execution.id)}
})

it('recovers the saved correction after reopening SQLite and does not release it twice',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const barrier=deferred(); vi.mocked(f.runtime.stop).mockImplementation(()=>barrier.promise)
  const next=await redirect(task.id)
  barrier.resolve();await stopOld(execution.id)
  // Rewind the persisted outbox to the post-stop/pre-release crash boundary.
  f.db.prepare("UPDATE person_task_redirects SET state='waiting' WHERE task_id=?").run(task.id)
  f.db.prepare("UPDATE person_executions SET state='pending' WHERE id=?").run(next.execution.id)
  await f.reopen()
  await advance();await advance()
  expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('queued')
  expect(f.store.taskPersonExecutions(1,task.id)).toHaveLength(2)
})

it('does not let background returns, another role or a stale task reference redirect work',async () => {
  const {task,execution}=await f.create()
  const {redirectPersonTask}=await import('../../packages/server/src/modules/studio/services/person/task-redirection')
  const body={goal:'wrong',expected_revision:task.revision,expected_execution_id:execution.id,idempotency_key:randomUUID()}
  await expect(redirectPersonTask(1,task.id,body,[{type:'text',text:'wrong'}],{...origin,returnExecutionId:execution.id})).rejects.toThrow(/new user instruction/)
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({id:'person-main-other',user_id:1,studio_user_id:1,title:'Other role',workspace:f.workspace,source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',profile:'default'})
  await expect(redirectPersonTask(1,task.id,body,[{type:'text',text:'wrong'}],{...origin,sessionId:'person-main-other'})).rejects.toThrow(/current role/)
  const tools=f.personTaskTools(1,task.session_id),query:any=await tools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:task.id})
  await append(task.id)
  expect(await tools.find(t=>t.name==='bot_task_control')!.execute({task_ref:query.task.task_ref,action:'redirect',goal:'wrong'},origin)).toMatchObject({ok:false,error:{code:'STALE_TASK'}})
})

it('ignores a late insertion acknowledgement without cancelling the saved direction correction',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  f.store.personEvent(f.store.getPersonExecution(1,execution.id),'run.started',{run_id:'native-old'})
  const oldInput=await append(task.id,'Old plan')
  const stop=deferred(),insertion=deferred()
  vi.mocked(f.runtime.stop).mockImplementation(()=>stop.promise)
  f.runtime.interruptForInsertion=vi.fn(async()=>{await insertion.promise;return {status:'accepted',phase:'model'}})
  const queue=await import('../../packages/server/src/modules/studio/services/person/task-queue')
  const t=f.get(task.id)
  const inFlight=queue.insertPersonTaskMessage(1,task.id,{queue_id:oldInput.execution.id,expected_execution_id:execution.id,expected_revision:t.revision,idempotency_key:randomUUID()})
  const result=inFlight.then(()=>null,error=>error.message)
  try {
    await vi.waitFor(()=>expect(f.runtime.interruptForInsertion).toHaveBeenCalled())
    const replacement=await redirect(task.id)
    insertion.resolve();expect(await result).toMatch(/Task changed/)
    expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('pending')
    stop.resolve();await stopOld(execution.id)
    expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('queued')
  } finally {insertion.resolve();stop.resolve()}
})

it('does not block or cancel an independent task while waiting for another task to stop',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const independent=await f.create({title:'Independent goal'})
  const stop=deferred();vi.mocked(f.runtime.stop).mockImplementation(()=>stop.promise)
  try {
    const replacement=await redirect(task.id)
    await f.runner.tickPersonWork()
    await vi.waitFor(()=>expect(f.store.getPersonExecution(1,independent.execution.id).state).toBe('finished'))
    expect(f.execute.mock.calls.map(([i])=>i.sessionId)).toEqual([independent.execution.session_id])
    expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('pending')
  } finally {stop.resolve();await stopOld(execution.id)}
})

it('waits for hidden old executions when deleting a conversation with a pending correction',async () => {
  const {task,execution}=await f.create(); active(execution.id)
  const stop=deferred();vi.mocked(f.runtime.stop).mockImplementation(()=>stop.promise)
  try {
    const replacement=await redirect(task.id)
    let completed=false
    const deleting=f.tasks.stopPersonSessionTasks(1,task.session_id).then(()=>{completed=true})
    await vi.waitFor(()=>expect(f.runtime.stop).toHaveBeenCalled())
    expect(completed).toBe(false)
    stop.resolve();await deleting
    expect(f.store.getPersonExecution(1,execution.id).state).toBe('interrupted')
    expect(f.store.getPersonExecution(1,replacement.execution.id).state).toBe('interrupted')
    expect(f.get(task.id).redirect_state).toBe('cancelled')
  } finally {stop.resolve()}
})

it('aborts an already running old result callback and waits for its actual unwind',async () => {
  const {task,execution}=await f.create()
  f.store.setPersonExecution(execution,'finished',{output:'Old result'})
  const delivery=await import('../../packages/server/src/modules/studio/services/person/delivery')
  delivery.readyPersonDelivery(f.store.getPersonExecution(1,execution.id))
  const returned=delivery.registerPersonReturnTurn(1,execution.id)
  try {
    const next=await redirect(task.id)
    expect(returned.signal.aborted).toBe(true)
    await advance();f.store.promotePersonFollowups()
    expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('pending')
    expect(()=>delivery.registerPersonReturnTurn(1,execution.id)).toThrow(/no longer current/)
    returned.release();await advance()
    expect(f.store.getPersonExecution(1,next.execution.id).state).toBe('queued')
  } finally {returned.release()}
})

it('rechecks a callback origin inside the transaction after async capability validation',async () => {
  const {task,execution}=await f.create()
  f.store.setPersonExecution(execution,'finished',{output:'Old result'})
  const delivery=await import('../../packages/server/src/modules/studio/services/person/delivery')
  delivery.readyPersonDelivery(f.store.getPersonExecution(1,execution.id))
  const runtime=await import('../../packages/server/src/modules/studio/public/session-agent-runtime')
  const original=runtime.getSessionAvailableModelGroups
  const wait=deferred()
  const spy=vi.spyOn(runtime,'getSessionAvailableModelGroups').mockImplementationOnce(async(...args)=>{await wait.promise;return original(...args)})
  const pending=f.tasks.applyPersonTask(1,{action:'create',session_id:task.session_id,title:'Stale callback creation',goal:'Old direction',idempotency_key:randomUUID()},undefined,{...origin,returnExecutionId:execution.id})
  const result=pending.then(()=>null,error=>error.message)
  try {
    await vi.waitFor(()=>expect(spy).toHaveBeenCalled())
    await redirect(task.id)
    wait.resolve()
    expect(await result).toMatch(/callback/)
    expect(f.store.listPersonTasks(1)).toHaveLength(1)
  } finally {wait.resolve();spy.mockRestore()}
})

it('keeps a current stage binding and refuses to revive a completed stage',async () => {
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  const {createPersonFlow}=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  createSession({id:'person-main-role',user_id:1,studio_user_id:1,title:'Role',workspace:f.workspace,source:'builtin_agent',agent:'ekko-agent',agent_preset:'person',profile:'default'})
  const flow=createPersonFlow(1,{title:'Flow',goal:'Original scope',session_id:'person-main-1',idempotency_key:randomUUID(),stages:[{session_id:'person-main-role',goal:'Current branch',return_expectation:'Result'}]})
  const stageOrigin={sessionId:'person-main-role',runId:'stage-turn',messages:[],stage:{flowId:flow.id,stageId:flow.stages[0].id,generation:flow.generation}}
  const created=await f.tasks.applyPersonTask(1,{action:'create',session_id:stageOrigin.sessionId,title:'Stage child',goal:'Old branch',idempotency_key:randomUUID()},undefined,stageOrigin)
  const {redirectPersonTask}=await import('../../packages/server/src/modules/studio/services/person/task-redirection')
  const current=f.get(created.task.id)
  const currentTools=f.personTaskTools(1,stageOrigin.sessionId)
  const available:any=await currentTools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:current.id})
  expect(available.task.allowed_actions).toContain('redirect')
  const next=await redirectPersonTask(1,current.id,{goal:'Correct branch',expected_revision:current.revision,expected_execution_id:current.execution_id,idempotency_key:randomUUID()},[{type:'text',text:'Correct branch'}],stageOrigin)
  expect(next.execution.state).toBe('queued')
  f.db.prepare("UPDATE person_stages SET state='completed' WHERE id=?").run(flow.stages[0].id)
  const tools=f.personTaskTools(1,stageOrigin.sessionId)
  const detail:any=await tools.find(t=>t.name==='bot_tasks_query')!.execute({task_id:current.id})
  expect(detail.task.allowed_actions).not.toContain('redirect')
  await expect(redirectPersonTask(1,current.id,{goal:'Do not revive',expected_revision:next.task.revision,expected_execution_id:next.execution.id,idempotency_key:randomUUID()},[{type:'text',text:'Do not revive'}],stageOrigin)).rejects.toThrow(/stage is no longer current/)
})
