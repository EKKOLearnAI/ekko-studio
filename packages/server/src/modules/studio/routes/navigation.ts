import Router from '@koa/router'
import * as ctrl from '../controllers/navigation'

export const navigationRoutes = new Router()
navigationRoutes.get('/api/navigation', ctrl.getNavigation)
navigationRoutes.put('/api/navigation', ctrl.updateNavigation)
