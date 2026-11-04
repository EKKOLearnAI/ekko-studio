import Router from '@koa/router'
import * as ctrl from '../controllers/jev'
import { requireSuperAdmin } from '../middleware/auth'

export const jevRoutes = new Router()
jevRoutes.get('/api/studio/jev/settings', ctrl.getSettings)
jevRoutes.put('/api/studio/jev/settings', requireSuperAdmin, ctrl.saveSettings)
jevRoutes.delete('/api/studio/jev/settings', requireSuperAdmin, ctrl.deleteSettings)
jevRoutes.post('/api/studio/jev/test', requireSuperAdmin, ctrl.testConnection)
jevRoutes.post('/api/studio/jev/evaluate', ctrl.evaluate)

jevRoutes.post('/api/studio/jev/browser/match', ctrl.matchBrowser)
jevRoutes.post('/api/studio/jev/browser/verify', ctrl.verifyBrowser)
