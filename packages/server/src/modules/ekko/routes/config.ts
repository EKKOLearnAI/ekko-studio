import Router from '@koa/router'
import { requireSuperAdmin } from '../../studio/public/auth'
import * as ctrl from '../controllers/config'

export const ekkoConfigRoutes = new Router()

ekkoConfigRoutes.get('/api/ekko/config', requireSuperAdmin, ctrl.get)
ekkoConfigRoutes.put('/api/ekko/config', requireSuperAdmin, ctrl.update)
