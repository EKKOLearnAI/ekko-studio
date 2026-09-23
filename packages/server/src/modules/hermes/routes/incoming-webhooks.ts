import Router from '@koa/router'
import * as ctrl from '../controllers/incoming-webhooks'
import { requireSuperAdmin } from '../../studio/public/auth'

export const incomingWebhookRoutes = new Router()

incomingWebhookRoutes.get('/api/hermes/incoming-webhooks', requireSuperAdmin, ctrl.list)
incomingWebhookRoutes.post('/api/hermes/incoming-webhooks/enable', requireSuperAdmin, ctrl.enable)
incomingWebhookRoutes.post('/api/hermes/incoming-webhooks', requireSuperAdmin, ctrl.create)
incomingWebhookRoutes.put('/api/hermes/incoming-webhooks/:name/enabled', requireSuperAdmin, ctrl.toggle)
incomingWebhookRoutes.delete('/api/hermes/incoming-webhooks/:name', requireSuperAdmin, ctrl.remove)
