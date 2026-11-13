import Router from '@koa/router'
import * as ctrl from '../controllers/copilot-auth'

export const copilotAuthRoutes = new Router()

copilotAuthRoutes.post('/api/hermes/auth/copilot/start', ctrl.start)
copilotAuthRoutes.get('/api/hermes/auth/copilot/poll/:sessionId', ctrl.poll)
copilotAuthRoutes.get('/api/hermes/auth/copilot/check-token', ctrl.checkToken)
copilotAuthRoutes.post('/api/hermes/auth/copilot/enable', ctrl.enable)
copilotAuthRoutes.post('/api/hermes/auth/copilot/disable', ctrl.disable)
