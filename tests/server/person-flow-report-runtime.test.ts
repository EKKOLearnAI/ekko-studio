import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {acceptanceFixture,type AcceptanceFixture} from './fixtures/person-acceptance'

let f:AcceptanceFixture
let reports:typeof import('../../packages/server/src/modules/studio/repositories/person-flow-report-store')
let flows:typeof import('../../packages/server/src/modules/studio/services/person/stage-flows')
let sessions:typeof import('../../packages/server/src/modules/studio/repositories/session-store')
let output:{content:string;reasoning?:string;finishReason?:string}
let steps:any[]
let runId:string
let claimed=false
let pauseClaim=false
let flowId:string
const creator='person-main-1',peer='person-main-peer'

beforeEach(async()=>{
  f=await acceptanceFixture()
  output={content:'Verified summary'};steps=[];runId=randomUUID();claimed=false;pauseClaim=false
  vi.doMock('../../packages/server/src/modules/studio/public/chat-agent-runtime',async original=>({
    ...await original<any>(),
    resolveChatEkkoProviderRuntimeConfig:async()=>({baseUrl:'https://fixture.invalid',apiMode:'chat_completions'}),
    resolveChatEkkoModelProviderConfigs:()=>({providerConfig:{provider:'fixture',model:'test-model',requestStyle:'chat_completions'}}),
    createChatEkkoAuthorizedProviderFetch:()=>vi.fn(()=>{throw new Error('Network is forbidden in this fixture')}),
    createChatEkkoModelClient:()=>({}),getChatEkkoModelRequestTimeoutMs:()=>1000,
    resolveChatEkkoMcpServers:()=>({}),chatEkkoAgentReasoningText:(value:unknown)=>typeof value==='string'?value:'',
    serializeChatEkkoAgentReasoningDetails:()=>null,
    hasChatEkkoBackgroundTasks:()=>false,
  }))
  vi.doMock('../../packages/server/src/modules/studio/services/chat-run/workspace-diff-tracker',()=>({startWorkspaceRunCheckpoint:vi.fn(),completeWorkspaceRunCheckpoint:()=>null}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/app-connections-store',async original=>({
    ...await original<any>(),listAppConnections:()=>[{id:'connection',user_id:1,device_code:'device',token_hash:'fixture',revoked_at:null,token_expires_at:Date.now()/1000+3600,push_enabled:1}],
  }))
  vi.doMock('../../packages/server/src/modules/studio/repositories/user-push-store',()=>({
    listUserPushDevices:()=>[{id:1,user_id:1,connection_id:'connection',device_id:'device',connection_token_hash:'fixture',app_id:'fixture',environment:'sandbox',ciphertext:'fixture'}],removeUserPushDevice:vi.fn(),
  }))
  vi.doMock('../../packages/server/src/modules/studio/services/notifications/push-secrets',()=>({decryptPushSecret:()=>JSON.stringify({platform:'ios',installation_ref:'device',push_token:'fixture',studio_device_id:'fixture',cloud_user_id:'fixture',app_id:'fixture',apns_environment:'sandbox',apns_token:'not-a-device'})}))
  vi.doMock('../../packages/server/src/modules/studio/services/app-relay/route',()=>({getAppRelayRoute:async()=>({}),appRelayUrlForRoute:()=> 'https://fixture.invalid'}))
  vi.doMock('../../packages/server/src/modules/studio/services/person/chat-agent',()=>({createPersonChatAgent:async()=>({
    sessionWorkspaceDirectory:()=>f.workspace,
    estimateContext:async()=>({contextTokens:1}),
    async run(input:any){
      input.onEvent({type:'run.started',runId})
      if(claimed) reports.claimPersonFlowReportForRun(1,flowId,creator,runId)
      if(pauseClaim) reports.pausePersonFlowReportsForSession(1,creator)
      return {runId,output,steps,context:[]}
    },
  })}))
  sessions=await import('../../packages/server/src/modules/studio/repositories/session-store')
  sessions.createSession({id:peer,studio_user_id:1,user_id:1,source:'builtin_agent',agent:'ekko-agent',workspace:f.workspace})
  flows=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  reports=await import('../../packages/server/src/modules/studio/repositories/person-flow-report-store')
  const flow=flows.createPersonFlow(1,{session_id:creator,title:'Summary',goal:'Return saved evidence',stages:[{session_id:peer,goal:'Work',return_expectation:'Evidence'}],idempotency_key:randomUUID()})
  flowId=flow.id
  const context={flowId,stageId:flow.stages[0].id,generation:0}
  await flows.controlPersonFlow(1,{action:'complete',flow_id:flow.id,expected_revision:0,idempotency_key:'complete'},{sessionId:peer,runId:'peer',stage:context,messages:[]})
  const message=sessions.addMessage({session_id:peer,run_marker:'peer',role:'assistant',content:'Verified evidence',finish_reason:'stop'})!
  flows.finishPersonStageTurn(1,context,'peer',message,true)
})
afterEach(async()=>{await f.close('report-runtime');vi.doUnmock('../../packages/server/src/modules/studio/services/person/chat-agent');vi.doUnmock('../../packages/server/src/modules/studio/public/chat-agent-runtime')})

function receipt(){return f.db.prepare('SELECT * FROM person_flow_reports').get() as any}
async function execute(){
  const row=receipt()
  let identity={id:row.id,attempt:row.attempts}
  if(!claimed){
    f.db.prepare("UPDATE person_flow_reports SET state='starting',attempts=attempts+1 WHERE id=?").run(row.id)
    identity={id:row.id,attempt:receipt().attempts}
  }
  const queueId=reports.personFlowReportQueueId(identity)
  const {handleEkkoAgentRun}=await import('../../packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run')
  const {appEventEnvelope}=await import('../../packages/server/src/modules/studio/services/webhooks/app-events')
  const {createRunPushConsumer}=await import('../../packages/server/src/modules/studio/services/notifications/run-push')
  const send=vi.fn(async()=>({status:200,body:{cancel:async()=>{}}}))
  const push=createRunPushConsumer(send as any),pendingPush:Promise<void>[]=[]
  const terminal:any[]=[],notices:any[]=[],events:any[]=[]
  const emit=(event:string,payload:any)=>events.push({event,payload})
  const nsp:any={to:()=>({emit,except:()=>({emit})}),adapter:{rooms:new Map()}}
  const socket:any={id:'fixture',connected:false,data:{user:{id:1,role:'super_admin'}},join:vi.fn(),emit,to:()=>({emit})}
  const states=new Map<string,any>()
  await handleEkkoAgentRun(nsp,socket,{session_id:creator,input:'Summarize',display_input:null,agent_id:'ekko-agent',model:'test-model',provider:'fixture',autonomous:!claimed,
    ...(!claimed?{background_delegation_id:queueId}:{}),
    onEvent(event,payload){
      if(event==='run.started'&&!claimed) reports.startPersonFlowReport(1,identity,creator,payload.run_id)
      if(!['run.completed','run.failed'].includes(event))return
      // This is the shared consumer boundary used by ChatRunSocket, before the queued callback.
      terminal.push({event,payload,receipt:{...receipt()}})
      const business={schema_version:1 as const,id:`event-${runId}`,type:`person.${event}`,occurred_at:new Date().toISOString(),profile:'default',source:'person',subject:{session_id:creator,run_id:payload.run_id,message_id:payload.message_id},payload}
      const envelope=appEventEnvelope(business)
      if(envelope)notices.push(envelope)
      pendingPush.push(push(business))
    },
  },'default',states,()=>false,true,!claimed?{runtime:'ekko',version:1,subagentId:queueId,originRunId:'',originStep:0,messages:[],memoryPolicy:'disabled'}:undefined)
  await Promise.all(pendingPush)
  const completionPush=send.mock.calls.map((call:any)=>JSON.parse(call[1].body)).filter((body:any)=>body.event_type==='completion')
  return {terminal,notices,events,state:states.get(creator),completionPush}
}

it('saves and settles a valid report before publishing its completion to the shared notification consumer',async()=>{
  const result=await execute()
  expect(result.terminal).toHaveLength(1)
  expect(result.terminal[0]).toMatchObject({event:'run.completed',receipt:{state:'delivered',run_id:runId},payload:{notification_suppressed:false}})
  expect(result.notices).toHaveLength(1)
  expect(result.notices[0].display.content).toBe('Verified summary')
  expect(result.completionPush).toHaveLength(1)
  const saved=f.db.prepare('SELECT content,finish_reason FROM messages WHERE id=?').get(receipt().result_message_id)
  expect(saved).toMatchObject({content:'Verified summary',finish_reason:'stop'})
  expect(result.state.isWorking).toBe(false)
})

it.each(['plain-empty','reasoning-only','tool-only'])('does not announce successful delivery for %s, and a valid retry announces once',async kind=>{
  output={content:'',...(kind==='reasoning-only'?{reasoning:'Private thought'}:{})}
  if(kind==='tool-only')steps=[{type:'model',message:{content:'',toolCalls:[{id:'call',name:'fixture',arguments:{}}]}},{type:'tool',toolCallId:'call',toolName:'fixture',result:{ok:true,content:'Internal tool result'}}]
  const first=await execute()
  expect(receipt()).toMatchObject({state:'pending',result_message_id:null})
  expect(first.notices.filter(n=>n.type==='person.run.completed')).toHaveLength(0)
  expect(first.completionPush).toHaveLength(0)
  if(kind==='plain-empty')expect(first.terminal[0].event).toBe('run.failed')
  else expect(first.terminal[0]).toMatchObject({event:'run.completed',payload:{notification_suppressed:true}})
  output={content:'Verified retry'};steps=[];runId=randomUUID()
  const retried=await execute()
  expect(receipt()).toMatchObject({state:'delivered',attempts:2})
  expect(retried.notices.filter(n=>n.type==='person.run.completed')).toHaveLength(1)
  expect(retried.completionPush).toHaveLength(1)
})

it('also gates a report claimed by a normal creator turn without an autonomous queue identity',async()=>{
  claimed=true;output={content:'',reasoning:'Private thought'}
  const first=await execute()
  expect(first.terminal[0]).toMatchObject({event:'run.completed',payload:{notification_suppressed:true},receipt:{state:'pending'}})
  expect(first.notices).toHaveLength(0)
})

it('retains the creator run binding after Stop and suppresses a late successful terminal',async()=>{
  claimed=true;pauseClaim=true
  const result=await execute()
  expect(result.terminal[0]).toMatchObject({event:'run.completed',payload:{notification_suppressed:true},receipt:{state:'paused'}})
  expect(result.completionPush).toHaveLength(0);expect(result.notices).toHaveLength(0)
})
