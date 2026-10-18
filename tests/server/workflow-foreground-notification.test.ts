import { bindLegacyAppEvents } from '../../packages/server/src/modules/studio/services/webhooks/legacy-app-events'
import { expect, it, vi } from 'vitest'
vi.mock('../../packages/server/src/modules/studio/public/auth',()=>({authenticateUserToken:vi.fn(),isAuthEnabled:vi.fn()}))
vi.mock('../../packages/server/src/modules/studio/repositories/users-store',()=>({listUserProfiles:()=>[{profile_name:'allowed'}]}))
const run=vi.hoisted(()=>({id:'r',workflow_id:'w',user_id:1,profile:'allowed',status:'completed',node_sessions:[],inputs:{credential:'secret'}}))
vi.mock('../../packages/server/src/modules/studio/repositories/workflow-run-store',()=>({getWorkflowRunWithEvidence:()=>run,getWorkflowRun:()=>run}))
vi.mock('../../packages/server/src/modules/studio/services/workflow/manager',()=>({getWorkflowManager:vi.fn()}))
vi.mock('../../packages/server/src/modules/studio/public/logging',()=>({logger:{error:vi.fn(),info:vi.fn()}}))
import { WorkflowSocketServer } from '../../packages/server/src/modules/studio/sockets/workflow'
it('notifies only terminal run once to currently authorized users, never canceled or node progress',()=>{
 const ok={id:'wf-ok',data:{user:{id:1}},handshake:{auth:{}},on:vi.fn(),emit:vi.fn()},guest={id:'wf-guest',data:{},handshake:{auth:{}},on:vi.fn(),emit:vi.fn()}
 const nsp={sockets:new Map([['ok',ok],['guest',guest]]),to:()=>({emit:vi.fn()})}
 const manager={onRuntimeStatus:vi.fn(()=>()=>{}),get:()=>({id:'w',name:'Workflow',profile:'allowed'})}
 const server=new WorkflowSocketServer({of:()=>nsp} as any,manager as any)
 bindLegacyAppEvents(ok as any,'workflow',e=>e.profile==='allowed')
 bindLegacyAppEvents(guest as any,'workflow',()=>false)
 const send=(status:string,runId='r')=>(server as any).emitRuntimeStatus({workflowId:'w',runId,status})
 send('running');send('canceled');expect(ok.emit).not.toHaveBeenCalled()
 send('completed');send('completed');expect(ok.emit).toHaveBeenCalledTimes(1);expect(guest.emit).not.toHaveBeenCalled()
 expect(ok.emit.mock.calls[0][1]).toMatchObject({target:'workflow',workflowId:'w',runId:'r',kind:'completion'})
 run.status='failed';run.id='r2';send('failed','r2');expect(ok.emit).toHaveBeenCalledTimes(2)
 manager.get=()=>({id:'w',name:'Workflow',profile:'denied'});send('failed','r3');expect(ok.emit).toHaveBeenCalledTimes(2)
 server.close()
 for (const socket of [ok,guest]) socket.on.mock.calls.find(call=>call[0]==='disconnect')?.[1]()
})

it('exposes sanitized workflow state through the unified stream and snapshot provider', async () => {
 const { businessEvents } = await import('../../packages/server/src/modules/studio/services/webhooks/business-events')
 const { appEventState } = await import('../../packages/server/src/modules/studio/services/webhooks/app-event-state')
 run.id='r';run.status='running'
 const status={workflowId:'w',runId:'r',status:'running',updatedAt:100,startedAt:10,pendingApprovals:[{nodeId:'n',executionId:'e'}]}
 const manager={onRuntimeStatus:vi.fn(()=>()=>{}),get:()=>({id:'w',name:'Workflow',profile:'allowed'}),listRuntimeStatuses:()=>[status]}
 const nsp={to:()=>({emit:vi.fn()})}
 const server=new WorkflowSocketServer({of:()=>nsp} as any,manager as any)
 const received:any[]=[];const stop=businessEvents.subscribe('test-workflow-state',event=>received.push(event))
 try {
  ;(server as any).emitRuntimeStatus(status)
  expect(received[0]).toMatchObject({type:'workflow.run.updated',profile:'allowed',payload:{state:{status:'running',pendingApprovals:[{nodeId:'n',executionId:'e'}]}}})
  expect(JSON.stringify(received[0])).not.toMatch(/secret|credential|inputs/)
  expect(appEventState({id:1,role:'user'} as any,'allowed')).toHaveLength(1)
  expect(appEventState({id:1,role:'user'} as any,'denied')).toHaveLength(0)
 } finally {server.close();stop()}
 expect(appEventState({id:1,role:'user'} as any,'allowed')).toHaveLength(0)
})
