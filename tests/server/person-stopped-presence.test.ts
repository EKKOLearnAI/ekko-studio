import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {randomUUID} from 'node:crypto'
import {acceptanceFixture,type AcceptanceFixture} from './fixtures/person-acceptance'
import {emitEkkoAbortCompletion} from '../../packages/server/src/modules/studio/services/chat-run/ekko-abort-completion'
import type {Socket} from 'socket.io'

let f:AcceptanceFixture
let Sync:typeof import('../../packages/server/src/modules/studio/services/session-state').SessionStateSync
const creator='person-main-1',recipient='person-main-recipient'
const syncs:InstanceType<typeof Sync>[]=[]
beforeEach(async()=>{
  f=await acceptanceFixture()
  Sync=(await import('../../packages/server/src/modules/studio/services/session-state')).SessionStateSync
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({id:recipient,studio_user_id:1,title:'Recipient',source:'builtin_agent',workspace:f.workspace})
})
afterEach(async()=>{for(const sync of syncs.splice(0))sync.close();await f.close('stopped-presence')})
function connection(sync:InstanceType<typeof Sync>){
  const events:Array<{event:string;payload:any}>=[],handlers=new Map<string,Function>()
  const socket={data:{user:{id:1,role:'super_admin'}},handshake:{query:{session_state:'1'}},on:(event:string,fn:Function)=>handlers.set(event,fn),emit:(event:string,payload:any)=>events.push({event,payload})} as unknown as Socket
  sync.attach(socket)
  return {request:()=>handlers.get('sessions.state.request')!(),read:(id=recipient)=>{
    const last=events.at(-1)!.payload;return Array.isArray(last.sessions)?last.sessions.find((s:any)=>s.sessionId===id):last
  }}
}
function fixture(){
  const runtime={working:true,backgroundPending:0,collaborationPending:0}
  const sync=new Sync(()=>runtime,()=>true);syncs.push(sync)
  return {runtime,sync,client:connection(sync)}
}

it('a real flow stop emits an abort terminal and leaves no running list state after refresh',async()=>{
  const flows=await import('../../packages/server/src/modules/studio/services/person/stage-flows')
  const stages=await import('../../packages/server/src/modules/studio/repositories/person-stage-store')
  const flow=flows.createPersonFlow(1,{title:'Repeat',goal:'Take turns',session_id:creator,rounds:0,idempotency_key:randomUUID(),
    stages:[recipient,creator].map(session_id=>({session_id,goal:'One reply',return_expectation:'One result'}))})
  const turn=flows.registerPersonStageTurn({flowId:flow.id,stageId:flow.stages[0].id,generation:flow.generation})
  const {runtime,sync,client}=fixture()
  sync.observe('run.started',{session_id:recipient,run_id:'stage-run'})
  expect(client.read().working).toBe(true)
  await flows.controlPersonFlow(1,{action:'stop',flow_id:flow.id,expected_revision:flow.revision,idempotency_key:randomUUID()})
  expect(turn.signal.aborted).toBe(true)
  expect(stages.personCollaborationPendingCount(1,recipient)).toBe(0)
  const owner=new AbortController(),state={abortController:owner,queue:[]}
  const events:string[]=[]
  const messages=f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n
  expect(emitEkkoAbortCompletion(state,owner,(event,payload)=>{events.push(event);sync.observe(event,payload)},
    {session_id:recipient,run_id:'stage-run',background_pending:0})).toBe(true)
  expect(events).toEqual(['abort.completed'])
  expect(client.read().working).toBe(false)
  runtime.working=false
  sync.refreshPerson(1)
  expect(connection(sync).read().working).toBe(false)
  expect(f.db.prepare('SELECT COUNT(*) n FROM messages').get()!.n).toBe(messages)
  turn.release()
})

it('a fresh snapshot reconciles an old missed terminal against the settled Person host',()=>{
  const {runtime,sync,client}=fixture()
  sync.observe('run.started',{session_id:recipient,run_id:'interrupted-stage'})
  runtime.working=false // the host already exited, but no terminal event arrived
  client.request()
  expect(client.read().working).toBe(false)
  expect(connection(sync).read().working).toBe(false)
})

it('retains genuine foreground, background work and other collaboration activity',()=>{
  const {runtime,sync,client}=fixture()
  sync.observe('run.started',{session_id:recipient,run_id:'another-real-run'})
  client.request();expect(client.read().working).toBe(true)
  runtime.working=false;runtime.backgroundPending=1
  client.request();expect(client.read()).toMatchObject({working:true,backgroundPending:1})
  runtime.backgroundPending=0;runtime.collaborationPending=1
  client.request();expect(client.read().working).toBe(true)
  runtime.collaborationPending=0
  client.request();expect(client.read().working).toBe(false)
  runtime.working=true
  sync.observe('run.started',{session_id:recipient,run_id:'new-user-run'})
  expect(client.read().working).toBe(true)
})

it('does not replace ordinary external-runtime event state with an idle host map',async()=>{
  const {createSession}=await import('../../packages/server/src/modules/studio/repositories/session-store')
  createSession({id:'ordinary-chat',studio_user_id:1,source:'web',profile:'default'})
  const {runtime,sync,client}=fixture();runtime.working=false
  sync.observe('run.started',{session_id:'ordinary-chat',run_id:'external-run'})
  client.request()
  expect(client.read('ordinary-chat').working).toBe(true)
})

it('does not duplicate the socket Abort handler terminal event',()=>{
  const owner=new AbortController();owner.abort()
  const emit=vi.fn()
  expect(emitEkkoAbortCompletion({abortController:owner,queue:[]},owner,emit,{run_id:'stopped'})).toBe(false)
  expect(emit).not.toHaveBeenCalled()
})

it('does not emit an old turn terminal over a replacement run',()=>{
  const owner=new AbortController(),replacement=new AbortController(),emit=vi.fn()
  const state={abortController:replacement,queue:[]}
  expect(emitEkkoAbortCompletion(state,owner,emit,{run_id:'old'})).toBe(false)
  expect(state.abortController).toBe(replacement)
  expect(emit).not.toHaveBeenCalled()
})

it('retains queued work in the terminal event instead of showing the whole session idle',()=>{
  const owner=new AbortController(),emit=vi.fn()
  const queue=[{queue_id:'next-user-message',input:'Continue'}]
  emitEkkoAbortCompletion({abortController:owner,queue},owner,emit,{run_id:'stage',background_pending:2})
  expect(emit).toHaveBeenCalledWith('abort.completed',expect.objectContaining({run_id:'stage',queue_length:1,queue_remaining:1,background_pending:2,stop_reason:'cancelled'}))
})
