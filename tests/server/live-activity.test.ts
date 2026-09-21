import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

describe('Studio Live Activity orchestration', () => {
 let db:any,home:string,connections:any[],users:Map<number,any>;const inspect=vi.fn(),fetchMock=vi.fn()
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
 beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));vi.resetModules();const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(':memory:');home=mkdtempSync(join(tmpdir(),'live-activity-'));connections=[];users=new Map([[7,{id:7,status:'active',role:'admin'}]])
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
  vi.doMock('../../packages/server/src/modules/studio/public/config',()=>({config:{appHome:home,appRelay:{url:'https://push.test'}}}))
  vi.doMock('../../packages/server/src/modules/studio/services/config/app-config',()=>({readAppConfig:async()=>({})}))
  vi.doMock('../../packages/server/src/modules/studio/public/auth',()=>({inspectAppUserToken:inspect}))
  vi.doMock('../../packages/server/src/modules/studio/public/system-info',()=>({getAppRelayDeviceIdentity:async()=>({device_id:'studio-a'})}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/app-connections-store',()=>({listAppConnections:()=>connections,hashAppCredential:hash}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store',()=>({findUserById:(id:number)=>users.get(id),listUserProfiles:()=>[{profile_name:'default'}]}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:()=>({title:'Build App',profile:'default',user_id:7,agent:'codex'}),getSessionNotificationPreview:()=>({})}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/workflow-run-store',()=>({getWorkflowRun:()=>null,getWorkflowRunForSession:()=>null}))
  vi.doMock('../../packages/server/src/modules/studio/services/webhooks/app-event-state',()=>({appEventState:()=>[]}))
  fetchMock.mockReset().mockResolvedValue({status:202,body:{cancel:vi.fn()}})
  connections.push({id:1,user_id:7,device_code:'phone-a',connection_type:'cloud',cloud_user_id:107,token_hash:hash('login'),token_expires_at:Date.now()/1000+3600,revoked_at:null})
  inspect.mockResolvedValue({status:'active',user:users.get(7),deviceCode:'phone-a',connectionType:'cloud'})
 })
 afterEach(()=>{vi.useRealTimers();db.close();rmSync(home,{recursive:true,force:true});vi.resetModules()})
 async function setup(){const {updateLiveActivityDestination}=await import('../../packages/server/src/modules/studio/services/notifications/live-activity-registration');await updateLiveActivityDestination('login',{schema_version:1,platform:'ios',studio_device_id:'studio-a',installation_ref:'phone-a',cloud_user_id:107,grant_id:'grant-a',push_token:'push_'+'a'.repeat(43),app_id:'com.ekkostudio.ai',apns_environment:'development',destination_id:'dest-a',enabled:true});return (await import('../../packages/server/src/modules/studio/services/notifications/live-activity')).createLiveActivityConsumer(fetchMock)}
 const event=(type:string,revision=1,status='in_progress')=>({schema_version:1 as const,id:`e-${revision}`,type,occurred_at:new Date().toISOString(),profile:'default',source:'chat',subject:{session_id:'session-a',run_id:'run-a'},payload:{},chat:type.endsWith('plan.updated')?{task_plan:{plan_id:'p',session_id:'session-a',run_id:'run-a',revision,execution_state:'running',updated_at:Date.now(),progress:{total:2,completed:status==='completed'?2:revision-1,in_progress:status==='in_progress'?1:0,pending:0,percent:50},plan:[{id:'a',step:'Inspect',status},{id:'b',step:'Verify',status:status==='completed'?'completed':'pending'}]}}:undefined} as any)
 it('persists an encrypted destination and emits ordered start update end without exposing credentials',async()=>{const consume=await setup();await consume(event('chat.plan.updated'));await consume(event('chat.plan.updated',2,'completed'));await consume(event('chat.run.completed',3));expect(fetchMock).toHaveBeenCalledTimes(3);const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','update','end']);expect(bodies.map(b=>b.revision)).toEqual([1,2,3]);expect(bodies.every(b=>b.content_state.agent==='codex')).toBe(true);expect(bodies[0].ekko_run).toMatchObject({session_id:'session-a',studio_device_id:'studio-a',cloud_user_id:107});expect(JSON.stringify(bodies)).not.toContain('push_')})
 it('preserves Pi runtime identity instead of the default session agent',async()=>{const consume=await setup();const e=event('chat.plan.updated');e.chat.agent='pi';await consume(e);expect(JSON.parse(fetchMock.mock.calls[0][1].body).content_state.agent).toBe('pi')})
 it('reports rejected start without logging credentials or task text',async()=>{const log=vi.spyOn(console,'info').mockImplementation(()=>{});try{const consume=await setup();fetchMock.mockResolvedValueOnce({status:403,json:async()=>({error:'grant_revoked'}),body:null});await consume(event('chat.plan.updated'));expect(log).toHaveBeenCalledWith('[live-activity] delivery',expect.objectContaining({connection:1,action:'start',http:403,error:'grant_revoked'}));expect(JSON.stringify(log.mock.calls)).not.toContain('push_');expect(JSON.stringify(log.mock.calls)).not.toContain('Build App')}finally{log.mockRestore()}})

 it('uses the bounded notification title when the saved session title is absent',async()=>{
  vi.doMock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:()=>({title:null,profile:'default',user_id:7,agent:'pi'}),getSessionNotificationPreview:()=>({title:'检查任务标题',preview:'never use reply'})}))
  const consume=await setup();await consume(event('chat.plan.updated'))
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).content_state.title).toBe('检查任务标题')
 })

 it('uses session title for real coding_agent event sources, not only chat sources',async()=>{
  const consume=await setup(), e=event('chat.plan.updated')
  e.source='coding_agent';e.chat.agent='pi'
  await consume(e)
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).content_state.title).toBe('Build App')
 })

 it.each([
  ['coding_agent','claude-code','claude'],['coding_agent','codex','codex'],
  ['coding_agent','pi','pi'],['coding_agent','grok','grok'],
  ['coding_agent','opencode','opencode'],['coding_agent','dsh','deepseek'],
  ['chat','bridge','hermes'],['chat','ekko-agent','ekko'],
 ])('preserves title and normalized agent for %s / %s',async(source,runtime,expected)=>{
  const consume=await setup(), e=event('chat.plan.updated')
  e.source=source;e.chat.agent=runtime
  await consume(e)
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).content_state).toMatchObject({title:'Build App',agent:expected})
 })

 it('sends business priority by default when the setting is absent',async()=>{
  const consume=await setup();await consume(event('chat.plan.updated'))
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).relevance_score).toBe(Date.now()/1000)
 })

 it('preserves explicit opt-out for old gateways on start update and end',async()=>{
  vi.doMock('../../packages/server/src/modules/studio/services/config/app-config',()=>({readAppConfig:async()=>({liveActivityRelevanceEnabled:false})}))
  const consume=await setup();await consume(event('chat.plan.updated'));await consume(event('chat.plan.updated',2));await consume(event('chat.run.completed',3))
  for(const [,request] of fetchMock.mock.calls) expect(JSON.parse(request.body)).not.toHaveProperty('relevance_score')
 })
 it('does not start cards for terminal-only or unknown-total work',async()=>{const consume=await setup();await consume(event('chat.run.completed'));await consume({...event('chat.plan.updated'),chat:{task_plan:{...event('chat.plan.updated').chat.task_plan,progress:{total:0,completed:0}}}});expect(fetchMock).not.toHaveBeenCalled()})
})

describe('Studio Live Activity plan-trigger policy', () => {
 let db:any,home:string,connections:any[],users:Map<number,any>;const inspect=vi.fn(),fetchMock=vi.fn()
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
 beforeEach(async()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-20T00:00:00Z'));vi.resetModules();const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(':memory:');home=mkdtempSync(join(tmpdir(),'live-plan-trigger-'));connections=[];users=new Map([[7,{id:7,status:'active',role:'admin'}]])
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
  vi.doMock('../../packages/server/src/modules/studio/public/config',()=>({config:{appHome:home,appRelay:{url:'https://push.test'}}}))
  vi.doMock('../../packages/server/src/modules/studio/services/config/app-config',()=>({readAppConfig:async()=>({})}))
  vi.doMock('../../packages/server/src/modules/studio/public/auth',()=>({inspectAppUserToken:inspect}))
  vi.doMock('../../packages/server/src/modules/studio/public/system-info',()=>({getAppRelayDeviceIdentity:async()=>({device_id:'studio-a'})}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/app-connections-store',()=>({listAppConnections:()=>connections,hashAppCredential:hash}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store',()=>({findUserById:(id:number)=>users.get(id),listUserProfiles:()=>[{profile_name:'default'}]}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:()=>({title:'Build App',profile:'default',user_id:7,agent:'codex'}),getSessionNotificationPreview:()=>({})}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/workflow-run-store',()=>({getWorkflowRun:()=>null,getWorkflowRunForSession:()=>null}))
  vi.doMock('../../packages/server/src/modules/studio/services/webhooks/app-event-state',()=>({appEventState:()=>[]}))
  fetchMock.mockReset().mockResolvedValue({status:202,body:{cancel:vi.fn()}});connections.push({id:1,user_id:7,device_code:'phone-a',connection_type:'cloud',cloud_user_id:107,token_hash:hash('login'),token_expires_at:Date.now()/1000+3600,revoked_at:null});inspect.mockResolvedValue({status:'active',user:users.get(7),deviceCode:'phone-a',connectionType:'cloud'})
 })
 afterEach(()=>{vi.useRealTimers();db.close();rmSync(home,{recursive:true,force:true});vi.resetModules()})
 const event=(type:string,run='run-a',revision=1,session='session-a')=>({schema_version:1 as const,id:`${run}-${revision}-${type}`,type,occurred_at:new Date().toISOString(),profile:'default',source:'chat',subject:{session_id:session,run_id:run},payload:{},chat:type.endsWith('plan.updated')?{task_plan:{plan_id:'p',session_id:session,run_id:run,revision,execution_state:'running',updated_at:Date.now(),progress:{total:3,completed:revision-1,in_progress:1,pending:2,percent:33},plan:[{id:'a',step:'Work',status:'in_progress'}]}}:undefined} as any)
 async function setup(){const {updateLiveActivityDestination}=await import('../../packages/server/src/modules/studio/services/notifications/live-activity-registration');await updateLiveActivityDestination('login',{schema_version:1,platform:'ios',studio_device_id:'studio-a',installation_ref:'phone-a',cloud_user_id:107,grant_id:'grant-a',push_token:'push_'+'a'.repeat(43),app_id:'com.ekkostudio.ai',apns_environment:'development',destination_id:'dest-a',enabled:true});return (await import('../../packages/server/src/modules/studio/services/notifications/live-activity')).createLiveActivityConsumer(fetchMock)}
 it('starts immediately when the first valid plan appears, even if the run completes right away',async()=>{const consume=await setup();await consume(event('chat.plan.updated'));expect(fetchMock).toHaveBeenCalledTimes(1);await consume(event('chat.run.completed'));expect(fetchMock).toHaveBeenCalledTimes(2);const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','end'])})
 it('updates one activity for repeated plans from the same run instead of starting duplicates',async()=>{const consume=await setup();await consume(event('chat.plan.updated','run-a',1));await consume(event('chat.plan.updated','run-a',2));expect(fetchMock).toHaveBeenCalledTimes(2);const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','update']);expect(bodies[1].activity_ref).toBe(bodies[0].activity_ref)})
 it('serializes concurrent plan events so only one request can start the activity',async()=>{const consume=await setup();await Promise.all([consume(event('chat.plan.updated','run-a',1)),consume(event('chat.plan.updated','run-a',2))]);const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start']);expect(bodies[0].content_state.completedSteps).toBe(1);expect(new Set(bodies.map(b=>b.activity_ref)).size).toBe(1)})
 it('keeps one activity across separate runs in the same session',async()=>{const consume=await setup();await consume(event('chat.plan.updated','run-a',1));await consume(event('chat.plan.updated','run-b',2));const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','update']);expect(new Set(bodies.map(b=>b.activity_ref)).size).toBe(1)})
 it('starts separate activities for separate sessions',async()=>{const consume=await setup();await consume(event('chat.plan.updated','run-a',1,'session-a'));await consume(event('chat.plan.updated','run-b',1,'session-b'));expect(fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body).event)).toEqual(['start','start'])})
 it('ends the session activity when a later run emits the terminal event',async()=>{const consume=await setup();await consume(event('chat.plan.updated','run-a',1));await consume(event('chat.run.completed','run-b',2));const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','end']);expect(bodies[1].activity_ref).toBe(bodies[0].activity_ref);expect(bodies[1].dismissal_at).toBe(bodies[1].occurred_at+60)})
 it('ends legacy per-run activities before starting the stable session activity',async()=>{const consume=await setup();const {saveLiveActivityRun}=await import('../../packages/server/src/modules/studio/repositories/live-activity-runtime-store');for(const run of ['run-old-a','run-old-b'])saveLiveActivityRun({run_key:`dest-a:chat:session-a:${run}`,destination_id:'dest-a',activity_ref:`legacy-${run}`,revision:1,started:1,terminal:0,title:'Old',completed:0,total:3,updated_at:Date.now()});await consume(event('chat.plan.updated','run-new',1));const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['end','end','start']);expect(bodies.slice(0,2).every(b=>b.dismissal_at===b.occurred_at)).toBe(true)})
 it('keeps the started state across consumer recreation and sends an update, not another start',async()=>{let consume=await setup();await consume(event('chat.plan.updated','run-a',1));vi.resetModules();consume=(await import('../../packages/server/src/modules/studio/services/notifications/live-activity')).createLiveActivityConsumer(fetchMock);await consume(event('chat.plan.updated','run-a',2));expect(fetchMock).toHaveBeenCalledTimes(2);expect(fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body).event)).toEqual(['start','update'])})
 it('polls a pending update with the exact same request until accepted',async()=>{const consume=await setup();fetchMock.mockResolvedValueOnce({status:202,json:vi.fn().mockResolvedValue({status:'queued'}),body:null}).mockResolvedValueOnce({status:202,json:vi.fn().mockResolvedValue({status:'pending_token'}),body:null}).mockResolvedValueOnce({status:200,json:vi.fn().mockResolvedValue({status:'accepted'}),body:null});const pending=consume(event('chat.plan.updated','run-a',1));await vi.advanceTimersByTimeAsync(10_000);await pending;expect(fetchMock).toHaveBeenCalledTimes(3);expect(fetchMock.mock.calls.map(([,r])=>r.body)).toEqual([fetchMock.mock.calls[0][1].body,fetchMock.mock.calls[0][1].body,fetchMock.mock.calls[0][1].body])})
 it('does not let a pending terminal receipt block a new turn in the same session',async()=>{const consume=await setup();fetchMock.mockResolvedValueOnce({status:200,json:vi.fn().mockResolvedValue({status:'accepted'}),body:null}).mockResolvedValueOnce({status:202,json:vi.fn().mockResolvedValue({status:'pending_token'}),body:null}).mockResolvedValueOnce({status:200,json:vi.fn().mockResolvedValue({status:'accepted'}),body:null});await consume(event('chat.plan.updated','run-a',1));const ending=consume(event('chat.run.completed','run-a',2));await vi.advanceTimersByTimeAsync(0);const next=consume(event('chat.plan.updated','run-b',1));await ending;await next;const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','end','start']);expect(fetchMock).toHaveBeenCalledTimes(3)})
 it('uses a fresh activity reference for a new run even when the plan ID is reused',async()=>{
  const consume=await setup()
  const first=event('chat.plan.updated','run-a',1)
  first.chat.task_plan.plan_id='same-session-plan'
  await consume(first)
  await consume(event('chat.run.completed','run-a',2))
  const second=event('chat.plan.updated','run-b',1)
  second.chat.task_plan.plan_id='same-session-plan'
  await consume(second)
  const starts=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body)).filter(b=>b.event==='start')
  expect(starts).toHaveLength(2)
  expect(starts[1].activity_ref).not.toBe(starts[0].activity_ref)
 })

 it('dispatches end without waiting for a queued update receipt',async()=>{
  const consume=await setup()
  fetchMock.mockResolvedValueOnce({status:200,json:async()=>({status:'accepted'}),body:null})
   .mockResolvedValueOnce({status:202,json:async()=>({status:'pending_token'}),body:null})
   .mockResolvedValueOnce({status:200,json:async()=>({status:'accepted'}),body:null})
  await consume(event('chat.plan.updated','run-a',1))
  const update=consume(event('chat.plan.updated','run-a',2))
  await vi.advanceTimersByTimeAsync(0)
  const end=consume(event('chat.run.completed','run-a',3))
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  await Promise.all([update,end])
  const body=JSON.parse(fetchMock.mock.calls[2][1].body)
  expect(body.event).toBe('end');expect(body.content_state.status).toBe('completed')
  expect(body.dismissal_at).toBe(body.occurred_at+60)
 })

 it('refreshes only a verified active run without changing progress or starting another activity',async()=>{
  let running=true
  vi.doMock('../../packages/server/src/modules/studio/services/chat-run/server-registry',()=>({getChatRunServer:()=>({isLiveActivityRunActive:()=>running})}))
  const consume=await setup()
  await consume(event('chat.plan.updated','run-a',1))
  await vi.advanceTimersByTimeAsync(120_000)
  const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body))
  expect(bodies.map(b=>b.event)).toEqual(['start','update'])
  expect(bodies[1].content_state).toEqual(bodies[0].content_state)
  expect(bodies[1].stale_at-bodies[0].stale_at).toBe(120)
  running=false
  await vi.advanceTimersByTimeAsync(240_000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  vi.doUnmock('../../packages/server/src/modules/studio/services/chat-run/server-registry')
 })

 it('cancels heartbeat after terminal even if a runtime snapshot still reports working',async()=>{
  vi.doMock('../../packages/server/src/modules/studio/services/chat-run/server-registry',()=>({getChatRunServer:()=>({isLiveActivityRunActive:()=>true})}))
  const consume=await setup()
  await consume(event('chat.plan.updated','run-a',1))
  await consume(event('chat.run.completed','run-a',2))
  await vi.advanceTimersByTimeAsync(600_000)
  expect(fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body).event)).toEqual(['start','end'])
  vi.doUnmock('../../packages/server/src/modules/studio/services/chat-run/server-registry')
 })

 it('ends an interrupted plan as cancelled immediately, retaining real progress',async()=>{
  const consume=await setup()
  await consume(event('chat.plan.updated','run-a',1))
  const stopped=event('chat.plan.updated','run-a',2)
  stopped.chat.task_plan.execution_state='interrupted'
  await consume(stopped)
  const body=JSON.parse(fetchMock.mock.calls[1][1].body)
  expect(body.event).toBe('end');expect(body.content_state.status).toBe('cancelled')
  expect(body.content_state.completedSteps).toBe(1)
  expect(body.dismissal_at).toBe(body.occurred_at)
  await consume(event('chat.run.completed','run-a',3))
  expect(fetchMock).toHaveBeenCalledTimes(2)
 })
 it('does not create an activity for a terminal-only plan',async()=>{
  const consume=await setup(), stopped=event('chat.plan.updated','run-a',1)
  stopped.chat.task_plan.execution_state='interrupted'
  await consume(stopped)
  expect(fetchMock).not.toHaveBeenCalled()
 })
 it('a newer plan supersedes pending receipt polling and queued older snapshots',async()=>{
  const consume=await setup()
  fetchMock.mockResolvedValueOnce({status:200,json:async()=>({status:'accepted'}),body:null})
    .mockResolvedValueOnce({status:202,json:async()=>({status:'pending_token'}),body:null})
    .mockResolvedValue({status:200,json:async()=>({status:'accepted'}),body:null})
  await consume(event('chat.plan.updated','run-a',1))
  const old=consume(event('chat.plan.updated','run-a',2));await vi.advanceTimersByTimeAsync(0)
  const next=event('chat.plan.updated','run-a',3);next.chat.task_plan.plan[0].step='Newest step'
  const fresh=consume(next);await vi.advanceTimersByTimeAsync(0)
  expect(fetchMock).toHaveBeenCalledTimes(3)
  await Promise.all([old,fresh])
  expect(JSON.parse(fetchMock.mock.calls[2][1].body).content_state.currentStep).toBe('Newest step')
 })

 it('keeps real per-run start and usage across complete snapshots without inventing values',async()=>{
  vi.doMock('../../packages/server/src/modules/studio/services/chat-run/server-registry',()=>({getChatRunServer:()=>({getLiveActivityStartedAt:()=>1789862400.25,isLiveActivityRunActive:()=>false})}))
  const consume=await setup(), first=event('chat.plan.updated','run-a',1)
  first.chat.summary={status:'updated',input_tokens:42,output_tokens:7}
  await consume(first);await consume(event('chat.plan.updated','run-a',2))
  const states=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body).content_state)
  expect(states[1]).toMatchObject({startedAtEpoch:1789862400.25,inputTokens:42,outputTokens:7})
  expect(states[1]).not.toHaveProperty('appearance')
  expect(states[1]).not.toHaveProperty('totalTokens')
  vi.doUnmock('../../packages/server/src/modules/studio/services/chat-run/server-registry')
 })

 it('gates priority and preserves business priority across heartbeat',async()=>{
  vi.doMock('../../packages/server/src/modules/studio/services/config/app-config',()=>({readAppConfig:async()=>({liveActivityRelevanceEnabled:true})}))
  vi.doMock('../../packages/server/src/modules/studio/services/chat-run/server-registry',()=>({getChatRunServer:()=>({isLiveActivityRunActive:()=>true})}))
  const consume=await setup(), e=event('chat.plan.updated','run-a',1)
  await consume(e);await vi.advanceTimersByTimeAsync(120000)
  const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body))
  expect(bodies[0].relevance_score).toBe(e.chat.task_plan.updated_at/1000)
  expect(bodies[1].relevance_score).toBe(bodies[0].relevance_score)
  await consume(event('chat.run.completed','run-a',2))
  expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).relevance_score).toBe(0)
  vi.doUnmock('../../packages/server/src/modules/studio/services/chat-run/server-registry')
 })

})
