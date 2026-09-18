import { beforeEach, it, expect, vi } from 'vitest'
const auth=vi.hoisted(()=>({user:{id:1,role:'user'} as any,profiles:['default']}))
vi.mock('../../packages/server/src/modules/studio/public/auth',()=>({authenticateUserToken:async()=>auth.user}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store',()=>({listUserProfiles:()=>auth.profiles.map(profile_name=>({profile_name}))}))
vi.mock('../../packages/server/src/modules/studio/repositories/session-store',()=>({getSession:()=>({source:'cli',agent:'codex',profile:'default'}),getSessionNotificationPreview:()=>({title:'Title',preview:'Reply'})}))
import { bindAppEventSubscription, parseAppSubscription, registerGroupEventAccess } from '../../packages/server/src/modules/studio/services/webhooks/app-events'
import { publishDomainEvent, publishGroupMessage } from '../../packages/server/src/modules/studio/services/webhooks/domain-events'
function socket(){const handlers=new Map<string,Function>();return {id:Math.random().toString(),handshake:{auth:{token:'test'}},data:{},emit:vi.fn(),on:(n:string,f:Function)=>{const old=handlers.get(n);handlers.set(n,old?(...args:any[])=>{old(...args);f(...args)}:f)},once:(n:string,f:Function)=>handlers.set(n,f),handlers}}
const flush=()=>new Promise(r=>setTimeout(r,15))
beforeEach(()=>{auth.user={id:1,role:'user'};auth.profiles=['default']})
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
