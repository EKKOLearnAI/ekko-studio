import Router from '@koa/router'
import * as ctrl from '../controllers/nous-auth'

export const nousAuthRoutes = new Router()

nousAuthRoutes.post('/api/hermes/auth/nous/start', ctrl.start)
nousAuthRoutes.get('/api/hermes/auth/nous/poll/:sessionId', ctrl.poll)
nousAuthRoutes.get('/api/hermes/auth/nous/status', ctrl.status)
