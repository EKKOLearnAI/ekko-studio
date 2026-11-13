import Router from '@koa/router'
import * as ctrl from '../controllers/codex-auth'

export const codexAuthRoutes = new Router()

codexAuthRoutes.post('/api/hermes/auth/codex/start', ctrl.start)
codexAuthRoutes.get('/api/hermes/auth/codex/poll/:sessionId', ctrl.poll)
codexAuthRoutes.get('/api/hermes/auth/codex/status', ctrl.status)
