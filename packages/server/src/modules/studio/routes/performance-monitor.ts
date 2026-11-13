import Router from '@koa/router'
import * as ctrl from '../controllers/performance-monitor'
import { requireSuperAdmin } from '../public/auth'

export const performanceMonitorRoutes = new Router()

performanceMonitorRoutes.get('/api/studio/performance/runtime', requireSuperAdmin, ctrl.runtime)
