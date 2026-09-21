import Router from '@koa/router'
import * as ctrl from '../controllers/app-connections'
import * as pushCtrl from '../controllers/push-registration'

export const appConnectionRoutes = new Router()

appConnectionRoutes.put('/api/studio/push/preference', pushCtrl.deviceNotificationPreferenceController)
appConnectionRoutes.put('/api/studio/push/registration', pushCtrl.pushRegistrationController)
appConnectionRoutes.delete('/api/studio/push/registration', pushCtrl.pushRegistrationController)
appConnectionRoutes.put('/api/studio/live-activities/registration', pushCtrl.liveActivityRegistrationController)
appConnectionRoutes.delete('/api/studio/live-activities/registration', pushCtrl.liveActivityRegistrationController)
appConnectionRoutes.patch('/api/studio/app-connections/:id/push', ctrl.updateAppConnectionPushController)

appConnectionRoutes.get('/api/app-connections', ctrl.listAppConnectionsController)
appConnectionRoutes.post('/api/app-connections/authorization-codes/lan', ctrl.createAppAuthorizationCodeController)
appConnectionRoutes.post('/api/app-connections/authorization-codes/cloud', ctrl.createCloudAppAuthorizationCodeController)
appConnectionRoutes.delete('/api/app-connections/:id', ctrl.deleteAppConnectionController)
