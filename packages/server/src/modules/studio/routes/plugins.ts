import Router from '@koa/router'
import * as ctrl from '../controllers/plugins'

export const studioPluginRoutes = new Router()
studioPluginRoutes.get('/api/studio/plugins', ctrl.list)
studioPluginRoutes.post('/api/studio/plugins/install', ctrl.install)
studioPluginRoutes.get('/api/studio/plugins/development', ctrl.developmentList)
studioPluginRoutes.post('/api/studio/plugins/:id/development', ctrl.developmentStart)
studioPluginRoutes.delete('/api/studio/plugins/:id/development', ctrl.developmentUnlink)
studioPluginRoutes.get('/api/studio/plugins/events', ctrl.events)
studioPluginRoutes.patch('/api/studio/plugins/:id', ctrl.update)
studioPluginRoutes.get('/api/studio/plugins/:id/client', ctrl.client)
studioPluginRoutes.get('/api/studio/plugins/:id/logs', ctrl.logs)
studioPluginRoutes.post('/api/studio/plugins/:id/invoke', ctrl.invoke)
studioPluginRoutes.post('/api/studio/plugins/:id/api', ctrl.api)
studioPluginRoutes.post('/api/studio/plugins/:id/storage', ctrl.storage)

studioPluginRoutes.post('/api/studio/plugins/:id/browser', ctrl.browser)
