import { beforeEach, it, expect, vi } from 'vitest'
const auth=vi.hoisted(()=>({user:{id:1,role:'user'} as any,profiles:['default']}))
const mutedTokens=vi.hoisted(()=>new Set<string>())
vi.mock('../../packages/server/src/modules/studio/repositories/app-connections-store',()=>({isAppConnectionPushEnabled:(token:string)=>!mutedTokens.has(token),listAppConnections:()=>[]}))
const ownership=vi.hoisted(()=>({sessionUser:'1' as string|null,runUser:1 as number|null}))
vi.mock('../../packages/server/src/modules/studio/public/auth',()=>({authenticateUserToken:async()=>auth.user}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store',()=>({listUserProfiles:()=>auth.profiles.map(profile_name=>({profile_name}))}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:(id:string)=>id==='missing'?null:({source:'cli',agent:'codex',profile:'default',user_id:ownership.sessionUser}),getSessionNotificationPreview:()=>({title:'Title',preview:'Reply'})}))
vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store',()=>({
 getWorkflowRun:(id:string)=>id==='missing'?null:({id,workflow_id:'w',profile:'default',user_id:ownership.runUser}),
 getWorkflowRunForSession:(id:string,profile:string)=>id==='node' && profile==='default'?({id:'root',workflow_id:'w',profile:'root-profile',user_id:ownership.runUser}):null,
}))
import { bindAppEventSubscription, parseAppSubscription, registerGroupEventAccess } from '../../packages/server/src/modules/studio/services/webhooks/app-events'
import { publishDomainEvent, publishGroupMessage } from '../../packages/server/src/modules/studio/services/webhooks/domain-events'
function socket(){const handlers=new Map<string,Function>();return {id:Math.random().toString(),handshake:{auth:{token:'test'}},data:{},emit:vi.fn(),on:(n:string,f:Function)=>{const old=handlers.get(n);handlers.set(n,old?(...args:any[])=>{old(...args);f(...args)}:f)},once:(n:string,f:Function)=>handlers.set(n,f),handlers}}
const flush=()=>new Promise(r=>setTimeout(r,15))
beforeEach(()=>{mutedTokens.clear();auth.user={id:1,role:'user'};auth.profiles=['default'];ownership.sessionUser='1';ownership.runUser=1})
it('normalizes omitted/blank profile before authorization and validates types',async()=>{
 expect(parseAppSubscription({schema_version:1}).profile).toBe('default')
 expect(()=>parseAppSubscription({schema_version:1,types:['unsafe']})).toThrow()
 const s=socket();bindAppEventSubscription(s as any);auth.profiles=['other'];const ack=vi.fn()
 await s.handlers.get('app.events.subscribe')!({schema_version:1},ack)
 expect(ack).toHaveBeenCalledWith({ok:false,error:'event_subscription_denied'})
 s.handlers.get('disconnect')!()
})
it('receives unified workflow event without HTTP endpoints and rechecks revocation',async()=>{
 const s=socket();bindAppEventSubscription(s as any)
 await s.handlers.get('app.events.subscribe')!({schema_version:1},vi.fn())
 publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'r'},{title:'W'})
 await flush();expect(s.emit).toHaveBeenCalledWith('app.event',expect.objectContaining({schema_version:1,type:'workflow.run.completed',subject:{workflow_id:'w',run_id:'r'}}))
 auth.profiles=[]
 publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'r2'},{title:'W'})
 await flush();expect(s.emit).toHaveBeenCalledTimes(1)
 s.handlers.get('disconnect')!()
})
it('group membership and filters are intersected at delivery and disconnected listeners removed',async()=>{
 let member=true;const unregister=registerGroupEventAccess({canReceive:()=>member})
 const s=socket();bindAppEventSubscription(s as any)
 await s.handlers.get('app.events.subscribe')!({schema_version:1,room_ids:['r']},vi.fn())
 publishGroupMessage({id:'r',name:'R',summaryProfile:'other'},{id:'a',senderName:'Pi',senderType:'agent',role:'assistant',content:'Reply'},[])
 await flush();expect(s.emit).toHaveBeenCalledTimes(1)
 member=false;publishGroupMessage({id:'r',name:'R',summaryProfile:'other'},{id:'b',senderName:'Pi',senderType:'agent',role:'assistant',content:'Reply'},[])
 await flush();expect(s.emit).toHaveBeenCalledTimes(1)
 s.handlers.get('disconnect')!();member=true
 publishGroupMessage({id:'r',name:'R',summaryProfile:'other'},{id:'c',senderName:'Pi',senderType:'agent',role:'assistant',content:'Reply'},[])
 await flush();expect(s.emit).toHaveBeenCalledTimes(1);unregister()
})
it('new protocol selection excludes legacy delivery and requested/resolved identities remain distinct',async()=>{
 const { bindLegacyAppEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events')
 const s=socket();s.handshake.auth={token:'test',appEventVersion:1} as any
 bindAppEventSubscription(s as any);bindLegacyAppEvents(s as any,'workflow',()=>true)
 await s.handlers.get('app.events.subscribe')!({schema_version:1},vi.fn())
 publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'versioned'},{title:'W'})
 await flush();expect(s.emit.mock.calls.map(call=>call[0])).toEqual(['app.event'])
 s.handlers.get('disconnect')!()
})
it('real Socket.IO transport restores subscriptions and emits the same envelope after reconnect',async()=>{
 const {createServer}=await import('node:http')
 const {Server}=await import('socket.io')
 const {io}=await import('socket.io-client')
 const http=createServer();const server=new Server(http)
 server.of('/chat-run').on('connection',bindAppEventSubscription)
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve))
 const port=(http.address() as any).port
 const client=io(`http://127.0.0.1:${port}/chat-run`,{auth:{token:'test',appEventVersion:1},transports:['websocket'],autoConnect:false})
 const received:any[]=[];client.on('app.event',e=>received.push(e))
 const connect=async()=>{const ready=new Promise<void>(resolve=>client.once('connect',()=>resolve()));client.connect();await ready;await new Promise<void>((resolve,reject)=>client.emit('app.events.subscribe',{schema_version:1,profile:'default'},(ack:any)=>ack.ok?resolve():reject(Error('denied'))))}
 try {
  await connect();publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'live1'},{title:'W'})
  await vi.waitFor(()=>expect(received).toHaveLength(1))
  expect(received[0]).toMatchObject({schema_version:1,type:'workflow.run.completed',subject:{workflow_id:'w',run_id:'live1'},display:{title:'W'}})
  client.disconnect();await flush();publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'offline'},{title:'W'})
  await connect();expect(received).toHaveLength(1)
  publishDomainEvent('workflow.run.failed','default',{workflow_id:'w',run_id:'live2'},{title:'W'})
  await vi.waitFor(()=>expect(received).toHaveLength(2))
 } finally {client.disconnect();await new Promise<void>(resolve=>server.close(()=>resolve()));http.close()}
})

it('returns an authorized state snapshot on the same subscription without replaying completion alerts', async () => {
 const { registerAppEventState, stateEvent, planStateEvent, publishAppState } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 const groupAccess = registerGroupEventAccess({canReceive:(_u, room, event)=>room==='visible' && (!event?.type.includes('.approval.') || event.payload.owner_member_id==='owner')})
 const running = stateEvent('chat.run.updated','default',{session_id:'s',run_id:'r'},{state:{session_id:'s',status:'running',timestamp:10}})
 const card = planStateEvent('default',{session_id:'s',run_id:'r'},{session_id:'s',run_id:'r',plan_id:'p',revision:2,created_at:1,updated_at:2,execution_state:'running',plan:[{id:'a',step:'Verify',status:'in_progress'}],secret:'never'})!
 const stop = registerAppEventState('test',()=>[running,card,
  stateEvent('group.run.updated','other',{room_id:'hidden'},{state:{status:'replying'}}),
  stateEvent('group.approval.requested','other',{room_id:'visible',approval_id:'a'},{owner_member_id:'another-user'}),
  stateEvent('group.approval.requested','other',{room_id:'visible',approval_id:'b'},{owner_member_id:'owner',command:'secret command',timeout_ms:5000}),
  stateEvent('chat.run.updated','denied',{session_id:'private'},{state:{status:'running'}})])
 const s=socket();bindAppEventSubscription(s as any)
 try {
  const ack=vi.fn();await s.handlers.get('app.events.subscribe')!({schema_version:1,include_snapshot:true},ack)
  const response=ack.mock.calls[0][0]
  expect(response.ok).toBe(true);expect(response.snapshot.map((e:any)=>e.type)).toEqual(['chat.run.updated','chat.plan.updated','group.approval.requested'])
  expect(response.snapshot[1]).toMatchObject({notify:false,task_plan:{revision:2,progress:{total:1,in_progress:1,completed:0}}})
  expect(JSON.stringify(response.snapshot)).not.toMatch(/secret|another-user|owner_member_id|private/)
  expect(s.emit).not.toHaveBeenCalled()
  publishAppState(stateEvent('chat.run.updated','default',{session_id:'s'},{state:{status:'completed'}}))
  await flush();expect(s.emit).toHaveBeenCalledWith('app.event',expect.objectContaining({type:'chat.run.updated',notify:false,state:{status:'completed'}}))
  auth.profiles=[];const denied=vi.fn();await s.handlers.get('app.events.subscribe')!({schema_version:1,include_snapshot:true},denied)
  expect(denied).toHaveBeenCalledWith({ok:false,error:'event_subscription_denied'})
 } finally {s.handlers.get('disconnect')!();stop();groupAccess()}
})

it('a failed snapshot provider leaves no live subscription behind', async () => {
 const { registerAppEventState, stateEvent, publishAppState } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 const stop=registerAppEventState('broken',()=>{throw Error('unavailable')})
 const s=socket();bindAppEventSubscription(s as any);const ack=vi.fn()
 try {
  await s.handlers.get('app.events.subscribe')!({schema_version:1,include_snapshot:true},ack)
  expect(ack).toHaveBeenCalledWith({ok:false,error:'event_subscription_denied'})
  publishAppState(stateEvent('chat.run.updated','default',{session_id:'s'},{state:{status:'running'}}))
  await flush();expect(s.emit).not.toHaveBeenCalled()
 } finally {stop();s.handlers.get('disconnect')!()}
})

it.each(['admin', 'super_admin'])('does not broadcast chat or workflow events to another %s in the same Profile', async role => {
 const { publishAppState, stateEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
 const s=socket();bindAppEventSubscription(s as any)
 await s.handlers.get('app.events.subscribe')!({schema_version:1,session_ids:['s'],workflow_ids:['w']},vi.fn())
 const events = [
  stateEvent('chat.run.completed','default',{session_id:'s',run_id:'r'},{run_id:'r'}),
  stateEvent('chat.approval.requested','default',{session_id:'s',approval_id:'a'},{approval_id:'a'}),
  stateEvent('chat.clarification.requested','default',{session_id:'s',clarification_id:'c'},{clarify_id:'c'}),
  stateEvent('chat.run.updated','default',{session_id:'s'},{state:{status:'running'}}),
  stateEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'r'},{}),
  stateEvent('workflow.run.updated','default',{workflow_id:'w',run_id:'r'},{state:{status:'running'}}),
  stateEvent('chat.clarification.requested','default',{workflow_id:'w',session_id:'node',run_id:'node-runtime',clarification_id:'nc'},{}),
 ]
 try {
  auth.user={id:2,role}
  events.forEach(event=>businessEvents.publish(event));await flush()
  expect(s.emit).not.toHaveBeenCalled()
  auth.user={id:1,role}
  events.forEach(event=>businessEvents.publish(event));await flush()
  expect(s.emit).toHaveBeenCalledTimes(events.length)
  ownership.sessionUser=null;ownership.runUser=null;s.emit.mockClear()
  events.forEach(event=>publishAppState({...event,id:`ownerless:${event.id}`}));await flush()
  expect(s.emit).not.toHaveBeenCalled()
 } finally {s.handlers.get('disconnect')!()}
})

it('filters reconnect snapshots by owner, including plans and workflow node interactions', async () => {
 const { stateEvent, planStateEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 const card=planStateEvent('default',{session_id:'s',run_id:'r'},{session_id:'s',run_id:'r',plan_id:'card',revision:1,created_at:1,updated_at:1,execution_state:'running',plan:[{id:'a',step:'Private step',status:'in_progress'}]})!
 const events=[stateEvent('chat.run.updated','default',{session_id:'s'},{state:{status:'running'}}),card,
  stateEvent('workflow.run.updated','default',{workflow_id:'w',run_id:'r'},{state:{status:'running'}}),
  stateEvent('chat.clarification.requested','default',{workflow_id:'w',session_id:'node',clarification_id:'c'},{})]
 const s=socket();bindAppEventSubscription(s as any,()=>events)
 try {
  auth.user={id:2,role:'super_admin'}
  const other=vi.fn();await s.handlers.get('app.events.subscribe')!({schema_version:1,include_snapshot:true},other)
  expect(other.mock.calls[0][0]).toMatchObject({ok:true,snapshot:[]})
  auth.user={id:1,role:'admin'}
  const owner=vi.fn();await s.handlers.get('app.events.subscribe')!({schema_version:1,include_snapshot:true},owner)
  expect(owner.mock.calls[0][0].snapshot).toHaveLength(events.length)
  expect(JSON.stringify(owner.mock.calls[0][0].snapshot)).not.toContain('user_id')
 } finally {s.handlers.get('disconnect')!()}
})

it('rejects missing or mismatched owners and never trusts ownership claimed in payloads', async () => {
 const { canReceiveAppEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/app-events')
 const { stateEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 auth.user={id:2,role:'super_admin'}
 for (const subject of [{session_id:'s'},{session_id:'missing'},{workflow_id:'w',run_id:'r'},{workflow_id:'w',run_id:'missing'},
  {workflow_id:'another',session_id:'node'},{workflow_id:'w',session_id:'missing'}]) {
  expect(canReceiveAppEvent(auth.user,stateEvent('chat.run.updated','default',subject,{user_id:2,state:{user_id:2}}))).toBe(false)
 }
})

it('applies ownership to legacy notifications as well as the versioned subscription', async () => {
 const { bindLegacyAppEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events')
 const { stateEvent } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
 const s=socket();bindLegacyAppEvents(s as any,'chat',()=>true)
 try {
  const event=stateEvent('chat.run.completed','default',{session_id:'s',run_id:'r'},{run_id:'r'})
  auth.user={id:2,role:'super_admin'};businessEvents.publish(event);await flush()
  expect(s.emit).not.toHaveBeenCalled()
  auth.user={id:1,role:'admin'};businessEvents.publish(event);await flush()
  expect(s.emit).toHaveBeenCalledWith('app.notification',expect.objectContaining({sessionId:'s'}))
 } finally {s.handlers.get('disconnect')!()}
})


it('mutes only the selected device immediately, including snapshots, and resumes without reconnect', async () => {
 const a=socket(), b=socket(); b.handshake.auth.token='other'
 const { stateEvent }=await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 const snapshot=stateEvent('chat.run.updated','default',{session_id:'s'},{state:{status:'running'}})
 bindAppEventSubscription(a as any,()=>[snapshot]);bindAppEventSubscription(b as any)
 await a.handlers.get('app.events.subscribe')!({schema_version:1},vi.fn())
 await b.handlers.get('app.events.subscribe')!({schema_version:1},vi.fn())
 mutedTokens.add('test')
 try {
  const ack=vi.fn();await a.handlers.get('app.events.subscribe')!({schema_version:1,include_snapshot:true},ack)
  expect(ack.mock.calls[0][0]).toMatchObject({ok:true,snapshot:[]})
  publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'muted'},{title:'W'})
  await flush();expect(a.emit).not.toHaveBeenCalled();expect(b.emit).toHaveBeenCalledTimes(1)
  mutedTokens.delete('test')
  publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'enabled'},{title:'W'})
  await flush();expect(a.emit).toHaveBeenCalledTimes(1);expect(b.emit).toHaveBeenCalledTimes(2)
 } finally {a.handlers.get('disconnect')!();b.handlers.get('disconnect')!()}
})

it('also applies device preferences to legacy notification subscriptions', async () => {
 const { bindLegacyAppEvents }=await import('../../packages/server/src/modules/studio/services/webhooks/legacy-app-events')
 const s=socket();bindLegacyAppEvents(s as any,'workflow',()=>true)
 try {
  mutedTokens.add('test');publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'off'},{title:'W'})
  await flush();expect(s.emit).not.toHaveBeenCalled()
  mutedTokens.delete('test');publishDomainEvent('workflow.run.completed','default',{workflow_id:'w',run_id:'on'},{title:'W'})
  await flush();expect(s.emit).toHaveBeenCalledWith('app.workflow-notification',expect.objectContaining({runId:'on'}))
 } finally {s.handlers.get('disconnect')!()}
})
