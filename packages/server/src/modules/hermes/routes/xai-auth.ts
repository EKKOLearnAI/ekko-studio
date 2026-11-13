import Router from '@koa/router'
import * as ctrl from '../controllers/xai-auth'

export const xaiAuthRoutes = new Router()

xaiAuthRoutes.post('/api/hermes/auth/xai/start', ctrl.start)
xaiAuthRoutes.get('/api/hermes/auth/xai/poll/:sessionId', ctrl.poll)
xaiAuthRoutes.get('/api/hermes/auth/xai/status', ctrl.status)
