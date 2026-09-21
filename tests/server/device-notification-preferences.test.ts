import {it,expect,vi} from 'vitest'
import {DatabaseSync} from 'node:sqlite'
it('persists per-account/device opt-out without overriding administrator preference',async()=>{
 const db=new DatabaseSync(':memory:')
 vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
 try {
  let store=await import('../../packages/server/src/modules/studio/repositories/device-notification-preferences')
  expect(store.deviceSystemNotificationsEnabled(7,'phone')).toBe(true)
  store.saveDeviceSystemNotifications(7,'phone',false);vi.resetModules()
  store=await import('../../packages/server/src/modules/studio/repositories/device-notification-preferences')
  expect(store.deviceSystemNotificationsEnabled(7,'phone')).toBe(false)
  expect(store.deviceSystemNotificationsEnabled(8,'phone')).toBe(true)
  expect(store.deviceSystemNotificationsEnabled(7,'other')).toBe(true)
  store.saveDeviceSystemNotifications(7,'phone',true);expect(store.deviceSystemNotificationsEnabled(7,'phone')).toBe(true)
 } finally {db.close();vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index');vi.resetModules()}
})

it('social task delivery is disabled and generic HTTP webhook subscription is retained',async()=>{
 const {readFileSync}=await import('node:fs')
 const consumers=readFileSync('packages/server/src/modules/studio/services/webhooks/business-consumers.ts','utf8')
 expect(consumers).toContain("businessEvents.subscribe('http-webhook'")
 expect(consumers.replace(/^\s*\/\/.*$/gm,'')).not.toContain("businessEvents.subscribe('social-messages'")
 const controller=readFileSync('packages/server/src/modules/studio/controllers/social-messages.ts','utf8')
 expect(controller).toContain("code: 'social_push_disabled'")
})

it('self preference uses authenticated device identity and rejects caller supplied targets',async()=>{
 const db=new DatabaseSync(':memory:');vi.resetModules()
 vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index',()=>({getDb:()=>db}))
 vi.doMock('../../packages/server/src/modules/studio/public/auth',()=>({inspectAppUserToken:async()=>({status:'active',user:{id:7},deviceCode:'phone',connectionType:'cloud'})}))
 vi.doMock('../../packages/server/src/modules/studio/repositories/app-connections-store',()=>({hashAppCredential:()=> 'hash',listAppConnections:()=>[{id:3,user_id:7,device_code:'phone',connection_type:'cloud',token_hash:'hash',token_expires_at:Date.now()/1000+60,revoked_at:null}]}))
 try {
  const {updateOwnDeviceNotificationPreference}=await import('../../packages/server/src/modules/studio/services/notifications/device-preference')
  expect(await updateOwnDeviceNotificationPreference('valid',{enabled:false})).toBe(3)
  await expect(updateOwnDeviceNotificationPreference('valid',{enabled:true,device_id:'another'})).rejects.toThrow('invalid_notification_preference')
 } finally {db.close();vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index');vi.doUnmock('../../packages/server/src/modules/studio/public/auth');vi.doUnmock('../../packages/server/src/modules/studio/repositories/app-connections-store');vi.resetModules()}
})
