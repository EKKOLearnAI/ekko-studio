import Router from '@koa/router'
import * as ctrl from '../controllers/context-manager'

export const contextManagerRoutes = new Router()

contextManagerRoutes.get('/api/studio/context-manager/settings', ctrl.getSettings)
contextManagerRoutes.put('/api/studio/context-manager/settings', ctrl.updateSettings)
contextManagerRoutes.get('/api/studio/context-manager/health', ctrl.health)
contextManagerRoutes.post('/api/studio/context-manager/worker/restart', ctrl.restartWorker)
contextManagerRoutes.post('/api/studio/context-manager/lifecycle/:action', ctrl.lifecycle)
