import Router from '@koa/router'
import * as ctrl from '../controllers/chat-webhooks'
import { requireSuperAdmin } from '../public/auth'

export const chatWebhookRoutes = new Router()
export const chatWebhookPublicRoutes = new Router()

chatWebhookPublicRoutes.post('/webhook-test/:token', ctrl.receiveLocalTestWebhook)

chatWebhookRoutes.get('/api/studio/webhooks/endpoints', requireSuperAdmin, ctrl.listEndpoints)
chatWebhookRoutes.get('/api/studio/webhooks/local-test-target', requireSuperAdmin, ctrl.localTestTarget)
chatWebhookRoutes.get('/api/studio/webhooks/local-test-events', requireSuperAdmin, ctrl.localTestEvents)
chatWebhookRoutes.delete('/api/studio/webhooks/local-test-events', requireSuperAdmin, ctrl.clearLocalTestEvents)
chatWebhookRoutes.post('/api/studio/webhooks/endpoints', requireSuperAdmin, ctrl.createEndpoint)
chatWebhookRoutes.patch('/api/studio/webhooks/endpoints/:id', requireSuperAdmin, ctrl.updateEndpoint)
chatWebhookRoutes.delete('/api/studio/webhooks/endpoints/:id', requireSuperAdmin, ctrl.removeEndpoint)
chatWebhookRoutes.post('/api/studio/webhooks/endpoints/:id/test', requireSuperAdmin, ctrl.testEndpoint)
