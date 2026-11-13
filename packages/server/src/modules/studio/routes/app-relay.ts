import Router from '@koa/router'
import * as ctrl from '../controllers/app-relay'

export const appRelayRoutes = new Router()

appRelayRoutes.get('/api/app-relay/status', ctrl.getAppRelayStatusController)
appRelayRoutes.post('/api/app-relay/connect', ctrl.connectAppRelayController)
appRelayRoutes.put('/api/app-relay/route', ctrl.updateAppRelayRouteController)
appRelayRoutes.post('/api/app-relay/pairing-code', ctrl.refreshAppRelayPairingController)
appRelayRoutes.post('/api/app-relay/disconnect', ctrl.disconnectAppRelayController)
