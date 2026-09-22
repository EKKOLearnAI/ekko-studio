import Router from '@koa/router'
import * as ctrl from '../controllers/orcarouter-auth'

export const orcaRouterAuthRoutes = new Router()

orcaRouterAuthRoutes.post('/api/hermes/auth/orcarouter/start', ctrl.start)
orcaRouterAuthRoutes.post('/api/hermes/auth/orcarouter/submit/:sessionId', ctrl.submit)
orcaRouterAuthRoutes.get('/api/hermes/auth/orcarouter/poll/:sessionId', ctrl.poll)
orcaRouterAuthRoutes.post('/api/hermes/auth/orcarouter/cancel/:sessionId', ctrl.cancel)
orcaRouterAuthRoutes.get('/api/hermes/auth/orcarouter/status', ctrl.status)
