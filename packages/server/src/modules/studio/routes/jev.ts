import Router from '@koa/router'
import * as ctrl from '../controllers/jev'

export const jevRoutes = new Router()
jevRoutes.get('/api/studio/jev/settings', ctrl.getSettings)
jevRoutes.put('/api/studio/jev/settings', ctrl.saveSettings)
jevRoutes.delete('/api/studio/jev/settings', ctrl.deleteSettings)
jevRoutes.post('/api/studio/jev/test', ctrl.testConnection)
jevRoutes.post('/api/studio/jev/evaluate', ctrl.evaluate)
