import Router from '@koa/router'
import * as ctrl from '../controllers/minimax-auth'

export const minimaxAuthRoutes = new Router()

minimaxAuthRoutes.post('/api/hermes/auth/minimax/start', ctrl.start)
minimaxAuthRoutes.get('/api/hermes/auth/minimax/poll/:sessionId', ctrl.poll)
minimaxAuthRoutes.get('/api/hermes/auth/minimax/status', ctrl.status)
