import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ModelClient, ModelRequest, ModelResponse } from '../../packages/ekko-agent/src/model/types'
import { acceptanceFixture, type AcceptanceFixture } from './fixtures/person-acceptance'

let f: AcceptanceFixture
let chat: typeof import('../../packages/server/src/modules/studio/services/person/chat-agent')
beforeEach(async () => {
  f = await acceptanceFixture()
  const { createPersonAgent } = await import('../../packages/server/src/bootstrap/person-chat-agent')
  // Keep the real host binding, tools and model loop; memory/compression are unrelated to waiting.
  f.runtime.chatAgent = options => createPersonAgent({...options,memory:undefined,contextTokens:1_000_000,compression:{enabled:false,threshold:1}})
  chat = await import('../../packages/server/src/modules/studio/services/person/chat-agent')
})
afterEach(async context => { await f?.close(context.task.name) })

function call(name: string, args: Record<string,unknown> = {}) {
  return {id:randomUUID(),name,arguments:args}
}
const waitingReply = '已安排执行，结果返回后我会继续汇报。'
function scripted(answer: (step: number, request: ModelRequest) => ModelResponse | Promise<ModelResponse>, reply = waitingReply) {
  let requests = 0
  const finalRequests: ModelRequest[] = []
  const client: ModelClient = {
    provider:'fixture',requestStyle:'custom-runtime',
    capabilities:{streaming:false,tools:true,vision:false,jsonMode:false,systemPrompt:true,maxInputTokens:1_000_000},
    create: request => {
      requests++
      if (request.toolChoice === 'none') {
        finalRequests.push(request)
        return Promise.resolve({ content: reply, finishReason: 'stop' })
      }
      return Promise.resolve(answer(requests,request))
    },
    async *stream() { throw new Error('Unexpected streaming request') },
  }
  return {client,requests:()=>requests,finalRequests}
}
async function run(model: ReturnType<typeof scripted>, returned?: string, sessionId = 'person-main-1', stageDeliveryId?: string) {
  const agent = await chat.createPersonChatAgent(1,sessionId,returned ? {executionId:returned} : undefined,stageDeliveryId)
  return agent.run({messages:[{role:'user',content:'Complete the assigned research and report back.'}],modelClient:model.client,
    signal:new AbortController().signal,toolContext:{sessionId}})
}

it.each([false,true])('bounds alternating unchanged task/event reads, repeated event=%s', async repeat => {
  const {task,execution} = await f.create()
  if (repeat) f.store.personEvent(execution,'run.started',{run_id:'persisted-run'})
  const model = scripted(step => ({content:'',toolCalls:[step % 2
    ? call('bot_tasks_query',{task_id:task.id})
    : call('bot_execution_events',{execution_id:execution.id,after:0})]}))
  const result = await run(model)
  expect(result.output.finishReason).toBe('waiting_for_tasks')
  expect(result.output.content).toBe(waitingReply)
  expect(model.requests()).toBeLessThanOrEqual(7)
  expect(model.finalRequests).toHaveLength(1)
  expect(model.finalRequests[0].tools).toEqual([])
  expect(result.events.some(event => event.type === 'run.max_steps')).toBe(false)
  expect(result.steps.filter(step => step.type === 'tool').every(step => step.result.ok)).toBe(true)
  expect(f.get(task.id)).toMatchObject({status:'open',execution_state:'queued'})
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)!.state).toBe('waiting')
})

it('dispatches independent tasks across steps before explicit waiting', async () => {
  const reply = '两个主题都已分别安排研究，结果返回后我会汇总给你。'
  const model = scripted(step => ({content:'',toolCalls:[step < 3
    ? call('bot_task_create',{title:`Independent ${step}`,goal:`Research topic ${step}`,agent_id:'reviewer'})
    : call('bot_tasks_wait')]}),reply)
  const result = await run(model)
  expect(result.output.finishReason).toBe('waiting_for_tasks')
  expect(model.requests()).toBe(4)
  expect(result.output.content).toBe(reply)
  expect(model.finalRequests).toHaveLength(1)
  expect(model.finalRequests[0].messages.filter(message => message.role === 'tool' && message.name === 'bot_task_create')).toHaveLength(2)
  expect(f.store.listPersonTasks(1)).toHaveLength(2)
  expect(f.store.listPersonTasks(1).every(task => task.status === 'open')).toBe(true)
})

it('settles every call in the current batch, including work after a wait call', async () => {
  const model = scripted(() => ({content:'',toolCalls:[
    call('bot_task_create',{title:'First task',goal:'First independent goal'}),
    call('bot_tasks_wait'),
    call('bot_task_create',{title:'Second task',goal:'Second independent goal'}),
  ]}))
  const result = await run(model)
  expect(model.requests()).toBe(2)
  expect(result.output.finishReason).toBe('waiting_for_tasks')
  expect(result.output.content).toBe(waitingReply)
  expect(result.steps.filter(step => step.type === 'tool')).toHaveLength(3)
  expect(f.store.listPersonTasks(1)).toHaveLength(2)
})

it('keeps reading genuinely new execution evidence without a false wait', async () => {
  const {execution} = await f.create()
  const model = scripted(step => {
    if (step === 8) return {content:'New progress has been inspected.',finishReason:'stop'}
    f.store.personEvent(execution,'tool.completed',{sequence:step})
    return {content:'',toolCalls:[call('bot_execution_events',{execution_id:execution.id,after:0})]}
  })
  const result = await run(model)
  expect(result.output.finishReason).toBe('stop')
  expect(model.requests()).toBe(8)
})

it('does not invent a wait when no callback can wake the Bot', async () => {
  const {task,execution} = await f.create()
  f.db.prepare("UPDATE person_deliveries SET state='cancelled' WHERE execution_id=?").run(execution.id)
  const model = scripted(step => step < 6 ? {content:'',toolCalls:[step === 1 ? call('bot_tasks_wait') : call('bot_tasks_query',{task_id:task.id})]}
    : {content:'There is no pending result callback.',finishReason:'stop'})
  expect((await run(model)).output.finishReason).toBe('stop')
  expect(model.requests()).toBe(6)
})

it('scopes waiting to the current Bot and does not treat a denied query as progress', async () => {
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  sessions.createSession({id:'person-main-other',studio_user_id:1,source:'builtin_agent',workspace:f.workspace})
  await f.create({session_id:'person-main-other'})
  const model = scripted(step => step < 6 ? {content:'',toolCalls:[step === 1 ? call('bot_tasks_wait') : call('bot_tasks_query',{task_id:'missing-task'})]}
    : {content:'The requested task is unavailable.',finishReason:'stop'})
  expect((await run(model)).output.finishReason).toBe('stop')
  expect(model.requests()).toBe(6)
})

it('sends a waiting reply while keeping the collaboration stage active without a completion confirmation', async () => {
  const sessions = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const flows = await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  const stages = await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  const confirmations = await import('../../packages/server/src/modules/studio/repositories/person-stage-confirmations')
  const {confirmPersonStage} = await import('../../packages/server/src/modules/studio/services/person/stage-confirmation')
  sessions.createSession({id:'person-main-creator',studio_user_id:1,source:'builtin_agent',workspace:f.workspace})
  const flow = flows.createPersonFlow(1,{title:'Research stage',goal:'Read and report',session_id:'person-main-creator',idempotency_key:randomUUID(),
    stages:[{session_id:'person-main-1',goal:'Research without edits',return_expectation:'Verified findings'}]})
  const context = {flowId:flow.id,stageId:flow.stages[0].id,generation:flow.generation}
  const child = await f.tasks.applyPersonTask(1,{action:'create',title:'Stage worker',goal:'Read-only research',idempotency_key:randomUUID()},
    undefined,{sessionId:'person-main-1',runId:'dispatch',messages:[],stage:context})
  const deliveryId = String(f.db.prepare('SELECT id FROM person_stage_deliveries WHERE stage_id=?').get(context.stageId)!.id)
  const model = scripted(() => ({content:'',toolCalls:[call('bot_tasks_wait')]}))
  const agent = await chat.createPersonChatAgent(1,'person-main-1',undefined,deliveryId)
  const result = await agent.run({messages:['Continue the assigned stage'],modelClient:model.client,signal:new AbortController().signal,
    toolContext:{sessionId:'person-main-1'},onEvent:event => {
      if (event.type === 'run.started') confirmations.startPersonStageRun(1,context,event.runId)
      if (event.type === 'run.completed' && event.output.finishReason === 'waiting_for_tasks') flows.waitPersonStageTurn(1,context,event.runId)
    }})
  expect(result.output.finishReason).toBe('waiting_for_tasks')
  expect(result.output.content).toBe(waitingReply)
  expect(model.finalRequests).toHaveLength(1)
  await confirmPersonStage(1,context)
  expect(confirmations.stageConfirmation(context)).toMatchObject({state:'waiting',attempts:0,message_id:null})
  expect(stages.getPersonFlow(1,flow.id)).toMatchObject({state:'active',stages:[{state:'active',result_message_id:null}]})
  expect(f.get(child.task.id)).toMatchObject({status:'open',execution_state:'queued'})
  expect(f.runtime.model).not.toHaveBeenCalled()
})

it.each(['finished','failed','interrupted'] as const)('yields to a queued %s callback, then consumes it once in a fresh model turn', async terminal => {
  const {task,execution} = await f.create()
  const {ChatRunSocket} = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const server: any = Object.create(ChatRunSocket.prototype)
  const state: any = {isWorking:true,queue:[],events:[]}
  server.sessionMap = new Map([['person-main-1',state]])
  server.nsp = {adapter:{rooms:new Map()},sockets:new Map(),to:()=>({emit:vi.fn()})}
  let callbackResult: Awaited<ReturnType<typeof run>> | undefined
  let finish!: () => void
  const callbackDone = new Promise<void>(resolve => {finish=resolve})
  server.executeRun = vi.fn(async (_socket: any, data: any) => {
    try {
      const model = scripted(step => step === 1 ? {content:'',toolCalls:[call('bot_tasks_wait')]}
        : step === 2 ? {content:'',toolCalls:[call('bot_tasks_query',{task_id:task.id})]}
        : {content:`Reported ${terminal} task result.`,finishReason:'stop'})
      callbackResult = await run(model,execution.id)
      expect(model.requests()).toBe(3)
      const {reply,receipt} = await f.reportDelivery(execution.id,callbackResult.output.content,callbackResult.runId)
      expect(receipt).toMatchObject({executionId:execution.id,state:terminal})
      data.onEvent('run.completed',{run_id:callbackResult.runId,message_id:reply?.messageId,output:callbackResult.output.content,person_task_return:receipt})
      server.markExternalRunCompleted('person-main-1','run.completed')
    } finally { finish() }
  })
  vi.mocked(f.runtime.deliver).mockImplementation(result => server.deliverPersonResult(result))
  const delivery = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const model = scripted(async step => {
    if (step === 1) {
      if (terminal === 'interrupted') {
        const current = f.get(task.id)
        await f.tasks.applyPersonTask(1,{action:'stop',task_id:task.id,execution_id:execution.id,
          expected_revision:current.revision,idempotency_key:randomUUID()})
      } else {
        if (terminal === 'failed') f.execute.mockResolvedValue({ok:false,error:'Read-only worker failed'})
        await f.run(task.id)
      }
      await delivery.deliverPersonResults()
      expect(state.queue).toHaveLength(1)
      expect(server.executeRun).not.toHaveBeenCalled()
    }
    return {content:'',toolCalls:[call('bot_tasks_query',{task_id:task.id})]}
  })
  const result = await run(model)
  expect(result.output.finishReason).toBe('waiting_for_tasks')
  expect(model.requests()).toBe(2)
  expect(result.output.content).toBe(waitingReply)
  server.markExternalRunCompleted('person-main-1','run.completed')
  await callbackDone
  expect(callbackResult?.output.finishReason).toBe('stop')
  expect(server.executeRun).toHaveBeenCalledTimes(1)
  expect(state.queue).toHaveLength(0)
  expect(state.isWorking).toBe(false)
  expect(f.db.prepare('SELECT state FROM person_deliveries WHERE execution_id=?').get(execution.id)!.state).toBe('delivered')
  await delivery.deliverPersonResults()
  expect(f.runtime.deliver).toHaveBeenCalledTimes(1)
})

async function resultSocket(execute?: (data: any) => Promise<void>) {
  const {ChatRunSocket} = await import('../../packages/server/src/modules/studio/sockets/chat-run')
  const server: any = Object.create(ChatRunSocket.prototype)
  const state = {isWorking:false,queue:[],events:[],messages:[]}
  server.sessionMap = new Map([['person-main-1',state]])
  server.nsp = {adapter:{rooms:new Map()},sockets:new Map(),to:()=>({emit:vi.fn()})}
  if (execute) server.executeRun = vi.fn(async (_socket, data) => {
    await execute(data)
    server.markExternalRunCompleted('person-main-1','run.completed')
  })
  vi.mocked(f.runtime.deliver).mockImplementation(result => server.deliverPersonResult(result))
  return {server,state}
}

function deliveryState(executionId: string) {
  return f.db.prepare('SELECT state,wait_for_json,claim_id,error FROM person_deliveries WHERE execution_id=?').get(executionId)!
}

function resultReceipts() {
  return f.db.prepare('SELECT execution_id,assistant_message_id FROM person_task_returns ORDER BY CAST(assistant_message_id AS INTEGER)').all()
}

it('reports A and B once when A yields until B reports, including after reopening SQLite', async () => {
  const a = await f.create({title:'A'})
  await f.run(a.task.id)
  const b = await f.create({title:'B'})
  const {deliverPersonResults} = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const attempts: string[] = []
  let client: ModelClient
  vi.doMock('../../packages/server/src/modules/studio/public/provider-account',async importOriginal=>({
    ...await importOriginal<object>(), withSocketProviderAccount:(operation:unknown)=>operation,
  }))
  vi.doMock('../../packages/server/src/modules/studio/public/chat-agent-runtime',async importOriginal=>({
    ...await importOriginal<object>(),
    resolveChatEkkoProviderRuntimeConfig:async()=>({apiMode:'chat_completions'}),
    resolveChatEkkoModelProviderConfigs:()=>({providerConfig:{provider:'fixture'}}),
    getChatEkkoModelRequestTimeoutMs:()=>1000,
    createChatEkkoAuthorizedProviderFetch:()=>undefined,
    createChatEkkoModelClient:()=>client,
    chatEkkoAgentReasoningText:()=>'',serializeChatEkkoAgentReasoningDetails:()=>null,
  }))
  const {server} = await resultSocket()
  const {handleEkkoAgentRun} = await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
  server.executeRun = vi.fn((socket,data,profile,skip,context)=>{
    const executionId = context.personDelivery.executionId
    attempts.push(executionId)
    client = scripted(step => step === 1
      ? {content:'',toolCalls:[call('bot_tasks_wait')]}
      : {content:executionId === a.execution.id ? 'A final result' : 'B final result',finishReason:'stop'}).client
    return handleEkkoAgentRun(server.nsp,socket,{...data,resolved_mcp_servers:{}},profile,
      server.sessionMap,server.dequeueNextQueuedRun.bind(server),skip,context)
  })
  vi.doUnmock('../../packages/server/src/modules/studio/public/provider-account')
  vi.doUnmock('../../packages/server/src/modules/studio/public/chat-agent-runtime')

  await deliverPersonResults()
  await vi.waitFor(() => expect(deliveryState(a.execution.id)).toMatchObject({state:'pending',error:'',wait_for_json:JSON.stringify([b.execution.id])}))
  expect(resultReceipts()).toEqual([])
  expect(f.get(a.task.id).execution_state).toBe('finished')
  await f.reopen()
  await deliverPersonResults()
  expect(deliveryState(a.execution.id).state).toBe('pending')
  expect(server.executeRun).toHaveBeenCalledTimes(1)

  await f.run(b.task.id)
  await deliverPersonResults()
  await vi.waitFor(() => expect(deliveryState(b.execution.id).state).toBe('delivered'))
  await deliverPersonResults()
  await vi.waitFor(() => expect(deliveryState(a.execution.id).state).toBe('delivered'))
  await deliverPersonResults()
  expect(attempts).toEqual([a.execution.id,b.execution.id,a.execution.id])
  expect(resultReceipts().map(row=>row.execution_id)).toEqual([b.execution.id,a.execution.id])
  const finalReplies = f.db.prepare("SELECT content FROM messages WHERE session_id='person-main-1' AND role='assistant' AND finish_reason='stop' ORDER BY id").all()
  expect(finalReplies).toEqual([{content:'B final result'},{content:'A final result'}])
})

it.each(['interrupted','provider failure','receipt write failure'])('retries %s and ignores duplicate or stale deliveries', async failure => {
  const {task,execution} = await f.create()
  await f.run(task.id)
  const {deliverPersonResults,persistPersonDeliveryReply,retryPersonDelivery} = await import('../../packages/server/src/modules/studio/services/person/delivery')
  const {addMessage} = await import('../../packages/server/src/modules/studio/repositories/session-store')
  const writeAgain = vi.fn(()=>({messageId:addMessage({session_id:'person-main-1',role:'assistant',content:'Duplicate'})}))
  let attempt = 0
  const {server,state} = await resultSocket(async data => {
    const result = vi.mocked(f.runtime.deliver).mock.lastCall![0]
    await server.deliverPersonResult(result)
    expect(state.queue).toHaveLength(0)
    if (++attempt === 1 && failure !== 'receipt write failure') {
      if (failure === 'provider failure') data.onEvent('run.failed',{error:'Provider unavailable'})
      return
    }
    if (attempt === 2) {
      const first = vi.mocked(f.runtime.deliver).mock.calls[0][0]
      const stale = {userId:first.user.id,executionId:execution.id,claimId:first.claimId}
      expect(() => persistPersonDeliveryReply(stale,'person-main-1',writeAgain)).toThrow(/no longer current/)
      expect(writeAgain).not.toHaveBeenCalled()
      retryPersonDelivery(stale,'A late error before the new claim commits')
      expect(deliveryState(execution.id)).toMatchObject({state:'queued',claim_id:result.claimId,error:''})
    }
    await f.reportDelivery(execution.id)
  })

  if (failure === 'receipt write failure') {
    f.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON person_task_returns BEGIN SELECT RAISE(ABORT, 'Receipt write failed'); END")
  }
  await deliverPersonResults()
  await vi.waitFor(() => expect(deliveryState(execution.id)).toMatchObject({state:'pending',error:expect.any(String)}))
  expect(deliveryState(execution.id).error).not.toBe('')
  expect(resultReceipts()).toEqual([])
  expect(f.db.prepare("SELECT content FROM messages WHERE session_id='person-main-1' AND role='assistant'").all()).toEqual([])
  expect(f.get(task.id).execution_state).toBe('finished')

  await deliverPersonResults()
  expect(server.executeRun).toHaveBeenCalledTimes(1)
  if (failure === 'receipt write failure') f.db.exec('DROP TRIGGER reject_receipt')
  f.db.prepare('UPDATE person_deliveries SET updated_at=0 WHERE execution_id=?').run(execution.id)
  const old = vi.mocked(f.runtime.deliver).mock.calls[0][0]
  const oldClaim = {userId:old.user.id,executionId:execution.id,claimId:old.claimId}
  await deliverPersonResults()
  await vi.waitFor(() => expect(deliveryState(execution.id).state).toBe('delivered'))
  expect(deliveryState(execution.id).claim_id).not.toBe(old.claimId)

  expect(() => persistPersonDeliveryReply(oldClaim,'person-main-1',writeAgain)).toThrow(/no longer current/)
  expect(writeAgain).not.toHaveBeenCalled()
  retryPersonDelivery(oldClaim,'A late error')
  await server.deliverPersonResult(old)
  // Reconciliation uses the durable receipt even if a replay puts the result back in the outbox.
  f.db.prepare("UPDATE person_deliveries SET state='pending' WHERE execution_id=?").run(execution.id)
  await deliverPersonResults()
  expect(deliveryState(execution.id)).toMatchObject({state:'delivered',error:''})
  expect(server.executeRun).toHaveBeenCalledTimes(2)
  expect(f.execute).toHaveBeenCalledTimes(1)
  expect(resultReceipts()).toHaveLength(1)
  expect(f.db.prepare("SELECT content FROM messages WHERE session_id='person-main-1' AND role='assistant'").all())
    .toEqual([{content:'Reported the task result.'}])
})

it('recovers a claim lost before the result reply commits when Studio restarts', async () => {
  const {task,execution} = await f.create()
  await f.run(task.id)
  const {deliverPersonResults} = await import('../../packages/server/src/modules/studio/services/person/delivery')
  await deliverPersonResults()
  const first = deliveryState(execution.id)
  expect(first).toMatchObject({state:'queued',claim_id:expect.any(String)})
  expect(resultReceipts()).toEqual([])

  await f.reopen()
  f.runner.startPersonWork()
  expect(deliveryState(execution.id).state).toBe('pending')
  vi.mocked(f.runtime.deliver).mockImplementation(async result=>{ await f.reportDelivery(result.executionId) })
  await deliverPersonResults()
  expect(deliveryState(execution.id).state).toBe('delivered')
  expect(deliveryState(execution.id).claim_id).not.toBe(first.claim_id)
  expect(resultReceipts()).toHaveLength(1)
  expect(f.execute).toHaveBeenCalledTimes(1)
})

it('keeps waiting acknowledgements out of completion notices and App push envelopes',async()=>{
  const {foregroundNotification}=await import('../../packages/server/src/modules/studio/services/chat-run/foreground-notification')
  const {appEventEnvelope}=await import('../../packages/server/src/modules/studio/services/webhooks/app-events')
  const payload={session_id:'person-main-1',run_id:'dispatch',output:waitingReply,stop_reason:'waiting_for_tasks'}
  expect(foregroundNotification('run.completed',payload)).toBeNull()
  const event={schema_version:1 as const,id:'dispatch',type:'person.run.completed',occurred_at:new Date().toISOString(),
    profile:'default',source:'person',subject:{session_id:'person-main-1',run_id:'dispatch'},payload}
  expect(appEventEnvelope(event)).toBeNull()
  const completed={...payload,run_id:'result',output:'已完成核查，结果如下。',stop_reason:'stop'}
  expect(foregroundNotification('run.completed',completed)).toMatchObject({kind:'completion'})
  expect(appEventEnvelope({...event,id:'result',payload:completed})).toMatchObject({display:{content:completed.output}})
})
