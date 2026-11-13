import Router from '@koa/router'
import * as ctrl from '../controllers/anthropic-auth'

export const anthropicAuthRoutes = new Router()

anthropicAuthRoutes.post('/api/hermes/auth/anthropic/start', ctrl.start)
anthropicAuthRoutes.post('/api/hermes/auth/anthropic/submit/:sessionId', ctrl.submit)
anthropicAuthRoutes.get('/api/hermes/auth/anthropic/status', ctrl.status)
