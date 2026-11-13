import Router from '@koa/router'
import * as ctrl from '../controllers/agent-status'
import { requireSuperAdmin } from '../public/auth'

export const agentStatusRoutes = new Router()

agentStatusRoutes.get('/api/agents/availability', ctrl.availability)
agentStatusRoutes.get('/api/agents/status', requireSuperAdmin, ctrl.status)
