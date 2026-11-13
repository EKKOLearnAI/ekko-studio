import Router from '@koa/router'
import * as ctrl from '../controllers/skill-bundles'

export const skillBundleRoutes = new Router()

skillBundleRoutes.get('/api/hermes/bundles', ctrl.list)
skillBundleRoutes.post('/api/hermes/bundles', ctrl.create)
skillBundleRoutes.delete('/api/hermes/bundles/:commandName', ctrl.remove)
