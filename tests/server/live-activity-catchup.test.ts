import { it, expect, vi, afterEach } from 'vitest'
afterEach(()=>{vi.resetModules();vi.useRealTimers()})
it('targets one authorized latest active snapshot and throttles repeated registration',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000000)
 const plan=(id:string)=>({session_id:id,run_id:'run',plan_id:id,revision:1,execution_state:'running',created_at:1000,updated_at:2000,plan:[{id:'s',step:'step',status:'in_progress'}]})
 vi.doMock('../../packages/server/src/modules/studio/services/chat-run/server-registry',()=>({getChatRunServer:()=>({getLiveActivityPlans:()=>[{profile:'forbidden',snapshot:plan('a')},{profile:'allowed',snapshot:plan('b')},{profile:'allowed',snapshot:plan('c')}]})}))
 vi.doMock('../../packages/server/src/modules/studio/repositories/live-activity-store',()=>({listLiveActivityDestinations:()=>[{connection_id:7,enabled:1,user_id:1}]}))
 vi.doMock('../../packages/server/src/modules/studio/repositories/users-store',()=>({findUserById:()=>({status:'active'})}))
 vi.doMock('../../packages/server/src/modules/studio/services/webhooks/app-events',()=>({canReceiveAppEvent:(_:unknown,e:any)=>e.profile==='allowed'}))
 const {configureLiveActivityCatchup,catchUpLiveActivities}=await import('../../packages/server/src/modules/studio/services/notifications/live-activity-catchup')
 const send=vi.fn(async()=>{});configureLiveActivityCatchup(send)
 await catchUpLiveActivities(7);await catchUpLiveActivities(7);await catchUpLiveActivities(8)
 expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0]).toEqual([expect.objectContaining({subject:expect.objectContaining({session_id:'b'})}),7])
})
