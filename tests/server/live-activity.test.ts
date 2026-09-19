import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

describe('Studio Live Activity orchestration', () => {
 let db:any,home:string,connections:any[],users:Map<number,any>;const inspect=vi.fn(),fetchMock=vi.fn()
 const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
 beforeEach(async()=>{vi.resetModules();const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(':memory:');home=mkdtempSync(join(tmpdir(),'live-activity-'));connections=[];users=new Map([[7,{id:7,status:'active',role:'admin'}]])
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
  vi.doMock('../../packages/server/src/modules/studio/public/config',()=>({config:{appHome:home,appRelay:{url:'https://push.test'}}}))
  vi.doMock('../../packages/server/src/modules/studio/services/config/app-config',()=>({readAppConfig:async()=>({})}))
  vi.doMock('../../packages/server/src/modules/studio/public/auth',()=>({inspectAppUserToken:inspect}))
  vi.doMock('../../packages/server/src/modules/studio/public/system-info',()=>({getAppRelayDeviceIdentity:async()=>({device_id:'studio-a'})}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/app-connections-store',()=>({listAppConnections:()=>connections,hashAppCredential:hash}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/users-store',()=>({findUserById:(id:number)=>users.get(id),listUserProfiles:()=>[{profile_name:'default'}]}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:()=>({title:'Build App',profile:'default',user_id:7}),getSessionNotificationPreview:()=>({})}))
  vi.doMock('../../packages/server/src/modules/studio/repositories/workflow-run-store',()=>({getWorkflowRun:()=>null,getWorkflowRunForSession:()=>null}))
  vi.doMock('../../packages/server/src/modules/studio/services/webhooks/app-event-state',()=>({appEventState:()=>[]}))
  fetchMock.mockReset().mockResolvedValue({status:202,body:{cancel:vi.fn()}})
  connections.push({id:1,user_id:7,device_code:'phone-a',connection_type:'cloud',cloud_user_id:107,token_hash:hash('login'),token_expires_at:Date.now()/1000+3600,revoked_at:null})
  inspect.mockResolvedValue({status:'active',user:users.get(7),deviceCode:'phone-a',connectionType:'cloud'})
 })
 afterEach(()=>{db.close();rmSync(home,{recursive:true,force:true});vi.resetModules()})
 async function setup(){const {updateLiveActivityDestination}=await import('../../packages/server/src/modules/studio/services/notifications/live-activity-registration');await updateLiveActivityDestination('login',{schema_version:1,platform:'ios',studio_device_id:'studio-a',installation_ref:'phone-a',cloud_user_id:107,grant_id:'grant-a',push_token:'push_'+'a'.repeat(43),app_id:'com.ekkostudio.ai',apns_environment:'development',destination_id:'dest-a',enabled:true});return (await import('../../packages/server/src/modules/studio/services/notifications/live-activity')).createLiveActivityConsumer(fetchMock)}
 const event=(type:string,revision=1,status='in_progress')=>({schema_version:1 as const,id:`e-${revision}`,type,occurred_at:new Date().toISOString(),profile:'default',source:'chat',subject:{session_id:'session-a',run_id:'run-a'},payload:{},chat:type.endsWith('plan.updated')?{task_plan:{plan_id:'p',session_id:'session-a',run_id:'run-a',revision,execution_state:'running',updated_at:Date.now(),progress:{total:2,completed:status==='completed'?2:revision-1,in_progress:status==='in_progress'?1:0,pending:0,percent:50},plan:[{id:'a',step:'Inspect',status},{id:'b',step:'Verify',status:status==='completed'?'completed':'pending'}]}}:undefined} as any)
 it('persists an encrypted destination and emits ordered start update end without exposing credentials',async()=>{const consume=await setup();await consume(event('chat.plan.updated'));await consume(event('chat.plan.updated',2,'completed'));await consume(event('chat.run.completed',3));expect(fetchMock).toHaveBeenCalledTimes(3);const bodies=fetchMock.mock.calls.map(([,r])=>JSON.parse(r.body));expect(bodies.map(b=>b.event)).toEqual(['start','update','end']);expect(bodies.map(b=>b.revision)).toEqual([1,2,3]);expect(bodies[0].ekko_run).toMatchObject({session_id:'session-a',studio_device_id:'studio-a',cloud_user_id:107});expect(JSON.stringify(bodies)).not.toContain('push_')})
 it('does not start cards for terminal-only or unknown-total work',async()=>{const consume=await setup();await consume(event('chat.run.completed'));await consume({...event('chat.plan.updated'),chat:{task_plan:{...event('chat.plan.updated').chat.task_plan,progress:{total:0,completed:0}}}});expect(fetchMock).not.toHaveBeenCalled()})
})
