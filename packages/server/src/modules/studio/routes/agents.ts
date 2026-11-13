import Router from '@koa/router'
import { requireSuperAdmin } from '../public/auth'
import * as controller from '../controllers/agents'

export const studioAgentRoutes = new Router()
studioAgentRoutes.get('/api/studio/agents', controller.list)
studioAgentRoutes.get('/api/studio/agents/:id/status', requireSuperAdmin, controller.status)
studioAgentRoutes.get('/api/studio/agents/:id/models', controller.models)
studioAgentRoutes.post('/api/studio/agents/:id/settings', controller.settings)
studioAgentRoutes.post('/api/studio/agents/:id/check-update', requireSuperAdmin, controller.checkUpdate)
studioAgentRoutes.post('/api/studio/agents/:id/upgrade', requireSuperAdmin, controller.upgrade)
studioAgentRoutes.post('/api/studio/agents/:id/remove', requireSuperAdmin, controller.remove)
studioAgentRoutes.get('/api/studio/agents/:id/update-policy', requireSuperAdmin, controller.updatePolicy)
studioAgentRoutes.put('/api/studio/agents/:id/update-policy', requireSuperAdmin, controller.setUpdatePolicy)
